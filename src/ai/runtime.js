/**
 * 模型运行时装配。
 *
 * ⚠️⚠️ 本模块是**唯一** import `src/vendor/pi-ai.js` 的地方。⚠️⚠️
 *
 * 这条约束不是洁癖，是「行为零变化」能被证明的前提：
 * 只要有第二个模块碰到 vendor 产物，单元测试就必须在 Node 下加载那 386KB，
 * 于是「单测变红」这件事就无法区分「业务逻辑坏了」与「打包产物坏了」。
 * `tests/unit/vendor-path.test.js` 会静态断言这条边界。
 *
 * ═══ 三个已实测、且与直觉相反的事实（照抄会让功能静默走错）═══
 * 1. `models.complete()` 失败时**不 reject**，而是 resolve 一个
 *    `{ stopReason:'error', content:[], errorMessage }`。
 *    当成成功读，HTTP 401/429/5xx 会全部退化成「模型返回了空内容」，
 *    整套按供应商定制的错误诊断（百炼 401 区域绑定、400 模型名、429 限流）**整条消失**。
 *    → 每次调用后必须过 `isErrorResult()`。
 * 2. 错误被压成扁平字符串（实测就是 `"Connection error."`），
 *    里面**没有状态码也没有响应体**。所以状态码与响应体必须靠
 *    我们注入的自定义 `fetch` 截下来，否则 `describeHttpError` 无从下手。
 * 3. `openaiProvider()` 是 `openai-responses` 而非 `openai-completions`；
 *    `minimaxCnProvider()` 是 `anthropic-messages` 而非 openai 兼容。
 *    协议走错不会报错，只会拿到莫名其妙的 404/400。
 *
 * ═══ 重试策略刻意关掉了 SDK 内建重试 ═══
 * OpenAI SDK 默认自己重试 2 次；我们外层还要按「4xx 不重试、429 才重试」
 * 的既有规则重试。两层都开就是最多 9 次请求，且会掩盖真实错误。
 * 所以这里 `maxRetries: 0`，重试完全由 `completeWithRetry` 掌控。
 */

import {
  isErrorResult, textOf, buildContext,
} from './context.js';
import {
  describeHttpError, describeTransportError, isJsonModeRejection, isRetryableStatus,
} from './errors.js';
import {
  PROVIDERS, resolveTarget, getProvider, resolveJsonMode,
} from './provider-registry.js';

/** vendor 产物的位置。契约测试会断言它与 esbuild 的 outfile 一致。 */
export const VENDOR_SPECIFIER = '../vendor/pi-ai.js';

/** 既有超时：比正常推理宽裕得多，又不至于让人以为面板死了（llm.js:288） */
const REQUEST_TIMEOUT_MS = 30_000;
/** 既有重试次数（不含首次） */
const MAX_RETRY = 2;
/** 既有退避基数 */
const RETRY_BASE_MS = 600;
/** 错误响应体最多留多少字用于诊断 */
const MAX_CAPTURED_BODY = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** vendor 加载结果缓存。失败也缓存，避免每次调用都重试一次注定失败的 import。 */
let vendorPromise = null;

/**
 * 加载 vendor 产物。
 *
 * ⚠️ 失败时**带着原因**返回，不无声退化成空对象。
 *    早先的 bug 正是 `.catch(() => ({}))` 把加载失败整个吞掉，
 *    于是「读不到」和「没注入」在面板上长得一模一样，排查成本极高（llm.js:60-63）。
 *
 * @returns {Promise<{vendor:object|null, loadedFrom:string|null, tried:string[]}>}
 */
export function loadVendor() {
  if (!vendorPromise) {
    vendorPromise = import(VENDOR_SPECIFIER)
      .then((m) => ({ vendor: m, loadedFrom: VENDOR_SPECIFIER, tried: [] }))
      .catch((e) => ({
        vendor: null,
        loadedFrom: null,
        tried: [`${VENDOR_SPECIFIER} → ${e && e.message ? e.message : e}`],
      }));
  }
  return vendorPromise;
}

/** 只给测试用：清掉加载缓存。 */
export function resetVendorCache() {
  vendorPromise = null;
}

/**
 * 造一个「目录里没有、但用户自己填了」的模型对象。
 *
 * 为什么需要：pi-ai 自带目录只收录了一部分模型，而面板一直允许自由填写模型名
 * （老的 `deepseek-v4-flash` 就不在目录里，但**一直可用**）。
 * 若坚持只认目录，那是一次真实的用户可见回退：用户配好的模型会突然报「不认识的模型」。
 * 实测 Model 就是一段纯数据，按 `dist` 里的真实对象形状构造即可被 `complete()` 接受。
 */
