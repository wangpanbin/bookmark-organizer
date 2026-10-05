/**
 * 去重检测与保留策略。
 * ⚠️ 纯函数模块：不得 import chrome API。
 *
 * ⚠️ 误删风险是这个模块最大的风险（计划 R6）。两道防线：
 *   1. dedupeKey() 保留 SPA 的 hash 路由，只有「纯顶部锚点」才剥
 *   2. 所有待删条目必须逐条出现在 dry-run 清单里，用户可逐条否决
 * 一旦这里放宽条件，删除动作就不可逆。
 */

import { dedupeKey, isExcludedUrl } from './normalize.js';

/**
 * keeper 排序比较器 —— 决定同一组重复里保留哪一条。
 * 1) 路径更浅者优先：散落的条目正是本次要被移动的，已深度归类的保留
 * 2) 更早收藏者优先：dateAdded 最小（最先收藏通常最重要）
 * 3) id 升序：保证同一输入永远得到同一结果（幂等的前提）
 *
 * @param {{path?: string[], dateAdded?: number, id?: string}} a
 * @param {{path?: string[], dateAdded?: number, id?: string}} b
 * @returns {number}
 */
export function compareKeeper(a, b) {
  const da = Array.isArray(a.path) ? a.path.length : 0;
  const db = Array.isArray(b.path) ? b.path.length : 0;
  if (da !== db) return da - db;

  const ta = Number.isFinite(a.dateAdded) ? a.dateAdded : Number.MAX_SAFE_INTEGER;
  const tb = Number.isFinite(b.dateAdded) ? b.dateAdded : Number.MAX_SAFE_INTEGER;
  if (ta !== tb) return ta - tb;

  return String(a.id || '') < String(b.id || '') ? -1 : 1;
}

/**
 * 找出所有重复组。
 * 只处理 type==='url' 的节点；排除浏览器内部页与本机地址。
 *
 * @param {Array<{id:string, type:string, url?:string, path?:string[], dateAdded?:number}>} entries
 * @returns {Array<{key:string, keeper:object, duplicates:object[]}>}
 */
export function findDuplicates(entries) {
  const groups = new Map();

  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || e.type !== 'url' || typeof e.url !== 'string' || e.url === '') continue;
    if (isExcludedUrl(e.url)) continue;
    const key = dedupeKey(e.url);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  const out = [];
  for (const [key, items] of groups) {
    if (items.length < 2) continue;
    const ordered = [...items].sort(compareKeeper);
    out.push({ key, keeper: ordered[0], duplicates: ordered.slice(1) });
  }
  // 输出顺序按 key 排序，保证幂等可比较
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}

/**
 * 展开成「待删除的重复条目」扁平列表。
 * @param {Array<{keeper:object, duplicates:object[]}>} groups
 */
export function toRemovalList(groups) {
  const out = [];
  for (const g of Array.isArray(groups) ? groups : []) {
    for (const d of g.duplicates || []) out.push({ ...d, keepId: g.keeper?.id ?? null });
  }
  return out;
}

/**
 * 重复统计：给 UI 展示。
 * @param {Array} groups
 * @returns {{groups:number, removable:number, savedBytes:number}}
 */
export function dedupeStats(groups) {
  const list = toRemovalList(groups);
  return {
    groups: Array.isArray(groups) ? groups.length : 0,
    removable: list.length,
    // 粗略估算：每条书签（url+title+路径+元信息）序列化后约 200 字节
    savedBytes: list.length * 200,
  };
}
