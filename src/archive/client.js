/**
 * 归档客户端：把抓到的正文送给本机接收器落盘。
 *
 * ⚠️ 这个模块会 fetch（打到 127.0.0.1）与 chrome.storage，属于写操作模块。
 *
 * ═══ 为什么不把正文存在扩展里 ═══
 * 「重要页存永久副本，原站挂了也能读」——**永久**与「扩展存储」在语义上互斥：
 * 扩展一卸载，扩展存储就全没了。所以落点只能是本机磁盘。
 *
 * ⚠️ 侧车没开时**不静默降级**。这与 `fail-log.js` 的做法刻意不同：
 *   · 日志小、可丢、丢了只影响排查 → 静默缓冲 + 手动导出
 *   · 归档是「防链接腐烂」这件事的**全部价值所在**，缓冲 80MB 进扩展存储不现实，
 *     而「以为存了其实没存」正是本项目栽过最多的那类坑
 * 所以这里直接把「接收器离线」这件事说出来，面板上有一行状态。
 */

const SINK_PORT = 8732;
const TIMEOUT_MS = 15_000;
const MAX_LOCAL_BODY = 512 * 1024;

let sinkStatus = { online: false, checkedAt: 0, written: 0, reason: '' };

/** 探接收器。面板上那行「接收器状态」的唯一依据。 */
export async function probeSink() {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 3000);
  try {
    const res = await fetch(`http://127.0.0.1:${SINK_PORT}/health`, { signal: c.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    sinkStatus = { online: true, checkedAt: Date.now(), written: d.written || 0, reason: '', dir: d.dir || '' };
  } catch (e) {
    sinkStatus = {
      online: false, checkedAt: Date.now(), written: 0,
      reason: '没起接收器：python tools/archive_sink.py',
    };
  } finally {
    clearTimeout(t);
  }
  return sinkStatus;
}

export function getSinkStatus() {
  return sinkStatus;
}

/**
 * 送一条去归档。
 *
 * @param {{url:string, html:string, title?:string, important?:boolean}} item
 * @returns {Promise<{ok:boolean, file?:string, skipped?:boolean, reason?:string}>}
 */
export async function archiveOne(item) {
  if (!item || !item.url) return { ok: false, reason: '缺 url' };
  const html = String(item.html || '');
  if (!html) return { ok: false, skipped: true, reason: '没有正文' };

  const c = new AbortController();
  const t = setTimeout(() => c.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${SINK_PORT}/archive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: item.url,
        // 只送前 512KB：再大对「原站挂了也能读」这个目标没有额外价值
        html: html.slice(0, MAX_LOCAL_BODY),
        title: item.title || '',
        important: item.important === true,
      }),
      signal: c.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      sinkStatus = { ...sinkStatus, online: false, checkedAt: Date.now(), reason: `HTTP ${res.status}` };
      return { ok: false, reason: `接收器返回 ${res.status}：${text.slice(0, 120)}` };
    }
    const out = JSON.parse(text);
    sinkStatus = { ...sinkStatus, online: true, checkedAt: Date.now(), written: sinkStatus.written + 1 };
    return { ok: true, file: out.file, skipped: out.skipped, rendered: out.rendered };
  } catch (e) {
    sinkStatus = {
      online: false, checkedAt: Date.now(), written: sinkStatus.written,
      reason: '没起接收器：python tools/archive_sink.py',
    };
    return { ok: false, reason: sinkStatus.reason };
  } finally {
    clearTimeout(t);
  }
}

/**
 * 批量归档（从 link-scan 的队列来）。
 * ⚠️ 串行：一次并发十几条大正文会把本机内存顶起来，
 *    而归档不是实时任务，没有并发的收益。
 *
 * @param {Array<{url:string, html:string, title?:string}>} items
 * @param {{onProgress?:Function, importantSet?:Set<string>}} [opts]
 */
export async function archiveMany(items, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  const results = [];
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    const r = await archiveOne({ ...it, important: opts.importantSet?.has(it.url) === true });
    results.push(r);
    opts.onProgress?.({ done: i + 1, total: list.length });
  }
  return results;
}
