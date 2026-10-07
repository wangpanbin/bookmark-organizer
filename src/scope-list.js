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

/**
 * 清单条目的状态。
 *
 * ⚠️⚠️ 2026-10-07 起从 4 个变成 7 个，因为「完整性契约」落地了：
 *    执行完不允许残留「待整理」——每一条都必须落到一个**明确的终态**，
 *    而那个终态的理由要看得见。早先只有 done/failed/stale 三种落点，
 *    于是「已被判定无需移动」「被范围挡住」「AI 没归类且你还没处置」
 *    这三种截然不同的情况，全都被 `if (!p) return it;` 静默吞掉，
 *    清单行永远停在「待整理」——用户视角就是「点了没反应」。
 *
 *    ⚠️ done / in-place / stale 三个是**终态**：不被后续运行改写
 *       （见 reconcileList 与 applyRunResult）。
 *    ⚠️ 新增状态时**必须**同时改四处，否则界面与闸门会静默漂移：
 *       ① 本表  ② summarize 的 switch  ③ applyRunResult 的映射
 *       ④ ui/options.js 的 SCOPE_STATUS_LABEL
 */
export const SCOPE_STATUS = Object.freeze({
  PENDING: 'pending',          // 待整理   — 还没跑
  DONE: 'done',                // 已整理   — 移动成功并回读确认
  IN_PLACE: 'in-place',        // 已在原位 — 规则判它该在这儿，不需要移动
  FAILED: 'failed',            // 失败     — 移动失败，可重试
  STALE: 'stale',              // 已失效   — 这条书签在树上找不到了
  BLOCKED: 'blocked',          // 无法处理 — 被范围校验挡住 / 浏览器内部页与本机地址
  UNCLASSIFIED: 'unclassified', // 未归类   — 还没归类；或你明确说了「就放待归类」
});

/**
 * 会被送去分类的状态。终态（done / in-place / stale）不在其中 ——
 * 它们已经有结论了，整理过的不重复花 LLM 的钱。
 *
 * ⚠️ blocked **不**在其中：它装的是「浏览器内部页 / 本机地址 / 被范围挡住」，
 *    重新判一次结果不会变（URL 还是那个 URL），重跑只是白花一次 LLM 的钱。
 *    早先把 BLOCKED 也加进来过，与「不可重试」的语义直接冲突。
 */
const RUNNABLE = [
  SCOPE_STATUS.PENDING,
  SCOPE_STATUS.FAILED,
  SCOPE_STATUS.UNCLASSIFIED,
];

/**
 * 全部状态值，`summarize` 的 switch 用它做穷尽性自检。
 * 写成 Object.values(SCOPE_STATUS) 而不是写死数组：
 * 加了状态忘了改 switch，这里会立刻报出来。
 */
const ALL_STATUS = Object.values(SCOPE_STATUS);

/**
 * 终态：不再参与「本轮要处理」的判定。
 * @param {string} status
 */
export function isTerminal(status) {
  return status === SCOPE_STATUS.DONE
    || status === SCOPE_STATUS.IN_PLACE
    || status === SCOPE_STATUS.STALE;
}

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
        status: ALL_STATUS.includes(it.status) ? it.status : SCOPE_STATUS.PENDING,
        // 用户对「未归类」条目的显式处置：'' | 'accept-unclassified'
        // 取值刻意与 plan.js 的 RESOLUTION_ACCEPT_UNCLASSIFIED 同值，
        // 但这里是**收敛**而非定义 —— 定义在那儿，这里只认它。
        resolution: it.resolution === 'accept-unclassified' ? 'accept-unclassified' : '',
        // ⚠️ 这里**刻意没有** plannedTo：面板每行的「将要归到 XXX」来自
        //    derivePlanView(plan.items)，那才是唯一判据。早先清单条目上
        //    挂过一个 plannedTo 字段，却从来没有人写它 —— 一个只有读没有写的
        //    字段，比没有更糟：它看起来像个数据源，实际永远为空。
        //    真要落一份快照，就在面板算完投影后写回，而不是另开一个字段。
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

