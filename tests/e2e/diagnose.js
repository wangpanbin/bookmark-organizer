/**
 * 诊断：执行过程中 task:current 的推进情况 + 失败原因 + 执行后的树结构。
 * 用法：node tests/e2e/diagnose.js
 */
import {
  launchWithExtension, openPanel, seedBookmarks, treeSignature,
  makeFixtures, runPreview, cleanupAll,
} from './harness.js';
import { writeFileSync } from 'node:fs';

process.on('exit', cleanupAll);

const log = [];
const say = (s) => { log.push(s); };

async function readTask(page) {
  return page.evaluate(async () => {
    const got = await chrome.storage.local.get('task:current');
    const t = got['task:current'];
    if (t === undefined) return { __missing: true, allKeys: Object.keys(got) };
    const items = (t.plan?.items) || [];
    return {
      topKeys: Object.keys(t),
      status: t.status,
      hasPlan: !!t.plan,
      planKeys: t.plan ? Object.keys(t.plan) : null,
      planItemsLen: Array.isArray(t.plan?.items) ? t.plan.items.length : 'NOT-ARRAY',
      newFoldersLen: Array.isArray(t.plan?.newFolders) ? t.plan.newFolders.length : 'n/a',
      total: items.length,
      done: items.filter((i) => i.status === 'done').length,
      pending: items.filter((i) => i.status === 'pending').length,
      failedCount: items.filter((i) => i.status === 'failed').length,
      failedList: (t.failed || []).slice(0, 3),
      createdFolders: (t.createdFolders || []).length,
      folderCacheKeys: Object.keys(t.folderCache || {}),
      lastDoneIndex: t.lastDoneIndex,
      duplicatesLen: Array.isArray(t.duplicates) ? t.duplicates.length : 'n/a',
      raw: JSON.stringify(t).slice(0, 500),
    };
  });
}

const main = async () => {
  const { ctx, extensionId } = await launchWithExtension();
  try {
    const page = await openPanel(ctx, extensionId);
    await seedBookmarks(page, makeFixtures(10));
    const r = await runPreview(page);
    say(`preview1: move=${r.move} total=${r.total} rows=${r.rows}`);

    // 直接发消息执行，绕开 UI 的 confirm
    const startRes = await page.evaluate(
      () => new Promise((res) => chrome.runtime.sendMessage({ type: 'getState' }, res)),
    );
    say(`getState ok=${startRes.ok} planItems=${startRes.result?.progress?.total}`);

    await page.click('#btnExecute');

    for (let i = 0; i < 12; i++) {
      await new Promise((r2) => setTimeout(r2, 250));
      const t = await readTask(page);
      if (!t) { say(`  t=${i * 250}ms  task=null`); continue; }
      say(
        `  t=${String(i * 250).padStart(4)}ms status=${t.status} done=${t.done}/${t.total} ` +
        `pending=${t.pending} failedN=${t.failedCount} folders=${t.createdFolders} lastIdx=${t.lastDoneIndex} ` +
        `topKeys=${JSON.stringify(t.topKeys)}`,
      );
      if (t.failedList.length) say(`     失败样例: ${JSON.stringify(t.failedList).slice(0, 500)}`);
      if (t.status === 'done') break;
    }

    // 顺便看报告区现在显示了什么（waitForExecutionDone 靠它判完成）
    say(`\n报告区文本: ${await page.evaluate(() => (document.getElementById('report') || {}).textContent || '')}`.slice(0, 300));

    const sig = await treeSignature(page);
    say(`\n执行后树（前 900 字符）:\n${sig.slice(0, 900)}`);

    const r2 = await runPreview(page);
    say(`\npreview2: move=${r2.move} total=${r2.total}`);

    const firstPending = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#planBody tr')].slice(0, 3);
      return rows.map((tr) => tr.textContent.replace(/\s+/g, ' ').trim().slice(0, 120));
    });
    say(`preview2 前三行:\n  ${firstPending.join('\n  ')}`);
  } finally {
    await ctx.close();
  }

  const { writeFileSync } = await import('node:fs');
  writeFileSync('tests/.diag.txt', log.join('\n'), 'utf8');
  console.log('written to tests/.diag.txt');
};

main().catch((e) => {
  say('FATAL: ' + (e && e.stack ? e.stack : e));
  writeFileSync('tests/.diag.txt', log.join('\n'), 'utf8');
  console.log('fatal written to tests/.diag.txt');
});
