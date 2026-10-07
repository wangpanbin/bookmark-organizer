/**
 * 执行器：逐条 move + 每条落盘 + 断点续跑。
 *
 * ═══ 为什么必须这么写 ═══
 * 1. chrome.bookmarks **没有批量移动 API**，move() 一次只能挪一条。
 *    几百条书签 = 几百次调用。
 * 2. MV3 service worker **空闲 30 秒即被回收**。所以任务绝不能是
 *    「一个循环跑完」—— 必须每条成功后立刻落盘，worker 被杀也能从断点接上。
 * 3. **单条失败不中断整批**：记进 failed[] 继续跑完，最后在报告里逐条列原因。
 *    半途中断比跑完更糟：跑完至少知道哪些没成功。
 *
 * 本模块在 service worker 里跑。模块级 running 标志防止重复启动；
 * worker 被回收后标志重置，但 task.status 仍是 running，
 * UI 检测到「running 但进度不动」会提示可以点继续。
 */

import {
  get, set, mutate, mutateMany, setVerified, K, TASK_STATUS, getTask, getSettings,
  getDedupeVeto, isDedupeVetoed,
} from './storage.js';
import { recordFailure, flushPending } from './fail-log.js';
import { resolveRoot } from './roots.js';

/** 模块级重入保护 */
let running = false;
/** 当前执行轮次的标识，仅用于日志排查 */
let runToken = 0;

/**
 * 当前这个 service worker 实例里是否真的有执行循环在跑。
 *
 * 这是判定「任务是被浏览器回收打断的」还是「此刻正在跑」的**权威判据**：
 * SW 被回收后模块状态会重置，running 归 false；而消息会把 SW 唤醒，
 * 唤醒后的新实例回答 false —— 正好说明原来的循环已经不存在了。
 *
 * 之前用 updatedAt 的时间戳去猜（「超过 5 秒没刷新就算陈旧」）不可靠：
 * 浏览器重开只要 2~4 秒，落在阈值内，于是中断的任务永远等不到「继续」按钮。
 *
 * @returns {boolean}
 */
export function isRunnerActive() {
  return running;
}

/** 当前执行轮次序号（诊断用） */
export function currentRunToken() {
  return runToken;
}
/** 让出事件循环的间隔。每条都 await 一个宏任务，保证 API 调用有机会派发出去 */
const YIELD_EVERY = 1;
const YIELD_MS = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 任务进度摘要（写进 storage，供 UI 轮询） */
function summarize(task) {
  const items = task.plan?.items || [];
  const stale = Array.isArray(task.stale) ? task.stale : [];
  return {
    status: task.status,
    total: items.length,
    done: items.filter((i) => i.status === 'done').length,
    skipped: items.filter((i) => i.status === 'skipped').length,
    failed: items.filter((i) => i.status === 'failed').length,
    pending: items.filter((i) => i.status === 'pending').length,
    failedList: (task.failed || []).slice(0, 50),
    /**
     * 这一轮因为「不在清单里」而没有动的条目。
     * ⚠️ 子集运行正常情况下这个数应该是 0。它不为 0 说明上游裁剪漏了，
     *    是范围校验**真的挡住了一次越界**的证据 —— 报告里必须露出来，
     *    静默吞掉等于让用户以为「它照我的范围整理了」。
     */
    outOfScope: stale.filter((s) => s && s.outOfScope).length,
    missing: stale.filter((s) => s && !s.outOfScope).length,
    /** 本次是不是子集运行（界面据此显示范围承诺） */
    scoped: task.scopeIds !== null && task.scopeIds !== undefined,
    scopeCount: Array.isArray(task.scopeIds) ? task.scopeIds.length : null,
    snapshotTs: task.snapshotTs ?? null,
    updatedAt: task.updatedAt || 0,
  };
}

/** 读进度（UI 用） */
export async function getProgress() {
  return summarize(await getTask());
}

/**
 * 在 parentId 下找/建同名文件夹。
 * createdOut 记录新建的文件夹，供回滚时精确清理。
 */
