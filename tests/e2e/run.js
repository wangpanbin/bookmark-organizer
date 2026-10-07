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
 *   7. 去重不误删 SPA 路由
 *   8. 锁定条目不进执行队列
 *   9. 去重逐条否决：勾了「不删」的条目执行后仍在，没勾的照删
 *  10. 整理栏只属于「计划明细」页
 *  11. 帮助页签真的读得到 docs/panel-help.md
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  launchWithExtension, openPanel, seedBookmarks, treeSignature,
  makeFixtures, makeDuplicateFixtures, makeVetoFixtures, runPreview, readStats, readReportStatus,
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

// ───────────────────── 9. 去重逐条否决 ─────────────────────

test('去重逐条否决：勾了「不删」的条目执行后仍在，没勾的照删', async () => {
  const FIXTURES = makeVetoFixtures();
  const urlOf = (title) => (FIXTURES.find((f) => f.title === title) || {}).url;

  const { ctx, extensionId } = await launchWithExtension();
  try {
    const page = await openPanel(ctx, extensionId);
    await seedBookmarks(page, FIXTURES);

    await runPreview(page);
    await page.click('#tabs button[data-tab="dup"]');

    // 精确定位 A 组那条待删项。
    // ⚠️ 不靠「某段文本出现了」等条件 —— 那类判据在面板 init() 之后就可能成立，
    //    会在真实渲染出来之前提前返回，然后读到上一轮的空清单。
    //    这里等的是带 data-dup-id 且带 .label 的完整 li，读到即渲染完成。
    const handle = await page
      .waitForFunction(
        () => {
          const li = [...document.querySelectorAll('#dupList li.drop')].find(
            (n) => (n.querySelector('.label')?.textContent || '').includes('否决组-待删'),
          );
          if (!li || !li.dataset.dupId) return null;
          if (!li.querySelector('input.veto')) return null;
          return { dupId: li.dataset.dupId, text: li.querySelector('.label').textContent };
        },
        null,
        { timeout: 20000 },
      )
      .then((h) => h.jsonValue());
    assert.ok(handle, 'A 组的待删项没渲染出来，这条闸门测不到东西');

    // 勾上「不删」，然后等 previewSeq 再涨一次（onVeto 会重跑一遍分类）
    const seqBefore = await page.evaluate(() => Number(document.body.dataset.previewSeq || 0));
    await page.click(`#dupList li.drop[data-dup-id="${handle.dupId}"] input.veto`);
    await page.waitForFunction(
      (n) => Number(document.body.dataset.previewSeq || 0) > n,
      seqBefore,
      { timeout: 20000 },
    );

    // 勾完之后该行文案必须变成「不删：」——
    // 勾了却看不出任何变化，用户就没法确认自己的否决生效了。
    const afterVeto = await page.evaluate(
      (id) => document.querySelector(`#dupList li.drop[data-dup-id="${id}"] .label`)?.textContent || '',
      handle.dupId,
    );
    assert.match(afterVeto, /^不删：/, `勾了「不删」但文案没变：${afterVeto}`);

    // 两组的待删项都还列在清单里 —— 否决只改这一行的状态，不会让整组从清单消失，
    // 否则用户勾了之后清单会自己少一行，反而看不出否决的是哪条。
    const dropCount = await page.evaluate(() => document.querySelectorAll('#dupList li.drop').length);
    assert.equal(dropCount, 2, `否决一条后清单里应仍列着 2 条待删，实际 ${dropCount}`);

    // 但**执行载荷**必须只剩 1 条：被否决的那条不能进删除队列。
    // 这条断言是本闸门的核心 —— 载荷里还留着它，执行器就会去删。
    const dupCount = await page.evaluate(async () => {
      const got = await chrome.storage.local.get('plan:last');
      return (got['plan:last']?.duplicates || []).length;
    });
    assert.equal(dupCount, 1, `执行载荷里应只剩 1 条待删，实际 ${dupCount}`);

    // ⚠️ 2026-10-07：整理栏被收进「计划明细」页，不再挂在所有页签共用的
    //    hero 上。而此刻我们停在「重复项」页 —— 非活动面板整棵 display:none，
    //    Playwright 点一个不可见的按钮会一直等到超时。
    //    跨页签执行本来就得先回到计划页核对，这不是新规矩。
    await page.click('#tabs button[data-tab="plan"]');
    await page.click('#btnExecute');
    await waitForExecutionDone(page, 90000);

    // 读书签树是允许用 chrome.* 的两处之一（另一处是造夹具）
    const urls = await page.evaluate(async () => {
      const out = [];
      const walk = (nodes) => {
        for (const n of nodes || []) {
          if (n.url) out.push(n.url);
          walk(n.children);
        }
      };
      walk(await chrome.bookmarks.getTree());
      return out;
    });

    // ⚠️⚠️ 断言的对象必须换掉，否则这条闸门会随机红绿。
    //
    // 早先这里断言「对照组-待删（?spm=abc 那条）必须消失」，
    // 并且断言「否决组-保留 / 对照组-保留 都必须还在」。
    // 但**哪一条是 keeper 不是夹具决定的，是 Chrome 分配的 id 决定的**：
    // compareKeeper 的口径是「同深度 → 同收藏时间 → id 升序」，
    // 这两条路径深度相同、又是同一批毫秒内创建的，dateAdded 常常完全相同，
    // 于是落到 id 升序 —— 而 id 跟着 profile 的分配走，
    // 带不带 ?spm=abc 谁拿到小 id 是不确定的（实测两种都出现过）。
    // 于是「待删项」有时真的是待删项、有时反而是保留项，断言就随机红绿。
    //
    // 真正要保证的不变量是**按组看**的：
    //   A 组（勾了不删）→ 两条都在，因为被保护的那条根本没进删除队列
    //   B 组（没勾）    → 只剩一条，因为另一条确实被删了
    const survives = (u) => urls.includes(u);
    const vetoKept = urlOf('否决组-待删');
    assert.ok(
      survives(vetoKept),
      `勾了「不删」的条目被删掉了（${vetoKept}）—— 不可逆数据损失`,
    );

    const groupA = ['否决组-保留', '否决组-待删'].map(urlOf);
    const aSurvivors = groupA.filter(survives);
    assert.equal(
      aSurvivors.length, 2,
      `A 组应当两条都在（被「不删」保护的那条没进删除队列），实际剩 ${aSurvivors.length} 条：${aSurvivors.join(' / ')}`,
    );

    const groupB = ['对照组-保留', '对照组-待删'].map(urlOf);
    const bSurvivors = groupB.filter(survives);
    assert.equal(
      bSurvivors.length, 1,
      `B 组应当也删掉一条，实际剩下 ${bSurvivors.length} 条（${bSurvivors.join(' / ')}）`
      + '—— 否决被当成了全局跳过，或两条都被删了',
    );
  } finally {
    await ctx.close();
  }
});

