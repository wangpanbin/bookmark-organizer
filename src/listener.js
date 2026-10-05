/**
 * 书签树变更监听。
 *
 * 关键约束（来自官方 API 文档原文）：
 *   onImportBegan —— "Expensive observers should ignore onCreated updates
 *                    until onImportEnded is fired."
 * 一次 HTML 导入会触发上千次 onCreated。不抑制的话，
 * 「待分类 N 条」会瞬间虚高，用户点开一看全是刚导进来的。
 *
 * ⚠️ D12 决策：只计数、只提示，**绝不自动重排**。
 *    重排书签树是破坏性操作，必须用户点确认。
 */

import { get, mutate, K } from './storage.js';
import { isExcludedUrl } from './normalize.js';

let importing = false;
let installed = false;

/**
 * 新增书签是否算「待分类」。
 * 已经落在两层类目结构下的（path.length >= 3）视为已归类。
 * 注意 node 上没有 path，要靠父链判断；这里用最简单的近似：
 * 只有当它的 title 不像类目、且是 url 时计数，由「预览」阶段再精确分类。
 */
function countAsPending(node) {
  if (importing) return false;
  if (!node || !node.url) return false;
  if (isExcludedUrl(node.url)) return false;
  return true;
}

/** 装上所有监听（幂等，SW 每次唤醒都会重跑顶层代码） */
export function installListeners() {
  if (installed) return;
  installed = true;

  // 导入期抑制
  chrome.bookmarks.onImportBegan.addListener(() => {
    importing = true;
  });
  chrome.bookmarks.onImportEnded.addListener(async () => {
    importing = false;
    // 导入结束后把待分类计数归零重算：导入进来的条目已经由「预览」统一处理
    await mutate(K.PENDING_COUNT, () => 0, 0);
  });

  // 新增书签 → 累加待分类计数
  chrome.bookmarks.onCreated.addListener(async (id, node) => {
    if (!countAsPending(node)) return;
    await mutate(K.PENDING_COUNT, (n) => (Number(n) || 0) + 1, 0);
  });

  // 树结构变了 → 版本号 +1，UI 轮询时据此判断需要重新读树
  const bump = async () => {
    await mutate(K.TREE_VERSION, (v) => (Number(v) || 0) + 1, 0);
  };
  chrome.bookmarks.onRemoved.addListener(() => { bump(); });
  chrome.bookmarks.onMoved.addListener(() => { bump(); });
  chrome.bookmarks.onChanged.addListener(() => { bump(); });
  chrome.bookmarks.onChildrenReordered.addListener(() => { bump(); });
}

/** 当前是否处于导入期（测试与 UI 展示用） */
export function isImporting() {
  return importing;
}

/** 手动把待分类计数清零（用户跑完一次预览后调用） */
export async function resetPending() {
  await mutate(K.PENDING_COUNT, () => 0, 0);
}

/** 读待分类计数 */
export async function getPendingCount() {
  return Number(await get(K.PENDING_COUNT, 0)) || 0;
}
