/**
 * 闸门：计划里的书签 id 全部失效时，必须自愈或明确拒绝，不能逐条撞同一句墙。
 *
 * ═══ 对应的真实故障（2026-10-05）══════════════════════════════
 * 用户执行整理，45 条**全部**报 `Error: Can't find bookmark for id.`
 * 探针 tests/e2e/probe-errid.js 验明：这句话在 Chrome 里只有一个含义 ——
 * **源书签 id 不存在**（与「目标文件夹不存在」是另一句
 *  `Can't find parent bookmark for id.`）。而用户的书签都还在树上。
 * ⇒ 计划是从一棵**已经不存在的树**算出来的：书签被删过又重建、
 *   恢复过备份、或同步落地过，旧 id 全部失效。
 * ⇒ 早先的实现不校验就硬搬，于是 45 条逐条撞同一句墙，
 *   而 Chrome 的原话对用户零信息量。
 *
 * 三个变体：
 *   ok        id 都有效 → 正常搬（回读校验不能误报）
 *   relocated 每条书签先删掉再按同 URL 重建（新 id）→ 必须按 URL 自动找回来并搬成功
 *   allGone   每条书签都被删干净 → 必须**拒绝启动**并给出可操作原因，不能跑出 45 条失败
 *
 * 用法：node tests/e2e/stale-ids.js
 */

import { launchWithExtension, openPanel, runPreview, cleanupAll } from './harness.js';
import { writeFileSync } from 'node:fs';

process.on('exit', cleanupAll);

const LOG = [];
const say = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  LOG.push(line);
  console.log(line);
};

const FIXTURES = [
  { title: 'GitHub', url: 'https://github.com/a/b' },
  { title: 'Redis', url: 'https://redis.io/docs/latest/' },
  { title: '知乎', url: 'https://www.zhihu.com/q/1' },
  { title: '掘金', url: 'https://juejin.cn/' },
];

/** 预览后、执行前：把每条书签删掉再用同 URL 重建（= id 全变，书签还在） */
const recycleIds = (page) =>
  page.evaluate(async (list) => {
    const before = new Map();
    for (const f of list) {
      const hit = (await chrome.bookmarks.search({ url: f.url }))[0];
      if (hit) before.set(f.url, String(hit.id));
    }
    for (const f of list) {
      const id = before.get(f.url);
      if (!id) continue;
      await chrome.bookmarks.remove(id);
      const re = await chrome.bookmarks.create({ parentId: '1', title: f.title, url: f.url });
      before.set(f.url, String(re.id));
    }
    return [...before.entries()].map(([url, id]) => ({ url, newId: id }));
  }, FIXTURES);

/** 预览后、执行前：把每条书签彻底删掉 */
const deleteAll = (page) =>
  page.evaluate(async (list) => {
    let n = 0;
    for (const f of list) {
      for (const hit of await chrome.bookmarks.search({ url: f.url })) {
        await chrome.bookmarks.remove(hit.id);
        n += 1;
      }
    }
    return n;
  }, FIXTURES);

