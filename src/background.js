/**
 * service worker 入口。
 *
 * 职责边界（重要）：
 *   - 读树 / 生成计划 / 展示清单：options 页面自己直接调 chrome.*，不经 SW。
 *     这样 dry-run 完全不碰 SW，SW 被回收也不影响预览。
 *   - **执行**才走 SW：只有它能扛住 options 页面被关掉。
 *   - SW 空闲 30 秒即被回收；任务状态每条落盘，被杀后 UI 提示「继续」即可。
 */

import { installListeners } from './listener.js';
import {
  startExecution, resumeExecution, pauseExecution, getProgress, clearTask, isRunnerActive, currentRunToken,
} from './apply.js';
import { createSnapshot, listSnapshots, restoreSnapshot, deleteSnapshot } from './backup.js';
import { getSettings, updateSettings, getTask, K, get } from './storage.js';
import { getTaxonomy } from './classify/taxonomy.js';

installListeners();

/** 打开主面板 */
async function openPanel() {
  const url = chrome.runtime.getURL('ui/options.html');
  const existing = await chrome.tabs.query({ url });
  if (existing && existing.length) {
    await chrome.tabs.update(existing[0].id, { active: true });
    await chrome.windows.update(existing[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

chrome.action.onClicked.addListener(openPanel);

chrome.runtime.onInstalled.addListener(async (details) => {
  // 首装：立刻建一份空快照，让用户第一次点开就有回滚点
  if (details.reason === 'install') {
    try {
      await createSnapshot({ note: '首次安装时的初始状态' });
    } catch (e) {
      console.warn('[bookmark-organizer] 初始快照创建失败', e);
    }
  }
});

/** 汇总状态：UI 轮询用 */
async function getState() {
  const [settings, task, snapshots, taxonomyOverride, learnedRules, locks, manual] = await Promise.all([
    getSettings(),
    getTask(),
    listSnapshots(),
    get(K.TAXONOMY_OVERRIDE, null),
    get(K.RULES_LEARNED, []),
    get(K.LOCKS, []),
    get(K.MANUAL_ASSIGNMENTS, {}),
  ]);
  return {
    settings,
    task,
    progress: await getProgress(),
    snapshots,
    taxonomy: getTaxonomy(taxonomyOverride),
    taxonomyIsOverridden: Array.isArray(taxonomyOverride) && taxonomyOverride.length > 0,
    learnedRules: learnedRules || [],
    locks: locks || [],
    manualAssignments: manual || {},
  };
}

const HANDLERS = {
  getState,
  /**
   * 探针：这个 SW 实例里此刻有没有执行循环在跑。
   * 面板靠它区分「正在执行」与「上次被回收打断」——
   * 消息会唤醒 SW，唤醒后的新实例模块状态重置，答案必然是否，这比时间戳可靠。
   */
  probeRunner: async () => ({ active: isRunnerActive(), token: currentRunToken() }),
  openPanel: () => openPanel().then(() => ({ ok: true })),
  startExecution: (p) => startExecution(p),
  resumeExecution: () => resumeExecution(),
  pauseExecution: () => pauseExecution().then(() => ({ ok: true })),
  clearTask: () => clearTask().then(() => ({ ok: true })),
  createSnapshot: (p) => createSnapshot(p || {}),
  listSnapshots: () => listSnapshots(),
  restoreSnapshot: (p) => restoreSnapshot(p?.ts),
  deleteSnapshot: (p) => deleteSnapshot(p?.ts).then(() => ({ ok: true })),
  updateSettings: (p) => updateSettings(p || {}),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const h = msg && msg.type ? HANDLERS[msg.type] : null;
  if (!h) {
    sendResponse({ error: `未知消息类型: ${msg?.type}` });
    return false;
  }
  Promise.resolve(h(msg.payload))
    .then((r) => sendResponse({ ok: true, result: r }))
    .catch((e) => {
      // 错误也必须回传：SW 里 console 输出在正式安装版可能被吞
      console.error('[bookmark-organizer]', msg.type, e);
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    });
  return true; // 异步响应
});
