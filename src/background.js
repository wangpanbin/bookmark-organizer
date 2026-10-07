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

/**
 * link-scan 的闹钟监听。
 * ⚠️ 动态 import：没开这个功能时不必加载它。
 * installAlarmListener 内部已经判了 chrome.alarms 存不存在。
 */
import('./scan/scheduler.js')
  .then((m) => {
    m.installAlarmListener();
    return m.syncAlarm();
  })
  .catch((e) => console.warn('[bookmark-organizer] link-scan 闹钟初始化失败（功能未启用）', e));

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

  // ── link-scan（死链/改链检测 + 元数据补全）──
  // ⚠️ 这些是**动态 import**：link-scan 不用时不必加载它，
  //    更不必让 SW 启动时就背上探测相关模块的初始化成本。
  linkStart: async (p) => {
    const m = await import('./scan/scheduler.js');
    const r = await import('./scan/runner.js');
    const perm = await import('./scan/permission.js');
    if (!await perm.hasScanPermission()) {
      return { started: false, reason: '尚未授予网站访问权限。请在「链接健康」页点一次授权。' };
    }
    const entries = await m.collectTargets();
    if (!entries.length) return { started: false, reason: '没有可探测的书签' };
    // ⚠️ 轮次要接着上次 +1。早先这里硬编码 `{ round: 1 }`，
    //    于是「D9 靠轮次跨 24h」这件事在手动点「立即检测」时会一直停在第 1 轮，
    //    而 state.round 记的是什么完全对不上。
    const prev = await r.getLinkState();
    await r.startRound(entries, { round: (prev.round || 0) + 1 });
    const res = await r.runSlice({ settings: await getSettings() });
    return { started: true, ...res };
  },
  linkStep: async () => {
    const r = await import('./scan/runner.js');
    return r.runSlice({ settings: await getSettings() });
  },
  linkState: async () => {
    const r = await import('./scan/runner.js');
    const st = await r.getLinkState();
    const idx = await r.buildIndex(st.ids || []);
    return { state: st, index: idx, unfinished: await r.hasUnfinished() };
  },
  /**
   * 批量读页面元数据（供分类链路复用）。
   *
   * ⚠️ 为什么单开一个而不是让面板逐条 send('linkRecord')：
   *    分类每次预览都会跑，而 linkRecord 是一次消息往返。800 条书签
   *    就是 800 次往返，且发生在 loadAndClassify 里 —— 那是面板**所有**
   *    交互的入口，界面会卡住整整一秒以上。
   *
   *    这里一次拿回全部记录里真正需要的两个字段。
   */
  linkMeta: async () => {
    const r = await import('./scan/runner.js');
    const st = await r.getLinkState();
    const ids = Array.isArray(st.ids) ? st.ids : [];
    const out = {};
    for (const id of ids) {
      const rec = await r.getRecord(id);
      if (!rec) continue;
      const description = String(rec.description || '').trim();
      const pageTitle = String(rec.pageTitle || '').trim();
      if (!description && !pageTitle) continue; // 没抓到就不占传输
      out[String(id)] = { description, pageTitle };
    }
    return { meta: out };
  },
  linkResume: async () => {
    const r = await import('./scan/runner.js');
    await r.resumeLinkScan();
    return r.runSlice({ settings: await getSettings() });
  },
  linkPause: async () => {
    const r = await import('./scan/runner.js');
    return r.pauseLinkScan().then(() => ({ ok: true }));
  },
  linkClear: async () => {
    const r = await import('./scan/runner.js');
    return r.clearLinkScan().then(() => ({ ok: true }));
  },
  linkRecord: async (p) => {
    const r = await import('./scan/runner.js');
    return r.getRecord(p?.id);
  },
  linkPerm: async (p) => {
    const perm = await import('./scan/permission.js');
    const has = await perm.hasScanPermission();
    if (p?.action === 'request') return { has: await perm.requestScanPermission() };
    if (p?.action === 'revoke') return { has: !(await perm.revokeScanPermission()) };
    return { has };
  },
  linkSyncAlarm: async () => {
    const s = await import('./scan/scheduler.js');
    return s.syncAlarm(await getSettings());
  },
  linkAlarm: async () => {
    const s = await import('./scan/scheduler.js');
    return s.readAlarm();
  },
  linkAlternatives: async (p) => {
    const alt = await import('./scan/alternatives.js');
    const s = await getSettings();
    // ⚠️ 这项曾经读的是一个不存在的键 → `undefined !== false` 恒为 true，
    //    AI 找新地址变成无条件常开。现在它在 DEFAULT_SETTINGS 里有定义且默认 false。
    return alt.findAlternatives({ url: p?.url, title: p?.title }, {
      aiEnabled: s.linkScanAiFind === true,
      settings: s,
    });
  },
  // ⚠️ 曾经的 `linkPropose` 已删除：它写 `link:proposal:<id>` 而全仓库没人读，
  //    面板的 toast 却在承诺「到计划明细预览确认后才会真正改书签」。
  //    界面承诺一件永远不会发生的事，比功能缺失更伤 —— 宁可没有这个按钮。
  //    真要支持自动替换 URL，必须先给 plan.js 设计一种不落文件夹的计划项，
  //    并重新审视那些「每条计划项都落在承诺的文件夹里」的 E2E 闸门。

  // ── 语义去重（F2）──
  /**
   * 跑一轮语义去重。
   * ⚠️ 结果**只**是「建议合并」，永远不进删除清单 —— D6 拍板的。
   *    现有的 URL 归一化去重不受影响，两者互不替代。
   */
  semanticRun: async (p) => {
    const R = await import('./dedupe/semantic-runner.js');
    const E = await import('./dedupe/embedding-client.js');
    // ⚠️ readFlatTree，不是 getFlatTree —— tree.js 从未导出过后者。
    //    写成 getFlatTree 会解构出 undefined，`await undefined()` 抛 TypeError，
    //    而 TypeError 恰好落进下面「semanticDedupeEnabled !== true」的判断之前，
    //    整条语义去重链路从来没跑起来过、也没报过任何错。
    const { readFlatTree } = await import('./tree.js');
    const s = await getSettings();
    if (s.semanticDedupeEnabled !== true) {
      return { suggestions: [], embedded: 0, reason: '语义去重未启用（在「设置」里打开）' };
    }
    // 正文摘要来自归档侧车；侧车没开就自动退回「只用标题」
    const texts = new Map();
    for (const e of (await readFlatTree()) || []) {
      if (!e || e.type !== 'url' || !e.url) continue;
      const t = await E.fetchArchivedText(e.url);
      if (t) texts.set(String(e.id), t);
    }
    return R.runSemanticDedupe(
      (await readFlatTree()) || [],
      {
        apiKey: s.embeddingApiKey || s.apiKey || '',
        baseUrl: s.embeddingBaseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        // ⚠️ 面板上的「相似度阈值」滑块以前**从来没传到这里**，
        //    于是 opts.threshold 是 undefined，semantic.js 退回硬编码 0.92 ——
        //    那个滑块是个改不动任何一条建议的常量。
        //    （`undefined` 与「用户没配」都落到同一个默认值，所以症状看起来像
        //    「阈值就是不准」，而不是「设置没接线」。）
        threshold: Number.isFinite(s.semanticThreshold) ? s.semanticThreshold : undefined,
        texts,
        onProgress: (pr) => {
          // 进度经 runtime 消息回传不了（它是同步 handler），所以只记在 storage 上
        },
      },
    );
  },
  semanticSuggestions: async () => {
    const R = await import('./dedupe/semantic-runner.js');
    return R.getSuggestions();
  },
  semanticClear: async () => {
    const R = await import('./dedupe/semantic-runner.js');
    return R.clearVectors().then(() => ({ ok: true }));
  },

  // ── 内容归档（F3）──
  archiveStatus: async () => {
    const A = await import('./archive/client.js');
    return A.probeSink();
  },
  /**
   * 归档**一个切片**，不是跑完整轮。
   * 循环由面板页驱动 —— SW 活不过 800 条，options 页面才活得久。
   * ⚠️ 早先这里读的是 `e.html`，而队列里根本没有正文（只有 {url,bytes,at}），
   *    于是每条都 skipped、永远显示「已归档 0/800」。见 src/archive/run.js 顶部。
   */
  archiveRun: async () => {
    const R = await import('./archive/run.js');
    return R.archiveSlice({ settings: await getSettings() });
  },
  archiveReset: async () => {
    const R = await import('./archive/run.js');
    return R.resetArchiveRun().then(() => ({ ok: true }));
  },
  archiveProgress: async () => {
    const R = await import('./archive/run.js');
    return R.summarize(await R.getArchiveRun());
  },
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
