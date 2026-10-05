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
} from './storage.js';
import { toRemovalList } from './dedupe.js';

/** 模块级重入保护 */
let running = false;
/** 让出事件循环的间隔。每条都 await 一个宏任务，保证 API 调用有机会派发出去 */
const YIELD_EVERY = 1;
const YIELD_MS = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 任务进度摘要（写进 storage，供 UI 轮询） */
function summarize(task) {
  const items = task.plan?.items || [];
  return {
    status: task.status,
    total: items.length,
    done: items.filter((i) => i.status === 'done').length,
    skipped: items.filter((i) => i.status === 'skipped').length,
    failed: items.filter((i) => i.status === 'failed').length,
    pending: items.filter((i) => i.status === 'pending').length,
    failedList: (task.failed || []).slice(0, 50),
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
  if (found) return String(found.id);
  const created = await chrome.bookmarks.create({ parentId: String(parentId), title });
  if (createdOut) createdOut.push({ id: String(created.id), path: [title] });
  return String(created.id);
}

/**
 * 确保目标路径存在，返回最深层文件夹 id。
 * 优先查 folderCache，再查真实树（缓存可能因用户手动删目录而失效），
 * 都没有才创建。
 *
 * @param {object} task 任务对象（会被就地补上 folderCache / createdFolders）
 * @param {string[]} toPath [根名, 大类, 子类]
 * @returns {Promise<string>}
 */
async function ensureTargetFolder(task, toPath) {
  const [rootName, ...segs] = toPath;
  const cache = task.folderCache || (task.folderCache = {});
  const createdOut = task.createdFolders || (task.createdFolders = []);

  // 根 id 就是 Chrome 的固定根名（书签栏/其他书签/移动设备书签）
  const rootId = rootName;
  let parentId = rootId;
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
    const id = await ensureFolder(parentId, seg, null);
    // 新建的话记下来（回滚时要精确清理）
    const fullPath = [rootName, ...acc];
    const isNew = !createdOut.some((c) => c.id === id);
    if (isNew) createdOut.push({ id, path: fullPath });
    cache[key] = id;
    parentId = id;
  }
  return parentId;
}

/** 每完成一条就落盘（断点续跑的关键） */
async function persistItem(item, extra) {
  return mutateMany(
    [K.TASK_CURRENT],
    (cur) => {
      const t = { ...(cur || {}) };
      const items = (t.plan?.items || []).map((i) => (i.id === item.id ? { ...i, ...item } : i));
      t.plan = { ...(t.plan || {}), items };
      t.lastDoneIndex = extra?.lastDoneIndex ?? t.lastDoneIndex;
      if (extra?.failed) t.failed = extra.failed;
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
 * 开始执行（或继续）。把 plan 写进 task 后进入主循环。
 *
 * @param {{plan: object, duplicates?: Array, snapshotTs?: number}} payload
 * @returns {Promise<{started:boolean, reason?:string}>}
 */
export async function startExecution(payload) {
  if (running) return { started: false, reason: '已在执行中' };

  const { plan, duplicates = [], snapshotTs = null } = payload || {};
  if (!plan || !Array.isArray(plan.items)) return { started: false, reason: '计划为空' };

  // 执行前先落一份快照 —— 回滚是唯一退路，必须在动第一个字节之前就有
  let snapTs = snapshotTs;
  if (snapTs == null) {
    const { createSnapshot } = await import('./backup.js');
    const snap = await createSnapshot({ note: '执行前自动备份' });
    snapTs = snap.ts;
  }

  const task = {
    status: TASK_STATUS.RUNNING,
    plan,
    duplicates,
    lastDoneIndex: -1,
    failed: [],
    createdFolders: [],
    removedDuplicates: [],
    folderCache: {},
    startedAt: Date.now(),
    updatedAt: Date.now(),
    snapshotTs: snapTs,
  };
  await set(K.TASK_CURRENT, task);

  await run();
  return { started: true, snapshotTs: snapTs };
}

/** 继续执行（worker 被回收后，或用户手动继续） */
export async function resumeExecution() {
  if (running) return { started: false, reason: '已在执行中' };
  const task = await getTask();
  if (!task.plan) return { started: false, reason: '没有待执行的任务' };
  if (task.status === TASK_STATUS.DONE) return { started: false, reason: '任务已完成' };

  await mutate(K.TASK_CURRENT, (cur) => ({ ...(cur || {}), status: TASK_STATUS.RUNNING, updatedAt: Date.now() }), {});
  await run();
  return { started: true };
}

/** 暂停 */
export async function pauseExecution() {
  return mutate(K.TASK_CURRENT, (cur) => ({ ...(cur || {}), status: TASK_STATUS.PAUSED, updatedAt: Date.now() }), {});
}

/**
 * 主执行循环。每条 move 成功后立刻落盘。
 * 用 while(true) + 找下一个 pending，而不是 for 遍历 —— 这样被暂停/中断后
 * 重新进来能自然地从断点继续。
 */
async function run() {
  if (running) return;
  running = true;
  try {
    let sinceYield = 0;
    for (;;) {
      const task = await getTask();
      if (!task.plan) return;
      if (task.status !== TASK_STATUS.RUNNING) return;

      const items = task.plan.items || [];
      const next = items.find((i) => i.status === 'pending');
      if (!next) {
        // 计划项跑完 → 接着处理待删的重复项
        const removed = await processDuplicates(task);
        await mutateMany([K.TASK_CURRENT], (cur) => {
          const t = { ...(cur || {}) };
          t.removedDuplicates = removed;
          t.status = TASK_STATUS.DONE;
          t.updatedAt = Date.now();
          return { [K.TASK_CURRENT]: t };
        }, {});
        return;
      }

      try {
        const parentId = await ensureTargetFolder(task, next.toPath);
        await chrome.bookmarks.move(next.id, { parentId });
        await persistItem(next, {
          status: 'done',
          lastDoneIndex: items.indexOf(next),
          createdFolders: task.createdFolders,
          folderCache: task.folderCache,
        });
      } catch (e) {
        // 单条失败不中断，记原因继续
        const failed = [...(task.failed || []), { id: next.id, url: next.url, title: next.title, error: String(e) }];
        await persistItem(next, { status: 'failed', failed, lastDoneIndex: items.indexOf(next) });
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
 */
async function processDuplicates(task) {
  const list = Array.isArray(task.duplicates) ? task.duplicates : [];
  if (!list.length) return task.removedDuplicates || [];

  const removed = [...(task.removedDuplicates || [])];
  for (const d of list) {
    try {
      await chrome.bookmarks.remove(d.id);
      removed.push({ url: d.url, title: d.title, path: d.path, keepId: d.keepId });
    } catch (e) {
      const failed = [...(task.failed || []), { id: d.id, url: d.url, title: d.title, error: `删除重复项失败: ${e}` }];
      await mutateMany([K.TASK_CURRENT], (cur) => {
        const t = { ...(cur || {}) };
        t.failed = failed;
        return { [K.TASK_CURRENT]: t };
      }, {});
    }
    await sleep(YIELD_MS);
  }
  return removed;
}

/** 把去重结果转成执行器要的形状 */
export function toDuplicatePayload(groups, entriesById) {
  return toRemovalList(groups).map((d) => {
    const src = entriesById.get(d.id);
    return { id: d.id, url: d.url, title: d.title, path: src?.path || ['2'], keepId: d.keepId };
  });
}

/** 清空当前任务（执行完成后 UI 用） */
export async function clearTask() {
  await set(K.TASK_CURRENT, null);
}

export { summarize };