async function ensureFolder(parentId, title, createdOut) {
  const children = await chrome.bookmarks.getChildren(parentId);
  const found = (children || []).find((c) => !c.url && c.title === title);
  if (found) return { id: String(found.id), created: false };
  const created = await chrome.bookmarks.create({ parentId: String(parentId), title });
  if (createdOut) createdOut.push({ id: String(created.id), path: [title] });
  return { id: String(created.id), created: true };
}

/**
 * 路径模型（踩过一次的坑）：
 *    fromPath 的第 0 段是根**名称**，toPath 则**不含根**（就是 taxonomy 的 '大类/子类'）。
 *    根归到哪是「写到哪儿」的问题，由 settings.targetRoot 决定，所以 plan.js 不参与。
 *    写盘时把根名补回去，再由根名找到根 id。
 *
 * ⚠️ 根 id **不是常量**，所以这里不再有任何硬编码，也不再有「兜底返回 '1'」。
 *    解析与存在性校验全部交给 roots.js 的 resolveRoot()，它会用
 *    chrome.bookmarks.get() 实测。详见 roots.js 顶部那段事故记录：
 *    写死 '1' 导致 2026-10-05 的 45 条全军覆没。
 */

/**
 * 确保目标路径存在，返回最深层文件夹 id。
 * 入参 fullPath 的第 0 段是根**名**，内部换算成根 id。
 *
 * @param {object} task 任务对象（会被就地补上 folderCache / createdFolders）
 * @param {string} rootId 根 id
 * @param {string[]} fullPath [根名, 大类, 子类]
 * @returns {Promise<string>}
 */
async function ensureTargetFolder(task, rootId, fullPath) {
  const [rootName, ...segs] = fullPath;
  const cache = task.folderCache || (task.folderCache = {});
  const createdOut = task.createdFolders || (task.createdFolders = []);

  let parentId = String(rootId);
  const acc = [];

  for (const seg of segs) {
    acc.push(seg);
    const key = acc.join('/');
    if (cache[key]) {
      try {
        await chrome.bookmarks.get(cache[key]);
        parentId = cache[key];
        continue;
      } catch {
        delete cache[key]; // 缓存指向的目录被用户删了
      }
    }
    // ⚠️ createdOut 传 null —— 记账统一由下面这一处负责。
    //    早先的两个版本各有毛病：传 null 后无条件 push，会把「复用了用户已有的
    //    同名文件夹」也记成我们建的（回滚时 backup.js 按此清单 removeTree，
    //    于是删掉用户自己的文件夹）；改成传 createdOut 又会和下面这处重复记账。
    //    正确做法：只要 created 这个布尔，由这里带完整路径记一次。
    const r = await ensureFolder(parentId, seg, null);
    if (r.created) {
      createdOut.push({ id: r.id, path: [rootName, ...acc] });
    }
    cache[key] = r.id;
    parentId = r.id;
  }
  return parentId;
}

/**
 * 每完成一条就落盘（断点续跑的关键）。
 *
 * ⚠️ patch 与 extra 必须分开传。
 *    之前写成 `{ ...i, ...item }`（item 是那条计划项本身），而计划项此刻的
 *    status 仍是 'pending'，于是把 extra 里的 'done' 又覆盖回 'pending' ——
 *    状态永远不推进，执行器会反复搬同一条，死循环。
 *    现在 patch 只带要改的字段；extra 里的任务级状态单独写进 task，
 *    不混进计划项。
 *
 * @param {string} id
 * @param {object} patch   计划项上要改的字段，如 { status: 'done' }
 * @param {object} [extra] 任务级状态：进度、失败列表、目录缓存
 */
