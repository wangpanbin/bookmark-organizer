/**
 * 模型供应商注册表 —— 纯数据 + 纯函数。
 *
 * ⚠️ 纯函数模块：不得 import 任何 chrome API，**也不得 import vendor 产物**
 *    （`src/vendor/pi-ai.js`）。本文件被单元测试直接加载，
 *    一旦拖进 386KB 的 bundle，测试就变成在测打包产物而不是测逻辑。
 *
 * ═══ 每个字段的来源都是实测，不是记忆 ═══
 * `baseUrl` / `api` / 模型名取自 node_modules 里各 provider 工厂的实际返回值：
 *   deepseek      baseUrl=https://api.deepseek.com      api=openai-completions  3 个模型
 *   dashscope     库里**没有**，用 createProvider + openai-completions 自建
 *   moonshotai-cn baseUrl=https://api.moonshot.cn/v1    api=openai-completions  2 个模型
 *   openai        baseUrl=https://api.openai.com/v1     api=openai-responses    1 个模型
 *   minimax-cn    baseUrl=https://api.minimaxi.com/anthropic  api=anthropic-messages  3 个模型
 *
 * ⚠️ 三个反直觉的事实，写错了会静默走到错误的 API 上：
 *   ① `openaiProvider()` 是 `openai-responses`，**不是** openai-completions；
 *   ② `minimaxCnProvider()` 是 `anthropic-messages`，**不是** openai-completions。
 *      「国产厂商都是 OpenAI 兼容」在这里不成立，所以它当年才被划在 T2。
 *   ③ minimax 的 baseUrl **带 `/anthropic` 后缀**，不是常见的 `/v1`。
 *      写成 `https://api.minimaxi.com/v1` 会 404，而错误文案会指向「模型名不对」——
 *      方向完全带偏。
 */

/**
 * 供应商目录。
 *
 * `factory` 是 vendor-entry.js 里导出的工厂函数名（`runtime.js` 用它注册）。
 * `factory: null` 表示走 `createProvider()` 自建 —— 目前只有百炼。
 *
 * `models` 是**给面板下拉用的策展目录**，不是白名单：
 * 面板依然允许自由填写任何模型名（见 `synthesizeModel`），
 * 因为 DeepSeek 这类厂商的模型名变动频繁，卡死目录等于制造「配了却不生效」。
 */
