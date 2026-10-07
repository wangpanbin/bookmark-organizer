/**
 * 手动指定书签范围（F4）—— 清单纯逻辑。
 *
 * ═══ 这个模块解决什么问题 ═══
 * 整理管线的集合来源历来是「整棵树」：`ui/options.js` 无条件读全树，
 * `targetRoot` 只决定搬到哪、不决定动哪些。用户要的「只整理我圈定的那几条」
 * 因此需要一个**集合**，以及两道保证它不被越界突破的护栏：
 *   ① 生成计划时只喂清单里的条目（本模块）
 *   ② 执行时逐条复核这条在不在清单里（在 apply.js，见那里的范围校验）
 *
 * ⚠️ 本模块是**第四套**「例外」语义，刻意不复用已有的三套：
 *   locks            URL   「永不动」
 *   dedupe:veto      id    「别删」
 *   archive:important URL  「归档时值得多花一份 PDF」
 * 它们的语义域分别是移动 / 删除 / 归档；而本清单的语义是「**这次动这些**」。
 * 复用任何一套都会立刻产生「用户以为锁了、结果只影响归档」这类静默失效
 * （见 archive/important.js 顶部记录的那次真实教训）。
 *
 * ═══ 纯函数约束 ═══
 * 不 import 任何写操作模块，不碰 chrome.* / fetch / indexedDB。
 * 这是它能在 Node 下直接单测的前提，也是 dry-run 零写入纪律的一部分。
 * 同一条纪律由 tests/unit/plan.test.js 的静态断言守着。
 *
 * ⚠️⚠️ 清单里的 **url 只用于失效时给人看，绝不用来认领**。
 *    同一 URL 存过好几条书签是常事（不同文件夹各存一份）。
 *    若 id 失效就按 URL 找一条顶替，被顶替的那条可能正是用户**没选**的那条 ——
 *    这在一个专门为「怕误伤」而做的功能里是最不可接受的失败方式。
 *    认不出来就老实标「已失效」跳过。
 */

import { dedupeKey, isExcludedUrl } from './normalize.js';

/** 清单条目的状态。done 是终态，不再参与对账与重跑 */
export const SCOPE_STATUS = Object.freeze({
  PENDING: 'pending',   // 待整理
  DONE: 'done',         // 已整理
  FAILED: 'failed',     // 整理失败，可重试
  STALE: 'stale',       // 已失效：树上找不到这条书签
});

/** 会被送去分类的状态。done 不在其中 —— 整理过的不重复花 LLM 的钱 */
const RUNNABLE = [SCOPE_STATUS.PENDING, SCOPE_STATUS.FAILED];

/**
 * 本轮允许动的书签 id。
 *
 * ⚠️ 这是**唯一**的一份判据。预览裁子集、执行器拿范围、芯片显示条数
 *    三处都必须走它 —— 各自复述一遍的话，一旦漂移，
 *    预览用的 entries 与执行器拿到的 scopeIds 就会对不上，
 *    于是多余条目被记成「不在清单里」，而它们其实**在**清单里。
 *
 * @param {object} list
 * @returns {string[]}
 */
export function runnableIds(list) {
  return normalizeList(list).items
    .filter((it) => RUNNABLE.includes(it.status))
    .map((it) => it.id);
}

/** 空清单 */
export const EMPTY_LIST = Object.freeze({ v: 1, updatedAt: 0, items: [] });

/**
 * 把 storage 里读出来的任意东西收敛成合法清单。
 *
 * ⚠️ 为什么需要它：storage 里的值可能来自旧版本、手改、或一次写到一半的
 *    写（见 storage.js mutate 的临界区说明）。一个下标越界的 list.items
 *    会让面板的每个 forEach 一起炸，而那时用户什么都改不了了。
 *
 * @param {unknown} raw
 * @returns {{v:number, updatedAt:number, items:Array}}
 */