async function persistItem(id, patch, extra) {
  return mutateMany(
    [K.TASK_CURRENT],
    (cur) => {
      // ⚠️ mutateMany 的回调收到的是 { key: value } 的**映射**，不是单个值。
      //    早先写成 `{ ...(cur || {}) }` 会把映射整个摊平：t.plan 变成 undefined
      //    → 被重建成 { items: [] } → 循环下一轮就找不到待办项，只搬了第一条就停。
      //    同时把原任务嵌套进了 t['task:current']，落盘对象结构整个坏掉。
      //    必须取 cur[K.TASK_CURRENT]。
      const t = { ...(cur?.[K.TASK_CURRENT] || {}) };
      const items = (t.plan?.items || []).map((i) => (i.id === id ? { ...i, ...patch } : i));
      t.plan = { ...(t.plan || {}), items };
      if (extra?.lastDoneIndex !== undefined) t.lastDoneIndex = extra.lastDoneIndex;
      if (extra?.failed) t.failed = extra.failed;
      if (extra?.stale) t.stale = extra.stale;
      if (extra?.createdFolders) t.createdFolders = extra.createdFolders;
      if (extra?.folderCache) t.folderCache = extra.folderCache;
      if (extra?.removedDuplicates) t.removedDuplicates = extra.removedDuplicates;
      t.updatedAt = Date.now();
      return { [K.TASK_CURRENT]: t };
    },
    {},
  );
}

/**
 * 本次任务允许动的书签 id 集合。
 *
 * ⚠️⚠️ `null` 与 `[]` 是**两件完全不同的事**，别混：
 *    - null  = 全量运行，沿用整理前的语义，不做任何范围限制
 *    - []    = 子集运行，而清单是空的 —— 什么都不该动
 *    所以判断必须写 `task.scopeIds === null` 而不是 `!task.scopeIds.length`。
 *
 * @param {object} task
 * @returns {Set<string>|null}
 */
function allowedIdSet(task) {
  if (task.scopeIds === null || task.scopeIds === undefined) return null;
  if (!Array.isArray(task.scopeIds)) return null;
  return new Set(task.scopeIds.map(String));
}

/**
 * 范围校验：这条书签在不在本次任务的允许集合里。
 *
 * ═══ 为什么执行器要自己再认一遍清单 ═══
 * 面板已经用清单裁出了计划，理论上 plan.items ⊆ 清单。
 * 那为什么还要执行侧复核？
 *
 * 因为这条链路上「计划载荷」与「用户当时勾的东西」之间隔着好几层
 * —— storage 里的残留计划、面板的旧内存状态、中途被别的预览覆盖。
 * 而这个功能存在的**全部理由**就是「我圈定范围之外的东西一条都不能动」。
 * 把这条保证只押在上游裁剪上，等于让承诺建立在一个纯逻辑的正确性上；
 * 一旦哪一层的裁剪漏了，后果是**静默搬动用户没选的书签**，
 * 而且报告上显示 100% 成功 —— 用户无从察觉。
 *
 * 这与 processDuplicates 里复核 dedupe:veto 是同一个道理：
 * 「用户明确说了不动的条目被执行器动了」是不可逆损失，
 * 所以执行侧必须自己认名单，不能只信上游。
 *
 * @param {Set<string>|null} allowed null = 全量运行，不限制
 * @param {string} id
 * @returns {boolean}
 */
export function isInScope(allowed, id) {
  if (allowed === null) return true;
  return allowed.has(String(id));
}

/**
 * 开始执行（或继续）。把 plan 写进 task 后进入主循环。
 *
 * @param {{plan: object, duplicates?: Array, snapshotTs?: number, scopeIds?: string[]|null}} payload
 *        scopeIds 缺省 / null = 全量运行（现有语义不变）；
 *        数组 = 只允许动这些 id，执行循环逐条复核。
 * @returns {Promise<{started:boolean, reason?:string}>}
 */
