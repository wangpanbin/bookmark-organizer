/**
 * 备份快照与回滚。
 *
 * ═══ 为什么必须自己实现 ═══
 * chrome.bookmarks **没有导出/导入 API**（已核对官方 API 参考页）。
 * getTree() 是唯一能拿到完整树（含 id / 路径 / 父子关系）的通道，
 * 所以「备份」只能靠把它整体序列化存进 chrome.storage.local。
 * 连带的后果：**Chrome 没有原生撤销，恢复是唯一退路** ——
 * 这就是为什么备份在 dry-run 阶段就落盘，而不是等到点「执行」前才存。
 */

import { get, mutate, mutateMany, remove, K, getSettings } from './storage.js';
import { flattenTree, readTree } from './tree.js';
import { dedupeKey } from './normalize.js';

const snapKey = (ts) => `snapshot:${ts}`;

/**
 * Chrome 三个根的 **id** 是固定契约：1=书签栏 2=其他书签 3=移动设备书签。
 * 随界面语言变的只是它们的**标题**。
 *
 * 所以规矩是：找根必须「标题 → id」反查（标题本地化，不能写死），
 * 而「指向某个根」可以用固定 id —— 但必须走常量，不写裸字面量。
 */
const ROOT_ID = Object.freeze({ BAR: '1', OTHER: '2', MOBILE: '3' });

/** 路径第 0 段是不是已经是一个根 id（而不是根名） */
function isRootId(seg) {
  return Object.values(ROOT_ID).includes(String(seg));
}

/**
 * 把根文件夹**名**换成根文件夹 **id**。
 *
 * ⚠️ 踩过的坑：这里曾经直接 `return pathArr[0]`，把「书签栏」这个**名字**
 *    当成 parentId 传给了 chrome.bookmarks.move()，而 API 只认 id（'1'/'2'/'3'）。
 *    根名随界面语言变，不能硬编码，所以从 getTree() 里反查。
 *    症状是「回滚对根级书签全部静默失败」—— 不报错，只是没归位。
 *
 * @param {string} rootName
 * @param {Array} tops getTree()[0].children
 * @returns {string} 根 id
 */
function rootIdFromName(rootName, tops) {
  const hit = (tops || []).find((t) => !t.url && t.title === rootName);
  if (hit) return String(hit.id);
  // 兜底：路径里的根名在树上找不到（根被删或被改名）。
  // 这里只按 id 契约回落，**不再比对中文字面量** —— 根标题是本地化的，
  // 拿「其他书签」四个字去比，在非中文 Chrome 上必然匹配不上，
  // 而匹配不上时静默回落到书签栏，正是上面那个「不报错只是没归位」的坑。
  return ROOT_ID.BAR;
}

/** 某段路径相对根之下的层级，用于建目录时逐级下降 */
function segmentsBelowRoot(pathArr) {
  return pathArr.slice(1);
}

/**
 * 在 parentId 下找一个同名文件夹，没有就建。
 * @returns {Promise<{id:string, created:boolean}>}
 */
async function ensureFolder(parentId, title) {
  const children = await chrome.bookmarks.getChildren(parentId);
  const found = (children || []).find((c) => !c.url && c.title === title);
  if (found) return { id: String(found.id), created: false };
  const created = await chrome.bookmarks.create({ parentId: String(parentId), title });
  return { id: String(created.id), created: true };
}

/**
 * 按路径逐级确保文件夹存在。
 *
 * ⚠️ 路径第 0 段允许是根**名**（正常情况），也允许直接是根 **id**。
 *    去重清单里的 path 在取不到源条目时会退化成 ['2']（见 ui/options.js 的 dupPayload），
 *    把它当根名丢给 rootIdFromName 会一路回落到书签栏，
 *    症状是**恢复出来的重复项静默落进书签栏**，不报错、清单上还看不出来。
 *    所以这里先判一次是不是根 id，是就直接拿它当起点。
 *
 * @param {string[]} pathArr 完整路径，第 0 段是根名（或根 id）
 * @param {Array} tops getTree()[0].children，用于把根名换成根 id
 * @param {string[]} [createdOut] 新建的文件夹 [{id, path}]
 * @returns {Promise<string>} 最深层文件夹 id
 */
async function ensurePath(pathArr, tops, createdOut) {
  const head = pathArr[0];
  const rootId = isRootId(head) ? String(head) : rootIdFromName(head, tops);
  const segs = segmentsBelowRoot(pathArr);
  let parentId = String(rootId);
  const acc = [];
  for (const seg of segs) {
    acc.push(seg);
    const r = await ensureFolder(parentId, seg);
    if (r.created && createdOut) createdOut.push({ id: r.id, path: [head, ...acc] });
    parentId = r.id;
  }
  return parentId;
}

