/**
 * 规模验证：真用户书签是几千条，不是 20 条。
 *
 * 执行器每搬一条都要落盘一次（断点续跑的关键），而落盘写的是**整个 task 对象**
 * ——里面装着全部计划项。于是单条代价随 N 线性上升，整轮是 O(N²)。
 * 这里量的是三件事：
 *   ① 能不能跑完（会不会中途被 SW 回收/卡死）
 *   ② 每条平均耗时（外推到 2000 条要多久）
 *   ③ 跑完之后是不是真的都落位了
 *
 * 用法：node tests/e2e/scale.js [条数，默认 800]
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

const N = Number(process.argv[2] || 800);

const readTreeState = (page) =>
  page.evaluate(async () => {
    const out = {};
    const walk = (node, p) => {
      out[String(node.id)] = [...p];
      const here = [...p, node.title || ''];
      for (const c of node.children || []) walk(c, here);
    };
    const tree = await chrome.bookmarks.getTree();
    for (const top of tree[0].children || []) walk(top, []);
    return out;
  });

const main = async () => {
  say(`═══ 规模验证 N=${N} ═══`);
  const { ctx, extensionId } = await launchWithExtension();
  let red = 0;
  try {
    const page = await openPanel(ctx, extensionId);

    const known = [
      ['GitHub', 'https://github.com/a/b'], ['Vue', 'https://cn.vuejs.org/guide/i.html'],
      ['MDN', 'https://developer.mozilla.org/zh-CN/docs/Web/CSS'], ['Redis', 'https://redis.io/docs/'],
      ['Docker', 'https://docs.docker.com/g/'], ['arXiv', 'https://arxiv.org/abs/1'],
      ['Notion', 'https://www.notion.so/w'], ['力扣', 'https://leetcode.cn/p/'],
      ['B站', 'https://www.bilibili.com/'], ['网易云', 'https://music.163.com/'],
      ['IT之家', 'https://www.ithome.com/'], ['知乎', 'https://www.zhihu.com/q'],
      ['淘宝', 'https://www.taobao.com/'], ['美团', 'https://www.meituan.com/'],
      ['Dribbble', 'https://dribbble.com/s'], ['Figma', 'https://www.figma.com/f'],
      ['iconfont', 'https://www.iconfont.cn/c'], ['CSDN', 'https://blog.csdn.net/'],
      ['掘金', 'https://juejin.cn/'], ['Netflix', 'https://www.netflix.com/'],
    ];
    const list = [];
    for (let i = 0; i < N; i++) {
      if (i < known.length) list.push({ title: known[i][0], url: known[i][1] });
      else list.push({ title: `站点 ${i}`, url: `https://site-${i}.example.org/page` });
    }

    let t0 = Date.now();
    await seedBookmarks(page, list);
    say(`  造 ${N} 条夹具耗时 ${Date.now() - t0}ms`);

    t0 = Date.now();
    const r1 = await runPreview(page, { timeout: 180000 });
    say(`  预览耗时 ${Date.now() - t0}ms：待移动=${r1.move} 总数=${r1.total}`);

    const planBytes = await page.evaluate(async () => {
      const t = (await chrome.storage.local.get('plan:last'))['plan:last'];
      return JSON.stringify(t?.plan?.items || []).length;
    });
    say(`  计划项 JSON 体积 ≈ ${(planBytes / 1024).toFixed(0)} KB`);

    t0 = Date.now();
    await page.click('#btnExecute');

    // 边跑边采样进度：看它是匀速推进还是卡住/停滞
    let last = null;
    const samples = [];
    for (let i = 0; i < 600; i++) {           // 最多等 300s
      await new Promise((r) => setTimeout(r, 500));
      const s = await page.evaluate(async () => {
        const t = (await chrome.storage.local.get('task:current'))['task:current'];
        const items = t?.plan?.items || [];
        return {
          status: t?.status,
          done: items.filter((x) => x.status === 'done').length,
          failed: items.filter((x) => x.status === 'failed').length,
          total: items.length,
          rep: (document.getElementById('reportStatus')?.textContent || '').trim(),
        };
      });
      if (!last || s.done !== last.done) {
        samples.push({ ms: Date.now() - t0, ...s });
        say(`    t=${((Date.now() - t0) / 1000).toFixed(1)}s done=${s.done}/${s.total} failed=${s.failed} status=${s.status}`);
      }
      last = s;
      if (s.rep && ['已完成', '失败', '已暂停'].includes(s.rep)) break;
    }
    const elapsed = Date.now() - t0;
    say(`  执行耗时 ${(elapsed / 1000).toFixed(1)}s`);
    const per = last && last.done ? elapsed / last.done : 0;
    say(`  每条平均 ${per.toFixed(1)}ms → 外推 2000 条约需 ${(per * 2000 / 1000 / 60).toFixed(1)} 分钟`);

    if (!last || last.done < last.total) {
      say(`  ❌ 没跑完：done=${last ? last.done : '?'}/${last ? last.total : '?'} status=${last ? last.status : '?'}`);
      red++;
    }

    const stored = await page.evaluate(async () => {
      const t = (await chrome.storage.local.get('task:current'))['task:current'];
      return {
        items: (t?.plan?.items || []).map((i) => ({ id: String(i.id), title: i.title, toStr: i.toStr, status: i.status })),
        failedList: (t?.failed || []).slice(0, 5),
      };
    });
    const after = await readTreeState(page);
    let mis = 0;
    for (const it of stored.items) {
      const p = after[it.id] || [];
      if (p.slice(1).join('/') !== it.toStr) mis++;
    }
    say(`  落位核对：不符 ${mis} / ${stored.items.length}`);
    if (mis) red++;

    // 面板报告是否与真实进度一致（用户就是看这个判断有没有生效）
    const rep = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#report tr')].map((tr) =>
        [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()).join('='));
      return rows;
    });
    say(`  面板报告: ${JSON.stringify(rep)}`);
  } catch (e) {
    say(`  ❌ 异常：${e && e.stack ? e.stack : e}`);
    red++;
  } finally {
    await ctx.close();
  }
  say(red ? `\nRED: ${red} 条` : '\nGREEN: 规模下跑通且全部落位');
  writeFileSync('tests/.scale.txt', LOG.join('\n'), 'utf8');
  process.exitCode = red ? 1 : 0;
};

main().catch((e) => {
  writeFileSync('tests/.scale.txt', LOG.concat([`FATAL ${e && e.stack ? e.stack : e}`]).join('\n'), 'utf8');
  console.error('FATAL', e);
  process.exitCode = 1;
});
