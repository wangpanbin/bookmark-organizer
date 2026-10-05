/**
 * 云端 LLM 兜底分类。
 *
 * ═══ 设计边界 ═══
 * 1. **只对规则未命中的条目发请求**，不是把整个书签列表外发。
 *    URL 列表本身就是隐私（内网地址、项目名、私有仓库都在里面），
 *    所以默认只发「其他/待归类」那一小撮。
 * 2. **权限按需申请**：manifest 里只写 optional_host_permissions，
 *    用户点「开启 LLM 兜底」时才弹窗。关闭 LLM 时整个扩展不需要任何 host 权限。
 * 3. **API key 只存 chrome.storage.local**，不进 manifest、不进代码、不进 git。
 *
 * 供应商：阿里云百炼 / 通义千问（OpenAI 兼容协议）。
 * base URL 与 model 都可配置 —— 官方已在推工作区专属域名
 * （https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1），
 * 稳定性比老域名好，UI 里提示可替换。
 */

/** 单次请求最多带多少条 */
const BATCH_SIZE = 20;
/** 最多重试几次（不含首次） */
const MAX_RETRY = 2;

/**
 * 从 base URL 推出 host_permissions 需要的模式串。
 * https://dashscope.aliyuncs.com/compatible-mode/v1 → https://dashscope.aliyuncs.com/*
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

/** 统一错误信息。401 必须区分「key 无效」与「key 与区域不匹配」——两者修法完全不同。 */
function describeHttpError(status, body) {
  const text = String(body || '');
  if (status === 401 || status === 403) {
    if (/InvalidApiKey|invalid_api_key/i.test(text)) {
      return `API key 无效或没有该模型的权限（HTTP ${status}）。请检查 key 是否复制完整、是否已过期。`;
    }
    return (
      `HTTP ${status} 鉴权失败。${text}`
      .trim() +
      '。\n百炼的 key 与区域强绑定：用北京区 key 调美区/国际区端点会返回 401。' +
      '请确认 base URL 的区域与创建 key 的区域一致。'
    );
  }
  if (status === 404) {
    return `HTTP 404：端点或模型名不对。请检查 base URL（应形如 .../compatible-mode/v1）与 model 名。`;
  }
  if (status === 429) return `HTTP 429：触发限流或额度用尽。稍后重试，或降低批次大小。`;
  if (status >= 500) return `HTTP ${status}：服务端错误，稍后重试。`;
  return `HTTP ${status}：${text.slice(0, 300)}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 发一次请求（带重试与指数退避）。
 * @returns {Promise<{items:Array, usage:object|null}>}
 */
async function callOnce({ system, user, settings }) {
  const url = `${String(settings.baseUrl).replace(/\/+$/, '')}/chat/completions`;
  let lastErr = null;

  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    if (attempt > 0) await sleep(600 * 2 ** (attempt - 1));
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify({
          model: settings.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0,
          response_format: { type: 'json_object' },
        }),
      });

      const text = await res.text();
      if (!res.ok) {
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
  const { taxonomy, settings, onProgress } = opts || {};
  const out = { assignments: {}, errors: [], asked: 0, batches: 0, usage: [] };

  if (!settings?.llmEnabled) return out;
  if (!settings?.apiKey) {
    out.errors.push('未填写 API key，LLM 兜底已跳过（未分类条目会留在「其他/待归类」）');
    return out;
  }
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return out;

  const granted = await hasLlmPermission(settings.baseUrl);
  if (!granted) {
    out.errors.push(
      '尚未授予该域名的访问权限。请在「设置 → LLM 兜底」里点「授权访问」后再开启。',
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
      const { items: arr, usage } = await callOnce({ system, user, settings });
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
