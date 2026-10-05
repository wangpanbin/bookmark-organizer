/**
 * 云端 LLM 兜底分类。
 *
 * ═══ 设计边界 ═══
 * 1. **只对规则未命中的条目发请求**，不是把整个书签列表外发。
 *    URL 列表本身就是隐私（内网地址、项目名、私有仓库都在里面），
 *    所以默认只发「其他/待归类」那一小撮。
 * 2. **权限按需申请**：manifest 里只写 optional_host_permissions，
 *    用户点「授权访问该域名」时才弹窗。关闭 LLM 时扩展不需要任何 host 权限。
 * 3. **API key 的来源与存放**（按优先级）：
 *      ① tools/inject_key.py 从本机环境变量注入到 src/llm-key.local.js
 *         —— 扩展运行时读不到 OS 环境变量（没有 process 对象），
 *            只能在加载前由本机脚本读一次。key 不进 git、不进发布包。
 *      ② 面板里手填，存在 chrome.storage.local
 *      ③ 都没有 → 跳过 LLM，未分类条目留在「其他/待归类」
 *    从环境变量注入的 key **不写入 storage**，只在内存里用。
 *
 * 供应商：默认 DeepSeek（OpenAI 兼容协议）。
 * base URL 与 model 都可配置 —— DeepSeek 官方文档对「当前该用哪个模型名」
 * 存在互相矛盾的说法，且 deepseek-chat 已公告弃用，与其押注一个会失效的
 * 名字，不如给默认值 + 面板可改 + 预设列表。
 */

/** 单次请求最多带多少条 */
const BATCH_SIZE = 20;
/** 最多重试几次（不含首次） */
const MAX_RETRY = 2;

export const DEFAULT_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_MODEL = 'deepseek-flash';

