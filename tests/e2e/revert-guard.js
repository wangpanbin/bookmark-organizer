/**
 * 闸门：move() 成功但改动没留住时，执行器必须**报失败**，不能报成功。
 *
 * ═══ 这道闸门对应一个真实的线上故障 ═══
 * 2026-10-05 用户报「点执行整理后书签栏毫无变动」。查下来：
 *   · 执行器把 45 条全部标成 done，面板弹「整理完成」，失败数 0
 *   · 但书签一条都没动
 * 根因不在执行器，而在**它从不回读**：`chrome.bookmarks.move()` resolve
 * 只代表请求被受理。真实环境里有别的力量会改写书签树 ——
 * 有 bookmarks 权限的广告拦截器/书签整理类扩展会在变更时自动重排、
 * Chrome 同步会覆盖、用户自己会拖动。改动被改回去之后，
 * 执行器一无所知，面板还报 100% 成功 —— 对用户完全不可见。
 *
 * 判据（用户可见）：
 *   ① 把 move 变成空操作后，任务必须落到 failed，面板必须弹红字
 *   ② 失败原因必须**可操作**：说清实际落在哪、目标在哪、下一步查什么
 *   ③ 绝不能出现「整理完成」这种与事实相反的提示
 *
 * 怎么模拟：把 chrome.bookmarks.move 包一层空实现（不报错、也不真的挪）。
 * 这正是「请求被受理但改动没生效」最忠实的替身。
 *
 * 用法：node tests/e2e/revert-guard.js
 */

import { launchWithExtension, openPanel, seedBookmarks, runPreview, cleanupAll } from './harness.js';
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

const readState = (page) =>
  page.evaluate(async () => {
    const t = (await chrome.storage.local.get('task:current'))['task:current'];
    const tree = await chrome.bookmarks.getTree();
    const bar = (tree[0].children || []).find((x) => String(x.id) === '1') || { children: [] };
    const paths = {};
    const walk = (n, p) => { paths[String(n.id)] = [...p]; for (const c of n.children || []) walk(c, [...p, n.title || '']); };
    for (const k of bar.children || []) walk(k, [k.title || '']);
    const items = t?.plan?.items || [];
    return {
      status: t?.status,
      total: items.length,
      done: items.filter((i) => i.status === 'done').length,
      failedItems: items.filter((i) => i.status === 'failed').length,
      failed: t?.failed || [],
      paths,
    };
  });

