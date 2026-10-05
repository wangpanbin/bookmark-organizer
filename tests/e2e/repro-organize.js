/**
 * 复现脚本：复刻用户的真实操作流程
 *   读取并预览 → 手动改判（✗改）→ 执行整理 → 断言书签真的落到了目标文件夹
 *
 * 判据是**用户可见的承诺**：「执行整理后，每条计划项都应该在它承诺的文件夹里」。
 * 不是「执行器说 done 了」（task.status=done 只说明循环跑完了，不说明书签动了）。
 *
 * 用法：node tests/e2e/repro-organize.js
 * 退出码 0 = 绿（每条都落位）；1 = 红（贴出没落位的条目）
 */

import { launchWithExtension, openPanel, seedBookmarks, runPreview, cleanupAll } from './harness.js';

process.on('exit', cleanupAll);

const say = (...a) => console.log(...a);

/**
 * 读整棵树的 id → **所在文件夹路径**（含根名，不含节点自己的标题）。
 * 只记父目录链：书签节点的 path 是 ['书签栏','学习资料','电子书']，
 * 剥掉第 0 段根名后正好与 toStr 同口径。
 */
const readTreeState = (page) =>
  page.evaluate(async () => {
    const out = {};
    const walk = (node, folderPath) => {
      out[String(node.id)] = [...folderPath];
      const here = [...folderPath, node.title || ''];
      for (const c of node.children || []) walk(c, here);
    };
    const tree = await chrome.bookmarks.getTree();
    for (const top of tree[0].children || []) walk(top, []);
    return out;
  });

/** 读页面里当前的计划（state.plan 不在 window 上，改从 DOM 的表格行还原 id→目标） */
const readPlanRows = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('#planBody tr')].map((tr) => {
      const tds = tr.querySelectorAll('td');
      return {
        title: tds[1]?.querySelector('.title')?.textContent || '',
        url: tds[1]?.querySelector('.url')?.textContent || '',
        from: tds[2]?.textContent?.trim() || '',
        to: tds[4]?.textContent?.trim() || '',
        why: tds[5]?.textContent?.trim() || '',
      };
    }),
  );

/** 从 storage 里读落盘的计划（执行器真正消费的那份） */
const readStoredPlan = (page) =>
  page.evaluate(async () => {
    const got = await chrome.storage.local.get('task:current');
    const t = got['task:current'];
    if (!t || !t.plan) return null;
    return {
      status: t.status,
      items: (t.plan.items || []).map((i) => ({
        id: String(i.id),
        title: i.title,
        url: i.url,
        toStr: i.toStr,
        toPath: i.toPath,
        status: i.status,
        reason: i.reason,
      })),
      failed: t.failed || [],
    };
  });

