/**
 * 探针：`Error: Can't find bookmark for id.` 到底是**源 id**坏了还是**目标 id**坏了？
 *
 * 为什么必须先探明：用户 2026-10-05 的失败清单里 45 条全是这一句。
 * 如果 Chrome 对两种故障报同一句话，那把原文直接透给用户就是零信息量 ——
 * 用户既不知道是哪条 id，也不知道该去查什么。这本身就是缺陷。
 *
 * 探针在真实 Chrome 里跑（E2E harness），每种情况单独触发，比对错误文案。
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
  say('═══ 探针：Can\'t find bookmark for id. 的归属 ═══');
  const { ctx, extensionId } = await launchWithExtension();
  let red = 0;
  try {
    const page = await openPanel(ctx, extensionId);

    const r = await page.evaluate(async () => {
      const out = {};
      const probe = async (name, fn) => {
        try { out[name] = { ok: true, value: await fn() }; }
        catch (e) { out[name] = { ok: false, error: String(e && e.message ? e.message : e) }; }
      };

      // 夹具
      const holder = await chrome.bookmarks.create({ parentId: '1', title: 'ZZ_probe_holder' });
      const doomed = await chrome.bookmarks.create({ parentId: String(holder.id), title: 'ZZ_probe_doomed' });
      const keep = await chrome.bookmarks.create({ parentId: '1', title: 'ZZ_probe_keep', url: 'https://probe.example.com/a' });
      const target = await chrome.bookmarks.create({ parentId: '1', title: 'ZZ_probe_target' });

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
      const throwaway = await chrome.bookmarks.create({ parentId: '1', title: 'ZZ_probe_throwaway' });
      const goneId = String(throwaway.id);
      await chrome.bookmarks.removeTree(goneId);
      await probe('7_dest_deleted', () => chrome.bookmarks.move(String(keep.id), { parentId: goneId }));

      // 8) 把源书签删掉之后再移它
      const doomedId = String(doomed.id);
      await chrome.bookmarks.removeTree(doomedId);
      await probe('8_source_deleted', () => chrome.bookmarks.move(doomedId, { parentId: String(target.id) }));

      // 9) 大 id 会不会被 String() 搞坏
      await probe('9_get_missing', () => chrome.bookmarks.get('999999999'));

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

    for (const [k, v] of Object.entries(r)) {
      say(`  ${k}: ${v.ok ? '✅ ' + v.value : '❌ ' + v.error}`);
    }

    // 判定：哪些情况共用同一句错误
    const byMsg = {};
    for (const [k, v] of Object.entries(r)) {
      if (v.ok) continue;
      (byMsg[v.error] ||= []).push(k);
    }
    say('\n  错误文案归组:');
    for (const [msg, keys] of Object.entries(byMsg)) {
      say(`    「${msg}」← ${keys.join(', ')}`);
    }
    const shared = Object.values(byMsg).find((g) => g.length > 1);
    if (shared) {
      say(`\n  ⚠️ 结论：${shared.length} 种不同故障共用同一句错误 → 原文透传对用户零信息量`);
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
