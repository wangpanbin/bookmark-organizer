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
 *
 * ═══ ⚠️ 为什么状态推进是「两个 mutate」，不是「get → 改 → set」 ═══
 * 早先这里是 `let state = await getLinkState()` …（跨过整批探测的网络）… `set(K.LINK_STATE, state)`。
 * 那是 AGENTS.md 第 2 条禁止的读-改-写，窗口大到不是理论风险：
 *   · 用户在探测途中点「暂停」（`pauseLinkScan` 走 mutate，是对的），
 *     这一片结束时把 `status: 'running'` 的旧快照整份写回 → **暂停被静默撤销**，
 *     面板上按钮显示已暂停而扫描还在跑；
 *   · 闹钟触发与面板点「立即检测」重叠（两个调用读到同一个 cursor），
 *     各自推进后整份覆盖 → 中间那批书签**永远没被探到**，而面板显示「扫完了」。
 * `scheduler.js` 里专门有一条注释防范「两个游标互相覆盖的并发写」，
 * 它防的正是自己这两处 —— 一道自己模块不遵守的注释不叫防线。
 *
 * 所以拆成两个临界区，**网络在两者之间**（storage.js 要求 fn 内不许 await 长耗时操作）：
 *   ① `beginRound`：原子地「确保这一轮是 RUNNING」。判断 status 与建新一轮必须
 *      在同一个临界区，否则两个调用同时看到 PAUSED 会各建一轮，丢掉的那轮
 *      在面板上表现为「明明有 N 条却只探了 M 条」。
 *   ② `advanceCursor`：带轮次+游标守卫的增量推进。守卫命中就 SKIP 不写 ——
 *      宁可这一片不计数（下一片重探，探测是幂等的 GET），也不推进别人的游标。
 */

import { get, mutate, set, SKIP, K } from '../storage.js';
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
 * ① 原子地「确保当前这一轮处于 RUNNING」，返回**权威的**当前状态。
 *
 * 为什么不能是 `if (state.status !== RUNNING) state = {...}`：
 * 那行读与写之间隔着一次让出，两个调用同时看到 PAUSED/DONE 时会各建一轮，
 * 后一轮整体覆盖前一轮，丢掉的那轮在面板上表现为「明明有 N 条却只探了 M 条」。
 *
 * @param {{now:number, round?:number}} opts
 * @returns {Promise<object>} mutate 写完（或 SKIP）后的状态
 */
function beginRound({ now, round }) {
  return mutate(K.LINK_STATE, (cur) => {
    const base = cur && cur.status ? cur : emptyState();
    // 已经在跑 → 什么都不改。SKIP 让 mutate 原样返回当前值，不产生多余的写
    if (base.status === LINK_STATUS.RUNNING) return SKIP;
    return {
      // ⚠️ 与早先实现一致：新一轮**从零开始**，不继承上一轮的 entries/cursor。
      //    「续跑」是 resumeLinkScan 的职责，不是这里的。
      ...emptyState(),
      status: LINK_STATUS.RUNNING,
      round: Number.isFinite(round) ? round : base.round + 1,
      startedAt: now,
      updatedAt: now,
    };
  }, emptyState());
}

/**
 * ② 带守卫的游标推进。
 *
 * 守卫比「把游标加上 n」更强：它要求**当前值仍然是我出发时看到的那个值**
 * （同一轮 + 同一游标）。少了这道守卫，两个重叠的调用会各推 n 条，
 * 整份覆盖的结果是中间那批条目被永久跳过。
 *
 * @param {object} expected 出发时读到的状态（提供 round 与 cursor 两个指纹）
 * @param {number} n 本片实际处理了几条（按 results.length，不按 slice.length ——
 *   探测提前收尾时未返回的那些留给下一片重试）
 * @param {number} now
 * @returns {Promise<{state:object, superseded:boolean}>}
 *   superseded=true 表示有别人推进过，本次**没有写任何东西**
 */
function advanceCursor(expected, n, now) {
  let superseded = false;
  return mutate(K.LINK_STATE, (cur) => {
    const base = cur && cur.status ? cur : emptyState();
    if (base.round !== expected.round || base.cursor !== expected.cursor) {
      superseded = true;
      return SKIP;
    }
    const next = { ...base, cursor: base.cursor + n, updatedAt: now };
    if (next.cursor >= next.entries.length) {
      next.status = LINK_STATUS.DONE;
      next.finishedAt = now;
    }
    return next;
  }, emptyState()).then((state) => ({ state, superseded }));
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

  // ① 原子地确保这一轮在跑，并取回**权威**状态。
  //    游标只信 storage，绝不信 SW 内存 —— 唤醒后内存态必然是空的
  const state = await beginRound({ now, round: opts.round });

  // ② 本批要探的 id
  const slice = state.entries.slice(state.cursor, state.cursor + concurrency * 4);
  if (slice.length === 0) {
    // 「跑完了」也是一次基于旧值的判断，所以同样走守卫。
    // 传 n=0：只是把状态收敛成 DONE，不推进任何游标。
    const { state: doneState, superseded } = await advanceCursor(state, 0, now);
    if (superseded) {
      return { done: doneState.status === LINK_STATUS.DONE, processed: 0, total: doneState.total, state: doneState, superseded: true };
    }
    return { done: true, processed: doneState.cursor, total: doneState.total, state: doneState, superseded: false };
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
    // ⚠️ 这里**不再** `state.cursor += 1`。`state` 现在是出发时的快照，
    //    它的 round/cursor 是 ⑥ 守卫的两个指纹，被就地改掉守卫就永远命中 ——
    //    那道守卫会退化成恒假的死代码，正是 AGENTS.md 第 9 条那种「没人能发现的恒真」。
    //    游标由 advanceCursor 一次性推进。
  }

  // ⑥ 推进游标（守卫 + 增量，见 advanceCursor）
  const { state: finalState, superseded } = await advanceCursor(state, results.length, now);

  // ⑦ 正文入队，交给 F3（content-archive）消费。
  //    本模块**不落盘正文** —— 800 × 100KB ≈ 80MB 不是扩展存储该装的东西，
  //    而且存了就等于和 F3 抢活。这里只留一个「这条抓到了、有正文」的信号。
  //
  //    ⚠️ 必须走 mutate：这是**纯变换**（往 map 里加几个键），一个 await 都没有，
  //    整类读-改-写都能收进临界区。
  //    早先的 get→改→set 在两个调用重叠时会静默丢条目：两边读到同一份旧 map，
  //    各自加完各写一次，后写的把先写的整个覆盖掉 —— 那几条 URL F3 永远收不到，
  //    而面板上「待归档」的数字对不上，且**没有任何报错**。
  const adds = {};
  for (const r of results) {
    if (r && r.result && r.result.html) adds[r.url] = { url: r.url, bytes: r.result.html.length, at: now };
  }
  if (Object.keys(adds).length) {
    await mutate(K.LINK_QUEUE, (cur) => ({ ...(cur || {}), ...adds }), {});
  }

  // ⚠️ 返回的是**权威**状态（⑥ 写完 / 守卫命中时的当前值），不是出发时的快照。
  //    superseded 时 done 按真实状态算 —— 这一片没能推进游标，
  //    说成 done 会让面板提前显示「扫完了」。
  return {
    done: finalState.status === LINK_STATUS.DONE,
    processed,
    total: finalState.total,
    state: finalState,
    superseded,
  };
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