// ───────────────────────── 快照 ─────────────────────────

/**
 * 创建一个快照。
 * @param {{note?: string, force?: boolean}} [opts]
 * @returns {Promise<{ts:number, count:number, urlCount:number, bytes:number}>}
 */
export async function createSnapshot(opts = {}) {
  const trees = await readTree();
  const flat = flattenTree(trees);
  const note = opts.note || '';

  const settings = await getSettings();
  const keep = Math.max(1, Number(settings.keepSnapshots) || 10);

  // ⚠️ 快照数据与索引必须在**同一个临界区**里一起写。
  //    分开写会留下两种半状态：索引里有、数据没有（回滚当场失败），
  //    或者数据有、索引没有（备份静默消失，用户以为存上了）。
  //    索引自身的读-改-写也必须整段待在临界区内 ——
  //    旧写法是 get → 算 → set 三次独立进出锁，两次并发备份会互相覆盖索引。
  let entry = null;
  let droppedKeys = [];
  await mutateMany([K.SNAPSHOT_INDEX], (cur) => {
    const index = Array.isArray(cur[K.SNAPSHOT_INDEX]) ? cur[K.SNAPSHOT_INDEX] : [];

    // ts 用毫秒并在临界区内去重。旧写法从 `new Date().toString()` 里抽数字，
    // 只有**秒级**精度且是本地化字符串 —— 同一秒内做两次备份，
    // 后一次会整个覆盖前一份（索引里同 ts 的旧条目被 filter 掉、数据被同名键覆盖），
    // 症状是「明明点了两次备份，列表里只有一条」。
    let ts = Date.now();
    while (index.some((e) => e.ts === ts)) ts += 1;

    const payload = { ts, note, trees, flat };
    entry = {
      ts,
      note,
      count: flat.length,
      urlCount: flat.filter((e) => e.type === 'url').length,
      bytes: new TextEncoder().encode(JSON.stringify(payload)).length,
      at: Date.now(),
    };

    const next = [entry, ...index.filter((e) => e.ts !== ts)].sort((a, b) => b.ts - a.ts);
    const keepList = next.slice(0, keep);
    droppedKeys = next.slice(keep).map((d) => snapKey(d.ts));

    return { [snapKey(ts)]: payload, [K.SNAPSHOT_INDEX]: keepList };
  }, { [K.SNAPSHOT_INDEX]: [] });

  // 淘汰旧快照的数据放在临界区**之外**：索引已经不含它们，
  // 删不掉只是留下没人看得见的孤儿数据，不会让用户回滚到错的东西。
  for (const k of droppedKeys) {
    try {
      await remove(k);
    } catch {
      /* 删不掉就留着，不影响主流程 */
    }
  }

  return entry;
}

/** 列出快照（按时间倒序） */
export async function listSnapshots() {
  return (await get(K.SNAPSHOT_INDEX, [])) || [];
}

/** 读一份快照 */
export async function readSnapshot(ts) {
  return (await get(snapKey(ts))) || null;
}

/** 删一份快照 */
export async function deleteSnapshot(ts) {
  await remove(snapKey(ts));
  await mutate(
    K.SNAPSHOT_INDEX,
    (cur) => (cur || []).filter((e) => e.ts !== ts),
    [],
  );
}

// ───────────────────────── 回滚 ─────────────────────────

/**
 * 恢复到某次快照。
 *
 * ⚠️ 这是「回滚」不是「时间机器」：它把书签**归位**到快照时的位置，
 *    并不会撤销用户在这期间自己做的编辑。这是我们能做的最好程度。
 *
 * 步骤：
 *   1) 建出快照里有、现在没有的文件夹（父先子后）
 *   2) 快照里有的书签 → 移回快照中的路径（已在位则跳过）
 *   3) 快照之后新增的书签 → 移回「其他书签」根，并报告数量
 *   4) 删掉本次任务新建、且现在为空的文件夹（用任务记录里的 createdFolders 精确判定，
 *      不靠「空文件夹」猜 —— 那样分不清是我们建的空文件夹和用户自己建的空文件夹）
 *   5) 重建本次任务删掉的重复项
 *
 * 单条失败不中断，集中在 failures 里返回。
 *
 * @param {number} ts
 * @returns {Promise<{ok:boolean, moved:number, movedBack:number, movedNew:number,
 *                    foldersCreated:number, foldersRemoved:number, dupRestored:number,
 *                    failures:Array<{step:string,detail:string,error:string}>, aborted:boolean}>}
 */
