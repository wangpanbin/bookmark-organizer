/**
 * E2E 验收闸门。
 *
 * 覆盖计划里列的五条集成判据：
 *   1. 扩展能加载（第一天先单独验，不通过整套不成立）
 *   2. dry-run 零写入
 *   3. 幂等（二次运行 0 变更）
 *   4. 备份回滚
 *   5. 断点续跑（模拟 SW 被回收）
 *   6. SW 回收后 UI 仍能读出完整数据（不能「计数有值但列表空」）
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  launchWithExtension, openPanel, seedBookmarks, treeSignature,
  makeFixtures, makeDuplicateFixtures, runPreview, readStats, readReportStatus,
  waitForExecutionDone, waitForPartialProgress, waitForReportStatus, cleanupAll,
} from './harness.js';

process.on('exit', cleanupAll);
process.on('SIGINT', () => { cleanupAll(); process.exit(130); });

// ───────────────────── 1. 扩展能加载（第一道闸门）─────────────────────

test('扩展能加载：service worker 注册 + 主面板可打开', async () => {
  const { ctx, sw, extensionId } = await launchWithExtension();
  try {
    assert.ok(sw, 'service worker 没有注册 —— 扩展没起来（headless_shell 不支持扩展加载）');
    assert.match(sw.url(), /background\.js$/, 'service worker 指向了意外的文件');
    assert.ok(extensionId, '拿不到扩展 ID');

    const page = await openPanel(ctx, extensionId);
    const title = await page.title();
    assert.match(title, /书签整理助手/);

    // 主面板能读到宿主书签树（本机为 0 条，这是正常的）
    await runPreview(page);
    const stats = await readStats(page);
    assert.match(stats.total, /^\d+$/, '统计卡没渲染出数字');
  } finally {
    await ctx.close();
  }
});

// ───────────────────── 2. dry-run 零写入 ─────────────────────

test('dry-run 零写入：跑完预览书签树逐字节不变', async () => {
  const { ctx, extensionId } = await launchWithExtension();
  try {
    const page = await openPanel(ctx, extensionId);
    await seedBookmarks(page, makeFixtures(40));
    const before = await treeSignature(page);

    const r = await runPreview(page);

    // ⚠️ 必须先确认预览真的算出了待移动条目。
    //    否则这条会因为「点击丢了、什么都没发生」而假绿 —— 那正是它本该抓的失败模式。
    assert.ok(r.move > 0, `预览后待移动条目为 ${r.move}，本条断言会因错误原因通过`);

    await page.waitForTimeout(1500); // 多等一会儿，确保没有任何异步写入

    const after = await treeSignature(page);
    assert.equal(after, before, '预览竟然改了书签树 —— dry-run 零写入的保证被破坏');
  } finally {
    await ctx.close();
  }
});

// ───────────────────── 3. 幂等 ─────────────────────

test('幂等：执行后重新预览应产生 0 变更', async () => {
  const { ctx, extensionId } = await launchWithExtension();
  try {
    const page = await openPanel(ctx, extensionId);
    await seedBookmarks(page, makeFixtures(40));

    await runPreview(page);
    const s1 = await readStats(page);
    assert.ok(Number(s1.move) > 0, '第一次预览没有任何待移动条目，测不出幂等');

    await page.click('#btnExecute');
    await waitForExecutionDone(page);

    // 重新预览：应该全部已在位
    await runPreview(page);
    const s2 = await readStats(page);
    assert.equal(Number(s2.move), 0, `二次预览仍有 ${s2.move} 条待移动 —— 幂等被破坏`);
    assert.equal(Number(s2.inPlace), Number(s2.total), '不是全部条目都落在目标位置上了');
  } finally {
    await ctx.close();
  }
});

// ───────────────────── 4. 备份与回滚 ─────────────────────

test('回滚：执行整理后恢复到快照，书签树回到执行前', async () => {
  const { ctx, extensionId } = await launchWithExtension();
  try {
    const page = await openPanel(ctx, extensionId);
    await seedBookmarks(page, makeFixtures(30));

    await runPreview(page);
    const before = await treeSignature(page); // 预览时已自动备份

    await page.click('#btnExecute');
    await waitForExecutionDone(page);

    const after = await treeSignature(page);
    assert.notEqual(after, before, '执行后书签树毫无变化，回滚无从验证');

    // 切到备份页，恢复最近一份
    await page.click('#tabs button[data-tab="snap"]');
    await page.waitForSelector('#snapList .snap', { state: 'attached' });
    await page.click('#snapList .snap button.danger-ghost');
    await page.waitForFunction(
      () => {
        const t = document.getElementById('toast');
        return t && !t.hidden && /恢复完成/.test(t.textContent || '');
      },
      null,
      { timeout: 30000 },
    );

    const restored = await treeSignature(page);
    assert.equal(restored, before, '恢复后书签树与执行前不一致');
  } finally {
    await ctx.close();
  }
});

// ───────────────────── 5. 去重不误删 SPA 路由 ─────────────────────

test('去重：同 URL 判为重复，SPA 不同路由不判为重复', async () => {
  const { ctx, extensionId } = await launchWithExtension();
  try {
    const page = await openPanel(ctx, extensionId);
    await seedBookmarks(page, makeDuplicateFixtures());

    await runPreview(page);
    await page.click('#tabs button[data-tab="dup"]');
    await page.waitForFunction(
      () => {
        const l = document.getElementById('dupList');
        return l && l.children.length > 0;
      },
      null,
      { timeout: 20000 },
    );

    const text = await page.evaluate(() => document.getElementById('dupList').textContent || '');
    assert.match(text, /dup\.example\.com\/same/, '同一页面的两种写法没被识别为重复');
    assert.doesNotMatch(
      text,
      /spa\.example\.com/,
      'SPA 的 #/settings 与 #/profile 被判成了重复 —— 会误删用户真收藏的页面',
    );
  } finally {
    await ctx.close();
  }
});

// ───────────────────── 6. 断点续跑（模拟 SW 被回收）─────────────────────

test('断点续跑：SW 被回收后继续执行，结果与不中断一致', async () => {
  // ── 阶段 A：完整跑一遍，拿到参照结果 ──
  const first = await launchWithExtension();
  let referenceSig = null;
  {
    const page = await openPanel(first.ctx, first.extensionId);
    await seedBookmarks(page, makeFixtures(150));
    const r = await runPreview(page);
    assert.ok(r.move > 0, '预览没有任何待移动条目，测不出断点续跑');
    await page.click('#btnExecute');
    await waitForExecutionDone(page, 90000);
    referenceSig = await treeSignature(page);
  }
  await first.ctx.close();

  // ── 阶段 B：跑到一半直接关掉浏览器 ──
  // 关掉上下文 = service worker 被回收 + 扩展内存态清零；书签数据因为
  // 写在磁盘 profile 里所以还在。这正是 MV3 真实会发生的事。
  // 条数给到 150 是为了让执行持续足够久、可靠地抓到中途状态 ——
  // 条数太少的话可能在第一次轮询前就跑完了，这条断言就永远抓不到。
  const second = await launchWithExtension();
  const resumeDir = second.userDataDir;
  {
    const page = await openPanel(second.ctx, second.extensionId);
    await seedBookmarks(page, makeFixtures(150));
    const r = await runPreview(page);
    assert.ok(r.move > 0, '预览没有任何待移动条目，测不出断点续跑');
    await page.click('#btnExecute');

    // 等到确实推进了几条，但别等它跑完
    const prog = await waitForPartialProgress(page, 1, 30000);
    assert.ok(prog.done >= 1, '执行没有产生任何进度');
    assert.ok(
      prog.done < prog.total,
      `执行太快，一次轮询就跑完了（${prog.done}/${prog.total}），抓不到中途状态 —— 加大夹具条数或放慢轮询`,
    );

    // 立刻硬关，不给它跑完的机会
    await second.ctx.close();
  }

  // ── 阶段 C：同一个 profile 重开，点「继续」 ──
  const third = await launchWithExtension({ reuseUserDataDir: resumeDir });
  try {
    const page = await openPanel(third.ctx, third.extensionId);

    const partial = await treeSignature(page);
    assert.notEqual(partial, referenceSig, '根本没跑一半就结束了，这条测不出续跑');

    // 面板重新打开时会把「陈旧的 running」降级为 paused，继续按钮才会出现
    const btn = await page.waitForSelector('#btnResume:not([hidden])', { timeout: 20000 });
    assert.ok(btn, '中断后没有出现「继续」按钮');

    await btn.click();
    // 先证明续跑真的启动了（点之前状态就是「已暂停」，直接等终态会立刻返回）
    await waitForReportStatus(page, '执行中', 30000);
    const finalStatus = await waitForExecutionDone(page, 120000);
    assert.equal(finalStatus, '已完成', `续跑结束状态异常：${finalStatus}`);

    const finalSig = await treeSignature(page);
    assert.equal(finalSig, referenceSig, '断点续跑的结果与不中断时不一致');
  } finally {
    await third.ctx.close();
  }
});

// ───────────────────── 7. SW 回收后数据仍可读 ─────────────────────

test('SW 回收后 UI 仍能读出完整数据（不能「计数有值但列表空」）', async () => {
  const { ctx, extensionId } = await launchWithExtension();
  try {
    const page = await openPanel(ctx, extensionId);
    await seedBookmarks(page, makeFixtures(20));
    await runPreview(page);

    const s1 = await readStats(page);
    assert.ok(Number(s1.move) > 0, '没有待移动条目，测不出问题');

    // 硬刷新页面：模拟 SW 内存态已归零
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#btnPreview', { state: 'attached' });

    // 重新读 storage 里的计划，看条数是否与统计一致
    const planCount = await page.evaluate(async () => {
      const got = await chrome.storage.local.get('plan:last');
      return (got['plan:last']?.plan?.items || []).length;
    });
    assert.equal(planCount, Number(s1.move), 'SW 归零后读不到落盘的计划，UI 会显示空列表');
  } finally {
    await ctx.close();
  }
});

// ───────────────────── 8. 锁定 ─────────────────────

test('锁定：锁定的条目不进执行队列', async () => {
  const { ctx, extensionId } = await launchWithExtension();
  try {
    const page = await openPanel(ctx, extensionId);
    await seedBookmarks(page, makeFixtures(20));

    await runPreview(page);
    const before = Number((await readStats(page)).move);

    // 勾选第一行的锁
    await page.click('#planBody tr:first-child input[type="checkbox"]');
    await page.waitForFunction(
      (b) => {
        const el = document.getElementById('stMove');
        return el && Number(el.textContent) === b - 1;
      },
      before,
      { timeout: 15000 },
    );

    const after = Number((await readStats(page)).move);
    assert.equal(after, before - 1, '锁定后待移动条数没有减 1');
  } finally {
    await ctx.close();
  }
});