export async function startExecution(payload) {
  if (running) return { started: false, reason: '已在执行中' };

  // plan 要能被下面的 reconcile 替换掉，所以必须是 let —— 早先写成 const 又去赋值，
  // 抛 `Assignment to constant variable`，整批任务直接启动失败。
  let { plan, duplicates = [], snapshotTs = null } = payload || {};
  if (!plan || !Array.isArray(plan.items)) return { started: false, reason: '计划为空' };

  // ⚠️ 范围校验要用**执行时**的 id 集合，而不是裁剪时的那份。
  //    reconcilePlanIds 会把失效 id 按 URL 重新定位，改掉的是 item.id；
  //    若拿旧 id 去比对，一个被重新定位的条目会因为「不在旧集合里」被误杀。
  //    所以逐条校验推迟到执行循环里做，那里的 id 已经是定位后的。
  //
  //    这里只做一件更早的事：**载荷自洽性**。子集运行时若一个 id 都没给，
  //    说明清单是空的 —— 此时应该一条都不动，而不是「没限制所以全放行」。
  const rawScopeIds = payload?.scopeIds;
  const scopeIds = Array.isArray(rawScopeIds) ? rawScopeIds.map(String) : null;
  if (scopeIds !== null && !scopeIds.length && plan.items.length) {
    return {
      started: false,
      reason: '这是一次「只整理清单里书签」的任务，但清单是空的 —— 不会有任何书签被移动。'
        + '请到「手动整理」页勾选书签后重新预览。',
    };
  }

  // ⚠️ 预检：动手之前先确认「归入位置」真的能解析成一个活着的根。
  //
  //    2026-10-05 的事故：目标根 id 被写死成 '1'，而 Chrome 154 的账号书签
  //    模型里书签栏是 279。于是 getChildren('1') 抛错、17 个分类文件夹一个没建成、
  //    45 条 move 全部报同一句 `Can't find bookmark for id.` ——
  //    用户只看到「45 条全军覆没」，完全看不出是目标根的问题。
  //    这里提前一步失败，理由能直接照着做。
  const preSettings = await getSettings();
  const preRoot = await resolveRoot(preSettings.targetRoot);
  if (!preRoot.ok) {
    return {
      started: false,
      reason: `归入位置解析失败：${preRoot.reason}。`
        + '这是 Chrome 的书签模型换了导致的（根 id 不再是固定的 1/2），'
        + '不是你的书签有问题。请点「读取并预览」重新算一份计划；'
        + '如果仍然失败，请到 chrome://extensions 重新加载一次扩展。',
    };
  }

  // 执行前先落一份快照 —— 回滚是唯一退路，必须在动第一个字节之前就有
  let snapTs = snapshotTs;
  if (snapTs == null) {
    const { createSnapshot } = await import('./backup.js');
    const snap = await createSnapshot({ note: '执行前自动备份' });
    snapTs = snap.ts;
  }

  // ⚠️ 计划里的 id 必须在动手前对齐一次「活着的树」。
  //
  //    踩过的坑：2026-10-05 用户 45 条**全部**报 `Can't find bookmark for id.`
  //    （探针验过：这句话就是「源 id 不存在」，与「目标文件夹不存在」是两句不同的话）。
  //    书签本身都还在树上，是 id 变了 —— 用户恢复过备份、书签被删过重建、
  //    或者同步落地过，都会让旧 id 失效。
  //    早先不校验就硬搬，于是 45 条逐条撞同一句墙，
  //    而 Chrome 的原话对用户零信息量。
  //
  //    这里做两件事：
  //    ① 按 URL 重新定位到活着的节点（书签没被删，只是 id 变了）
  //    ② 真的找不到的标成 skipped，并带可操作的原因
  const reconciled = await reconcilePlanIds(plan);
  if (reconciled.recovered === 0 && reconciled.missing.length > 0
      && reconciled.missing.length === plan.items.length) {
    // 一条都对不上 → 这份计划整体作废，硬跑只会产出 45 条同样的失败
    return {
      started: false,
      reason: `这份计划的 ${plan.items.length} 条书签 id 全部失效了（书签被删过或恢复过备份，id 变了）。`
        + '请点「读取并预览」重新算一份 —— 预览是只读的，不会动你的书签。',
    };
  }
  plan = reconciled.plan;

  const task = {
    status: TASK_STATUS.RUNNING,
    plan,
    duplicates,
    lastDoneIndex: -1,
    failed: [],
    stale: reconciled.missing,
    createdFolders: [],
    removedDuplicates: [],
    folderCache: {},
    startedAt: Date.now(),
    updatedAt: Date.now(),
    snapshotTs: snapTs,
    // ⚠️ 必须落盘，不能只留在载荷里。
    //    MV3 service worker 空闲 30 秒即被回收，resumeExecution 是**新进程**
    //    从 storage 读回这个 task 继续跑的。若范围只存在于内存，
    //    一旦回收后续跑就完全没有范围校验了 —— 而用户看到的界面一模一样，
    //    他仍然以为「只动我勾的那些」。
    scopeIds,
  };
  await set(K.TASK_CURRENT, task);

  // ⚠️ 不能 await run()：run() 会把整批跑完，而 sendMessage 的响应要等它返回。
  //    那样 UI 在整个执行期间拿不到任何回音，进度条从头到尾都是空的。
  //    run() 里的 `running = true` 是在第一个 await 之前同步置位的，
  //    所以不 await 依然能挡住重复启动。
  run().catch((e) => {
    console.error('[apply] 执行循环异常', e);
    mutate(K.TASK_CURRENT, (cur) => ({ ...(cur || {}), status: TASK_STATUS.FAILED, updatedAt: Date.now() }), {});
  });
  return {
    started: true,
    snapshotTs: snapTs,
    recovered: reconciled.recovered,
    missing: reconciled.missing.length,
  };
}

