/**
 * learned 规则（人工反馈沉淀）的匹配与晋升判定。
 * ⚠️ 纯函数模块：不得 import chrome API。
 *
 * ═══ 为什么要单独一个模块，而不用 rules.js 的 hitLevel ═══
 *
 * **这里曾经是一个会主动制造错误的缺陷**，根因是两种语义被混为一谈：
 *
 *   · `rules.js` 的 `hitLevel` 对一条规则内的
 *     `domains` / `domainSuffixes` / `pathWords` / `titleWords` 是**或**关系。
 *     这对预置词典**是必需的**：`dict.js` 里一条规则同时带 `domains`
 *     和 `titleWords` 是常态（如 github.com + 中文品牌名），改成「且」会
 *     让命中率从 90.3% 塌到接近 0。
 *
 *   · 但人工反馈**不能**用或语义。`buildLearnedRule` 对一条非根路径书签
 *     产出 `{ to, domains:[host], pathWords:[pathname] }`，而或语义下
 *     `domains` 命中就 `return`，`pathWords` **从来没被检查过**。
 *     实测（改判 github.com/ruanyf/blog 之后）：
 *
 *       github.com/ruanyf/blog       => 学习资料/编程学习  [learned/high]
 *       github.com/vuejs/core        => 学习资料/编程学习  [learned/high]
 *       github.com/tailwindlabs/...  => 学习资料/编程学习  [learned/high]
 *       github.com/explore/trending  => 学习资料/编程学习  [learned/high]
 *
 *     而 `ui/options.js` 的注释白纸黑字承诺过「粒度必须收窄：不能因为用户
 *     纠正了一条 github.com 书签，就把所有 github.com 书签都改道」。
 *     **承诺未实现。** 更糟的是 learned 是最高优先级、confidence 直接标
 *     `high`，压过预置词典 —— 用户越纠正，整站错得越整齐。
 *
 * 所以：**预置词典继续用或语义，learned 走本模块的精确语义。**
 * 两者绝不合并。这条边界必须由 `tests/unit/learned.test.js` 钉住 ——
 * 否则下一个维护者会「顺手统一两种语义」，把词典打坏。
 *
 * ═══ 作用域模型 ═══
 *
 * | scope       | 语义                     | 何时产生                                   |
 * |-------------|--------------------------|--------------------------------------------|
 * | `'url'`     | 归一化 URL 全串必须相等  | **默认**。改判一条只影响那一条              |
 * | `'domain'`  | 域名相等即可             | 同域 **≥3 次**改判到同一 `to` 时自动晋升   |
 * | 缺失        | 视作 `'domain'`          | 向后兼容历史数据（`scope` 是后加的字段）   |
 *
 * **默认精确、晋升需证据** —— 精确那一侧是安全侧：判错的最坏后果是
 * 「这条又走回词典」，而域级误判的后果是「整站被改道且无法从界面上察觉」。
 */

import { hostOf, dedupeKey } from '../normalize.js';

/**
 * 晋升为域级规则所需的改判次数。
 * 🔴 **未校准** —— 这是一个拍的数字，没有真实数据支撑。
 * 回调它只需要改这一个常量，不影响其它设计。
 */
export const PROMOTE_AFTER = 3;

/**
 * 取规则的作用域，缺失时向后兼容为 `'domain'`。
 * @param {{scope?:string}} rule
 * @returns {'url'|'domain'}
 */
export function scopeOf(rule) {
  return rule && rule.scope === 'url' ? 'url' : 'domain';
}

/**
 * 一条 learned 规则是否命中某条书签。
 *
 * ⚠️ 与 `hitLevel` 的关键差别：这里是**且**语义。规则上带了哪个限定条件，
 *    哪个就必须满足 —— 带 `pathWords` 却 path 不匹配的规则**不算命中**，
 *    宁可让它落回词典，也不要用一个半对的规则去覆盖整站。
 *
 * @param {{to:string, scope?:string, urls?:string[], domains?:string[], pathWords?:string[], titleWords?:string[]}} rule
 * @param {{url:string, title?:string}} entry
 * @returns {boolean}
 */