/** 面板预设：不同服务商的可用模型。DeepSeek 的模型名变动较频繁，这里只列确认存在的。 */
export const MODEL_PRESETS = [
  { label: 'DeepSeek · flash（默认，非思考模式）', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' },
  { label: 'DeepSeek · pro（更强，较慢较贵）', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-pro' },
  { label: 'DeepSeek · v4-flash（旧名，仍可调用）', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash' },
  // ⚠️ 不要再把 `deepseek-reasoner` 加回预设列表：
  //    本文件下方的 400 错误提示明确写了 DeepSeek 已公告它于 2026-07-24 弃用。
  //    预置一个自家文档说已下线的模型名，等于让用户每次都去撞一次 400。
  //    思考型模型的手工用法仍然支持 —— callOnce 按模型名里的 reasoner/thinking
  //    自动关掉 json_mode 和 temperature，与是否在预设里无关。
  { label: '阿里云百炼 · qwen-plus', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { label: '阿里云百炼 · qwen-turbo（更便宜）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-turbo' },
  { label: 'OpenAI · gpt-4o-mini', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
];

/** 注入配置的缓存（文件不存在是正常情况，不能让整个模块挂掉） */
let injectedPromise = null;

/**
 * 注入文件的候选路径。
 *
 * ⚠️ 这里曾经是一个**静默失效**的 bug，症状极有欺骗性：
 *    面板一直报「没有 API key，LLM 兜底已跳过」，
 *    但用户明明跑过 `python tools/inject_key.py`、文件也确实躺在磁盘上。
 *    根因是路径写错了一级：
 *      · tools/inject_key.py 写的是  <root>/src/llm-key.local.js
 *      · 本文件在 <root>/src/classify/llm.js，
 *        写 `import('./llm-key.local.js')` 会解析到
 *        <root>/src/classify/llm-key.local.js —— 那个文件从来不存在。
 *    再加上原来的 `.catch(() => ({}))` 把加载失败整个吞掉，
 *    于是「读不到」和「没注入」长得一模一样，排查成本极高。
 *
 * 修法有两条，缺一不可：
 *    ① 两条路径都试（../ 指回 src/，./ 是为将来挪目录留的余地）
 *    ② 加载失败要**带原因**返回，不能再无声退化成 {}
 */
const INJECTED_CANDIDATES = ['../llm-key.local.js', './llm-key.local.js'];

async function loadInjected() {
  const tried = [];
  for (const spec of INJECTED_CANDIDATES) {
    try {
      const m = await import(/* @vite-ignore */ spec);
      const cfg = (m && m.default) || null;
      if (cfg) return { ...cfg, source: cfg.source || 'env', loadedFrom: spec };
      tried.push(`${spec} → 模块里没有 default 导出`);
    } catch (e) {
      tried.push(`${spec} → ${e && e.message ? e.message : e}`);
    }
  }
  return { loadedFrom: null, tried };
}

/**
 * 读 tools/inject_key.py 注入的本地配置。
 *
 * @returns {Promise<{apiKey?:string, baseUrl?:string, model?:string, source?:string, loadedFrom:?string, tried?:string[]}>}
 */
export function getInjectedConfig() {
  if (!injectedPromise) injectedPromise = loadInjected();
  return injectedPromise;
}

/**
 * 合并出实际生效的配置。
 * key 优先级：面板手填 > 环境变量注入。从环境变量注入的**不写进 storage**。
 *
 * @param {object} settings 面板里存的设置
 * @returns {Promise<object>} 附加了 apiKey / keySource 的配置
 */
export async function resolveConfig(settings) {
  const injected = await getInjectedConfig();
  const manual = (settings?.apiKey || '').trim();
  const envKey = (injected.apiKey || '').trim();
  const apiKey = manual || envKey;
  return {
    llmEnabled: settings?.llmEnabled !== false,
    baseUrl: (settings?.baseUrl || '').trim() || injected.baseUrl || DEFAULT_BASE_URL,
    model: (settings?.model || '').trim() || injected.model || DEFAULT_MODEL,
    apiKey,
    keySource: manual ? 'manual' : envKey ? 'env' : 'none',
    // 诊断用：让面板能说清「key 到底从哪来 / 为什么读不到」
    injectedLoadedFrom: injected.loadedFrom || null,
    injectedTried: injected.tried || [],
  };
}

/**
 * 从 base URL 推出 host_permissions 需要的模式串。
 * https://api.deepseek.com → https://api.deepseek.com/*
 * @param {string} baseUrl
 * @returns {string}
 */
export function originPatternOf(baseUrl) {
  try {
    const u = new URL(baseUrl);
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return '';
  }
}

/** 当前是否已拿到该域名的权限 */
export async function hasLlmPermission(baseUrl) {
  const origin = originPatternOf(baseUrl);
  if (!origin || !chrome.permissions) return false;
  try {
    return await chrome.permissions.contains({ origins: [origin] });
  } catch {
    return false;
  }
}

/**
 * 按需申请权限。必须由用户手势（点击）直接触发，否则 Chrome 会拒绝。
 * @param {string} baseUrl
 * @returns {Promise<boolean>}
 */
export async function requestLlmPermission(baseUrl) {
  const origin = originPatternOf(baseUrl);
  if (!origin || !chrome.permissions) return false;
  try {
    return await chrome.permissions.request({ origins: [origin] });
  } catch (e) {
    console.warn('[llm] 权限申请失败', e);
    return false;
  }
}

/** 撤销权限（用户想彻底关掉 LLM 时用） */
export async function revokeLlmPermission(baseUrl) {
  const origin = originPatternOf(baseUrl);
  if (!origin || !chrome.permissions) return false;
  try {
    return await chrome.permissions.remove({ origins: [origin] });
  } catch {
    return false;
  }
}

/**
 * 把模型回复里的 JSON 抠出来。
 * 模型很爱包 ```json 代码块，所以先剥围栏，再从第一个 [ 截到最后一个 ]。
 * @param {string} text
 * @returns {Array|null}
 */
export function parseJsonArray(text) {
  if (typeof text !== 'string') return null;
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(s.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 构造提示词。
 *
 * 硬约束写进 system：只能用给定类目名、不能发明新类目、
 * 不确定就返回空数组（宁可进「待归类」也不要瞎猜）。
 *
 * @param {Array<{key:string,url:string,title:string}>} items
 * @param {Array} taxonomy
 * @returns {{system:string, user:string}}
 */
export function buildPrompt(items, taxonomy) {
  const lines = [];
  for (const top of taxonomy || []) {
    const subs = Array.isArray(top.children) ? top.children : [];
    lines.push(subs.length ? `- ${top.name}：${subs.join('、')}` : `- ${top.name}`);
  }
  const system = [
    '你是书签分类助手。用户会给你一批书签的 URL 与标题，你要为每一条挑选最合适的分类。',
    '',
    '硬性要求：',
    '1. 只能用下面【可用分类】里出现过的分类名，格式为「顶层/子类」。',
    '2. 绝对不许发明新分类。若没有任何一个合适，就返回空数组——宁可放进待归类也不要瞎猜。',
    '3. 依据 URL 域名与标题判断，不要臆测页面内容。',
    '4. 内网地址、localhost、chrome:// 等一律返回空数组。',
    '5. 只输出 JSON 数组，不要任何解释文字。每个元素形如 {"key":"...","to":"顶层/子类"}。',
    '6. key 必须原样回填我给你的 key。',
    '',
    '【可用分类】',
    ...lines,
  ].join('\n');

  const user = items
    .map((it, i) => `${i + 1}. key=${it.key}\n   url=${it.url}\n   title=${it.title || '(无标题)'}`)
    .join('\n');

  return { system, user };
}

/**
 * 统一错误信息。
 * ⚠️ 401 的成因因服务商而异：DeepSeek 没有区域绑定（key 有效就是有效），
 *    而阿里云百炼的 key 与区域强绑定，跨区调会返回 401 且看起来像 key 无效。
 *    所以文案不能只说「key 无效」—— 两者修法完全不同。
 */
function describeHttpError(status, body) {
  const text = String(body || '');

  if (status === 401 || status === 403) {
    if (/region|区域|cross-region|invalid_api_key|incorrect api key/i.test(text)) {
      return `HTTP ${status} 鉴权失败：${text.slice(0, 200)}\n`
        + '（若你用的是阿里云百炼：它的 key 与区域强绑定，用某区 key 调另一区端点就会报这个错，'
        + '请让 base URL 的区域与创建 key 的区域一致。DeepSeek 无此限制。）';
    }
    return `HTTP ${status} 鉴权失败：key 无效、已过期或没有该模型的权限。${text.slice(0, 200)}`;
  }

  if (status === 404) {
    return `HTTP 404：端点或模型名不对。请检查 base URL（DeepSeek 官方格式是 https://api.deepseek.com，`
      + '不带 /v1 也能通）与 model 名。DeepSeek 的模型名变动较频繁，建议在面板里换一个预设。';
  }

  if (status === 400) {
    if (/response_format|json_object|json mode/i.test(text)) {
      return `HTTP 400：该模型不支持 JSON 模式（response_format）。${text.slice(0, 200)}`;
    }
    if (/model/i.test(text)) {
      return `HTTP 400：请求被拒，通常是模型名不存在或已下线。${text.slice(0, 200)}\n`
        + '（DeepSeek 曾公告 deepseek-chat / deepseek-reasoner 于 2026-07-24 弃用，'
        + '请在面板里换一个预设模型。）';
    }
    return `HTTP 400：请求格式有误。${text.slice(0, 200)}`;
  }

  if (status === 429) return `HTTP 429：触发限流或额度用尽。稍后重试，或减少批次大小。`;
  if (status >= 500) return `HTTP ${status}：服务端错误，稍后重试。`;
  return `HTTP ${status}：${text.slice(0, 300)}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 单次请求的超时（毫秒）。
 *
 * ⚠️ 为什么必须有：loadAndClassify() 是 **await** 它的，而 loadAndClassify
 *    是面板上所有交互的入口 —— 预览、改判、锁定、去重否决、恢复备份
 *    全都要等它返回。原来的 fetch 没有任何超时/AbortSignal，
 *    于是一个挂住的连接（连接被墙、代理半开、服务端不回包）
 *    会让整个面板永久停在「LLM 兜底分类中…」：
 *    计划算不出来 → 计划表空着 → **「执行整理」按钮一直是禁用的**，
 *    用户点它等于点空气，看上去就是「点了没反应」。
 *    再叠上 classifyBatch 按 BATCH_SIZE 分批、每批还重试 2 次，
 *    未分类条目一多，等待时间被成倍放大。
 *
 * 取 30s：比正常推理（秒级）宽裕得多，又不至于让人等到以为面板死了。
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * 带超时的 fetch。
 * 超时抛出的错误文案要说清是「超时」而不是「网络错误」——
 * 这两者的排查方向完全不同（前者是慢/被墙，后者是 DNS/证书/断网）。
 */
async function fetchWithTimeout(url, opts, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } catch (e) {
    if (e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')))) {
      throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}s 无响应）。`
        + '通常是网络不通或服务商不可达 —— 可以在「设置」里关掉 LLM 兜底，'
        + '规则分类不受影响。');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 发一次请求（带重试与指数退避）。
 *
 * `useJsonMode`：DeepSeek 的 deepseek-chat 支持 JSON 模式，但并非所有模型都支持。
 * 先按支持的方式发，若 400 明确指向 response_format，去掉它重试一次 ——
 * 提示词里已经要求只输出 JSON，解析侧也剥代码块，退一步不影响可用性。
 *
 * @returns {Promise<{items:Array, usage:object|null}>}
 */
async function callOnce({ system, user, settings }) {
  const url = `${String(settings.baseUrl).replace(/\/+$/, '')}/chat/completions`;
  const isReasoner = /reasoner|thinking/i.test(String(settings.model || ''));
  let jsonMode = !isReasoner;
  let lastErr = null;

  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    if (attempt > 0) await sleep(600 * 2 ** (attempt - 1));
    try {
      const body = {
        model: settings.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        stream: false,
      };
      if (jsonMode) body.response_format = { type: 'json_object' };
      // 思考型模型不支持 temperature，传了也只是被忽略，但别添乱
      if (!isReasoner) body.temperature = 0;

      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      const text = await res.text();
      if (!res.ok) {
        // JSON 模式不被支持 → 去掉它再试（本次不计入重试次数）
        if (res.status === 400 && jsonMode && /response_format|json_object|json mode/i.test(text)) {
          jsonMode = false;
          attempt -= 1;
          continue;
        }
        lastErr = new Error(describeHttpError(res.status, text));
        // 4xx 里除了 429 以外重试没有意义
        if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
        continue;
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        lastErr = new Error('响应不是合法 JSON：' + text.slice(0, 200));
        continue;
      }
      const content = data?.choices?.[0]?.message?.content;
      const arr = parseJsonArray(typeof content === 'string' ? content : JSON.stringify(content));
      if (!arr) {
        lastErr = new Error('模型没有返回可解析的 JSON 数组：' + String(content).slice(0, 200));
        continue;
      }
      return { items: arr, usage: data?.usage || null };
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastErr || new Error('请求失败');
}

/**
 * 对一批条目做 LLM 分类。
 *
 * @param {Array<{key:string,url:string,title:string}>} items
 * @param {{taxonomy:Array, settings:object, onProgress?:Function}} opts
 * @returns {Promise<{assignments:Record<string,string>, errors:string[], asked:number, batches:number, usage:object[]}>}
 */
export async function classifyBatch(items, opts) {
  const { taxonomy, onProgress } = opts || {};
  const cfg = await resolveConfig(opts?.settings);
  const out = { assignments: {}, errors: [], asked: 0, batches: 0, usage: [] };

  if (!cfg.llmEnabled) return out;
  if (!cfg.apiKey) {
    // ⚠️ 措辞要能区分两种完全不同的情况：
    //    「压根没注入」和「注入了但没读到」。
    //    早先这里只说「没有 API key」，而动态 import 路径写错一级导致
    //    「注入了却读不到」也报同一句 —— 用户按提示去检查环境变量，
    //    一切正常，于是判定扩展在骗人。真正的信息在 loadedFrom/tried 里。
    const diag = cfg.injectedTried && cfg.injectedTried.length
      ? `（已尝试读取注入文件：${cfg.injectedTried.join('；')}）`
      : '';
    out.errors.push(
      '没有 API key，LLM 兜底已跳过。'
      + '可以设环境变量 DEEPSEEK_API_KEY 后跑 python tools/inject_key.py 注入，'
      + '或在「设置 → LLM 兜底」里手填。'
      + '未分类的条目会留在「其他/待归类」，不影响其余整理。' + diag,
    );
    return out;
  }
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return out;

  const granted = await hasLlmPermission(cfg.baseUrl);
  if (!granted) {
    out.errors.push(
      `尚未授予 ${cfg.baseUrl} 的访问权限。请在「设置 → LLM 兜底」里点「授权访问该域名」后再开启。`,
    );
    return out;
  }

  for (let i = 0; i < list.length; i += BATCH_SIZE) {
    const batch = list.slice(i, i + BATCH_SIZE);
    out.batches += 1;
    out.asked += batch.length;
    onProgress?.({ done: i, total: list.length });

    const { system, user } = buildPrompt(batch, taxonomy);
    try {
      const { items: arr, usage } = await callOnce({ system, user, settings: cfg });
      if (usage) out.usage.push(usage);
      for (const row of arr) {
        const key = row && row.key ? String(row.key) : null;
        const to = row && row.to ? String(row.to) : null;
        // 只接受 taxonomy 里真实存在的路径，模型自造的类目一律丢弃
        if (key && to) out.assignments[key] = to;
      }
    } catch (e) {
      out.errors.push(`第 ${out.batches} 批（${i + 1}-${i + batch.length} 条）失败：${e.message}`);
    }
  }

  onProgress?.({ done: list.length, total: list.length });
  return out;
}

/**
 * 校验 LLM 返回的路径是否都在 taxonomy 内，丢掉模型自造的类目。
 * @param {Record<string,string>} assignments
 * @param {Array} taxonomy
 * @param {import('../classify/taxonomy.js').isKnownPath} isKnownPath
 * @returns {{valid:Record<string,string>, dropped:string[]}}
 */
export function validateAssignments(assignments, taxonomy, isKnownPath) {
  const valid = {};
  const dropped = [];
  for (const [k, v] of Object.entries(assignments || {})) {
    if (isKnownPath(taxonomy, v)) valid[k] = v;
    else dropped.push(v);
  }
  return { valid, dropped: [...new Set(dropped)] };
}
