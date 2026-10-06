/**
 * 归档循环：把队列里的 URL 变成磁盘上的 HTML（重要页另加 PDF + 截图）。
 *
 * ⚠️ 这个模块碰 chrome.storage / fetch，属于写操作模块。
 *
 * ═══ 为什么循环在面板、每片在 SW ═══
 * MV3 的 service worker 空闲 30 秒即被回收（background.js:8 已写明）。
 * 800 条正文逐条重抓 + 逐条送出，必然跨过好几次回收。
 * 所以本模块**每次只处理一个切片**，游标每片落盘，
 * 由面板页驱动循环 —— options 页面是真页面，不会被回收。
 * 这与 link-scan 的 `linkStart` / `linkStep` 是同一个形状，不发明新的。
 *
 * ═══ ⚠️ 为什么这里要重新抓一次正文 ═══
 * 队列 `link:queue` 里存的是 `{url, bytes, at}` —— **只有指针，没有正文**。
 * 那是 `src/scan/runner.js` 有意的决定（它不想把 80MB 塞进扩展存储），
 * 但 `background.js` 早先读的是 `e.html`：
 *
 *     entries.map((e) => ({ url: e.url, html: e.html || '' }))   // ← 恒为 ''
 *
 * 于是每一条都撞上 `archiveOne` 的「没有正文 → skipped」，
 * 面板显示「已归档 0/800」，而按钮看上去一切正常。
 * **一个承诺了归档、实际归档 0 条的按钮，比没有这个按钮更伤。**
 *
 * 所以正文在归档时重抓一次。这也顺带有个好处：归档发生在**用户点按钮的那一刻**，
 * 而不是探测的那一刻 —— 用户标重要页通常就是因为现在还来得及存。
 *
 * 代价是每条多一次 GET。对一个「防链接腐烂」的功能来说这笔账是划算的。
 */

import { get, set, K } from '../storage.js';
import { probeMany } from '../scan/probe.js';
import { archiveMany, probeSink } from './client.js';
import { importantUrlSet } from './important.js';

/** 一次处理几条。20 条在正常响应下约 10 秒，SW 不会被判定为空闲。 */
export const ARCHIVE_SLICE = 20;

function emptyRun(total) {
  return {
    cursor: 0,
    total,
    done: 0,
    fetchFailed: 0,
    postFailed: 0,
    skipped: 0,
    rendered: 0,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** 读当前这一轮归档的进度。 */
export async function getArchiveRun() {
  return (await get(K.ARCHIVE_STATE)) || null;
}

/** 清掉进度。下次点「归档队列里的正文」从头开始。 */
export function resetArchiveRun() {
  return set(K.ARCHIVE_STATE, null).then(() => ({ ok: true }));
}

/** 给面板看的汇总。四个失败类别**必须分开报**，合并成一个数字就是在骗人。 */
export function summarize(run) {
  const r = run || emptyRun(0);
  return {
    cursor: r.cursor,
    total: r.total,
    done: r.done,
    fetchFailed: r.fetchFailed,
    postFailed: r.postFailed,
    skipped: r.skipped,
    rendered: r.rendered,
    remaining: Math.max(0, r.total - r.cursor),
    finished: r.cursor >= r.total,
  };
}

/**
 * 归档一个切片。
 *
 * @param {{queue?:Array, settings?:object, slice?:number, sink?:object}} [opts]
 *   `sink` / `queue` / `settings` 只为测试可注入；生产全部从各自模块自己取。
 * @returns {Promise<object>} summarize() 的形状，外加 `reason`（离线/空队列时的提示）
 */
export async function archiveSlice(opts = {}) {
  const settings = opts.settings || {};
  const sink = opts.sink || await probeSink();
  if (!sink.online) {
    return { ...summarize(await getArchiveRun()), reason: '接收器离线 —— 先跑 python tools/archive_sink.py' };
  }

  const stored = opts.queue || Object.values((await get(K.LINK_QUEUE, {})) || {});
  const queue = Array.isArray(stored) ? stored.filter((e) => e && e.url) : [];
  if (!queue.length) {
    return { ...summarize(null), reason: '队列是空的，先跑一轮链接检测' };
  }

  // ⚠️ 「跑完了」的判据是 **cursor ≥ 当前队列长度**，不是跟存档里的 total 比。
  //    · 拿存档的 total 比：队列在跑完后又长出 50 条（又扫了一轮），
  //      这 50 条会被判成「已经跑完」而永远归档不到。
  //    · 跑完后自动从头再来：用户手滑点第二下，就把 800 条重抓一遍重发一遍，
  //      而按钮上没有任何东西提示这是第二次。要重来必须显式点「从头再归档一遍」。
  let run = await getArchiveRun();
  if (!run) run = emptyRun(queue.length);
  if (run.cursor >= queue.length) {
    return { ...summarize({ ...run, total: queue.length }), reason: null, finished: true };
  }

  const size = Number.isFinite(opts.slice) ? Math.max(1, opts.slice) : ARCHIVE_SLICE;
  const batch = queue.slice(run.cursor, run.cursor + size);

  // 重抓正文。`wantSoft404:false` —— 这里不判软 404，省一次全量正则
  const timeoutMs = Number.isFinite(settings.linkScanTimeoutMs) ? settings.linkScanTimeoutMs : 8000;
  const concurrency = Number.isFinite(settings.linkScanConcurrency) ? settings.linkScanConcurrency : 6;
  const probed = await probeMany(batch.map((e) => e.url), { concurrency, timeoutMs, wantSoft404: false });

  const items = [];
  for (const p of probed) {
    if (!p || !p.result) continue;
    const r = p.result;
    // 页面这会儿已经打不开了 —— 如实记成「重抓失败」，不静默丢
    if (r.error || !r.html) continue;
    items.push({ url: p.url, html: r.html, title: (r.meta && r.meta.pageTitle) || '' });
  }
  run.fetchFailed += batch.length - items.length;

  // G4 的分级在这一行生效：被标星的才带 important，接收器才去渲染
  const importantSet = await importantUrlSet();
  const res = await archiveMany(items, { importantSet });
  for (const r of res) {
    if (r.ok) run.done += 1;
    else if (r.skipped) run.skipped += 1;
    else run.postFailed += 1;
    if (r.rendered && r.rendered.ok) run.rendered += 1;
  }

  run.cursor += batch.length;
  run.total = queue.length;
  run.updatedAt = Date.now();
  await set(K.ARCHIVE_STATE, run);

  return { ...summarize(run), reason: null, finished: run.cursor >= run.total };
}