/** 清空「已整理」的那些（保留历史直到用户主动清）。已在原位同样是已完成的，一并清掉 */
export function clearDone(list, now = Date.now()) {
  const cur = normalizeList(list);
  return {
    v: 1,
    updatedAt: now,
    items: cur.items.filter((it) => it.status !== SCOPE_STATUS.DONE && it.status !== SCOPE_STATUS.IN_PLACE),
  };
}

// ───────────────────────── 对账 ─────────────────────────

/**
 * 把清单和**当前活着的树**对账，失效的标成「已失效」。
 *
 * ⚠️⚠️ 刻意**不**按 URL 找回：同一 URL 存过多条是常事，按 URL 顶替等于
 *    整理了一条用户没选的书签。认不出来就标 stale 跳过，让用户自己看着办。
 *
 * `done` / `in-place` / `stale` 条目不参与对账：它们已经是历史结论，
 * 书签事后被用户删掉是正常收尾，让它们翻回「已失效」反而把
 * 「这批确实整理过」的事实抹掉了。
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
    if (isTerminal(it.status)) return it;
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

/**
 * 各状态的计数，面板上的徽章用它。
 *
 * ⚠️⚠️ 这里刻意**穷举**每个状态，**没有 `else` 兜底**。
 *    早先的写法是 `if DONE … else if FAILED … else pending += 1`，
 *    后果是**任何新增状态都被静默计入「待整理」**，而
 *    「七档之和 === total」那条求和闭包**照样成立** ——
 *    闸门全绿，失效无从发现。误报与漏报都来自这里，所以宁可 default 记成 unknown。
 *
 * @param {object} list
 * @returns {{total:number, pending:number, done:number, failed:number,
 *            stale:number, blocked:number, unclassified:number, unknown:number}}
 */
export function summarize(list) {
  const cur = normalizeList(list);
  const out = {
    total: cur.items.length,
    pending: 0, done: 0, failed: 0, inPlace: 0,
    stale: 0, blocked: 0, unclassified: 0, unknown: 0,
  };

  for (const it of cur.items) {
    switch (it.status) {
      case SCOPE_STATUS.PENDING: out.pending += 1; break;
      case SCOPE_STATUS.DONE: out.done += 1; break;
      case SCOPE_STATUS.IN_PLACE: out.inPlace += 1; break;
      case SCOPE_STATUS.FAILED: out.failed += 1; break;
      case SCOPE_STATUS.STALE: out.stale += 1; break;
      case SCOPE_STATUS.BLOCKED: out.blocked += 1; break;
      case SCOPE_STATUS.UNCLASSIFIED: out.unclassified += 1; break;
      default:
        // normalizeList 已把非法值收敛成 PENDING，走不到这里；
        // 留着是为了「新增状态忘了加分支」时**显形**，而不是被吞成 pending。
        out.unknown += 1;
    }
  }
  return out;
}

// ───────────────────────── 执行结果回写 ─────────────────────────

/**
 * plan item 的 (status, reason) → SCOPE_STATUS 的**唯一**映射表。
 *
 * ⚠️ 为什么单列一张表：这张表曾经是内联 if-else 链，只有三条分支，
 *    结果 `out-of-scope`（apply.js 的范围闸门产出）**没有落点**，
 *    条目每轮都被 `runnableIds` 重新选中、每轮都没裁决，
 *    永远停在「待整理」且界面不解释 —— 与「AI 过滤」的症状一模一样，
 *    但根因完全无关。散落的 if-else 链越写越长，漏掉一条分支没有任何提示。
 *
 *    plan.items 的 reason 取值见 src/plan.js 的 REASON。
 */
