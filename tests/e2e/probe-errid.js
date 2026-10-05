/**
 * 探针：把 chrome.bookmarks 在各种故障下的**原话**逐条录下来。
 *
 * ═══ 这个探针的定位（2026-10-05 改写）═══
 * 它的产出是**一条带浏览器版本的记录**，不是一张「哪句话对应哪个原因」的对照表。
 *
 * 改写原因：早先的版本把结论写在了标题里，于是被当成契约用了 ——
 * 我据它断定「`Can't find bookmark for id.` = 源书签 id 不存在」，
 * 把用户的 45 条失败统一解释成「书签被删过/恢复过备份」，还加了一整套
 * 按 URL 重新定位 id 的自愈逻辑。而真实根因是**目标根 id 写死成 '1'**，
 * 在 Chrome 154 上报的就是同一句话。**错误文案不是稳定契约，跨版本会变。**
 *
 * 所以：每条记录都带上「这是哪个 Chrome 说的」，让结论无法脱离来源单独流通。
 * 诊断时以现场 `get()` 核实到的事实为准，不以本文件的归组为准。
 *
 * ⚠️ 早先的夹具还写死了 `parentId: '1'`（根 id 当常量）——在 Chrome 154 上
 *    书签栏是 279，第一行 create 就会抛错，整个探针根本跑不起来。
 *    这也是「没人发现它已经坏了」的原因：它只在 Playwright 自带的
 *    chromium 上跑过，那里根 id 恰好还是 1。现在按位置解析，不写死。
 */

import { launchWithExtension, openPanel, cleanupAll } from './harness.js';
import { writeFileSync } from 'node:fs';

process.on('exit', cleanupAll);

const LOG = [];
const say = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  LOG.push(line);
  console.log(line);
};

