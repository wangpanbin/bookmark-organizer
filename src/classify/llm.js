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
 * ═══ 2026-10-06 改造：模型访问下沉到 src/ai/ ═══
 * 本文件现在只负责**业务编排**（提示词、分批、权限门控、降级），
 * 实际发请求委托给 `src/ai/runtime.js`，后者走 `@earendil-works/pi-ai`。
 *
 * 刻意**没有**搬走的东西（它们是这个项目最贵的那部分资产，且都是 Chrome 特有的）：
 *   · 30s 超时 —— 挂住的连接曾让整个面板永久停在「LLM 兜底分类中…」，
 *     计划表算不出来 → 「执行整理」按钮一直是禁用的 → 用户点它等于点空气；
 *   · 重试与退避、400 时降级 JSON 模式；
 *   · `describeHttpError` 里逐个对着真实报错写的排障文案；
 *   · 按需 host 权限门控；
 *   · 注入的 key 不落盘。
 *
 * 供应商与模型目录现在由 `src/ai/provider-registry.js` 统一提供，
 * `MODEL_PRESETS` 由它派生，不再维护第二份手写列表。
 * 下面对外导出的每一个名字与语义都保持不变 —— 现有 154 项单测一行未改即证明。
 */

import {
  MODEL_PRESETS, DEFAULT_BASE_URL, DEFAULT_MODEL, originPatternOf,
  providerForBaseUrl, resolveTarget,
} from '../ai/provider-registry.js';
import {
  describeHttpError, describeTransportError, isJsonModeRejection, isRetryableStatus,
} from '../ai/errors.js';

export {
  MODEL_PRESETS, DEFAULT_BASE_URL, DEFAULT_MODEL,
  originPatternOf, providerForBaseUrl, resolveTarget,
  describeHttpError, describeTransportError, isJsonModeRejection, isRetryableStatus,
};

/** 单次请求最多带多少条 */
const BATCH_SIZE = 20;

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
 * 2026-10-06：实现搬到 `src/ai/provider-registry.js`，本文件顶部已 re-export。
 * 搬走是因为 `runtime.js` 也要用它算权限模式，而 runtime 要被本文件调用。
 */

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
 * ⚠️ `strict` 是「一键重试未归类」用的模式（D12）：
 *    把第 2 条从「不确定就返回空数组」翻成「**每一条都必须给出最接近的一个**」。
 *    这是一次真实的权衡 —— 强制必答会让模型宁可猜也不留白，
 *    猜错的分类比「待归类」更难被发现。
 *    所以 strict 的结果在界面上要标成「这是 AI 的猜测」，
 *    并且必须出现在每行的下拉里、可改。**别把 strict 当默认。**
 *
 * @param {Array<{key:string,url:string,title:string}>} items
 * @param {Array} taxonomy
 * @param {{strict?:boolean}} [opts]
 * @returns {{system:string, user:string}}
 */