async function runVariant(mode) {
  say(`\n═══ 变体：${mode} ═══`);
  const { ctx, extensionId, sw } = await launchWithExtension();
  const bad = [];
  try {
    const page = await openPanel(ctx, extensionId);
    await seedBookmarks(page, FIXTURES);

    if (mode === 'reverted') {
      // ⚠️ 补丁必须打在 **service worker** 上，不能打在面板页。
      //    执行器跑在 SW 里，面板页和 SW 是两个独立的 JS 上下文、
      //    两份独立的 chrome 对象 —— 在页面里替换 chrome.bookmarks.move
      //    对执行器毫无影响（早先踩过：替身装错地方，闸门对着正常实现报红）。
      //    service worker 里也没有 window，用 self。
      if (!sw) { bad.push('reverted: 拿不到 service worker，无法打补丁'); return bad; }
      await sw.evaluate(async () => {
        const real = chrome.bookmarks.move.bind(chrome.bookmarks);
        self.__moveCalls = 0;
        self.__reverts = 0;
        chrome.bookmarks.move = async (id, dest) => {
          self.__moveCalls += 1;
          // ⚠️ 必须真搬一次：先记下原父目录，搬过去，再立刻搬回来。
          //    只把 move 变成 no-op 的话，执行器会在 move 本身抛错/走到别的分支，
          //    验不到「move 成功但回读发现没留住」这条真正要守的路径。
          const before = await chrome.bookmarks.get(id);
          const node = await real(id, dest);
          await real(id, { parentId: before[0].parentId });   // 模拟被改回
          self.__reverts += 1;
          return node;
        };
      });
      say('  已在 service worker 上装好「搬完就改回」的替身');
    }

    const r = await runPreview(page, { timeout: 60000 });
    say(`  预览: 待移动=${r.move} 总数=${r.total}`);

    await page.click('#btnExecute');
    const dl = Date.now() + 90000;
    let st = '';
    while (Date.now() < dl) {
      st = await page.evaluate(() => (document.getElementById('reportStatus')?.textContent || '').trim());
      if (['已完成', '失败', '已暂停'].includes(st)) break;
      await new Promise((x) => setTimeout(x, 150));
    }
    await new Promise((x) => setTimeout(x, 800));      // 等 pollProgress 收尾 + toast 出现

    const s = await readState(page);
    const toast = await page.evaluate(() => ({
      text: (document.getElementById('toast')?.textContent || '').trim(),
      isErr: !!document.getElementById('toast')?.classList.contains('err'),
    }));
    const banner = await page.evaluate(() => {
      const el = document.getElementById('failBanner');
      return { hidden: !!el?.hidden, text: (el?.textContent || '').replace(/\s+/g, ' ').trim() };
    });

    say(`  状态=${st}  done=${s.done}/${s.total}  failed条目=${s.failedItems}`);
    say(`  失败明细: ${JSON.stringify(s.failed).slice(0, 700)}`);
    say(`  toast: "${toast.text}"  红色=${toast.isErr}`);
    say(`  失败横幅: hidden=${banner.hidden}  "${banner.text.slice(0, 220)}"`);

    if (mode === 'reverted') {
      // ① 必须报失败
      if (s.failedItems === 0) {
        bad.push('reverted: move 空操作后仍报 0 失败 —— 执行器没有回读校验，改动没留住它也不知道');
      } else {
        say(`  ✓ 正确识别出 ${s.failedItems} 条没有生效`);
      }
      // ② 失败原因必须可操作
      const err = (s.failed[0]?.error || '');
      if (!/回读|没有留住/.test(err)) {
        bad.push(`reverted: 失败原因不可操作：「${err.slice(0, 120)}」`);
      } else if (!/实际在|其他扩展|同步|chrome:\/\/extensions/.test(err)) {
        bad.push(`reverted: 失败原因没告诉用户下一步查什么：「${err.slice(0, 160)}」`);
      } else {
        say('  ✓ 失败原因可操作：指出了实际位置、目标位置和下一步排查方向');
      }
      // ③ 绝不能报成功
      if (toast.text.includes('整理完成')) {
        bad.push(`reverted: 什么都没搬动却弹「${toast.text}」—— 提示与事实相反`);
      } else {
        say(`  ✓ 没有谎报「整理完成」`);
      }
      // ④ 失败必须摆在主面板
      if (banner.hidden) bad.push('reverted: 失败横幅没显示在计划页 —— 用户看不到失败');
      else say('  ✓ 失败横幅已显示在计划页');
    } else {
      // 正常路径：回读校验不能引入误报
      if (s.failedItems !== 0) {
        bad.push(`normal: 回读校验误报 ${s.failedItems} 条失败（正常移动不该被判失败）`);
        for (const f of s.failed.slice(0, 3)) say(`      ${f.title} — ${f.error}`);
      } else {
        say('  ✓ 回读校验零误报');
      }
      if (!toast.text.includes('整理完成')) bad.push(`normal: 正常完成却没说完成：「${toast.text}」`);
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
  for (const m of ['normal', 'reverted']) all.push(...(await runVariant(m)));
  say('\n═══════════ 汇总 ═══════════');
  if (all.length) { for (const b of all) say(`🔴 ${b}`); say(`\nRED: ${all.length} 条`); }
  else say('\nGREEN: 回读校验既能识破无效改动，又不会误报正常移动');
  writeFileSync('tests/.revert.txt', LOG.join('\n'), 'utf8');
  process.exitCode = all.length ? 1 : 0;
};

main().catch((e) => {
  writeFileSync('tests/.revert.txt', LOG.concat([`FATAL ${e && e.stack ? e.stack : e}`]).join('\n'), 'utf8');
  console.error('FATAL', e);
  process.exitCode = 1;
});