export function synthesizeModel({ providerId, modelId, api, baseUrl }) {
  return {
    id: modelId,
    name: modelId,
    api,
    baseUrl,
    provider: providerId,
    reasoning: false,
    thinkingLevelMap: {},
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
    compat: {},
    inputLimits: {},
  };
}

/** 自定义端点（用户手填的 base URL）用一个稳定 id 注册，避免每次调用重建。 */
export function customProviderId(baseUrl) {
  try {
    return `custom-${new URL(baseUrl).host}`;
  } catch {
    return 'custom-invalid';
  }
}

/**
 * 装配一个 Models 集合并注册全部 provider。
 * @param {object} vendor loadVendor() 的 vendor
 * @param {object} [opts]
 * @param {object} [opts.credentials] CredentialStore
 * @returns {object} pi-ai 的 Models 集合
 */
export function buildCollection(vendor, opts = {}) {
  const { createModels } = vendor;
  const models = opts.credentials ? createModels({ credentials: opts.credentials }) : createModels();
  for (const p of PROVIDERS) {
    if (!p.factory) continue; // 百炼在 ensureProvider 里按需自建
    const factory = vendor[p.factory];
    if (typeof factory !== 'function') continue; // vendor 产物没带上这个 provider，跳过而不是崩
    models.setProvider(factory());
  }
  return models;
}

/**
 * 确认目标 provider 已注册；认不出的自定义端点就现造一个。
 * @returns {{ok:true}|{ok:false,reason:string}}
 */
export function ensureProvider(vendor, models, target) {
  if (target.providerId) {
    if (models.getProvider(target.providerId)) return { ok: true };
    return {
      ok: false,
      reason: `供应商 ${target.providerId} 没有打进 vendor 产物。`
        + '改完 src/ai/vendor-entry.js 后要重跑 npm run build:vendor。',
    };
  }
  // 自定义端点：createProvider + openai-completions 是官方给任意兼容服务留的口子
  const id = customProviderId(target.baseUrl);
  if (!models.getProvider(id)) {
    const { createProvider, openAICompletionsApi } = vendor;
    if (typeof createProvider !== 'function' || typeof openAICompletionsApi !== 'function') {
      return { ok: false, reason: 'vendor 产物缺少 createProvider / openAICompletionsApi，无法接入自定义端点。' };
    }
    models.setProvider(createProvider({
      id,
      name: `自定义 · ${target.baseUrl}`,
      baseUrl: target.baseUrl,
      auth: { type: 'api_key' },
      models: [],
      api: openAICompletionsApi(),
    }));
  }
  target.providerId = id;
  return { ok: true };
}

/** 目标 → 可交给 `models.complete()` 的模型对象。 */
export function resolveModel(models, target) {
  if (target.providerId) {
    const known = models.getModel(target.providerId, target.model);
    if (known) return known;
  }
  return synthesizeModel({
    providerId: target.providerId || customProviderId(target.baseUrl),
    modelId: target.model,
    api: target.api,
    baseUrl: target.baseUrl,
  });
}

/**
 * 截获响应的自定义 fetch。
 *
 * 库的默认错误信息只有 `"Connection error."` 这种扁平字符串，
 * 状态码与响应体都拿不到 —— 而 `describeHttpError(status, body)` 两者都要：
 * 400 要靠响应体里的 `response_format` 判断是不是 JSON 模式不兼容，
 * 百炼 401 要靠响应体里的 `region` 判断是不是区域绑定问题。
 *
 * ⚠️ 必须 `clone()` 之后再读：直接读会把调用方的流消耗掉，
 *    表现是「错误诊断拿到了，但成功响应体空了」——两个方向一起坏，且极难定位。
 */
export function capturingFetch(sink) {
  return async (url, init) => {
    const res = await fetch(url, init);
    sink.status = res.status;
    if (!res.ok) {
      try {
        sink.body = (await res.clone().text()).slice(0, MAX_CAPTURED_BODY);
      } catch {
        // 响应体读不到就算了，状态码还在，诊断仍能给出方向
      }
    }
    return res;
  };
}

/** 把一次调用的失败翻译成带诊断的 Error（附带供重试策略判断的标记）。 */
function toError({ sink, result, timedOut, timeoutMs, regionBound, useJsonMode }) {
  if (timedOut) {
    const e = new Error(describeTransportError(null, true, timeoutMs));
    e.retryable = true;
    return e;
  }
  const status = Number(sink.status) || 0;
  if (status > 0) {
    const body = sink.body || '';
    const e = new Error(describeHttpError(status, body, { regionBound }));
    e.status = status;
    e.retryable = isRetryableStatus(status);
    e.jsonModeRejected = isJsonModeRejection(status, body, useJsonMode && status === 400);
    return e;
  }
  const e = new Error(describeTransportError(new Error(result && result.errorMessage), false, timeoutMs));
  e.retryable = true;
  return e;
}

