/**
 * 工具栏弹窗：只做两件事 —— 显示待分类条数、打开主面板。
 * 不做任何写操作（D11/D12：重排书签树必须用户点确认）。
 */

import { getPendingCount } from '../src/listener.js';

const $ = (id) => document.getElementById(id);

async function refresh() {
  try {
    $('pending').textContent = await getPendingCount();
  } catch {
    $('pending').textContent = '?';
  }
}

$('open').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'openPanel' }, () => window.close());
});

refresh();
