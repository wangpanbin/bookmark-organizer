/**
 * 扫描循环：把书签树变成探测队列，逐条探、逐条落盘、可中断可续跑。
 *
 * ⚠️ 这个模块碰 chrome.storage / chrome.alarms / fetch，属于写操作模块。
 *
 * ═══ 为什么它是整个功能里最容易坏的一段 ═══
 * MV3 的 service worker **空闲 30 秒即被回收**（background.js:8 已写明）。
 * 一次全量扫描 800 条要走很久，中间必然被回收好几次。
 *
 * 所以这里的纪律只有一条：**每探完一条立刻落盘 + 存游标**。
 * 任何「等这一轮跑完再统一写」的写法都会在回收时丢掉整轮结果，
 * 而且症状极其恶劣 —— 面板显示「扫完了」，实际上一条都没记下来。
 *
 * 形状照抄 `src/apply.js` 的 `task.current` / `lastDoneIndex` 范式，
 * 不发明新的。
 */

import { get, mutate, set, K } from '../storage.js';
import { probeMany } from './probe.js';
import { classifyProbe, VERDICT, summarize } from './verdict.js';
import { advanceFailState, shouldMarkDead } from './dead-threshold.js';

/** 扫描循环的状态。合法值与 TASK_STATUS 同构，便于面板复用那套渲染。 */
export const LINK_STATUS = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused',
  DONE: 'done',
});

/** 空状态。getState 永远返回它，调用方不用到处判空。 */
function emptyState() {
  return {
    status: LINK_STATUS.IDLE,
    round: 0,
    // ⚠️ 队列存的是 {id, url} 而不是光 id。
    //    早先只存 ids，探测时从「上一条记录」里取 url —— 而第一轮没有上一条，
    //    于是探测的是空字符串。症状极其恶劣：面板显示「扫完了」，
    //    而每一条都是失败，一条都没真正探到。
    entries: [],
    ids: [],
    cursor: 0,
    total: 0,
    startedAt: 0,
    updatedAt: 0,
    finishedAt: 0,
    lastError: '',
  };
}

export async function getLinkState() {
  return (await get(K.LINK_STATE)) || emptyState();
}

/**
 * 读一条书签的探测记录。
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function getRecord(id) {
  return (await get(K.linkRec(id))) || null;
}

/** 写一条记录。走 storage 的串行链。 */
export async function putRecord(id, rec) {
  return set(K.linkRec(id), rec);
}

/**
 * 一次「立即检测」的完整推进。
 *
 * @param {{budgetMs?:number, settings?:object, now?:number, round?:number}} [opts]
 * @returns {Promise<{done:boolean, processed:number, total:number, state:object}>}
 */