/**
 * 单次尝试。
 * @returns {Promise<{text:string, usage:object}>}
 */
async function completeOnce({ models, model, systemPrompt, user, apiKey, useJsonMode, timeoutMs, regionBound }) {
  const sink = { status: 0, body: '' };
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const result = await models.complete(model, buildContext({ systemPrompt, user }), {
      apiKey,
      signal: controller.signal,
      fetch: capturingFetch(sink),
      // 重试由 completeWithRetry 掌控；SDK 内建重试会与之叠加成 3×3 次
      maxRetries: 0,
      // JSON 模式：prompt 里已经要求只输出 JSON，解析侧也会剥代码块，
      // 所以它只是「让格式更稳」的优化，拿不到就降级，不该因此失败。
      onPayload: (payload) => {
        if (!useJsonMode || !payload || typeof payload !== 'object') return undefined;
        return { ...payload, response_format: { type: 'json_object' } };
      },
    });

    if (!isErrorResult(result)) return { text: textOf(result), usage: result.usage || null };
    throw toError({ sink, result, timedOut, timeoutMs, regionBound, useJsonMode });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 带重试的一次调用。
 *
 * @param {object} input
 * @param {string} input.baseUrl
 * @param {string} input.model
 * @param {string} input.systemPrompt
 * @param {string} input.user
 * @param {string} input.apiKey
 * @param {number} [input.timeoutMs]
 * @param {boolean} [input.useJsonMode]
 * @returns {Promise<{text:string, usage:object|null}>}
 */
export async function completeWithRetry(input) {
  const { vendor, loadedFrom, tried } = await loadVendor();
  if (!vendor) {
    throw new Error(
      '模型运行库加载失败，已跳过 LLM 兜底（规则分类不受影响）。'
      + `尝试过：${(tried || []).join('；') || loadedFrom}`,
    );
  }

  const target = resolveTarget({ baseUrl: input.baseUrl, model: input.model });

  // key 解析：显式传入优先，否则问 CredentialStore。
  // ⚠️ 这个 store 曾经**建了但没人用** —— 单测全绿、模块干净、然后就没人管了。
  //    它存在的理由正是库设计 CredentialStore 的理由：让模型访问层
  //    只认「providerId → 凭据」这一件事，不去关心 key 存在哪。
  let apiKey = String(input.apiKey || '').trim();
  if (!apiKey && target.providerId) {
    try {
      const { getSettings } = await import('../storage.js');
      const { getInjectedConfig } = await import('../classify/llm.js');
      const { createCredentialStore } = await import('./credential-store.js');
      const store = createCredentialStore({ getSettings, getInjected: getInjectedConfig });
      const cred = await store.read(target.providerId);
      if (cred && cred.key) apiKey = cred.key;
    } catch (e) {
      // 解析失败不是致命：下面的「没 key」分支会给出可操作的提示
      console.warn('[runtime] 凭据解析失败', e);
    }
  }

  const models = buildCollection(vendor);
  const ensured = ensureProvider(vendor, models, target);
  if (!ensured.ok) throw new Error(ensured.reason);

  const model = resolveModel(models, target);
  const timeoutMs = Number.isFinite(input.timeoutMs) ? input.timeoutMs : REQUEST_TIMEOUT_MS;

  // ⚠️ 别对 anthropic-messages 协议注入 `response_format`：
  //    MiniMax 走的正是那个协议，而 Anthropic 请求体里没有这个字段，塞进去会被 400 拒。
  //    降级路径是有的（`isJsonModeRejection` 嗅到字样后重试），但那意味着
  //    **每一次调用都先白吃一个 400**。「能降级」不等于「应该先降级再试」。
  let useJsonMode = resolveJsonMode({ requested: input.useJsonMode, api: target.api });
  let lastErr = null;

  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    if (attempt > 0) await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
    try {
      return await completeOnce({
        models,
        model,
        systemPrompt: input.systemPrompt,
        user: input.user,
        apiKey,
        useJsonMode,
        timeoutMs,
        regionBound: target.regionBound,
      });
    } catch (e) {
      lastErr = e;
      // 400 且疑似 JSON 模式不兼容 → 去掉 JSON 模式重试一次，且不计入重试次数
      if (e && e.jsonModeRejected && useJsonMode) {
        useJsonMode = false;
        attempt -= 1;
        continue;
      }
      if (e && e.retryable === false) break;
    }
  }
  throw lastErr || new Error('请求失败');
}

export { REQUEST_TIMEOUT_MS, MAX_RETRY, getProvider, resolveTarget };