const PLAN_VERDICT = Object.freeze({
  'done': SCOPE_STATUS.DONE,
  'failed': SCOPE_STATUS.FAILED,
  'skipped:already-in-place': SCOPE_STATUS.IN_PLACE,
  // ⚠️⚠️ 这一条**曾经缺失**，症状正是本功能最初报的那个：
  //    查不到落点 → 条目保持原状态 → 「永远停在待整理」。
  //    它对应的正是「还躺在兜底桶里、没被判出分类」那一批。
  'skipped:unclassified': SCOPE_STATUS.UNCLASSIFIED,
  'skipped:unclassified-accepted': SCOPE_STATUS.UNCLASSIFIED,
  'skipped:bookmark-missing': SCOPE_STATUS.STALE,
  'skipped:out-of-scope': SCOPE_STATUS.BLOCKED,
  'skipped:excluded': SCOPE_STATUS.BLOCKED,
  'skipped:locked': SCOPE_STATUS.BLOCKED,
  'skipped:readonly': SCOPE_STATUS.BLOCKED,
});

/** reason → 给人看的一句话。⚠️ 与 PLAN_VERDICT 同源维护，改一处必须改另一处。 */
const REASON_LABEL = Object.freeze({
  'already-in-place': '已在原位',
  'unclassified': '未归类',
  'unclassified-accepted': '未归类（你已确认就放待归类）',
  'bookmark-missing': '书签已不存在',
  'out-of-scope': '被范围校验挡住',
  'excluded': '浏览器内部页或本机地址',
  'locked': '已锁定',
  'readonly': '移动设备书签是只读的',
});

/**
 * 把 reason 翻成人话。面板不许自己复述这张表 —— 它与 PLAN_VERDICT 同源。
 * @param {string} reason
 * @returns {string}
 */
export function reasonLabel(reason) {
  return REASON_LABEL[reason] || String(reason || '');
}

/**
 * 一轮执行结束后，把 plan 里每条计划项的最终状态写回清单。
 *
 * ⚠️ plan.items 的 status 语义（见 src/apply.js）：
 *    'done'    移动成功且回读确认（assertMoved）
 *    'failed'  移动失败，原因在 task.failed 里
 *    'skipped' 未执行；具体原因看 reason，落点见 PLAN_VERDICT
 *    'pending' 一轮跑完还不该出现，出现了就当没处理过
 *
 * ⚠️⚠️ **map 里查不到的组合一律保持原状**，这是刻意的：
 *    判据表漏了新分支时宁可让用户看见「还在待整理」，
 *    也不要把它归到一个看起来正常、实则错误的终态上。
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
    // 终态不被后续运行改写
    if (isTerminal(it.status)) return it;
    const p = verdict.get(it.id);
    if (!p) return it;   // 这一轮没轮到它，保持原状

    const key = p.status === 'skipped' ? `skipped:${p.reason}` : p.status;
      const nextStatus = PLAN_VERDICT[key];
    // 查不到 → 保持原状（见上面「宁可让用户看见」的说明）
    if (!nextStatus) return it;

    let next = { ...it, status: nextStatus, updatedAt: Date.now() };
    if (nextStatus === SCOPE_STATUS.DONE) {
      next.lastReason = p.reason || it.lastReason;
      next.lastError = '';
    } else if (nextStatus === SCOPE_STATUS.FAILED) {
      next.lastError = errById.get(it.id) || '未知原因';
    } else if (nextStatus === SCOPE_STATUS.UNCLASSIFIED) {
      // 只有「你已确认」才记成处置过；「还没判出来」不能倒过来写成已确认，
      // 否则下一轮它会从闸门里漏过去 —— 而它恰恰是还没交代的那条。
      next.resolution = p.reason === 'unclassified-accepted' ? 'accept-unclassified' : '';
      next.lastError = '';
    } else if (nextStatus === SCOPE_STATUS.IN_PLACE) {
      next.lastError = '';
    } else {
      next.lastError = errById.get(it.id) || it.lastError;
    }

    changed = true;
    return next;
  });

  return changed ? { v: 1, updatedAt: Date.now(), items } : cur;
}

/**
 * 把一份计划投影成「清单每一行该怎么显示」。
 *
 * ⚠️ 为什么面板不能自己反推：清单行要显示「将要归到 XXX」，
 *    而那份信息只存在于 plan.items 里。面板若自己按 status 复述一遍规则，
 *    就会与 plan.js 漂移 —— 而漂移的症状是「清单里写着要搬去 A，
 *    执行时搬到 B」，界面承诺与实际行为不一致，比不做更糟。
 *    所以这里是**唯一**一份投影判据。
 *
 * @param {Array} planItems plan.items
 * @param {string} fallbackStr 兜底桶的 '顶层/子类' 串
 * @returns {Map<string, {toStr:string, toPath:string[], willMove:boolean,
 *                        inFallback:boolean, blocked:string, reason:string}>}
 */