/**
 * 把计划里的书签 id 对齐到活着的书签树上。
 *
 * 为什么按 **URL** 而不是按标题找：id 会变、标题会被用户改、URL 更稳定；
 * 且 `chrome.bookmarks.search({url})` 走的是 Chrome 自己的精确匹配，
 * 拿到的是**当前真实存在的节点**。
 *
 * @param {object} plan
 * @returns {Promise<{plan:object, recovered:number, missing:Array}>}
 */
async function reconcilePlanIds(plan) {
  const items = Array.isArray(plan.items) ? plan.items : [];
  const missing = [];
  let recovered = 0;
  const next = [];

  for (const it of items) {
    // id 还活着就不用动 —— 这是绝大多数情况，一次 get 就够
    const alive = await chrome.bookmarks.get(String(it.id)).catch(() => null);
    if (alive && alive.length) {
      next.push(it);
      continue;
    }

    // id 失效 → 按 URL 找活着的同一条
    const hit = it.url ? await chrome.bookmarks.search({ url: it.url }).catch(() => []) : [];
    const same = (hit || []).find((n) => n && n.url && n.id && String(n.id) !== String(it.id));
    if (same) {
      recovered += 1;
      next.push({ ...it, id: String(same.id), idRelocated: true });
      continue;
    }

    missing.push({ title: it.title, url: it.url, oldId: String(it.id) });
    next.push({ ...it, status: 'skipped', reason: 'bookmark-missing' });
  }

  return { plan: { ...plan, items: next }, recovered, missing };
}

/** 继续执行（worker 被回收后，或用户手动继续） */
export async function resumeExecution() {
  if (running) return { started: false, reason: '已在执行中' };
  const task = await getTask();
  if (!task.plan) return { started: false, reason: '没有待执行的任务' };
  if (task.status === TASK_STATUS.DONE) return { started: false, reason: '任务已完成' };

  await mutate(K.TASK_CURRENT, (cur) => ({ ...(cur || {}), status: TASK_STATUS.RUNNING, updatedAt: Date.now() }), {});
  run().catch((e) => {
    console.error('[apply] 续跑异常', e);
    mutate(K.TASK_CURRENT, (cur) => ({ ...(cur || {}), status: TASK_STATUS.FAILED, updatedAt: Date.now() }), {});
  });
  return { started: true };
}

/** 暂停 */
export async function pauseExecution() {
  return mutate(K.TASK_CURRENT, (cur) => ({ ...(cur || {}), status: TASK_STATUS.PAUSED, updatedAt: Date.now() }), {});
}