export const PROVIDERS = Object.freeze([
  Object.freeze({
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    api: 'openai-completions',
    factory: 'deepseekProvider',
    envVar: 'DEEPSEEK_API_KEY',
    models: Object.freeze([
      Object.freeze({ id: 'deepseek-flash', name: 'deepseek-flash（非思考模式）' }),
      Object.freeze({ id: 'deepseek-v4-pro', name: 'deepseek-v4-pro（更强，较慢较贵）' }),
      // ⚠️ 不在 pi-ai 自带目录里（那边只有 flash 与 v4-pro），但**一直可用**：
      //    runtime.js 的 synthesizeModel 会照着真实 Model 形状造一个交给 complete()。
      //    改造前它就在 MODEL_PRESETS 里，删掉是一次真实的用户可见回退。
      Object.freeze({ id: 'deepseek-v4-flash', name: 'deepseek-v4-flash（旧名，仍可调用）' }),
    ]),
  }),
  Object.freeze({
    id: 'dashscope',
    label: '阿里云百炼',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    api: 'openai-completions',
    // 库里没有 DashScope —— 这是官方给「任意 OpenAI 兼容服务」留的接线口子
    factory: null,
    envVar: 'DASHSCOPE_API_KEY',
    /** 百炼 key 与区域强绑定，跨区调返回 401 且看起来像 key 无效。错误文案必须带上这句。 */
    regionBound: true,
    models: Object.freeze([
      Object.freeze({ id: 'qwen-plus', name: 'qwen-plus' }),
      Object.freeze({ id: 'qwen-turbo', name: 'qwen-turbo（更便宜）' }),
    ]),
  }),
  Object.freeze({
    id: 'moonshotai-cn',
    label: 'Moonshot Kimi（国内）',
    baseUrl: 'https://api.moonshot.cn/v1',
    api: 'openai-completions',
    factory: 'moonshotaiCnProvider',
    envVar: 'MOONSHOT_API_KEY',
    models: Object.freeze([
      Object.freeze({ id: 'kimi-k2.6', name: 'kimi-k2.6' }),
      Object.freeze({ id: 'kimi-k3', name: 'kimi-k3' }),
    ]),
  }),
  Object.freeze({
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    api: 'openai-responses',
    factory: 'openaiProvider',
    envVar: 'OPENAI_API_KEY',
    models: Object.freeze([
      Object.freeze({ id: 'gpt-4o-mini', name: 'gpt-4o-mini' }),
    ]),
  }),
  /**
   * MiniMax 国内站。2026-10-06 接入，是第一家 T2（依赖 @anthropic-ai/sdk）。
   *
   * ⚠️ 三处与前四家都不同，接线时别照抄：
   *   ① 协议是 `anthropic-messages`，不是 OpenAI 兼容；
   *   ② baseUrl 带 `/anthropic` 后缀（`/anthropic` 才是它的 Anthropic 兼容端点，
   *      `/v1` 是另一套 OpenAI 兼容端点，本扩展**没有**接）；
   *   ③ 它不支持 `response_format`，所以 JSON 模式对它自动关闭（见 `resolveJsonMode`）。
   *
   * 体积代价：vendor 产物从 386KB 涨到 601KB（+215KB 全部是 @anthropic-ai/sdk）。
   * 上限由 `tests/unit/vendor-path.test.js` 的体积闸门盯着。
   */
  Object.freeze({
    id: 'minimax-cn',
    label: 'MiniMax（国内）',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    api: 'anthropic-messages',
    factory: 'minimaxCnProvider',
    envVar: 'MINIMAX_CN_API_KEY',
    models: Object.freeze([
      Object.freeze({ id: 'MiniMax-M3', name: 'MiniMax-M3（1M 上下文，支持图文）' }),
      Object.freeze({ id: 'MiniMax-M2.7', name: 'MiniMax-M2.7' }),
      Object.freeze({ id: 'MiniMax-M2.7-highspeed', name: 'MiniMax-M2.7-highspeed（更贵更快）' }),
    ]),
  }),
]);

/** 默认供应商与默认模型。defaultProviderId 必须能在 PROVIDERS 里找到。 */
export const DEFAULT_PROVIDER_ID = 'deepseek';
export const DEFAULT_MODEL = 'deepseek-flash';
export const DEFAULT_BASE_URL = 'https://api.deepseek.com';

/** @param {string} id */
export function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}

/**
 * 哪些协议认 OpenAI 那个 `response_format: {type:'json_object'}`。
 *
 * ⚠️ 这不是「哪些模型支持 JSON 输出」的同义词，是「请求体里放得下这个字段」的同义词。
 *    `anthropic-messages`（MiniMax 走的就是它）没有这个参数：Anthropic 的 JSON 输出
 *    靠 tool-use 或纯靠 prompt 约束，请求体里塞 `response_format` 会被 400 拒掉。
 */
const JSON_MODE_APIS = Object.freeze(['openai-completions', 'openai-responses']);

/** 某协议能不能吃 `response_format`。 */
export function supportsJsonMode(api) {
  return JSON_MODE_APIS.includes(String(api || ''));
}

/**
 * 这一次调用到底要不要开 JSON 模式。
 *
 * ⚠️ 为什么要有这个函数，而不是在 `onPayload` 里判断：
 *    判错的后果不是「没优化」，而是**每一次调用都先吃一个 400**。
 *    恢复路径是有的（`isJsonModeRejection` 会嗅到 `response_format` 字样并重试），
 *    但那意味着每个用户每批书签都白跑一轮，而 400 还会被算进错误统计。
 *    「能降级」不等于「应该先降级再试」。
 *
 * @param {{requested?:boolean, api?:string}} input
 * @returns {boolean}
 */
