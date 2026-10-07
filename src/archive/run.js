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
 *
 * ═══ ⚠️ 为什么进度是「增量 + 游标守卫」写回，而不是整份覆盖 ═══
 * 早先这里是 `let run = await getArchiveRun()` …（跨过整段网络）… `set(K.ARCHIVE_STATE, run)`。
 * 那是 AGENTS.md 第 2 条明令禁止的读-改-写，而且**中间隔着几十秒的网络**，
 * 窗口大到不是理论风险：
 *   · 用户在这期间点「从头再归档一遍」（`resetArchiveRun` 置 null）
 *     → 这一片结束时把已清空的状态**原样写回**，用户的重置被静默撤销；
 *   · 两个面板页 / 双击按钮让两个调用读到同一个 cursor=0
 *     → 各自 `cursor += 20` 后整份覆盖，游标从 0 跳到 20，
 *       中间那 20 条**永久跳过**，面板显示「扫完了」而它们从没被归档。
 * 所以现在：网络在临界区**之外**跑完，结果压成一份 `delta`，
 * 进 `mutate` 时基于**当前**值累加，并带一道游标守卫
 * （`base.cursor !== startCursor` → SKIP，不写）。
 * 守卫挡的是「重复推进」：宁可这一片不计数、下一片重发一次
 * （归档文件名按 URL 稳定哈希，重发是覆盖不是重复），也不丢条目。
 */

import { get, set, mutate, SKIP, K } from '../storage.js';
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
  // ⚠️ 钉住起点：它后面是写回时的游标守卫条件（「我还基于这个位置在算」）
  const startCursor = run.cursor;
  const batch = queue.slice(startCursor, startCursor + size);

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
  // ⚠️ 以下全部只往 delta 上加，**不碰 run**。run 是几十秒前读出来的快照，
  //    拿它当累加器就等于把读-改-写又搬回临界区外。
  const delta = { done: 0, fetchFailed: batch.length - items.length, postFailed: 0, skipped: 0, rendered: 0 };

  // G4 的分级在这一行生效：被标星的才带 important，接收器才去渲染
  const importantSet = await importantUrlSet();
  const res = await archiveMany(items, { importantSet });
  for (const r of res) {
    if (r.ok) delta.done += 1;
    else if (r.skipped) delta.skipped += 1;
    else delta.postFailed += 1;
    if (r.rendered && r.rendered.ok) delta.rendered += 1;
  }

  // 增量写回 + 游标守卫。理由见文件顶部那一节。
  let superseded = false;
  const next = await mutate(K.ARCHIVE_STATE, (cur) => {
    const base = cur && Number.isFinite(cur.cursor) ? cur : emptyRun(queue.length);
    if (base.cursor !== startCursor) {
      superseded = true;
      return SKIP;
    }
    return {
      ...base,
      cursor: startCursor + batch.length,
      total: queue.length,
      done: base.done + delta.done,
      fetchFailed: base.fetchFailed + delta.fetchFailed,
      postFailed: base.postFailed + delta.postFailed,
      skipped: base.skipped + delta.skipped,
      rendered: base.rendered + delta.rendered,
      // 空跑一轮（队列非空但没有一条能重抓）也要有个 startedAt，
      // 否则面板上的「开始于」是 0
      startedAt: base.startedAt || Date.now(),
      updatedAt: Date.now(),
    };
  }, null);

  if (superseded) {
    // 有人推进过了。**如实报当前真实进度**，不把这片的计数叠上去
    // —— 叠上去就是重复计数，而重复计数比少计数更难被发现。
    const real = await getArchiveRun();
    return {
      ...summarize(real),
      reason: '另一个归档循环已推进了进度；本批正文已落盘（文件名按 URL 稳定哈希，重发是覆盖不是重复），但未计入进度',
      finished: !!real && real.cursor >= queue.length,
      superseded: true,
    };
  }

  return { ...summarize(next), reason: null, finished: next.cursor >= next.total, superseded: false };
}