const main = async () => {
  say('═══ 探针：chrome.bookmarks 各故障下的原话（记录用，非契约）═══');
  const { ctx, extensionId } = await launchWithExtension();
  let red = 0;
  try {
    const page = await openPanel(ctx, extensionId);

    const r = await page.evaluate(async () => {
      // 根 id 按**位置**取：getTree()[0].children[0] 恒为书签栏。
      // 同一规则住在 src/roots.js 的 rootsFromTree()；这里不 import 它，
      // 是为了不依赖 page.evaluate 里有没有 chrome.runtime（隔离世界里可能是 undefined）。
      const tree = await chrome.bookmarks.getTree();
      const tops = tree?.[0]?.children || [];
      const bar = tops[0] || null;
      const out = {
        _env: {
          ua: navigator.userAgent,
          barId: bar ? String(bar.id) : null,
          barTitle: bar ? bar.title : null,
          rootIds: tops.map((t) => `${t.title}=${t.id}`).join('  '),
        },
      };
      if (!bar) {
        out._fatal = '书签树里没有顶层根';
        return out;
      }
      const ROOT = String(bar.id);

      const probe = async (name, fn) => {
        try { out[name] = { ok: true, value: await fn() }; }
        catch (e) { out[name] = { ok: false, error: String(e && e.message ? e.message : e) }; }
      };

      // 夹具（一律挂在解析出来的书签栏下，不再写死 '1'）
      const holder = await chrome.bookmarks.create({ parentId: ROOT, title: 'ZZ_probe_holder' });
      const doomed = await chrome.bookmarks.create({ parentId: String(holder.id), title: 'ZZ_probe_doomed' });
      const keep = await chrome.bookmarks.create({ parentId: ROOT, title: 'ZZ_probe_keep', url: 'https://probe.example.com/a' });
      const target = await chrome.bookmarks.create({ parentId: ROOT, title: 'ZZ_probe_target' });

      // 1) 正常移动 —— 应当成功
      await probe('1_ok_move', () => chrome.bookmarks.move(String(keep.id), { parentId: String(target.id) })
        .then((n) => `成功，parentId=${n.parentId}`));

      // 2) 源 id 不存在（纯数字，但树里没有）
      await probe('2_source_bogus', () => chrome.bookmarks.move('999999999', { parentId: String(target.id) }));

      // 3) 源 id 不是数字
      await probe('3_source_notnum', () => chrome.bookmarks.move('ZZZ', { parentId: String(target.id) }));

      // 4) 目标 parentId 不存在
      await probe('4_dest_bogus', () => chrome.bookmarks.move(String(keep.id), { parentId: '999999999' }));

      // 5) 目标 parentId 不是数字
      await probe('5_dest_notnum', () => chrome.bookmarks.move(String(keep.id), { parentId: 'ZZZ' }));

      // 6) 目标 = 根节点（文档明确说会报错）
      await probe('6_dest_root', () => chrome.bookmarks.move(String(keep.id), { parentId: '0' }));

      // 7) 把目标文件夹删掉之后再移进去（模拟「文件夹被别的扩展删了/我们缓存了失效 id」）
      const throwaway = await chrome.bookmarks.create({ parentId: ROOT, title: 'ZZ_probe_throwaway' });
      const goneId = String(throwaway.id);
      await chrome.bookmarks.removeTree(goneId);
      await probe('7_dest_deleted', () => chrome.bookmarks.move(String(keep.id), { parentId: goneId }));

      // 8) 把源书签删掉之后再移它
      const doomedId = String(doomed.id);
      await chrome.bookmarks.removeTree(doomedId);
      await probe('8_source_deleted', () => chrome.bookmarks.move(doomedId, { parentId: String(target.id) }));

      // 9) 大 id 会不会被 String() 搞坏
      await probe('9_get_missing', () => chrome.bookmarks.get('999999999'));

      // 10) ★ 事故复现：把根 id 当成常量用。Chrome 154 上书签栏是 279，
      //     所以这里报的错**与上面 2/7 号未必同句** —— 这正是要录下来的。
      await probe('10_hardcoded_root_id', () => chrome.bookmarks.getChildren('1'));

      // 清理
      for (const t of ['ZZ_probe_holder', 'ZZ_probe_target']) {
        const hit = (await chrome.bookmarks.search(t))[0];
        if (hit) await chrome.bookmarks.removeTree(hit.id).catch(() => {});
      }
      for (const b of (await chrome.bookmarks.search('ZZ_probe_keep'))) {
        await chrome.bookmarks.remove(b.id).catch(() => {});
      }
      return out;
    });

    const env = r._env || {};
    say(`  浏览器：${String(env.ua || '').match(/Chrome\/([\d.]+)/)?.[0] || '未知'}`);
    say(`  顶层根：${env.rootIds || '（读不到）'}`);
    say(`  本次用的书签栏 id：${env.barId}（标题：${env.barTitle}）`);
    if (r._fatal) say(`  ❌ ${r._fatal}`);
    say('  ⚠️ 下面每条都只对上面这个 Chrome 版本成立。跨版本请重跑本探针。');
    say('');

    for (const [k, v] of Object.entries(r)) {
      if (k.startsWith('_')) continue;
      say(`  ${k}: ${v.ok ? '✅ ' + v.value : '❌ ' + v.error}`);
    }

    // 归组：只报告「哪些故障共用同一句」，不解释这句话意味着什么。
    const byMsg = {};
    for (const [k, v] of Object.entries(r)) {
      if (k.startsWith('_') || v.ok) continue;
      (byMsg[v.error] ||= []).push(k);
    }
    say('\n  同句归组（同一句话覆盖了哪几种故障）:');
    for (const [msg, keys] of Object.entries(byMsg)) {
      say(`    「${msg}」← ${keys.join(', ')}`);
    }
    const shared = Object.values(byMsg).find((g) => g.length > 1);
    if (shared) {
      say(`\n  ⚠️ 记录：${shared.length} 种不同故障共用同一句错误`);
      say('     → 原文透传对用户零信息量，所以失败提示必须**现场核实**'
        + '（分别 get 源 id 与目标 id），不能靠匹配这句话反推原因。');
    }
  } catch (e) {
    say(`  ❌ 探针异常：${e && e.stack ? e.stack : e}`);
    red++;
  } finally {
    await ctx.close();
  }
  writeFileSync('tests/.probe.txt', LOG.join('\n'), 'utf8');
  process.exitCode = red ? 1 : 0;
};

main().catch((e) => {
  writeFileSync('tests/.probe.txt', LOG.concat([`FATAL ${e && e.stack ? e.stack : e}`]).join('\n'), 'utf8');
  console.error('FATAL', e);
  process.exitCode = 1;
});