// ───────────────────── 10. 整理栏只属于「计划明细」页 ─────────────────────
// 2026-10-07 新增。这条闸门量的是**用户提的那件事**：
// 读一遍计划就能看懂要动什么，不必先猜「这 45 条书签会不会动」。
//
// 为什么要有它：整理栏原本挂在 <main> 之下、六个面板之外，于是每一个页签
// 顶部都顶着「执行整理」。那个状态看起来完全正常 —— 按钮能点、执行照跑，
// 一次预览照过。所以它不会以任何报错的形式暴露出来。
//
// ⚠️ 判据用 **isVisible** 而不是「元素存不存在」：节点一直在 DOM 里，
//    非活动面板只是 display:none。查存在性会对正确的代码报红 ——
//    误报的闸门比没有闸门更糟（大家只会学会忽略它，真违规也一起被忽略）。
test('整理栏只出现在「计划明细」页，其余页签都不许露出执行入口', async () => {
  const { ctx, extensionId } = await launchWithExtension();
  try {
    const page = await openPanel(ctx, extensionId);
    await seedBookmarks(page, makeFixtures(12));
    await runPreview(page);

    const onPlan = ['#btnExecute', '#btnPreview', '#planSpine', '#stats'];
    for (const sel of onPlan) {
      assert.ok(await page.isVisible(sel), `计划明细页上 ${sel} 反而不可见`);
    }

    // 每一个非计划页签：整理栏一个都不许露
    for (const tab of ['scope', 'dup', 'health', 'snap', 'settings', 'help']) {
      await page.click(`#tabs button[data-tab="${tab}"]`);
      for (const sel of onPlan) {
        assert.equal(
          await page.isVisible(sel), false,
          `${sel} 在「${tab}」页上仍然可见 —— 整理栏又漏回公共区域了`,
        );
      }
    }

    // #busy 反过来：它**必须**在每一页都可用。
    // 它有 7 个调用点来自别的页签（勾选区读树、快照恢复、展开全部），
    // 跟着整理栏一起被藏起来的话，症状是「点了没反应」且界面不作解释。
    for (const tab of ['plan', 'scope', 'dup', 'health', 'snap', 'settings', 'help']) {
      await page.click(`#tabs button[data-tab="${tab}"]`);
      const owner = await page.evaluate(() => {
        const el = document.getElementById('busy');
        return el ? el.closest('.panel')?.id || 'body' : 'missing';
      });
      assert.equal(owner, 'body',
        `#busy 在「${tab}」页上挂在 ${owner}，它必须是 body 的直接子级`);
    }

    // 切回计划页，一切照旧
    await page.click('#tabs button[data-tab="plan"]');
    assert.ok(await page.isVisible('#btnExecute'), '切回计划明细页后执行按钮不见了');
  } finally {
    await ctx.close();
  }
});

// ───────────────────── 11. 帮助页签真的读得到文档 ─────────────────────
// ⚠️ 这条同时是 fetch 方案可行性的实测。扩展页能不能 fetch 自己包里的
//    资源，代码审查判不出来 —— 只有真跑一次浏览器才知道。
//    若这里红了而失败原因是「读不到 docs/panel-help.md」，说明 CSP 挡住了，
//    退路写在计划里（manifest 显式放行 connect-src，或改内联）。
test('帮助页签读得到 docs/panel-help.md，且读不到时要说清为什么', async () => {
  const { ctx, extensionId } = await launchWithExtension();
  try {
    const page = await openPanel(ctx, extensionId);
    await page.click('#tabs button[data-tab="help"]');

    await page.waitForFunction(
      () => {
        const err = document.getElementById('helpError');
        const body = document.getElementById('helpBody');
        return (err && !err.hidden) || (body && body.children.length > 0);
      },
      undefined,
      { timeout: 15000 },
    );

    const failed = await page.isVisible('#helpError');
    const text = await page.textContent('#helpBody');
    assert.ok(
      !failed,
      `帮助文档读不出来：${(await page.textContent('#helpError')).trim()}`,
    );
    assert.match(text, /书签/, '帮助文档渲染出来了但内容是空的');
    assert.ok(
      (await page.$$('#helpBody h2')).length > 0,
      '帮助文档一个二级标题都没渲染出来 —— Markdown 渲染器没生效',
    );
  } finally {
    await ctx.close();
  }
});