export async function restoreSnapshot(ts) {
  const snap = await readSnapshot(ts);
  const report = {
    ok: true,
    moved: 0,
    movedBack: 0,
    movedNew: 0,
    foldersCreated: 0,
    foldersRemoved: 0,
    dupRestored: 0,
    failures: [],
    aborted: false,
  };
  if (!snap) {
    return { ...report, ok: false, aborted: true, failures: [{ step: 'load', detail: String(ts), error: '快照不存在' }] };
  }

  // 快照里 url 节点 → 路径（按归一化 URL 索引；书签 id 在重建后会变，不能用 id）
  const snapByUrl = new Map();
  for (const e of snap.flat || []) {
    if (e.type !== 'url' || e.readOnly) continue;
    const k = dedupeKey(e.url);
    if (k && !snapByUrl.has(k)) snapByUrl.set(k, e);
  }

  const treesNow = await readTree();
  const tops = treesNow?.[0]?.children || [];
  const current = flattenTree(treesNow);
  const createdOut = [];

  try {
    // 1) 补齐文件夹
    const snapFolders = (snap.flat || []).filter((e) => e.type === 'folder' && !e.readOnly);
    snapFolders.sort((a, b) => a.path.length - b.path.length);
    for (const f of snapFolders) {
      if (!f.path || f.path.length < 1) continue;
      try {
        await ensurePath(f.path, tops, createdOut);
        report.foldersCreated += 1;
      } catch (e) {
        report.failures.push({ step: 'ensureFolder', detail: f.path.join('/'), error: String(e) });
      }
    }

    // 2) + 3) 归位
    for (const e of current) {
      if (e.type !== 'url' || e.readOnly) continue;
      const k = dedupeKey(e.url);
      const target = k ? snapByUrl.get(k) : null;

      if (target) {
        if (target.path.join('/') === e.path.join('/')) continue; // 已在位
        try {
          const parentId = await ensurePath(target.path, tops, createdOut);
          await chrome.bookmarks.move(e.id, { parentId });
          report.movedBack += 1;
        } catch (err) {
          report.failures.push({ step: 'moveBack', detail: e.url, error: String(err) });
        }
      } else {
        // 快照之后新增的：放回「其他书签」根。
        // 走 ROOT_ID.OTHER 而不是裸写 '2' —— 同文件里就有 rootIdFromName
        // 这套「根名↔根 id」的解析，绕开它等于把规则又破一次。
        if (e.path.length <= 1) continue;
        try {
          await chrome.bookmarks.move(e.id, { parentId: ROOT_ID.OTHER });
          report.movedNew += 1;
        } catch (err) {
          report.failures.push({ step: 'moveNew', detail: e.url, error: String(err) });
        }
      }
    }
    report.moved = report.movedBack + report.movedNew;

    // 4) 清理本次任务新建的空文件夹
    const task = (await get(K.TASK_CURRENT)) || {};
    const createdList = Array.isArray(task.createdFolders) ? task.createdFolders : [];
    // 深路径先删（子先父），且只删已经空掉的
    const ordered = [...createdList].sort((a, b) => (b.path?.length || 0) - (a.path?.length || 0));
    for (const cf of ordered) {
      try {
        const children = await chrome.bookmarks.getChildren(cf.id);
        if ((children || []).length === 0) {
          await chrome.bookmarks.removeTree(cf.id);
          report.foldersRemoved += 1;
        }
      } catch {
        /* 已不存在或非空，跳过 */
      }
    }

    // 5) 重建被删掉的重复项
    const removedDups = Array.isArray(task.removedDuplicates) ? task.removedDuplicates : [];
    for (const d of removedDups) {
      try {
        const parentId = await ensurePath(d.path || ['2'], tops, createdOut);
        await chrome.bookmarks.create({ parentId, title: d.title || d.url, url: d.url });
        report.dupRestored += 1;
      } catch (err) {
        report.failures.push({ step: 'restoreDup', detail: d.url, error: String(err) });
      }
    }
  } catch (e) {
    report.ok = false;
    report.aborted = true;
    report.failures.push({ step: 'fatal', detail: '', error: String(e) });
  }

  // 恢复完成后清掉任务里的「新建文件夹 / 已删重复项」记录，
  // 否则再恢复一次会重复处理
  await mutate(
    K.TASK_CURRENT,
    (cur) => ({ ...(cur || {}), createdFolders: [], removedDuplicates: [] }),
    {},
  );

  return report;
}