export function resolveJsonMode(input) {
  const requested = !(input && input.requested === false);
  return requested && supportsJsonMode(input && input.api);
}

/** @returns {string[]} */
export function providerIds() {
  return PROVIDERS.map((p) => p.id);
}

/**
 * 某供应商的策展模型目录。
 * @param {string} id
 * @returns {ReadonlyArray<{id:string,name:string}>}
 */
export function modelsOf(id) {
  const p = getProvider(id);
  return p ? p.models : [];
}

/**
 * 从 base URL 推出 host_permissions 模式串。
 * 非法 URL 返回**空串**而不是抛异常 —— 面板里 base URL 是用户手填的，
 * 畸形值在书签场景下是常态，抛异常会让整个设置面板打不开。
 *
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

/**
 * 归一化 base URL，让「同一个端点的不同写法」能对上。
 * 去掉末尾斜杠 —— `https://api.deepseek.com` 与 `https://api.deepseek.com/`
 * 是同一个端点，认不出同一个会让用户在面板里反复以为自己没配对。
 * @param {string} baseUrl
 * @returns {string}
 */
export function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

/**
 * 反查：面板里存的 base URL 属于哪个已登记供应商。
 *
 * 为什么必须有这个反查：设置项里存的是**语义值**（baseUrl + model），
 * 不是 providerId —— 早先把 `targetRoot` 写死成根 id 已经酿过一次事故
 * （storage.js:205-209 记着 Chrome 154 下 45 条书签全军覆没）。
 * 同理，绝不能因为将来新增了一个供应商，就把用户手填的 baseUrl 判成不认识。
 *
 * @param {string} baseUrl
 * @returns {object|null} 命中返回 provider，否则 null（表示「自定义端点」）
 */
export function providerForBaseUrl(baseUrl) {
  const target = normalizeBaseUrl(baseUrl);
  if (!target) return null;
  return PROVIDERS.find((p) => normalizeBaseUrl(p.baseUrl) === target) || null;
}

/**
 * 把「设置项里的 baseUrl + model」解析成一次调用的目标。
 *
 * 行为零变化的关键：**认不出的 baseUrl 不报错**。
 * 改造前用户可以填任意 OpenAI 兼容端点，那是既有能力，不能因为重构就砍掉。
 *
 * @param {{baseUrl?:string, model?:string}} settings
 * @returns {{providerId:string|null, baseUrl:string, model:string, api:string, regionBound:boolean, isCustom:boolean}}
 */
export function resolveTarget(settings) {
  const baseUrl = normalizeBaseUrl(settings?.baseUrl) || DEFAULT_BASE_URL;
  const model = String(settings?.model || '').trim() || DEFAULT_MODEL;
  const known = providerForBaseUrl(baseUrl);
  return {
    providerId: known ? known.id : null,
    baseUrl,
    model,
    // 认不出的端点一律按 openai-completions 处理：这是 DeepSeek/百炼/Moonshot
    // 共用的协议，也是 OpenAI 兼容生态的事实标准。
    api: known ? known.api : 'openai-completions',
    regionBound: known ? known.regionBound === true : false,
    isCustom: !known,
  };
}

/**
 * 面板「模型预设」下拉的数据源。
 *
 * ⚠️ 由注册表派生，不再维护第二份手写列表 ——
 *    两份列表必然漂移，而漂移的表现是「面板里选得到、实际调不通」。
 *    老的 `deepseek-v4-flash` 仍然保留：它不在 pi-ai 的目录里，
 *    但**一直可用**（`synthesizeModel` 会兜住），删掉它是一次真实的用户可见回退。
 *
 * @returns {ReadonlyArray<{label:string, baseUrl:string, model:string, providerId:string}>}
 */
export const MODEL_PRESETS = Object.freeze(
  PROVIDERS.flatMap((p) =>
    p.models.map((m) =>
      Object.freeze({
        label: `${p.label} · ${m.name}`,
        baseUrl: p.baseUrl,
        model: m.id,
        providerId: p.id,
      }),
    ),
  ),
);