/**
 * 把 Chrome 的原话翻译成能照着做的中文。
 *
 * ⚠️⚠️ 这里**刻意不再有「消息 → 原因」的对照表**。
 *    早先有一张表，是用 tests/e2e/probe-errid.js 在 Playwright 自带的
 *    chromium 上实测的，结论是「`Can't find bookmark for id.` = 源书签 id 不存在」。
 *    到了用户本机的 Chrome 154 上，这张表**是错的**：目标根 id 失效导致的
 *    失败，报的也是同一句话。于是 45 条失败被统一解释成
 *    「书签被删过或恢复过备份」，我据此加了一整套「按 URL 重新定位 id」的自愈逻辑，
 *    而真实根因（根 id 写死成 '1'）从头到尾没被看见。
 *
 *    教训：**错误文案不是稳定契约，跨 Chrome 版本会变。**
 *    所以这里改成「只说核实过的事」：把源 id 和目标 id 分别 get() 一遍，
 *    哪个不存在就点哪个的名字。核实不出来的就明说不知道，不猜。
 *
 * @param {unknown} e
 * @param {{item?:object, parentId?:string|null}} [ctx] 本次尝试的目标
 * @returns {Promise<string>}
 */
export async function explainMoveError(e, ctx = {}) {
  const raw = String(e && e.message ? e.message : e);
  const bits = [raw];

  const exists = async (id) => {
    if (id === null || id === undefined || id === '') return false;
    return !!(await chrome.bookmarks.get(String(id)).then((r) => r && r[0]).catch(() => null));
  };

  const srcId = ctx.item ? ctx.item.id : null;
  const [srcOk, parOk] = await Promise.all([exists(srcId), exists(ctx.parentId)]);

  if (!srcOk) {
    bits.push('这条书签的 id 在当前书签树里已经查不到了（被删过又重建、或恢复过备份都会让 id 失效）');
  }
  if (!parOk) {
    bits.push('要移过去的那个文件夹不存在 —— 目标根或分类文件夹在这一轮里失效了');
  }
  if (srcOk && parOk) {
    bits.push('源和目标都还在，多半是另一个扩展（广告拦截器 / 书签整理类插件）在书签变更时'
      + '自动重排，或 Chrome 同步覆盖了改动。可先到 chrome://extensions 临时关掉其他'
      + '有「书签」权限的扩展，再重跑一次');
  }
  if (bits.length === 1) {
    bits.push('（原因未确认。点面板上的「重新导出」把日志发出来，里面带 id 和完整路径）');
  }
  return bits.join(' —— ');
}

/**
 * 写完回读：确认这条书签**真的**落在目标文件夹里。
 *
 * 为什么要多这一次调用：见 run() 里的注释。`move()` resolve 不等于改动留下来了。
 * 不回读的话，「被别的扩展/同步改回去」和「move 根本没生效」会长得一模一样，
 * 而这两种都需要用户知道。
 *
 * 抛出的错误文案要能直接指导下一步排查，所以必须带上
 * 「实际落在哪」和「应该落在哪」两个可读名字。
 *
 * @param {string} id       书签节点 id
 * @param {string} parentId 期望的目标文件夹 id
 * @param {string[]} toPath 期望的类目路径（不含根名），只用于文案
 */
async function assertMoved(id, parentId, toPath) {
  const nameOf = async (pid) => {
    try {
      const [n] = await chrome.bookmarks.get(String(pid));
      return n ? (n.title || String(pid)) : String(pid);
    } catch {
      return String(pid);
    }
  };

  // get() 对已不存在的 id 是 reject，不是 resolve 空数组 —— 要包 catch
  const node = await chrome.bookmarks.get(String(id)).catch(() => null);
  if (!node || !node.length) {
    throw new Error('移动后回读：这条书签已经不在书签树里了（可能被其他扩展删掉，或同步覆盖）');
  }
  const actual = String(node[0].parentId);
  if (actual === String(parentId)) return;

  throw new Error(
    `移动后回读：实际在「${await nameOf(actual)}」而不是「${await nameOf(parentId)}」`
    + `（目标 ${(toPath || []).join(' / ')}）—— 改动没有留住。`
    + '常见原因：另一个扩展（广告拦截器 / 书签整理类插件）在书签变更时自动重排，'
    + '或 Chrome 同步把改动覆盖了。可先到 chrome://extensions 临时关掉其他'
    + '有「书签」权限的扩展，再重跑一次。',
  );
}

/**
 * 主执行循环。每条 move 成功后立刻落盘。
 * 用 while(true) + 找下一个 pending，而不是 for 遍历 —— 这样被暂停/中断后
 * 重新进来能自然地从断点继续。
 */