export function normalizeList(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const items = Array.isArray(src.items) ? src.items : [];
  return {
    v: 1,
    updatedAt: Number(src.updatedAt) || 0,
    items: items
      .filter((it) => it && typeof it === 'object' && it.id != null)
      .map((it) => ({
        id: String(it.id),
        url: typeof it.url === 'string' ? it.url : '',
        title: typeof it.title === 'string' ? it.title : '',
        path: Array.isArray(it.path) ? it.path.map(String) : [],
        status: Object.values(SCOPE_STATUS).includes(it.status) ? it.status : SCOPE_STATUS.PENDING,
        addedAt: Number(it.addedAt) || 0,
        updatedAt: Number(it.updatedAt) || 0,
        lastReason: typeof it.lastReason === 'string' ? it.lastReason : '',
        lastError: typeof it.lastError === 'string' ? it.lastError : '',
      })),
  };
}

/** 空清单判定（items 为空或压根没这个键） */
export function isEmptyList(list) {
  return !normalizeList(list).items.length;
}

// ───────────────────────── 可动性判定 ─────────────────────────

/**
 * 为什么这条不能被选中，以及是哪一类原因。
 *
 * ⚠️ 判据必须与 src/plan.js 的逐条过滤**同源**，否则勾选区会把一批
 *    「勾了也不会动」的条目放进去 —— 用户勾了 50 条、预览只显示 3 条，
 *    而界面没给出任何解释，那是最伤的一种体验。
 *    plan.js 的三道过滤是：readOnly（tree.js 标）、isExcludedUrl、locks。
 *
 * @param {object} entry flattenTree 的条目
 * @param {Set<string>} lockKeys 归一化后的锁集合
 * @returns {string} 空串 = 可选；否则是不可动原因
 */
export function blockedReason(entry, lockKeys) {
  if (!entry) return '条目不存在';
  if (entry.readOnly) return '移动设备书签是只读的，移不动';
  if (entry.type !== 'url') return '';
  if (isExcludedUrl(entry.url)) return '浏览器内部页或本机地址，不处理';
  const k = dedupeKey(entry.url);
  if (k && lockKeys && lockKeys.has(k)) return '已锁定，整理时不移动';
  return '';
}

/**
 * 给每个条目标注能否被勾选，供勾选区渲染灰态与行内原因。
 *
 * 不改原对象：entries 同时喂给 plan.js，污染它等于污染计划。
 *
 * @param {Array} entries
 * @param {string[]} [locks] 原始 URL 数组
 * @returns {Array<{entry:object, blocked:string}>}
 */
export function annotateSelectable(entries, locks = []) {
  const lockKeys = new Set();
  for (const l of locks || []) {
    const k = dedupeKey(l);
    if (k) lockKeys.add(k);
  }
  return (entries || []).map((entry) => ({ entry, blocked: blockedReason(entry, lockKeys) }));
}

// ───────────────────────── 勾选：文件夹展开成 id 快照 ─────────────────────────

/**
 * 把一个文件夹（或单条书签）展开成「可动的书签条目」快照。
 *
 * ⚠️⚠️ 这是**快照**，不是活引用 —— 展开之后清单里只剩具体书签 id，
 *    文件夹再增删都不影响已生成的清单。
 *    理由：执行器只认具体 item，而一个会随时间漂移的边界，
 *    对一个专门为「怕误伤」而做的功能来说是反着来的。
 *
 * 用 parentId 链向下走，不用 path 前缀匹配 —— parentId 是 tree.js 已经在填的
 * 权威字段，而 path 的第 0 段在不同书签模型下语义并不相同。
 *
 * @param {Array} entries flattenTree 的完整结果
 * @param {string} folderId 起点 id（文件夹或单条书签都可以）
 * @param {string[]} [locks] 原始 URL 数组，用于剔除已锁定的
 * @returns {Array} 可动的书签条目（folder 自身不算，它移不动）
 */
