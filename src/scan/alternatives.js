/**
 * 死链的替代方案：Wayback 存档快照 + AI 候选新地址。
 *
 * ⚠️ 这个模块会 fetch 出网，属于写操作模块。
 *
 * ═══ 核心设计：把「猜」变成「有依据的搜索」═══
 *
 * LLM **没有联网能力**，它只能猜。一个猜出来的 URL 直接替换书签，
 * 价值为负、风险为正 —— 写错了没有撤销。
 *
 * 所以 AI 产出的候选**必须逐个过探测器验证**，只展示真的能打开的：
 *   1. 模型给 3~5 个候选
 *   2. 逐个用 probe.js 验证
 *   3. 面板按「已验证 ✓ / 未验证」分组，未验证的默认折叠
 *
 * ⚠️ 「未验证的候选不得出现在可采纳区」是一条要单测钉死的判据。
 *    漏了它，用户点一下就把真收藏的地址换成了一个 404。
 */

import { probeOne } from './probe.js';
import { parseJsonArray as llmParseJsonArray } from '../classify/llm.js';

const WAYBACK_API = 'https://archive.org/wayback/available';
const TIMEOUT_MS = 8000;

/**
 * 查 Wayback 有没有这个 URL 的快照。
 *
 * ⚠️ 主路径与降级路径的**可靠性不同**，所以必须记 `method`：
 *    `api` 是查出来的（有具体时间戳），`magic-url` 是靠
 *    `web.archive.org/web/2/` 那个 302 魔法链接跳过去的。
 *    面板上要能说清「这个地址是怎么来的」—— 混在一起展示就是骗人。
 *
 * @param {string} url
 * @param {{timeoutMs?:number}} [opts]
 * @returns {Promise<{url:string, ts:string, method:'api'|'magic-url'}|null>}
 */
export async function findSnapshot(url, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : TIMEOUT_MS;

  // ① 主路径：availability API，能拿到确切时间戳
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeoutMs);
    const res = await fetch(`${WAYBACK_API}?url=${encodeURIComponent(url)}`, { signal: c.signal });
    clearTimeout(t);
    if (res.ok) {
      const data = await res.json();
      const snap = data && data.archived_snapshots && data.archived_snapshots.closest;
      if (snap && snap.available && snap.timestamp && snap.url) {
        return { url: snap.url, ts: String(snap.timestamp), method: 'api' };
      }
      // API 明确回答了「没有存档」。这不是失败，是一个答案。
      return null;
    }
  } catch {
    // 落到降级路径。**不静默** —— method 会如实记成 magic-url
  }

  // ② 降级路径：web.archive.org/web/2/<url> 会 302 到最近快照，不依赖 JSON API
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeoutMs);
    const res = await fetch(`https://web.archive.org/web/2/${url}`, { method: 'GET', redirect: 'follow', signal: c.signal });
    clearTimeout(t);
    // 302 到了 web.archive.org 上 = 有快照
    if (res.ok && String(res.url || '').includes('web.archive.org')) {
      return { url: res.url, ts: '', method: 'magic-url' };
    }
  } catch {
    // 两条路都失败
  }
  return null;
}

/**
 * 让模型给候选新地址。
 *
 * ⚠️ 走 `src/ai/runtime.js`：超时、重试、错误诊断、按需权限门控都在那儿，
 *    **不要**在这里重写一遍。旧的 LLM 分类已经把 key/权限那套踩出坑了。
 *
 * @param {{title?:string, url:string, note?:string}} item
 * @param {{settings?:object, enabled?:boolean}} [opts]
 * @returns {Promise<{ok:boolean, candidates:string[], reason?:string}>}
 */
