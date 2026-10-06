/**
 * 百炼 embedding 客户端。
 *
 * ⚠️ 这个模块会 fetch 出网，属于写操作模块。
 *
 * ═══ 为什么不用 pi-ai ═══
 * `@earendil-works/pi-ai` 的模型类型只有 chat / image / classifier ——
 * **没有 embedding**。所以 F2 这一块无论如何都得自己写客户端。
 * 但鉴权、超时、错误诊断、key 来源**复用 `src/ai/` 那一套**，
 * 不重新发明。
 *
 * ═══ 规格（全部取自阿里云官方文档，不是记忆）═══
 *   模型      text-embedding-v4
 *   维度      64–2048 可自定义，默认 1024
 *   **批量    单次最多 10 条** ← 真正的约束，不是价格
 *   单条长度  ≤ 8192 token
 *   价格      ¥0.0005 / 千 token（800 条约几分钱到一毛二）
 *   免费额度  100 万 token，开通后 90 天
 *   限流      RPM 1800 / TPM 1,200,000
 *   端点      POST {baseUrl}/embeddings（OpenAI 兼容）
 */

import { DEFAULT_BASE_URL } from '../ai/provider-registry.js';

/** 单次请求最多 10 条 —— 官方硬限制，超了会 400 */
export const MAX_BATCH = 10;

export const EMBEDDING_MODEL = 'text-embedding-v4';
export const EMBEDDING_DIM = 1024;
const TIMEOUT_MS = 30_000;
const SINK_PORT = 8732;

/** 把 url 列表切成每批 ≤10 条 */
export function chunk(items, size = MAX_BATCH) {
  const list = Array.isArray(items) ? items : [];
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * 调一次 embedding。
 *
 * ⚠️ 用**裸 fetch**而不是经由 runtime.js：runtime 是为 chat 设计的
 *    （走库的 complete()，而库没有 embedding）。这里自己发，
 *    但超时、错误分类、key 来源都照抄 runtime 那一套的纪律。
 *
 * @param {string[]} input
 * @param {{apiKey:string, baseUrl?:string, dimension?:number, signal?:AbortSignal}} opts
 * @returns {Promise<number[][]>}
 */
export async function embedOnce(input, opts = {}) {
  if (!Array.isArray(input) || input.length === 0) return [];
  if (input.length > MAX_BATCH) {
    throw new Error(`单次最多 ${MAX_BATCH} 条，收到 ${input.length} 条 —— 批处理漏了这一步会拿到 400`);
  }
  const base = String(opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await fetch(`${base}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input,
        ...(opts.dimension ? { dimensions: opts.dimension } : {}),
      }),
      signal: opts.signal || controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const msg = e && /abort/i.test(String(e.message || '')) ? `请求超时（${TIMEOUT_MS / 1000}s）` : String(e && e.message ? e.message : e);
    throw new Error(`embedding 请求失败：${msg}。可在「设置」里关掉语义去重，其余去重不受影响。`);
  }
  clearTimeout(timer);

  const text = await res.text();
  if (!res.ok) {
    // 百炼的 key 与区域强绑定，401 看起来和「key 无效」一模一样 ——
    // 那个提示（见 ai/errors.js）必须复用，别自己重写一条
    const { describeHttpError } = await import('../ai/errors.js');
    throw new Error(describeHttpError(res.status, text, { regionBound: true }));
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('embedding 响应不是合法 JSON：' + text.slice(0, 200));
  }
  const rows = data && data.data;
  if (!Array.isArray(rows)) throw new Error('embedding 响应里没有 data 数组');
  // data 里的 index 决定顺序，不能假设它就是请求顺序
  return rows.slice().sort((a, b) => (a.index || 0) - (b.index || 0)).map((r) => r.embedding);
}

/**
 * 批量取向量。**串行**逐批发 —— 800 条 = 80 批，
 * 并发发会撞 RPM 1800 的限流，而限流返回的错误更难读。
 *
 * @param {string[]} texts
 * @param {{apiKey:string, baseUrl?:string, onProgress?:Function}} opts
 * @returns {Promise<number[][]>}
 */
export async function embedAll(texts, opts = {}) {
  const batches = chunk(texts);
  const out = [];
  for (let i = 0; i < batches.length; i++) {
    out.push(...await embedOnce(batches[i], opts));
    opts.onProgress?.({ done: out.length, total: texts.length });
  }
  return out;
}

// ═══════════ 归档侧车（正文摘要从这里来）═══════════

/** 读一条归档正文（F3 侧车）。读不到就返回空串 —— 语义去重降级成纯标题。 */
export async function fetchArchivedText(url, opts = {}) {
  const port = opts.port || SINK_PORT;
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), opts.timeoutMs || 5000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/text?url=${encodeURIComponent(url)}`, { signal: c.signal });
    if (!res.ok) return '';
    const d = await res.json();
    return d && typeof d.text === 'string' ? d.text.slice(0, 4000) : '';
  } catch {
    // 侧车没开不是错误：降级成「只用标题」即可
    return '';
  } finally {
    clearTimeout(t);
  }
}