export function expandFolderSelection(entries, folderId, locks = []) {
  const all = Array.isArray(entries) ? entries : [];
  const target = String(folderId);
  const byId = new Map(all.map((e) => [String(e.id), e]));
  if (!byId.has(target)) return [];

  const lockKeys = new Set();
  for (const l of locks || []) {
    const k = dedupeKey(l);
    if (k) lockKeys.add(k);
  }

  const kids = new Map();
  for (const e of all) {
    const k = String(e.parentId);
    if (!kids.has(k)) kids.set(k, []);
    kids.get(k).push(e);
  }

  const out = [];
  const seen = new Set();
  const stack = [target];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;          // 环了就停，别死循环
    seen.add(id);
    const node = byId.get(id);
    if (!node) continue;
    // 起点自己也要判可动性：单独勾一条书签时走的就是这条路
    if (!blockedReason(node, lockKeys) && node.type === 'url') out.push(node);
    for (const c of kids.get(id) || []) stack.push(String(c.id));
  }
  return out;
}

// ───────────────────────── 清单增删 ─────────────────────────

/**
 * 把条目并进清单。已存在的 id 不重复添加。
 *
 * @param {object} list
 * @param {Array} entries 要加入的条目（expandFolderSelection 的输出）
 * @param {number} [now]
 * @returns {{v:number, updatedAt:number, items:Array}} 新清单（不改原对象）
 */
export function addEntries(list, entries, now = Date.now()) {
  const cur = normalizeList(list);
  const have = new Set(cur.items.map((it) => it.id));
  const added = [];
  for (const e of entries || []) {
    if (!e || e.id == null || e.type !== 'url') continue;
    const id = String(e.id);
    if (have.has(id)) continue;
    have.add(id);
    added.push({
      id,
      url: e.url || '',
      title: e.title || '',
      path: Array.isArray(e.path) ? e.path.slice() : [],
      status: SCOPE_STATUS.PENDING,
      addedAt: now,
      updatedAt: now,
      lastReason: '',
      lastError: '',
    });
  }
  if (!added.length) return cur;
  return { v: 1, updatedAt: now, items: [...cur.items, ...added] };
}

/** 从清单里移除若干 id（不可动的条目、用户手动剔除、已失效条目） */
export function removeEntries(list, ids, now = Date.now()) {
  const drop = new Set((ids || []).map(String));
  const cur = normalizeList(list);
  return { v: 1, updatedAt: now, items: cur.items.filter((it) => !drop.has(it.id)) };
}

/** 清空「已整理」的那些（保留历史直到用户主动清） */
export function clearDone(list, now = Date.now()) {
  const cur = normalizeList(list);
  return { v: 1, updatedAt: now, items: cur.items.filter((it) => it.status !== SCOPE_STATUS.DONE) };
}

// ───────────────────────── 对账 ─────────────────────────

/**
 * 把清单和**当前活着的树**对账，失效的标成「已失效」。
 *
 * ⚠️⚠️ 刻意**不**按 URL 找回：同一 URL 存过多条是常事，按 URL 顶替等于
 *    整理了一条用户没选的书签。认不出来就标 stale 跳过，让用户自己看着办。
 *
 * `done` 条目不参与对账：它已经是历史记录，书签事后被用户删掉是正常收尾，
 * 让它翻回「已失效」反而把「这批确实整理过」的事实抹掉了。
 *
 * @param {object} list
 * @param {Array} entries 当前 flattenTree 的完整结果
 * @returns {{list:object, stale:Array, revived:Array}}
 */
export function reconcileList(list, entries) {
  const cur = normalizeList(list);
  const live = new Set((entries || []).map((e) => String(e.id)));

  const stale = [];
  const revived = [];
  const items = cur.items.map((it) => {
    if (it.status === SCOPE_STATUS.DONE) return it;
    const alive = live.has(it.id);
    if (alive) {
      if (it.status === SCOPE_STATUS.STALE) revived.push(it.id);
      // 只有失败原因可能已随树变化而过期；状态本身原样保留
      return it;
    }
    stale.push(it.id);
    return { ...it, status: SCOPE_STATUS.STALE, updatedAt: Date.now() };
  });

  return { list: { v: 1, updatedAt: Date.now(), items }, stale, revived };
}

/**
 * 从完整 entries 里裁出「本次要整理」的那一批。
 *
 * ⚠️ `path` 字段**必须原样保留**：src/plan.js 的幂等判定
 *    （`fromPath.slice(1).join('/')` 与 toPath 比对）靠它，
 *    丢了就会把已经在目标位置上的条目重新 move 一次。
 *
 * 只含 pending / failed —— done 是历史，重跑它等于再花一次 LLM 的钱。
 *
 * @param {Array} entries
 * @param {object} list
 * @returns {Array} 喂给 buildPlan 的 entries 子集
 */
