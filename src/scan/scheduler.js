/**
 * chrome.alarms 接线。
 *
 * ⚠️ 这个模块调 chrome.alarms，属于写操作模块。
 *
 * ═══ 两条不能忽略的平台事实 ═══
 * ① 官方原文：Chrome "limits alarms to at most once every 30 seconds
 *    **but may delay them an arbitrary amount more**"；
 *    且 unpacked 加载时 "there's **no limit** to how often the alarm can fire"。
 *    → **任何判据都不得建在 30 秒上**，那会「本地过、发布后挂」。
 * ② MV3 的 SW 空闲 30 秒即被回收。闹钟唤不回来一个已经丢掉的状态机，
 *    所以状态一律落 storage（见 runner.js）。
 */

import { getSettings } from '../storage.js';
import { hasScanPermission } from './permission.js';
import {
  runSlice, startRound, getLinkState, LINK_STATUS,
} from './runner.js';

export const ALARM_NAME = 'link-scan';

/** 面板下拉里的几档。值直接就是 periodInMinutes。 */
export const INTERVALS = Object.freeze([
  { value: 360, label: '每 6 小时' },
  { value: 1440, label: '每天' },
  { value: 10080, label: '每周' },
  { value: 0, label: '关闭' },
]);

/**
 * 设置/重排闹钟。
 * @param {object} [settings]
 * @returns {Promise<{armed:boolean, periodMinutes:number, reason:string}>}
 */
export async function syncAlarm(settings) {
  const s = settings || await getSettings();
  const period = Number(s.linkScanIntervalMinutes);

  if (!chrome.alarms) return { armed: false, periodMinutes: period, reason: '本浏览器没有 chrome.alarms' };

  if (!s.linkScanEnabled || !Number.isFinite(period) || period <= 0) {
    await chrome.alarms.clear(ALARM_NAME);
    return { armed: false, periodMinutes: period, reason: '已关闭' };
  }
  // 还没授权就先不排：排了闹钟也只会每轮都因为没权限而空转
  if (!await hasScanPermission()) {
    await chrome.alarms.clear(ALARM_NAME);
    return { armed: false, periodMinutes: period, reason: '尚未授予网站访问权限' };
  }

  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: period });
  return { armed: true, periodMinutes: period, reason: '已启用' };
}

/** 读回当前闹钟设置（面板显示用，判据是 Chrome 自己说的，不是我们记的） */
export async function readAlarm() {
  if (!chrome.alarms) return null;
  const a = await chrome.alarms.get(ALARM_NAME);
  if (!a) return null;
  return { name: a.name, periodInMinutes: a.periodInMinutes };
}

/**
 * 闹钟回调。
 *
 * ⚠️ **不叠加**：已经在跑就直接返回。
 *    探 800 条要很久，闹钟又可能任意延迟，两次唤醒叠在一起会
 *    产生两个游标互相覆盖的并发写 —— 症状是记录乱序、计数对不上。
 *
 * ⚠️ 每轮只跑**一个时间片**就收工，剩下的留给下一次唤醒。
 *    主动跑满会让 SW 长时间不空闲，而被回收时正在写的那条会丢。
 *
 * @returns {Promise<{skipped?:string, done?:boolean, processed?:number}>}
 */
export async function onAlarm() {
  const s = await getSettings();
  if (!s.linkScanEnabled) return { skipped: '功能已关闭' };
  if (!await hasScanPermission()) return { skipped: '没有网站访问权限' };

  const st = await getLinkState();
  if (st.status === LINK_STATUS.RUNNING) return { skipped: '上一轮还在跑' };

  // ⚠️ 暂停就是暂停。闹钟不得替用户「顺手继续」。
  //    面板上那个按钮写的是「暂停」，用户的预期是「我说了算」；
  //    而这里早先落到 else 分支去 startRound([]) —— 那会**整体替换**
  //    entries/ids/cursor/total，等于把整条队列抹掉，runSlice 紧接着看到
  //    slice 为空就报 done，面板上显示「扫完了」。注释还写着「接着跑」，
  //    与代码做的正好相反。
  if (st.status === LINK_STATUS.PAUSED) {
    return { skipped: '你暂停了这一轮。等你点「继续未完成的检测」' };
  }

  // 新一轮：只有「上轮已跑完」或「压根没有队列」才重建。
  if (st.status === LINK_STATUS.DONE || !st.ids.length) {
    const entries = await collectTargets();
    if (!entries.length) return { skipped: '没有可探测的书签' };
    await startRound(entries, { round: st.round + 1 });
  }
  // 其余情况队列还在（RUNNING 与 PAUSED 都已在上方返回），
  // 直接续跑游标即可。⚠️ 这里**绝不能**调 startRound()：
  //   它是「建新一轮」而不是「续跑」，传空数组 = 抹掉整轮。
  //   tests/unit/scan-runner.test.js 的「暂停后闹钟不抹队列」钉着这条。

  const r = await runSlice({ budgetMs: 20_000, settings: s });
  return { done: r.done, processed: r.processed };
}

/**
 * 收集待探测的书签。
 *
 * ⚠️ 用 `tree.js` 的扁平化结果，**不要**自己再实现一遍 getTree ——
 *    判重、排除内网页那些规则已经在 `normalize.js` 里，
 *    复制一份就是复制一处会漂移的地方。
 *
 * @returns {Promise<Array<{id:string, url:string}>>}
 */
export async function collectTargets() {
  const { getFlatTree } = await import('../tree.js');
  const { isExcludedUrl, parseUrl } = await import('../normalize.js');
  let flat = [];
  try {
    flat = (await getFlatTree()) || [];
  } catch {
    return [];
  }
  const out = [];
  for (const n of flat) {
    if (!n || n.type !== 'url' || typeof n.url !== 'string') continue;
    if (isExcludedUrl(n.url)) continue;
    if (!parseUrl(n.url)) continue;
    out.push({ id: String(n.id), url: n.url });
  }
  return out;
}

/** 注册监听。扩展启动时调一次。 */
export function installAlarmListener() {
  if (!chrome.alarms) return;
  chrome.alarms.onAlarm.addListener((a) => {
    if (a && a.name === ALARM_NAME) {
      onAlarm().catch((e) => console.warn('[link-scan] 闹钟轮失败', e));
    }
  });
}
