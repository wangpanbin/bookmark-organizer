/**
 * 语义去重：embedding 判「不同 URL 但同内容」。
 *
 * ⚠️ 纯函数模块：不得 import chrome API、不得 fetch、不得碰 indexedDB。
 *    API 调用在 `embedding-client.js`（写操作模块），这里只做数学。
 *
 * ═══ 这个功能最大的风险是误判，所以它的处置被拍成最保守的那一档 ═══
 *
 * URL 归一化判重敢自动删，是因为同一组条目 URL 字符串**完全相同**，
 * 判错的可能性极低。而 embedding 判重完全不同：
 *   · 两篇不同的文章语义相近是**常态**，不是异常
 *   · 同一篇文章被多个站点转载非常常见
 *   · 站点不同但内容同构（文库镜像、官方文档与镜像站、GitHub 仓库与其文档站）
 *     是真实且大量的「同内容」
 *
 * 所以 D6 拍板：**结果只进「建议合并」，永不进删除清单。**
 * 现有的逐条否决机制（`K.DEDUPE_VETO`，按条目 id 记录）可以原样复用。
 */

/** 余弦相似度。输入空数组或零向量时返回 0 —— 不抛异常。 */
export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]) || 0;
    const y = Number(b[i]) || 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * 粗筛：先用便宜的特征砍掉绝大多数不可能同内容的对。
 *
 * ⚠️ 这一步存在的理由很实际：800 条两两比较是 32 万对，
 *   虽然算得动，但面板上要显示的就是「候选对」，
 *   粗筛能把候选压到几十对，用户才看得下去。
 *
 * 判据只用**零成本且不会错**的信号：同站 + 标题高度重合。
 * 跨站的内容同构（镜像/转载）在这里**不会被砍掉** ——
 * 粗筛只砍「同站且标题完全不像」的那种。
 *
 * @param {Array<{id:string,url:string,title?:string}>} items
 * @returns {Array<[number,number]>} 候选对的下标
 */
export function candidatePairs(items) {
  const list = Array.isArray(items) ? items : [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if (!a || !b || a.id === b.id) continue;
      // 同站且标题毫无重合 → 不可能是同一内容
      if (hostOf(a.url) === hostOf(b.url) && !titleOverlap(a.title, b.title)) continue;
      out.push([i, j]);
    }
  }
  return out;
}

function hostOf(u) {
  try { return new URL(String(u)).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

/** 标题的词级重合度（中文按 2-gram，英文按空格分词） */
export function titleOverlap(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return false;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit += 1;
  return hit / Math.min(ta.size, tb.size) >= 0.6;
}

function tokens(title) {
  const s = String(title || '').toLowerCase().trim();
  if (!s) return new Set();
  const out = new Set();
  for (const w of s.split(/[^\p{L}\p{N}]+/u)) {
    if (!w) continue;
    if (/[一-龥]/.test(w)) {
      // 中文没有空格，按 2-gram 切
      for (let i = 0; i + 2 <= w.length; i++) out.add(w.slice(i, i + 2));
    } else {
      out.add(w);
    }
  }
  return out;
}

/**
 * 判成「疑似同内容」。
 *
 * ⚠️ 阈值刻意偏高（D6 的保守档）。宁可漏掉真镜像，也不要把两篇
 *   主题相近的不同文章判成重复 —— 那是会让人失去真收藏的那种错。
 *
 * @param {{title?:string, url:string, kind?:string}} item
 * @param {{text?:string}} [ctx] F3 归档出来的正文摘要（有正文时更准）
 */
export function buildEmbeddingText(item, ctx = {}) {
  const parts = [String(item?.title || '').trim()];
  if (item?.url) parts.push(String(item.url));
  const body = String(ctx.text || '').trim().slice(0, 300);
  if (body) parts.push(body);
  return parts.filter(Boolean).join('\n').slice(0, 1200);
}

/**
 * 从候选对里挑出达标的，做成「建议合并」列表。
 *
 * @param {Array} items
 * @param {Map<string, number[]>|Record<string, number[]>} vectors id → 向量
 * @param {{threshold?:number}} [opts]
 * @returns {Array<{a:object,b:object,score:number}>}
 */
export function suggestMerges(items, vectors, opts = {}) {
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : 0.92;
  const vec = (id) => {
    const v = vectors instanceof Map ? vectors.get(id) : (vectors || {})[id];
    return Array.isArray(v) ? v : null;
  };
  const list = Array.isArray(items) ? items : [];
  const out = [];
  for (const [i, j] of candidatePairs(list)) {
    const a = list[i];
    const b = list[j];
    const va = vec(a && a.id);
    const vb = vec(b && b.id);
    if (!va || !vb || va.length !== vb.length) continue; // 没向量就不判，不瞎猜
    const score = cosine(va, vb);
    if (score >= threshold) out.push({ a, b, score });
  }
  out.sort((x, y) => y.score - x.score);
  return out;
}

/**
 * 保留哪一条。
 * ⚠️ 复用 `src/dedupe.js` 的 `compareKeeper` 语义：路径更浅 → 更早收藏 → id。
 *   不重新发明一套 —— 两套规则必然漂移，而漂移的表现是「面板建议保留 A、
 *   实际执行保留了 B」。
 */
export function pickKeeper(a, b) {
  const da = Array.isArray(a?.path) ? a.path.length : 0;
  const db = Array.isArray(b?.path) ? b.path.length : 0;
  if (da !== db) return da <= db ? a : b;
  const ta = Number.isFinite(a?.dateAdded) ? a.dateAdded : Number.MAX_SAFE_INTEGER;
  const tb = Number.isFinite(b?.dateAdded) ? b.dateAdded : Number.MAX_SAFE_INTEGER;
  if (ta !== tb) return ta <= tb ? a : b;
  return String(a?.id || '') <= String(b?.id || '') ? a : b;
}