export async function proposeCandidates(item, opts = {}) {
  if (opts.enabled === false) {
    return { ok: false, candidates: [], reason: 'AI 找新地址未启用' };
  }
  let runtime;
  try {
    runtime = await import('../ai/runtime.js');
  } catch (e) {
    return { ok: false, candidates: [], reason: `模型运行库加载失败：${e && e.message}` };
  }

  const target = {
    providerId: null,
    baseUrl: (opts.settings && opts.settings.baseUrl) || 'https://api.deepseek.com',
    model: (opts.settings && opts.settings.model) || 'deepseek-flash',
  };

  const system = [
    '你是链接修复助手。给定一条已经失效的书签，猜它可能搬到哪儿去了。',
    '',
    '硬性要求：',
    '1. **你没有联网能力**，你只是在猜。给出 3~5 个最可能的候选。',
    '2. 只输出 JSON 数组，每个元素就是一个候选 URL 字符串，不要任何解释。',
    '3. 保持原来的路径风格与域名习惯；站内改路径优先于换域名。',
    '4. 实在猜不出来就返回空数组，不要编造。',
  ].join('\n');

  const user = [
    `原始 URL: ${item.url}`,
    `书签标题: ${item.title || '(无标题)'}`,
    item.note ? `补充线索: ${item.note}` : '',
  ].filter(Boolean).join('\n');

  try {
    const { text } = await runtime.completeWithRetry({
      baseUrl: target.baseUrl,
      model: target.model,
      systemPrompt: system,
      user,
      apiKey: opts.settings && opts.settings.apiKey,
      useJsonMode: true,
    });
    const arr = parseJsonArray(text);
    const candidates = normalizeCandidates(arr);
    if (!candidates.length) {
      return { ok: true, candidates: [], reason: '模型没有给出可用的候选' };
    }
    return { ok: true, candidates };
  } catch (e) {
    return { ok: false, candidates: [], reason: e && e.message ? e.message : String(e) };
  }
}

/**
 * 从模型回复里抠出 JSON 数组。
 *
 * ⚠️ 刻意**从 `classify/llm.js` 复用**而不是再抄一份。
 *    早先这里有一份本地拷贝，注释还写着「只有这一处会解析模型输出」——
 *    而 `classify/llm.js:174` 明明就有一份。那句注释是假的。
 *    模型输出的解析规则（剥 ```json 围栏、从噪声里找第一个 [ 到最后一个 ]）
 *    有 4 条边界，两份实现迟早会漂移，而漂移的表现是
 *    「分类能解析、找新地址解析不了」，且极难定位。
 *
 *    `alternatives.js` 本身也是写操作模块，import 一个写操作模块不违反零写入闸门。
 */
function parseJsonArray(text) {
  return llmParseJsonArray(text);
}

/** 把模型返回的数组洗成 URL 列表，滤掉明显不是 URL 的东西 */
function normalizeCandidates(arr) {
  const out = new Set();
  for (const x of Array.isArray(arr) ? arr : []) {
    const s = (typeof x === 'string' ? x : (x && x.url)) || '';
    const v = String(s).trim();
    if (!v) continue;
    try {
      const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      out.add(u.toString());
    } catch {
      // 不是 URL，跳过。宁可少一个候选，也不要把垃圾喂给探测器
    }
  }
  return [...out].slice(0, 5);
}

/**
 * 验证候选。
 *
 * ⚠️ 这一步是整个功能的安全闸门：没验证过的候选**不能**出现在可采纳区。
 *
 * @param {string[]} candidates
 * @param {{timeoutMs?:number}} [opts]
 * @returns {Promise<Array<{url:string, verified:boolean, status:number, finalUrl:string}>>}
 */
export async function verifyCandidates(candidates, opts = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const out = [];
  for (const url of list) {
    const r = await probeOne(url, { timeoutMs: opts.timeoutMs });
    const ok = !r.error && r.status >= 200 && r.status < 400;
    out.push({
      url,
      verified: ok,
      status: r.status,
      finalUrl: r.finalUrl,
      // 验证失败的原因要带出来：用户看到「未验证」会问为什么
      note: r.error || (ok ? '' : `HTTP ${r.status}`),
    });
  }
  return out;
}

/**
 * 给一条死链接找替代方案。快照与 AI 候选**并行**取，任一失败不影响另一个。
 *
 * @param {{title?:string, url:string}} item
 * @param {{aiEnabled?:boolean, settings?:object}} [opts]
 */
export async function findAlternatives(item, opts = {}) {
  const [snapshot, ai] = await Promise.all([
    findSnapshot(item.url, opts).catch(() => null),
    proposeCandidates(item, { enabled: opts.aiEnabled, settings: opts.settings }).catch(() => ({ ok: false, candidates: [], reason: 'AI 候选生成失败' })),
  ]);

  const candidates = await verifyCandidates(ai.candidates || [], opts).catch(() => []);

  return {
    url: item.url,
    snapshot,
    candidates,
    // 分组是给面板用的：可采纳区只放 verified 的
    adoptable: candidates.filter((c) => c.verified),
    unverified: candidates.filter((c) => !c.verified),
    aiReason: ai.reason || '',
  };
}