export function buildPrompt(items, taxonomy, opts = {}) {
  const strict = !!(opts && opts.strict);
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
    strict
      ? '2. **每一条都必须给出一个分类**，即使你觉得很不确定，也要选最接近的那一个。'
        + '返回的条数必须与输入条数一致，不允许省略任何一条。'
      : '2. 绝对不许发明新分类。若没有任何一个合适，就返回空数组——宁可放进待归类也不要瞎猜。',
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
 *
 * 2026-10-06：实现搬到 `src/ai/errors.js`，因为 `runtime.js` 也要用它，
 * 而 runtime 要被本文件调用 —— 不搬就是循环依赖。文案逐字未改，
 * 本文件顶部已 re-export，外部调用方（`ui/options.js`）无需改。
 */

/**
 * 单次请求的超时。
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
 *
 * 2026-10-06：常量本身搬到 `src/ai/runtime.js`（要经由库的 options.signal 生效），
 * **本文件不再声明第二份**。曾经在这里留过一个副本，理由是「方便看」——
 * 结果证伪闸门直接把它判成摆设：runtime.js 把超时改成 0，这条断言照样绿。
 * 「同一个值在两处各存一份」等于给退化留了一条绕路。
 */

/**
 * 发一次请求（带重试与指数退避）。
 *
 * `useJsonMode`：并非所有模型都支持 JSON 模式。先按支持的方式发，
 * 若 400 明确指向 response_format，去掉它重试一次 ——
 * 提示词里已经要求只输出 JSON，解析侧也剥代码块，退一步不影响可用性。
 *
 * 2026-10-06：本函数改为委托 `runtime.completeWithRetry()`。
 * 它之所以还能保持行为不变，是因为超时、重试次数、退避基数、
 * 「4xx 不重试 / 429 才重试」、「400 降级 JSON 模式不计入重试次数」
 * 这几条规则都原样搬了过去，并由 `src/ai/runtime.js` 顶部的常量表钉住。
 * 唯一一处**有意的放宽**：拿不到响应体时（库会把错误压成扁平的
 * "Connection error."），改为「凡是 400 且开着 JSON 模式就先降级重试一次」，
 * 而不是只对响应体里出现 response_format 的 400 才降级 ——
 * 宁可多试一次，不要在不支持 JSON 模式的模型上直接失败。
 *
 * @returns {Promise<{items:Array, usage:object|null}>}
 */
async function callOnce({ system, user, settings }) {
  const isReasoner = /reasoner|thinking/i.test(String(settings.model || ''));
  // runtime.js 是动态 import 的：单测里没有任何一次真实请求，
  // 于是这 386KB 的 vendor 产物在 Node 下永远不会被加载。
  const { completeWithRetry } = await import('../ai/runtime.js');
  const { text, usage } = await completeWithRetry({
    baseUrl: settings.baseUrl,
    model: settings.model,
    systemPrompt: system,
    user,
    apiKey: settings.apiKey,
    useJsonMode: !isReasoner,
  });
  const arr = parseJsonArray(text);
  if (!arr) {
    throw new Error('模型没有返回可解析的 JSON 数组：' + String(text).slice(0, 200));
  }
  return { items: arr, usage: usage || null };
}

/**
 * 对一批条目做 LLM 分类。
 *
 * ⚠️⚠️ 返回值里 `undecided` 与 `errors` 是**两件完全不同的事**，不能合并：
 *    · undecided —— 请求成功，模型**亲口说不知道**（没给这条结果）。
 *      这是「AI 的判断」，可以换个提示词再问一次。
 *    · errors    —— 请求压根没成（超时 / 401 / JSON 解析不了）。
 *      这是「网络或配置问题」，重发同一份请求多半还是同样的结果。
 *    早先这两者混在 errors[] 里变成一句话，界面上分不出
 *    「模型不愿答」与「模型没答上来」，于是「AI 过滤」这件事无从查证。
 *
 * @param {Array<{key:string,url:string,title:string}>} items
 * @param {{taxonomy:Array, settings:object, onProgress?:Function, strict?:boolean}} opts
 * @returns {Promise<{assignments:Record<string,string>, errors:string[],
 *                    undecided:string[], malformed:number, asked:number, batches:number,
 *                    usage:object[], skipped?:string}>}
 */
export async function classifyBatch(items, opts) {
  const { taxonomy, onProgress, strict } = opts || {};
  const cfg = await resolveConfig(opts?.settings);
  const out = {
    assignments: {}, errors: [], undecided: [], malformed: 0,
    asked: 0, batches: 0, usage: [],
  };

  if (!cfg.llmEnabled) {
    // ⚠️ 早先这里是静默 return，一句话都不留。后果：「AI 没参与」和
    //    「AI 说不知道」在界面上长得一模一样，用户无从分辨。
    out.skipped = 'llm-disabled';
    out.errors.push('LLM 兜底已关闭：这些条目只能靠规则分类，没归类的会留在「其他/待归类」。');
    return out;
  }
  if (!cfg.apiKey) {
    // ⚠️ 措辞要能区分两种完全不同的情况：
    //    「压根没注入」和「注入了但没读到」。
    //    早先这里只说「没有 API key」，而动态 import 路径写错一级导致
    //    「注入了却读不到」也报同一句 —— 用户按提示去检查环境变量，
    //    一切正常，于是判定扩展在骗人。真正的信息在 loadedFrom/tried 里。
    out.skipped = 'no-api-key';
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
    out.skipped = 'no-permission';
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

    const { system, user } = buildPrompt(batch, taxonomy, { strict });
    const answered = new Set();
    try {
      const { items: arr, usage } = await callOnce({ system, user, settings: cfg });
      if (usage) out.usage.push(usage);
      for (const row of arr) {
        const key = row && row.key ? String(row.key) : null;
        const to = row && row.to ? String(row.to) : null;
        // ⚠️ 早先这里是 `if (key && to)` 静默忽略，缺 key 或缺 to 的元素
        //    一个字都不留。症状与「模型没返回这条」完全一样，
        //    而两者要开的药方不同（前者是模型输出格式坏了）。
        if (key && to) {
          out.assignments[key] = to;
          answered.add(key);
        } else {
          out.malformed += 1;
        }
      }
    } catch (e) {
      out.errors.push(`第 ${out.batches} 批（${i + 1}-${i + batch.length} 条）失败：${e.message}`);
    }

    // 请求成功但模型没提到的那些 = 「它说不知道」。失败批不记进来：
    // 那是「没问成」，重发同一份请求未必有用，要靠 errors 单独说清。
    if (out.errors.length === 0 || !out.errors.some((m) => m.startsWith(`第 ${out.batches} 批`))) {
      for (const it of batch) {
        const k = it && it.key ? String(it.key) : null;
        if (k && !answered.has(k)) out.undecided.push(k);
      }
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