export async function runSlice(opts = {}) {
  const budgetMs = Number.isFinite(opts.budgetMs) ? opts.budgetMs : 20_000;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const st = opts.settings || {};
  const timeoutMs = Number.isFinite(st.linkScanTimeoutMs) ? st.linkScanTimeoutMs : 8000;
  const concurrency = Number.isFinite(st.linkScanConcurrency) ? st.linkScanConcurrency : 6;

  // ① 取状态。游标只信 storage，绝不信 SW 内存 —— 唤醒后内存态必然是空的
  let state = await getLinkState();
  if (state.status !== LINK_STATUS.RUNNING) {
    // 新的一轮
    state = {
      ...emptyState(),
      status: LINK_STATUS.RUNNING,
      round: Number.isFinite(opts.round) ? opts.round : state.round + 1,
      startedAt: now,
    };
  }

  // ② 本批要探的 id
  const slice = state.entries.slice(state.cursor, state.cursor + concurrency * 4);
  if (slice.length === 0) {
    state.status = LINK_STATUS.DONE;
    state.finishedAt = now;
    state.updatedAt = now;
    await set(K.LINK_STATE, state);
    return { done: true, processed: state.cursor, total: state.total, state };
  }

  // ③ 读旧记录，算出新的失败计数
  const prevs = new Map();
  for (const e of slice) {
    const r = await getRecord(e.id);
    if (r) prevs.set(e.id, r);
  }

  // ④ 并发探这一批。**URL 取自队列本身**，不是从上一条记录里取
  const deadline = now + budgetMs;
  const results = await probeMany(
    slice.map((e) => e.url),
    {
      concurrency,
      timeoutMs,
      wantSoft404: st.linkScanSoft404 !== false,
      shouldStop: () => Date.now() > deadline,
    },
  );

  // ⑤ 逐条落盘。**每条都写**，不等这一批跑完
  let processed = 0;
  for (let i = 0; i < results.length; i++) {
    const id = slice[i].id;
    const r = results[i];
    // ⚠️ 游标**必须无条件前进**，哪怕这条结果拿不到。
    //    早先这里是 `if (!r) continue;` —— 跳过了下面那句 `state.cursor += 1`，
    //    于是只要有一条拿不到结果，游标就永远停在它前面：
    //    每一轮都重试同一条，800 条里卡住一条就再也走不到终点。
    //    「这一条没探到」要如实记成一条记录，而不是让它把整轮拖死。
    if (r) {
      const prev = prevs.get(id) || {};
      const res = r.result || {};
      const ok = Number.isFinite(res.status) && res.status >= 200 && res.status < 400 && !res.error;
      const fail = advanceFailState(
        { failStreak: prev.failStreak, firstFailAt: prev.firstFailAt },
        { status: res.status, ok, now },
      );

      const rec = {
        id,
        url: r.url,
        checkedAt: now,
        status: res.status,
        finalUrl: res.finalUrl,
        redirected: res.redirected,
        sameSite: res.sameSite,
        error: res.error,
        probeMethod: res.probeMethod,
        failStreak: fail.failStreak,
        firstFailAt: fail.firstFailAt,
        lastOkAt: ok ? now : (prev.lastOkAt || 0),
        soft404: res.soft404 === true,
        pageTitle: res.meta?.pageTitle || '',
        description: res.meta?.description || '',
        siteName: res.meta?.siteName || '',
        ogImage: res.meta?.ogImage || '',
        author: res.meta?.author || '',
        publishedAt: res.meta?.publishedAt || '',
        kind: res.kind || 'web',
        provider: res.provider || null,
        kindConfidence: res.kindConfidence || 'unknown',
      };
      rec.verdict = classifyProbe(rec, { now, shouldMarkDead });
      await putRecord(id, rec);
      processed += 1;
    } else {
      // 没结果也要留痕：面板上要能看出「这一条没探到」，而不是它凭空消失
      const prev = prevs.get(id) || {};
      const rec = {
        ...prev, id, url: slice[i].url, checkedAt: now,
        error: 'no-result', status: 0,
        verdict: classifyProbe({ ...prev, checkedAt: now, error: 'no-result' }, { now, shouldMarkDead }),
      };
      await putRecord(id, rec);
    }
    state.cursor += 1;
  }

  // ⑥ 存游标
  state.updatedAt = now;
  if (state.cursor >= state.entries.length) {
    state.status = LINK_STATUS.DONE;
    state.finishedAt = now;
  }
  await set(K.LINK_STATE, state);

  // ⑦ 正文入队，交给 F3（content-archive）消费。
  //    本模块**不落盘正文** —— 800 × 100KB ≈ 80MB 不是扩展存储该装的东西，
  //    而且存了就等于和 F3 抢活。这里只留一个「这条抓到了、有正文」的信号。
  const q = await get(K.LINK_QUEUE, {}) || {};
  for (const r of results) {
    if (r && r.result && r.result.html) q[r.url] = { url: r.url, bytes: r.result.html.length, at: now };
  }
  await set(K.LINK_QUEUE, q);

  return { done: state.status === LINK_STATUS.DONE, processed, total: state.total, state };
}

/**
 * 构建一轮的队列。
 * @param {Array<{id:string, url:string}>} entries
 * @param {{now?:number, round?:number}} [opts]
 */
export async function startRound(entries, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const list = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && e.id && e.url)
    .map((e) => ({ id: String(e.id), url: String(e.url) }));
  await set(K.LINK_STATE, {
    ...emptyState(),
    status: LINK_STATUS.RUNNING,
    round: Number.isFinite(opts.round) ? opts.round : 1,
    entries: list,
    ids: list.map((e) => e.id),
    total: list.length,
    startedAt: now,
    updatedAt: now,
  });
}

/** 有未跑完的一轮吗（面板据此显示「继续未完成的检测」） */
export async function hasUnfinished() {
  const s = await getLinkState();
  return s.status === LINK_STATUS.RUNNING || s.status === LINK_STATUS.PAUSED;
}

/** 暂停。已探过的结果全部保留。 */
export async function pauseLinkScan() {
  return mutate(K.LINK_STATE, (cur) => {
    const s = cur && cur.status ? cur : emptyState();
    return s.status === LINK_STATUS.RUNNING ? { ...s, status: LINK_STATUS.PAUSED, updatedAt: Date.now() } : s;
  }, emptyState());
}

/** 续跑：不重新建队列，接着上次的游标继续 */
export async function resumeLinkScan() {
  return mutate(K.LINK_STATE, (cur) => {
    const s = cur && cur.status ? cur : emptyState();
    return s.status === LINK_STATUS.PAUSED ? { ...s, status: LINK_STATUS.RUNNING, updatedAt: Date.now() } : s;
  }, emptyState());
}

/** 清空扫描状态（不动任何记录） */
export async function clearLinkScan() {
  return set(K.LINK_STATE, emptyState());
}

/**
 * 汇总面板要显示的数字。
 * 判据是**逐条读记录算出来的**，不是累加一个计数器 ——
 * 累加计数器一旦中途异常就永远对不上，而面板上的数字对不上是没法自证的。
 * @param {string[]} ids
 */
export async function buildIndex(ids) {
  const records = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    const r = await getRecord(id);
    if (r) records.push(r);
  }
  return { ...summarize(records), at: Date.now() };
}