export function buildScopeEntries(entries, list) {
  const cur = normalizeList(list);
  if (!cur.items.length) return [];

  const wanted = new Set(runnableIds(cur));
  if (!wanted.size) return [];

  return (entries || []).filter((e) => e && wanted.has(String(e.id)));
}

/** 四种状态的计数，面板上的徽章用它 */
export function summarize(list) {
  const cur = normalizeList(list);
  const out = { total: cur.items.length, pending: 0, done: 0, failed: 0, stale: 0 };
  for (const it of cur.items) {
    if (it.status === SCOPE_STATUS.DONE) out.done += 1;
    else if (it.status === SCOPE_STATUS.FAILED) out.failed += 1;
    else if (it.status === SCOPE_STATUS.STALE) out.stale += 1;
    else out.pending += 1;
  }
  return out;
}

// ───────────────────────── 执行结果回写 ─────────────────────────

/**
 * 一轮执行结束后，把 plan 里每条计划项的最终状态写回清单。
 *
 * ⚠️ plan.items 的 status 语义（见 src/apply.js）：
 *    'done'    移动成功且回读确认（assertMoved）
 *    'failed'  移动失败，原因在 task.failed 里
 *    'skipped' 只可能是 reconcilePlanIds 判定的 bookmark-missing
 *    'pending' 一轮跑完还不该出现，出现了就当没处理过
 *
 * @param {object} list
 * @param {Array} planItems task.plan.items
 * @param {Array} [failures] task.failed，用来带 lastError
 * @returns {{v:number, updatedAt:number, items:Array}} 新清单（不改原对象）
 */
export function applyRunResult(list, planItems, failures = []) {
  const cur = normalizeList(list);
  if (!cur.items.length) return cur;

  const errById = new Map();
  for (const f of failures || []) {
    if (f && f.id != null) errById.set(String(f.id), String(f.error || '未知原因'));
  }

  const verdict = new Map();
  for (const it of planItems || []) {
    if (!it || it.id == null) continue;
    verdict.set(String(it.id), it);
  }

  let changed = false;
  const items = cur.items.map((it) => {
    // done 是终态，不被后续运行改写
    if (it.status === SCOPE_STATUS.DONE) return it;
    const p = verdict.get(it.id);
    if (!p) return it;   // 这一轮没轮到它，保持原状

    let next = null;
    if (p.status === 'done') {
      next = { ...it, status: SCOPE_STATUS.DONE, lastReason: p.reason || it.lastReason, lastError: '', updatedAt: Date.now() };
    } else if (p.status === 'failed') {
      next = { ...it, status: SCOPE_STATUS.FAILED, lastError: errById.get(it.id) || '未知原因', updatedAt: Date.now() };
    } else if (p.status === 'skipped' && p.reason === 'bookmark-missing') {
      next = { ...it, status: SCOPE_STATUS.STALE, updatedAt: Date.now() };
    }
    if (next) changed = true;
    return next || it;
  });

  return changed ? { v: 1, updatedAt: Date.now(), items } : cur;
}

/**
 * 面板一次要用的全部派生数据。
 *
 * 之所以聚成一个函数：这些数必须来自**同一次**对账结果，
 * 分开调用会出现「列表显示 5 条待整理、统计却按 6 条算」这种自相矛盾，
 * 而用户没有任何办法自己核平。
 *
 * @param {object} list
 * @param {Array} entries 当前 flattenTree 的完整结果
 * @param {string[]} [locks]
 * @returns {{list:object, entries:Array, stats:object, staleIds:string[], runnable:number}}
 */
export function prepareScope(list, entries, locks = []) {
  const rec = reconcileList(list, entries);
  const scoped = buildScopeEntries(entries, rec.list);
  return {
    list: rec.list,
    entries: scoped,
    stats: summarize(rec.list),
    staleIds: rec.stale,
    runnable: scoped.length,
  };
}