/**
 * 死链判据。
 *
 * ⚠️ 纯函数模块：不得 import 任何 chrome API，不得 fetch，不得碰 indexedDB。
 *    （`tests/unit/falsification.test.js` 里的能力闸门会当场报红。）
 *
 * ═══ 整个功能里最容易写错、且错了不会立刻报错的一条 ═══
 *
 * 死链判据是「**连续 3 次 404/410，且距上次成功 ≥24h**」，
 * **不是**「最近 3 次调用里失败了 3 次」。
 *
 * 原因：`chrome.alarms` 官方文档写明它 "may delay them an arbitrary amount more"
 * （<https://developer.chrome.com/docs/extensions/reference/api/alarms>，2026-10-04 更新）。
 * 丢一轮时，「最近 3 次里有 3 次失败」会把两个正常的链接判成死链 ——
 * 而死链的下游是「建议用 Wayback 快照替代」，判错的代价是用户可能真去换掉一个好地址。
 *
 * 另一个容易混进来的：**只有 404 与 410 算「链接没了」**。
 * 403（要登录）、429（限流）、5xx（服务端抽风）、网络层失败 —— 全都不是。
 * 把它们算进去，一次网络抖动就能让一批书签集体变死链。
 */

/** 连续失败多少次才考虑判死 */
export const DEAD_MIN_STREAK = 3;

/** 判死要求的「距上次成功」的最短跨度（24 小时） */
export const DEAD_MIN_SPAN_MS = 24 * 60 * 60 * 1000;

/**
 * 这个状态码是否代表「这个资源没了」。
 * 只有 404 / 410。其它一律不算。
 * @param {number} status
 * @returns {boolean}
 */
export function isGoneStatus(status) {
  return status === 404 || status === 410;
}

/**
 * 是否该判为死链。
 *
 * ⚠️ `lastOkAt` 为 0/undefined 表示**从来没成功探测过**。
 *    那时不能判死 —— 从没成功过不等于已经死了。
 *    第一次探测就是 404 的新书签，应该停在 `suspect`，等下一轮。
 *
 * @param {{failStreak?:number, lastOkAt?:number, now?:number}} input
 * @returns {boolean}
 */
export function shouldMarkDead({ failStreak, lastOkAt, now } = {}) {
  if (!Number.isFinite(failStreak) || failStreak < DEAD_MIN_STREAK) return false;
  if (!Number.isFinite(lastOkAt) || lastOkAt <= 0) return false;
  const t = Number.isFinite(now) ? now : Date.now();
  return t - lastOkAt >= DEAD_MIN_SPAN_MS;
}

/**
 * 推进一次失败计数，返回新的计数状态。
 *
 * - 只有 404/410 会让 `failStreak` 增长
 * - 其它状态码**既不增长也不清零** —— 它们是噪声，不是信号，
 *   清零会让一次 500 把之前攒的 3 次 404 抹掉
 * - 一次成功则把 streak 与 firstFailAt 一起清掉
 *
 * @param {{failStreak?:number, firstFailAt?:number}} cur
 * @param {{status?:number, ok?:boolean, now?:number}} probe
 * @returns {{failStreak:number, firstFailAt:number}}
 */
export function advanceFailState(cur, probe) {
  const now = Number.isFinite(probe?.now) ? probe.now : Date.now();
  const streak = Number.isFinite(cur?.failStreak) ? cur.failStreak : 0;
  const first = Number.isFinite(cur?.firstFailAt) ? cur.firstFailAt : 0;

  if (probe?.ok === true) return { failStreak: 0, firstFailAt: 0 };
  if (!isGoneStatus(probe?.status)) return { failStreak: streak, firstFailAt: first };

  return {
    failStreak: streak + 1,
    // 首次失败的时间要**保留**，它是「跨 ≥24h」这条判据的起点
    firstFailAt: first > 0 ? first : now,
  };
}