async function runVariant(mode) {
  say(`\n═══ 变体：${mode} ═══`);
  const { ctx, extensionId } = await launchWithExtension();
  const bad = [];
  try {
    const page = await openPanel(ctx, extensionId);
    await page.evaluate(async (list) => {
      for (const f of list) await chrome.bookmarks.create({ parentId: '1', title: f.title, url: f.url });
    }, FIXTURES);

    const r = await runPreview(page, { timeout: 60000 });
    say(`  预览: 待移动=${r.move}`);

    if (mode === 'relocated') {
      const m = await recycleIds(page);
      say(`  已把 ${m.length} 条书签删掉重建（新 id: ${m.map((x) => x.newId).join(',')}）`);
    } else if (mode === 'allGone') {
      const n = await deleteAll(page);
      say(`  已彻底删除 ${n} 条书签`);
    }

    // 记录 confirm 弹窗与 toast
    let confirmText = '';
    page.on('dialog', async (d) => {
      if (d.type() === 'confirm') { try { confirmText = d.message(); } catch { /* 已关 */ } }
      await d.accept().catch(() => {});
    });

    await page.click('#btnExecute');
    // allGone 变体里任务**被拒**、根本不会建，终态永远不会出现 ——
    // 早先给它和正常路径一样的 90s 耐心，纯白等 90 秒。
    // 判据按变体给足即可。
    const waitMs = mode === 'allGone' ? 12000 : 90000;
    const dl = Date.now() + waitMs;
    let st = '';
    while (Date.now() < dl) {
      st = await page.evaluate(() => (document.getElementById('reportStatus')?.textContent || '').trim());
      if (['已完成', '失败', '已暂停'].includes(st)) break;
      await new Promise((x) => setTimeout(x, 150));
    }
    await new Promise((x) => setTimeout(x, 600));

    const s = await page.evaluate(async () => {
      const t = (await chrome.storage.local.get('task:current'))['task:current'];
      const items = t?.plan?.items || [];
      const tree = await chrome.bookmarks.getTree();
      const paths = {};
      // ⚠️ 记的是**所在文件夹路径**（含根名、不含节点自己的标题）：
      //    早先写成 walk(top, [top.title]) 却又把 node.title 拼一次，
      //    根名被算两遍，`.slice(1).join('/')` 永远对不上 toStr ——
      //    「落位 0/4」恒成立，闸门对着跑通了的实现报红。
      const walk = (n, p) => {
        paths[String(n.id)] = [...p];
        const here = [...p, n.title || ''];
        for (const c of n.children || []) walk(c, here);
      };
      for (const top of tree[0].children || []) walk(top, []);
      return {
        taskExists: !!t,
        status: t?.status,
        total: items.length,
        done: items.filter((i) => i.status === 'done').length,
        failed: items.filter((i) => i.status === 'failed').length,
        skipped: items.filter((i) => i.status === 'skipped').length,
        relocated: items.filter((i) => i.idRelocated).length,
        stale: (t?.stale || []).length,
        failedList: (t?.failed || []).slice(0, 3).map((f) => f.error),
        inPlace: items.filter((i) => i.toStr && (paths[String(i.id)] || []).slice(1).join('/') === i.toStr).length,
        paths,
      };
    });
    const toast = await page.evaluate(() => (document.getElementById('toast')?.textContent || '').trim());

    say(`  状态=${st}  total=${s.total} done=${s.done} failed=${s.failed} skipped=${s.skipped} 重新定位=${s.relocated}`);
    say(`  落位核对: ${s.inPlace} / ${s.total} 在承诺的位置`);
    say(`  toast: "${toast}"`);
    if (s.failedList.length) say(`  失败样例: ${JSON.stringify(s.failedList).slice(0, 400)}`);

    if (mode === 'ok') {
      if (s.failed > 0) bad.push(`ok: 回读/对齐校验误报 ${s.failed} 条失败`);
      if (s.inPlace !== s.total) bad.push(`ok: 落位 ${s.inPlace}/${s.total}，不齐`);
    } else if (mode === 'relocated') {
      // 核心判据：id 全变之后仍然必须搬成功
      if (s.relocated !== s.total) {
        bad.push(`relocated: 只有 ${s.relocated}/${s.total} 条被重新定位 —— 应当全部按 URL 找回`);
      }
      if (s.inPlace !== s.total) {
        bad.push(`relocated: 落位 ${s.inPlace}/${s.total} —— 书签还在但没搬进类目文件夹`);
      }
      if (s.failed > 0) bad.push(`relocated: 仍有 ${s.failed} 条失败，不该发生`);
      if (!/重新定位/.test(toast)) {
        bad.push(`relocated: 最后一条提示没说明「重新定位」：「${toast}」—— 计划被改过却没告诉用户`);
      } else {
        say('  ✓ 最后一条提示保留了「已按 URL 重新定位」这个事实');
      }
    } else if (mode === 'allGone') {
      // 一条都对不上：必须拒绝启动，而不是跑出 45 条同样的失败
      if (s.taskExists) {
        bad.push('allGone: 书签全被删掉却仍然建了任务并开跑 —— 应该直接拒绝');
      }
      if (!/读取并预览|重新算/.test(toast)) {
        bad.push(`allGone: 拒绝时没告诉用户下一步：「${toast}」`);
      } else {
        say('  ✓ 已拒绝启动并给出可操作的下一步');
      }
    }
  } catch (e) {
    bad.push(`${mode}: 抛异常 ${e && e.message ? e.message : e}`);
  } finally {
    await ctx.close();
  }
  return bad;
}

const main = async () => {
  const all = [];
  for (const m of ['ok', 'relocated', 'allGone']) all.push(...(await runVariant(m)));
  say('\n═══════════ 汇总 ═══════════');
  if (all.length) { for (const b of all) say(`🔴 ${b}`); say(`\nRED: ${all.length} 条`); }
  else say('\nGREEN：id 失效能自愈，全失效能拒绝，正常路径零误报');
  writeFileSync('tests/.stale.txt', LOG.join('\n'), 'utf8');
  process.exitCode = all.length ? 1 : 0;
};

main().catch((e) => {
  writeFileSync('tests/.stale.txt', LOG.concat([`FATAL ${e && e.stack ? e.stack : e}`]).join('\n'), 'utf8');
  console.error('FATAL', e);
  process.exitCode = 1;
});