async function run() {
  if (running) return;
  running = true;
  runToken += 1;
  try {
    // 根 id / 根名在整轮里固定，解析一次就够
    //
    // ⚠️ 解析不出来就在这里**停掉整轮**，而不是继续跑。
    //    根 id 错位的后果是 45 条 move 报同一句 `Can't find bookmark for id.`：
    //    用户看到的是「全部失败」，而真正的原因（目标根不存在）一个字母都没露。
    //    宁可一条都不搬并说清原因，也不要产出 45 条一模一样的噪音。
    const settings = await getSettings();
    const root = await resolveRoot(settings.targetRoot);
    if (!root.ok) {
      await mutateMany([K.TASK_CURRENT], (cur) => {
        const t = { ...(cur?.[K.TASK_CURRENT] || {}) };
        t.status = TASK_STATUS.FAILED;
        t.failed = [...(t.failed || []), { id: '-', url: '', title: '（整轮未启动）', error: `归入位置解析失败：${root.reason}` }];
        t.updatedAt = Date.now();
        return { [K.TASK_CURRENT]: t };
      }, {});
      return;
    }
    const rootId = root.id;
    const rootName = root.title;
    let sinceYield = 0;
    for (;;) {
      const task = await getTask();
      if (!task.plan) return;
      if (task.status !== TASK_STATUS.RUNNING) return;

      // ⚠️ 每一轮都重算：任务可能被暂停后恢复，也可能被别的预览换了 task。
      const allowed = allowedIdSet(task);
      const items = task.plan.items || [];
      const next = items.find((i) => i.status === 'pending');
      if (!next) {
        // 计划项跑完 → 接着处理待删的重复项
        const removed = await processDuplicates(task);
        await mutateMany([K.TASK_CURRENT], (cur) => {
          const t = { ...(cur?.[K.TASK_CURRENT] || {}) };
          t.removedDuplicates = removed;
          t.status = TASK_STATUS.DONE;
          t.updatedAt = Date.now();
          return { [K.TASK_CURRENT]: t };
        }, {});
        // 兜底补发：某条失败时若接收器刚好没开，那条会留在本机缓冲里。
        // 这里统一再试一次，缓冲上限 200 条，正常情况下是空转。
        await flushPending();
        return;
      }

      // ⚠️⚠️ 子集运行的范围闸门。位置在**动手之前**、在 try 之外：
      //    不在清单里的条目根本不该走到 move()，更不该占用失败日志与重试位。
      //    记成 skipped 而不是 failed —— 它不是「搬失败」，是「本轮不属于我」。
      if (!isInScope(allowed, next.id)) {
        const skippedOutOfScope = [...(task.stale || []), {
          title: next.title, url: next.url, oldId: String(next.id), outOfScope: true,
        }];
        await persistItem(next.id, { status: 'skipped', reason: 'out-of-scope' }, {
          stale: skippedOutOfScope,
          lastDoneIndex: items.indexOf(next),
        });
        sinceYield += 1;
        if (sinceYield >= YIELD_EVERY) {
          await sleep(YIELD_MS);
          sinceYield = 0;
        }
        continue;
      }

      // parentId 提到 try 外面：catch 要靠它核实「目标文件夹到底还在不在」，
      // 而核实结果决定错误文案怎么说 —— 早先那张凭错误文案猜原因的对照表
      // 就是这么把诊断带偏的（见 explainMoveError 的注释）。
      let parentId = null;
      try {
        parentId = await ensureTargetFolder(task, rootId, [rootName, ...next.toPath]);
        await chrome.bookmarks.move(next.id, { parentId });
        // ⚠️ 写完必须回读校验 —— 这是本次踩坑的直接教训。
        //
        //    chrome.bookmarks.move() **resolve 只代表请求被受理，不代表改动留下来了**。
        //    真实环境里有好几股力量会改写书签树：另一个扩展（广告拦截器、书签整理类
        //    插件在变更时自动重排，且不提示不留痕）、Chrome 同步落地、用户自己拖动。
        //    早先不校验，于是「move 成功 → 立刻被改回 → 面板报 100% 成功」，
        //    从用户眼里就是「点了执行整理，书签栏一点没变，也没有任何报错」——
        //    这类故障对用户完全不可见，是最难查的一类。
        //
        //    MV3 扩展开发指南在讲书签写入时也是这条：guard every write with a re-read
        //    （「树会在你读和写之间变化：用户拖了文件夹、另一个扩展重排了、同步落下来了」）。
        await assertMoved(next.id, parentId, next.toPath);
        await persistItem(next.id, { status: 'done' }, {
          lastDoneIndex: items.indexOf(next),
          createdFolders: task.createdFolders,
          folderCache: task.folderCache,
        });
      } catch (e) {
        // 单条失败不中断，记原因继续
        const reason = await explainMoveError(e, { item: next, parentId });
        const failed = [...(task.failed || []), {
          id: next.id, url: next.url, title: next.title, error: reason,
        }];
        await persistItem(next.id, { status: 'failed' }, { failed, lastDoneIndex: items.indexOf(next) });
        // 旁路：把这条失败送到本机接收器，由脚本落成 F 盘上的 jsonl。
        // ⚠️ 放在 persistItem **之后** —— 日志写不进去绝不能影响进度落盘。
        // ⚠️ recordFailure 自己保证不抛，所以这里不需要（也不该）再包 try。
        // ⚠️ 但必须 await：MV3 SW 空闲 30 秒即被回收，不等的话这条可能根本没发出去。
        await recordFailure({
          kind: 'move',
          id: next.id,
          url: next.url,
          title: next.title,
          error: reason,
          fromPath: next.fromPath,
          toPath: next.toPath,
          batch: task.startedAt,
        });
      }

      sinceYield += 1;
      if (sinceYield >= YIELD_EVERY) {
        await sleep(YIELD_MS);
        sinceYield = 0;
      }
    }
  } finally {
    running = false;
  }
}

