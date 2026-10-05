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
import { toRemovalList } from './dedupe.js';
import { recordFailure, flushPending } from './fail-log.js';

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
  if (found) return { id: String(found.id), created: false };
  const created = await chrome.bookmarks.create({ parentId: String(parentId), title });
  if (createdOut) createdOut.push({ id: String(created.id), path: [title] });
  return { id: String(created.id), created: true };
}

/**
 * 把设置里的根 id（'1' 书签栏 / '2' 其他书签）解析成**根文件夹名**。
 *
 * ⚠️ 路径模型（踩过一次的坑）：
 *    fromPath 的第 0 段是根**名称**，toPath 则**不含根**（就是 taxonomy 的 '大类/子类'）。
 *    根归到哪是「写到哪儿」的问题，由 settings.targetRoot 决定，所以 plan.js 不参与。
 *    写盘时必须把根名补回去，而 chrome.bookmarks 的 API 要的是**根 id**，
 *    所以这里先由 id 反查名字（根名随界面语言变，不能硬编码）。
 */
async function resolveRootName() {
  const settings = await getSettings();
  const trees = await chrome.bookmarks.getTree();
  const tops = trees?.[0]?.children || [];
  const hit = tops.find((t) => String(t.id) === String(settings.targetRoot || '1'));
  // 兜底：根 id 在任何语言下都是 1（书签栏）
  return { rootId: hit ? String(hit.id) : '1', rootName: hit ? hit.title : '书签栏' };
}

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

  // plan 要能被下面的 reconcile 替换掉，所以必须是 let —— 早先写成 const 又去赋值，
  // 抛 `Assignment to constant variable`，整批任务直接启动失败。
  let { plan, duplicates = [], snapshotTs = null } = payload || {};
  if (!plan || !Array.isArray(plan.items)) return { started: false, reason: '计划为空' };

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
 * ⚠️ 为什么必须翻译：Chrome 对几种**完全不同的**故障只有三句话，
 *    探针实测（tests/e2e/probe-errid.js）：
 *      Can't find bookmark for id.      ← 源书签 id 不存在
 *      Can't find parent bookmark for id.← 目标文件夹 id 不存在
 *      Bookmark id is invalid.          ← id 不是数字
 *    2026-10-05 用户拿到 45 条「Can't find bookmark for id.」，
 *    光看这句既不知道是哪条、也不知道该查什么，只能干瞪眼。
 *
 * @param {unknown} e
 * @returns {string}
 */
export function explainMoveError(e) {
  const raw = String(e && e.message ? e.message : e);
  if (/Can't find parent bookmark for id/i.test(raw)) {
    return `${raw} —— 目标文件夹已经不存在了（可能被其他扩展删掉，或同步覆盖了）。`
      + '重新点一次「读取并预览」再执行即可。';
  }
  if (/Can't find bookmark for id/i.test(raw)) {
    return `${raw} —— 这条书签在当前书签树里已经不存在了`
      + '（删过又重建、或恢复过备份，都会让 id 失效）。'
      + '请点「读取并预览」重新算一份计划。';
  }
  if (/Bookmark id is invalid/i.test(raw)) {
    return `${raw} —— 书签 id 格式不对，节点已被删除。请重新预览。`;
  }
  if (/Can't modify the root/i.test(raw)) {
    return `${raw} —— 不能把书签移动到根目录。`;
  }
  return raw;
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
    // 根 id/名在整轮里固定，解析一次就够
    const { rootId, rootName } = await resolveRootName();
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

      try {
        const parentId = await ensureTargetFolder(task, rootId, [rootName, ...next.toPath]);
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
        const reason = explainMoveError(e);
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
