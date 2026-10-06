/**
 * 探测结果 → verdict（面板上那一行显示什么状态）。
 *
 * ⚠️ 纯函数模块：不得 import 任何 chrome API，不得 fetch。
 *
 * ═══ 优先级顺序本身就是设计 ═══
 * 下面 if 的先后不是随手排的，每一条都压过后面所有条：
 *
 *   redirect_cross  >  redirect_same  >  dead  >  soft404  >  ok
 *
 * 理由：一个 URL 可能同时满足多条（跳了 + 落地页还是 404 + 落地页内容写着
 * 「页面不存在」）。**重定向优先**，因为「它搬到哪去了」比「现在能不能打开」
 * 更有决策价值 —— 你真正要做的是把书签指到新地址，而不是把它归档。
 */

/** verdict 的全部取值。面板按这个渲染，不要新增未登记的值。 */
export const VERDICT = Object.freeze({
  /** 从没探过 */
  UNCHECKED: 'unchecked',
  /** 正常 */
  OK: 'ok',
  /** 有失败记录但没到死链阈值 */
  SUSPECT: 'suspect',
  /** 连续多轮 404/410 且跨 ≥24h */
  DEAD: 'dead',
  /** 改了地址，仍在原站 —— 可一键采纳替换 */
  REDIRECT_SAME: 'redirect_same',
  /** 跳到别处 —— 一律人工判断，不给建议 */
  REDIRECT_CROSS: 'redirect_cross',
  /** 返回 200 但内容像「页面不存在」（启发式） */
  SOFT404: 'soft404',
  /** 网络层失败：超时 / DNS / TLS。**不计入失败计数** */
  NET_ERROR: 'net_error',
});

/** 面板上每一类该怎么措辞。省得散落在各处各写一套。 */
export const VERDICT_LABEL = Object.freeze({
  [VERDICT.UNCHECKED]: '未探测',
  [VERDICT.OK]: '正常',
  [VERDICT.SUSPECT]: '可疑',
  [VERDICT.DEAD]: '死链',
  [VERDICT.REDIRECT_SAME]: '已改址（同站）',
  [VERDICT.REDIRECT_CROSS]: '跳到别处（需人工判断）',
  [VERDICT.SOFT404]: '疑似软 404（启发式）',
  [VERDICT.NET_ERROR]: '网络错误（不计失败）',
});

/**
 * 只有同站重定向才允许「一键采纳替换」。
 *
 * ⚠️ 这条是 D7 拍板的安全边界，实现时**不要**放宽：
 * 跨站重定向可能是品牌改名，也可能是跳到登录页，
 * 这两类从 URL 上完全无法区分。盲信会毁掉用户真收藏的地址。
 *
 * @param {string} verdict
 * @returns {boolean}
 */
export function canAutoReplace(verdict) {
  return verdict === VERDICT.REDIRECT_SAME;
}

/**
 * 从一条探测记录算出 verdict。
 *
 * @param {{
 *   checkedAt?:number, status?:number, redirected?:boolean, sameSite?:boolean|null,
 *   failStreak?:number, lastOkAt?:number, soft404?:boolean, error?:string
 * }} rec
 * @param {{now?:number, shouldMarkDead?:Function}} [opts] shouldMarkDead 由调用方注入，便于测试
 * @returns {string} VERDICT 之一
 */
export function classifyProbe(rec, opts = {}) {
  if (!rec || !Number.isFinite(rec.checkedAt) || rec.checkedAt <= 0) return VERDICT.UNCHECKED;

  // ① 网络层失败：连「状态码」都没有，谈不上死链
  //    放最前面是因为它会伪装成 status=0，而 0 不是 404/410，
  //    但如果不先拦掉，后面的逻辑得去猜 0 是什么意思
  if (rec.error) return VERDICT.NET_ERROR;

  // ② 重定向优先于一切
  if (rec.redirected) {
    return rec.sameSite === true ? VERDICT.REDIRECT_SAME : VERDICT.REDIRECT_CROSS;
  }

  // ③ 死链
  const dead = opts.shouldMarkDead
    ? opts.shouldMarkDead({ failStreak: rec.failStreak, lastOkAt: rec.lastOkAt, now: opts.now })
    : false;
  if (dead) return VERDICT.DEAD;

  // ④ 有 404/410 记录但没到阈值
  if (Number.isFinite(rec.failStreak) && rec.failStreak > 0) return VERDICT.SUSPECT;

  // ⑤ 软 404：只标不判，所以排在 suspect 之后、死链之前不会覆盖死链
  if (rec.soft404 === true) return VERDICT.SOFT404;

  // ⑥ 其余只要成功拿到 2xx 就是正常
  return VERDICT.OK;
}

/**
 * 面板的汇总。按 verdict 计数。
 * @param {Array<{verdict?:string}>} records
 * @returns {{total:number, byVerdict:Record<string,number>, actionable:number}}
 *   actionable = 需要你动手看的条数（死链 + 同站改址 + 跨站 + 可疑 + 软 404）
 */
export function summarize(records) {
  const byVerdict = {};
  for (const v of Object.values(VERDICT)) byVerdict[v] = 0;
  let total = 0;
  for (const r of Array.isArray(records) ? records : []) {
    total += 1;
    const v = r && r.verdict;
    if (v && Object.prototype.hasOwnProperty.call(byVerdict, v)) byVerdict[v] += 1;
  }
  const actionable = byVerdict[VERDICT.DEAD]
    + byVerdict[VERDICT.REDIRECT_SAME]
    + byVerdict[VERDICT.REDIRECT_CROSS]
    + byVerdict[VERDICT.SUSPECT]
    + byVerdict[VERDICT.SOFT404];
  return { total, byVerdict, actionable };
}