const main = async () => {
  const { ctx, extensionId } = await launchWithExtension();
  let red = 0;
  try {
    const page = await openPanel(ctx, extensionId);

    // ── 造更贴近真实用户的夹具：根目录若干 + 一个已存在的文件夹里若干 ──
    await page.evaluate(async () => {
      const f = await chrome.bookmarks.create({ parentId: '1', title: '待整理的旧文件夹' });
      window.__oldFolderId = String(f.id);
    });
    const oldFolderId = await page.evaluate(() => window.__oldFolderId);

    const fixtures = [
      { title: 'GitHub 某仓库', url: 'https://github.com/some/repo' },
      { title: 'Vue 文档', url: 'https://cn.vuejs.org/guide/introduction.html' },
      { title: 'MDN Web Docs', url: 'https://developer.mozilla.org/zh-CN/docs/Web/CSS' },
      { title: 'Redis 文档', url: 'https://redis.io/docs/latest/' },
      { title: 'arXiv 论文', url: 'https://arxiv.org/abs/1706.03762' },
      { title: '某博客', url: 'https://blog.example.org/post/1' },
      // 已经躺在旧文件夹里的（真实用户绝大多数书签都在文件夹里，不在根目录）
      { title: '知乎收藏', url: 'https://www.zhihu.com/question/1', parentId: oldFolderId },
      { title: '豆瓣电影', url: 'https://movie.douban.com/', parentId: oldFolderId },
      { title: 'CSDN', url: 'https://blog.csdn.net/', parentId: oldFolderId },
    ];
    await seedBookmarks(page, fixtures);

    const before = await readTreeState(page);

    // ── 第 1 步：读取并预览 ──
    const r1 = await runPreview(page);
    say(`[1] 预览: 待移动=${r1.move} 总数=${r1.total} 表格行=${r1.rows}`);
    if (r1.move === 0) {
      say('❌ 预览就算出 0 条待移动 —— 问题在计划生成，先不用往下走。');
      process.exitCode = 1;
      return;
    }
    const rows1 = await readPlanRows(page);
    for (const r of rows1) say(`      ${r.title.padEnd(14)} ${r.from.padEnd(18)} → ${r.to}   [${r.why}]`);

    // ── 第 2 步：手动改判第 1 条（用户说「我正确的分类之后」）──
    const PICK = '学习资料/电子书';   // 故意挑一个和现状完全不同的类目
    const seqBefore = await page.evaluate(() => Number(document.body.dataset.previewSeq || 0));
    await page.click('#planBody tr:nth-child(1) .fb button:nth-child(2)');   // ✗ 改
    await page.waitForSelector('#pathPicker[open]', { timeout: 5000 });
    await page.click(`#pathPicker input[name="pick"][value="${PICK}"]`);
    await page.click('#pickerOk');
    await page.waitForFunction(
      (n) => Number(document.body.dataset.previewSeq || 0) > n,
      seqBefore,
      { timeout: 30000 },
    );
    const rows2 = await readPlanRows(page);
    const first = rows2[0];
    // UI 渲染用 ' / ' 连接，比较前统一去掉空格
    const shown = (s) => (s || '').replace(/\s*\/\s*/g, '/').trim();
    say(`[2] 手动改判后第 1 行: ${first.title} → ${first.to}   [${first.why}]`);
    if (!first || shown(first.to) !== PICK) {
      say(`❌ 改判没生效：期望「${PICK}」，实际「${first && shown(first.to)}」`);
      red++;
    }

    // ── 第 3 步：执行整理 ──
    const r2 = await runPreview(page);
    say(`[3] 改判后重新确认: 待移动=${r2.move}`);
    await page.click('#btnExecute');          // confirm 已被 harness 自动接受
    // 等落盘的任务状态变终态（判据是 status 单元格的值，不是全文子串）
    const deadline = Date.now() + 90000;
    let st = null;
    while (Date.now() < deadline) {
      st = await page.evaluate(() => (document.getElementById('reportStatus')?.textContent || '').trim());
      if (['已完成', '失败', '已暂停'].includes(st)) break;
      await new Promise((res) => setTimeout(res, 200));
    }
    say(`[3] 任务状态 = ${st}`);
    const stored = await readStoredPlan(page);
    say(`[3] 落盘计划: ${stored ? stored.items.length : 'null(没有 task:current!)'} 条，` +
        `done=${stored ? stored.items.filter((i) => i.status === 'done').length : '-'}/` +
        `${stored ? stored.items.length : '-'}，失败记录 ${stored ? stored.failed.length : '-'} 条`);
    if (stored && stored.failed.length) {
      for (const f of stored.failed.slice(0, 8)) say(`      ❌ ${f.url} — ${f.error}`);
    }

    // ── 第 4 步：断言「书签真的落位了」—— 这才是用户看到的现象 ──
    const after = await readTreeState(page);
    if (!stored || !stored.items.length) {
      say('❌ storage 里根本没有 task:current —— 执行器压根没建任务。');
      red++;
    } else {
      say('[4] 逐条核对落位情况:');
      for (const it of stored.items) {
        const p = after[it.id];
        if (!p) { say(`      ❌ ${it.title} —— 树里找不到这个节点了（被删了？）`); red++; continue; }
        const actualRel = p.slice(1).join('/');     // 剥掉根名，与 toStr 同口径
        const ok = actualRel === it.toStr;
        if (!ok) {
          red++;
          say(`      ❌ ${it.title}`);
          say(`           期望 ${it.toStr}`);
          say(`           实际 ${actualRel || '(在根目录)'}   完整路径 ${JSON.stringify(p)}`);
        } else {
          say(`      ✓ ${it.title.padEnd(14)} → ${actualRel}`);
        }
      }
    }

    // ── 第 5 步：树到底变了没有（用户的原话「标签也没有任何的变化」）──
    const beforeKeys = Object.keys(before);
    const movedCount = beforeKeys.filter((id) => JSON.stringify(before[id]) !== JSON.stringify(after[id])).length;
    say(`[5] 书签树中位置发生变化的节点数 = ${movedCount} / ${beforeKeys.length}`);
    if (movedCount === 0) {
      say('❌ 整棵树一个字节都没变 —— 与用户描述的症状完全一致。');
      red++;
    }

    // ── 第 6 步：幂等 ──
    const r3 = await runPreview(page);
    say(`[6] 执行后再预览: 待移动=${r3.move}（期望 0）`);
    if (r3.move !== 0) red++;
  } finally {
    await ctx.close();
  }

  say('');
  if (red) {
    say(`🔴 RED —— ${red} 条断言不通过。`);
    process.exitCode = 1;
  } else {
    say('🟢 GREEN —— 每条都落到了承诺的文件夹里。');
  }
};

main().catch((e) => {
  console.error('FATAL:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