export function derivePlanView(planItems, fallbackStr) {
  const fb = String(fallbackStr || '');
  const out = new Map();
  for (const it of planItems || []) {
    if (!it || it.id == null) continue;
    const id = String(it.id);
    const toStr = it.toStr || (Array.isArray(it.toPath) ? it.toPath.join('/') : '');
    const willMove = it.status === 'pending';
    const inFallback = toStr === fb;
    out.set(id, {
      toStr,
      toPath: Array.isArray(it.toPath) ? it.toPath.slice() : [],
      willMove,
      inFallback,
      reason: it.reason || '',
      // 面板对终态条目要显示「为什么不动」，读的就是这个字段。
      // 早先它去读一个从未被产出的 blockedLabel，于是永远拿到 undefined，
      // 界面只剩一个光秃秃的类目名，用户不知道自己看的是哪一种结局。
      blockedLabel: willMove ? '' : reasonLabel(it.reason),
    });
  }
  return out;
}

/**
 * 清单里「本轮还需要你处理」的条目：AI 没归类、且你还没明确说「就放待归类」。
 *
 * ⚠️ 这就是执行闸门的判据（见 ui/options.js 的 syncExecuteButton）：
 *    D6 的「未归类必须在执行前处理完，或显式接受」全靠它。
 *    判据放在纯函数里是为了能被单测直接钉住 ——
 *    面板里写一个 `.filter(...)` 的话，闸门就成了没人验的一句表达式。
 *
 * @param {object} list
 * @param {Map<string,object>} [planView] derivePlanView 的输出。
 *        **缺省时一条都不算** —— 还没预览过就等于「还没算」，
 *        那不是「没归类」。宁可闸门此刻不拦，也不要在没有计划时编造一个理由。
 * @returns {string[]} 清单条目 id
 */
export function unresolvedIds(list, planView) {
  const cur = normalizeList(list);
  const out = [];
  for (const it of cur.items) {
    if (isTerminal(it.status)) continue;
    if (it.status === SCOPE_STATUS.FAILED || it.status === SCOPE_STATUS.BLOCKED) continue;
    if (it.resolution === 'accept-unclassified') continue;
    const v = planView && planView.get(it.id);
    if (!v) continue;
    // ⚠️⚠️ 判据是「目标落在兜底桶」，**与 willMove 无关**。
    //    两种都算「没归类」：
    //      ① willMove=false：已经躺在待归类里，没有东西要搬 ——
    //         D6 要你给它一个分类，或承认它就该留在这儿。
    //      ② willMove=true ：**正要把它搬进待归类** ——
    //         这才是用户最初报的「静默塞进待归类」，更该拦。
    //    早先写成 `if (v.willMove) continue`，恰好把 ② 放过去了，
    //    于是「正要被塞进待归类」的条目畅通无阻，而闸门看上去是好的。
    if (!v.inFallback) continue;
    out.push(it.id);
  }
  return out;
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