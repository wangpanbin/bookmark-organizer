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

import { get, set, mutate, remove, K, getSettings, serialize } from './storage.js';
import { flattenTree, readTree } from './tree.js';
import { dedupeKey } from './normalize.js';

const snapKey = (ts) => `snapshot:${ts}`;

/**
 * 取根节点 id（书签栏 '1' / 其他书签 '2' / 移动设备 '3'）。
 * 层级路径第一段就是根名，所以 [0] 即根 id。
 */
function rootIdOf(pathArr) {
  return pathArr && pathArr.length ? pathArr[0] : '1';
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
 * @param {string[]} pathArr 完整路径，第 0 段是根名
 * @param {string[]} [createdOut] 新建的文件夹 [{id, path}]，用于回滚时清理
 * @returns {Promise<string>} 最深层文件夹 id
 */
async function ensurePath(pathArr, createdOut) {
  const rootId = rootIdOf(pathArr);
  const segs = segmentsBelowRoot(pathArr);
  let parentId = String(rootId);
  const acc = [];
  for (const seg of segs) {
    acc.push(seg);
    const r = await ensureFolder(parentId, seg);
    if (r.created && createdOut) createdOut.push({ id: r.id, path: [pathArr[0], ...acc] });
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
  const ts = Number(new Date().toString().replace(/\D/g, '').slice(0, 17)) || Date.now();
  const payload = { ts, note: opts.note || '', trees, flat };

  const text = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(text).length;

  const settings = await getSettings();
  const keep = Math.max(1, Number(settings.keepSnapshots) || 10);

  await set(snapKey(ts), payload);

  const index = (await get(K.SNAPSHOT_INDEX, [])) || [];
  const entry = {
    ts,
    note: opts.note || '',
    count: flat.length,
    urlCount: flat.filter((e) => e.type === 'url').length,
    bytes,
    at: Date.now(),
  };
  const next = [entry, ...index.filter((e) => e.ts !== ts)].sort((a, b) => b.ts - a.ts);

  // 超出保留份数：把最旧的连同其数据一起删掉
  const drop = next.slice(keep);
  const keepList = next.slice(0, keep);
  for (const d of drop) {
    try {
      await remove(snapKey(d.ts));
    } catch {
      /* 删不掉就留着，不影响主流程 */
    }
  }
  await set(K.SNAPSHOT_INDEX, keepList);

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

  const current = flattenTree(await readTree());
  const createdOut = [];

  try {
    // 1) 补齐文件夹
    const snapFolders = (snap.flat || []).filter((e) => e.type === 'folder' && !e.readOnly);
    snapFolders.sort((a, b) => a.path.length - b.path.length);
    for (const f of snapFolders) {
      if (!f.path || f.path.length < 1) continue;
      try {
        const id = await ensurePath(f.path, createdOut);
        void id;
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
          const parentId = await ensurePath(target.path, createdOut);
          await chrome.bookmarks.move(e.id, { parentId });
          report.movedBack += 1;
        } catch (err) {
          report.failures.push({ step: 'moveBack', detail: e.url, error: String(err) });
        }
      } else {
        // 快照之后新增的：放回「其他书签」根
        if (e.path.length <= 1) continue;
        try {
          await chrome.bookmarks.move(e.id, { parentId: '2' });
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
        const parentId = await ensurePath(d.path || ['2'], createdOut);
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