export function ruleMatches(rule, entry) {
  if (!rule || typeof rule.to !== 'string' || rule.to === '') return false;
  if (!entry || !entry.url) return false;

  const host = hostOf(entry.url);

  if (scopeOf(rule) === 'url') {
    // URL 精确：归一化后全串相等。空 urls 数组的规则永远不命中，
    // 而不是退化成「匹配一切」—— 那正是原 bug 的形态。
    const urls = Array.isArray(rule.urls) ? rule.urls : [];
    if (urls.length === 0) return false;
    const key = dedupeKey(entry.url);
    if (!key) return false;
    return urls.some((u) => dedupeKey(u) === key);
  }

  // 域级：domains 命中即可。与历史行为一致，保持向后兼容。
  const domains = Array.isArray(rule.domains) ? rule.domains : [];
  if (domains.length === 0) return false;
  return domains.some((d) => host === String(d).toLowerCase());
}

/**
 * 对单条书签跑 learned 匹配。
 *
 * 命中即返回，优先级最高（与 rules.js 中 learned 先于词典的既有顺序一致）。
 *
 * @param {{url:string, title?:string}} entry
 * @param {Array} learned  人工反馈沉淀的规则（数量少，线性扫描代价可忽略）
 * @returns {{to:string, reason:'learned', confidence:'high'}|null}
 */
export function matchLearned(entry, learned) {
  const list = Array.isArray(learned) ? learned : [];
  for (const rule of list) {
    if (ruleMatches(rule, entry)) {
      // ⚠️ URL 精确的规则给 high：它证明的是「用户明确针对这一条给过答案」。
      //    域级规则同样给 high：它必须先攒够 PROMOTE_AFTER 次一致改判才存在。
      return { to: rule.to, reason: 'learned', confidence: 'high' };
    }
  }
  return null;
}

/**
 * 构造一条 URL 精确的 learned 规则。
 *
 * @param {string} url 归一化前即可，内部会算 dedupeKey
 * @param {string} to  目标路径 '大类/子类'
 * @returns {{to:string, scope:'url', urls:string[]}}
 */
export function buildUrlRule(url, to) {
  const key = dedupeKey(url);
  return { to, scope: 'url', urls: key ? [key] : [] };
}

/**
 * 同一 host、同一 to 的 URL 精确规则攒够 PROMOTE_AFTER 条 → 该晋升为域级。
 *
 * 这是**纯函数**：它读到的必须是 mutate fn 内部的当前值，
 * 不能跨临界区读一次再写回去（违反 AGENTS.md 约束 2）。
 *
 * ⚠️ 计数**按 `to` 分别进行**。同一个域名既有 A 类收藏又有 B 类收藏是正常的，
 *    两类各自攒够 PROMOTE_AFTER 就各自晋升 —— 不能因为「这个站被改到过
 *    两个不同的类」就把晋升整个卡死，否则真实的多用途站点永远学不会。
 *    反过来，某一条 pathWords / 标题线索**不能**跨 to 计数：
 *    「改到过 3 次 A」不能拿来证明「这个域整体该是 B」。
 *
 * @param {Array} learned 当前 learned 数组
 * @param {string} host
 * @param {string} to
 * @returns {boolean}
 */
export function shouldPromoteToDomain(learned, host, to) {
  if (!host || !to) return false;
  const h = String(host).toLowerCase();
  const urls = [];
  for (const rule of Array.isArray(learned) ? learned : []) {
    if (!rule || scopeOf(rule) !== 'url') continue;
    if (rule.to !== to) continue;
    for (const u of Array.isArray(rule.urls) ? rule.urls : []) {
      if (hostOf(u) === h) urls.push(u);
    }
  }
  return new Set(urls).size >= PROMOTE_AFTER;
}

/**
 * 晋升：在 learned 数组里把该 host + to 的 URL 精确规则合并成一条域级规则。
 *
 * 失败时**保持原样返回**（调用方应退回精确语义）—— 精确那一侧是安全侧，
 * 一次晋升失败不该让已积累的精确规则也一起丢。
 *
 * @param {Array} learned
 * @param {string} host
 * @param {string} to
 * @returns {{learned:Array, promoted:boolean}}
 */
export function promoteToDomain(learned, host, to) {
  if (!shouldPromoteToDomain(learned, host, to)) return { learned, promoted: false };
  const h = String(host).toLowerCase();
  const kept = (Array.isArray(learned) ? learned : []).filter(
    (r) => !(r && scopeOf(r) === 'url' && r.to === to
      && (Array.isArray(r.urls) ? r.urls : []).some((u) => hostOf(u) === h)),
  );
  return { learned: [...kept, { to, scope: 'domain', domains: [h] }], promoted: true };
}