/**
 * 处理待删除的重复项。返回被删除的条目清单（回滚时要重建）。
 * 删除是不可逆的，所以清单必须落到 task.removedDuplicates。
 *
 * ⚠️ 这里再查一次否决名单，是**兜底**而不是重复劳动：
 *    面板在生成 payload 时已经过滤过一遍，但 payload 落进 storage 后可能被
 *    下一轮预览覆盖、或来自上一次会话的残留计划。
 *    「用户明确说不删的条目被执行器删掉」是不可逆损失，
 *    所以执行侧必须自己认否决名单，不能只信上游。
 */
export async function processDuplicates(task) {
  const list = Array.isArray(task.duplicates) ? task.duplicates : [];
  if (!list.length) return task.removedDuplicates || [];

  const veto = await getDedupeVeto();
  const removed = [...(task.removedDuplicates || [])];
  for (const d of list) {
    if (isDedupeVetoed(d.id, veto)) continue;   // ← 用户否决过，跳过
    try {
      await chrome.bookmarks.remove(d.id);
      removed.push({ url: d.url, title: d.title, path: d.path, keepId: d.keepId });
    } catch (e) {
      const reason = `删除重复项失败: ${e}`;
      const failed = [...(task.failed || []), { id: d.id, url: d.url, title: d.title, error: reason }];
      await mutateMany([K.TASK_CURRENT], (cur) => {
        const t = { ...(cur?.[K.TASK_CURRENT] || {}) };
        t.failed = failed;
        return { [K.TASK_CURRENT]: t };
      }, {});
      // 同样进 F 盘日志。kind 标成 delete，面板上它们和移动失败并排在同一个横幅里，
      // 日志里却不出现的话，面板和日志会自相矛盾。
      await recordFailure({
        kind: 'delete',
        id: d.id,
        url: d.url,
        title: d.title,
        error: reason,
        fromPath: d.path,
        toPath: [],
        batch: task.startedAt,
      });
    }
    await sleep(YIELD_MS);
  }
  return removed;
}

/**
 * 清空当前任务（执行完成后 UI 用）
 */
export async function clearTask() {
  await set(K.TASK_CURRENT, null);
}

export { summarize };
