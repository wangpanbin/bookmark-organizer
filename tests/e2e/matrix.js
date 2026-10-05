/**
 * 场景矩阵：在**全新 profile** 里逐个跑真实场景，每个都断言用户可见的承诺。
 *
 * 为什么不用现有 E2E：那 9 道闸门跑的是「根目录下散落的书签 + 默认设置」。
 * 真实用户不会长成那样：书签大多在已有文件夹里、可能有几百上千条、
 * 可能改过「归入位置」、可能连续点两次执行。这些都不在闸门覆盖里。
 *
 * 判据（两条都是用户能直接看到的）：
 *   ① 每条计划项都落在它承诺的文件夹里（剥掉根名后与 toStr 严格相等）
 *   ② 它们落在**设置里指定的根**下（targetRoot），而不是别的根
 *   ③ 再预览一次必须是 0（幂等）
 *
 * 用法：node tests/e2e/matrix.js [场景名...]      不给参数就跑全部
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

/** id → 所在文件夹路径（含根名） */
const readTreeState = (page) =>
  page.evaluate(async () => {
    const out = {};
    const roots = {};
    const walk = (node, folderPath) => {
      out[String(node.id)] = [...folderPath];
      const here = [...folderPath, node.title || ''];
      for (const c of node.children || []) walk(c, here);
    };
    const tree = await chrome.bookmarks.getTree();
    for (const top of tree[0].children || []) {
      walk(top, []);
      roots[String(top.id)] = top.title || '';
    }
    return { out, roots };
  });

const readStoredPlan = (page) =>
  page.evaluate(async () => {
    const got = await chrome.storage.local.get('task:current');
    const t = got['task:current'];
    if (!t || !t.plan) return null;
    return {
      status: t.status,
      rootName: t.rootNameProbe || null,
      items: (t.plan.items || []).map((i) => ({ id: String(i.id), title: i.title, toStr: i.toStr, status: i.status })),
      failed: (t.failed || []).map((f) => `${f.url} — ${f.error}`),
    };
  });

/** 跑完执行并等终态，返回 {stored, after} */
async function executeAndRead(page, timeout = 120000) {
  await page.click('#btnExecute');                       // confirm 由 harness 自动接受
  const deadline = Date.now() + timeout;
  let st = '';
  while (Date.now() < deadline) {
    st = await page.evaluate(() => (document.getElementById('reportStatus')?.textContent || '').trim());
    if (['已完成', '失败', '已暂停'].includes(st)) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  const stored = await readStoredPlan(page);
  const after = await readTreeState(page);
  return { st, stored, after };
}

/** 核心断言：每条计划项是否落在承诺的位置 + 承诺的根 */
function assertPlaced({ stored, after, expectRootName, label }) {
  const bad = [];
  if (!stored || !stored.items.length) {
    return { bad: [`${label}: storage 里没有 task:current（执行器压根没建任务）`], total: 0 };
  }
  for (const it of stored.items) {
    const p = after.out[it.id];
    if (!p) { bad.push(`${label}: 「${it.title}」在树里消失了`); continue; }
    const rel = p.slice(1).join('/');
    if (rel !== it.toStr) {
      bad.push(`${label}: 「${it.title}」应在 [${it.toStr}]，实际 [${rel}]（完整 ${JSON.stringify(p)}）`);
      continue;
    }
    if (expectRootName && p[0] !== expectRootName) {
      bad.push(`${label}: 「${it.title}」落在了根「${p[0]}」下，应在「${expectRootName}」下`);
    }
  }
  return { bad, total: stored.items.length };
}

// ───────────────────────── 场景定义 ─────────────────────────

const SCENARIOS = {
  /** 基线：书签散在根目录 */
  async baseline(page) {
    await seedBookmarks(page, [
      { title: 'GitHub', url: 'https://github.com/a/b' },
      { title: 'Vue', url: 'https://cn.vuejs.org/guide/introduction.html' },
      { title: 'Redis', url: 'https://redis.io/docs/latest/' },
    ]);
  },

  /** 真实用户形态：书签都在已有文件夹里 */
  async inFolders(page) {
    const f1 = await page.evaluate(async () => String((await chrome.bookmarks.create({ parentId: '1', title: '收藏夹A' })).id));
    const f2 = await page.evaluate(async (p) => String((await chrome.bookmarks.create({ parentId: p, title: '子层B' })).id), f1);
    await seedBookmarks(page, [
      { title: 'GitHub', url: 'https://github.com/a/b' },
      { title: '知乎', url: 'https://www.zhihu.com/q/1', parentId: f1 },
      { title: '豆瓣', url: 'https://movie.douban.com/', parentId: f1 },
      { title: 'CSDN', url: 'https://blog.csdn.net/x', parentId: f2 },
    ]);
  },

  /** 用户把「归入位置」改成了「其他书签」——面板顶部那个下拉框 */
  async otherRoot(page) {
    await page.selectOption('#targetRoot', '2');
    await seedBookmarks(page, [
      { title: 'GitHub', url: 'https://github.com/a/b' },
      { title: 'Redis', url: 'https://redis.io/docs/latest/' },
    ]);
  },

  /** 已有同名文件夹（用户自己早就建过「开发与技术」等） */
  async existingFolders(page) {
    await page.evaluate(async () => {
      await chrome.bookmarks.create({ parentId: '1', title: '开发与技术' });
    });
    await seedBookmarks(page, [
      { title: 'GitHub', url: 'https://github.com/a/b' },
      { title: 'Vue', url: 'https://cn.vuejs.org/guide/introduction.html' },
    ]);
  },

  /** 大批量：150 条 */
  async bulk(page) {
    const list = [];
    const known = [
      ['GitHub', 'https://github.com/a/b'], ['Vue', 'https://cn.vuejs.org/guide/i.html'],
      ['MDN', 'https://developer.mozilla.org/zh-CN/docs/Web/CSS'], ['Redis', 'https://redis.io/docs/'],
      ['Docker', 'https://docs.docker.com/get-started/'], ['arXiv', 'https://arxiv.org/abs/1'],
      ['Notion', 'https://www.notion.so/w'], ['力扣', 'https://leetcode.cn/p/'], ['B站', 'https://www.bilibili.com/'],
      ['网易云', 'https://music.163.com/'], ['IT之家', 'https://www.ithome.com/'], ['知乎', 'https://www.zhihu.com/q'],
      ['雪球', 'https://xueue.com/x'], ['淘宝', 'https://www.taobao.com/'], ['美团', 'https://www.meituan.com/'],
      ['Dribbble', 'https://dribbble.com/s'], ['Figma', 'https://www.figma.com/f'], ['iconfont', 'https://www.iconfont.cn/c'],
      ['CSDN', 'https://blog.csdn.net/'], ['掘金', 'https://juejin.cn/'],
    ];
    for (const [t, u] of known) list.push({ title: t, url: u });
    for (let i = list.length; i < 150; i++) list.push({ title: `长尾 ${i}`, url: `https://tail-${i}.example.org/p` });
    await seedBookmarks(page, list);
  },

  /** 书签本来就在「其他书签」根下，targetRoot 保持默认「书签栏」 */
  async fromOtherRoot(page) {
    await seedBookmarks(page, [
      { title: 'GitHub', url: 'https://github.com/a/b', parentId: '2' },
      { title: 'Redis', url: 'https://redis.io/docs/latest/', parentId: '2' },
    ]);
  },

  /** 深层嵌套的源文件夹（4 层） */
  async deepSource(page) {
    const f1 = await page.evaluate(async () => String((await chrome.bookmarks.create({ parentId: '1', title: 'A' })).id));
    const f2 = await page.evaluate(async (p) => String((await chrome.bookmarks.create({ parentId: p, title: 'B' })).id), f1);
    const f3 = await page.evaluate(async (p) => String((await chrome.bookmarks.create({ parentId: p, title: 'C' })).id), f2);
    await seedBookmarks(page, [
      { title: 'GitHub', url: 'https://github.com/a/b', parentId: f3 },
      { title: 'Redis', url: 'https://redis.io/docs/latest/', parentId: f3 },
    ]);
  },

  /** 用户在设置里自定义了类目结构，且类目名里带斜杠（真实用户很爱这么起名） */
  async slashTaxonomy(page) {
    await page.evaluate(async () => {
      await chrome.storage.local.set({
        'taxonomy:override': [
          { name: '学习/工作', children: ['课程', '笔记'] },
          { name: '购物', children: ['数码', '日用'] },
          { name: '其他', children: ['待归类'] },
        ],
      });
    });
    await seedBookmarks(page, [
      { title: 'GitHub', url: 'https://github.com/a/b' },
      { title: '淘宝', url: 'https://www.taobao.com/' },
    ]);
  },

  /** 连续点两次「执行整理」（用户很容易这么干） */
  async doubleExecute(page) {
    await seedBookmarks(page, [
      { title: 'GitHub', url: 'https://github.com/a/b' },
      { title: 'Redis', url: 'https://redis.io/docs/latest/' },
    ]);
  },
};

// ───────────────────────── 驱动 ─────────────────────────

async function runScenario(name) {
  const { ctx, extensionId } = await launchWithExtension();
  const bad = [];
  try {
    const page = await openPanel(ctx, extensionId);
    await SCENARIOS[name](page);

    const r1 = await runPreview(page, { timeout: 60000 });
    say(`  预览：待移动=${r1.move} 总数=${r1.total}`);
    if (r1.move === 0) { say(`  ❌ 预览就是 0 条待移动`); return [`${name}: 预览 0 条`]; }

    if (name === 'doubleExecute') {
      // 第一次执行
      let a = await executeAndRead(page);
      bad.push(...assertPlaced({ stored: a.stored, after: a.after, label: `${name}/第一次` }).bad);
      say(`  第一次：状态=${a.st} 计划=${a.stored ? a.stored.items.length : 'null'} 条`);
      // 再点一次（按钮此时应该已禁用；这里强制点，模拟按钮状态没及时更新的情况）
      const disabled = await page.evaluate(() => document.getElementById('btnExecute').disabled);
      say(`  第二次点击前按钮 disabled=${disabled}`);
      if (!disabled) {
        const b = await executeAndRead(page);
        say(`  第二次：状态=${b.st} 计划=${b.stored ? b.stored.items.length : 'null'} 条`);
        // 第二次不该把已经归位的条目搬走
        const tree1 = JSON.stringify(a.after.out);
        const tree2 = JSON.stringify(b.after.out);
        if (tree1 !== tree2) {
          bad.push(`${name}: 第二次执行把已经归位的书签又搬了（树结构变了）`);
        }
      }
    } else {
      const a = await executeAndRead(page);
      say(`  执行：状态=${a.st} 计划=${a.stored ? a.stored.items.length : 'null'} 条 ` +
          `done=${a.stored ? a.stored.items.filter((i) => i.status === 'done').length : '-'}`);
      if (a.stored && a.stored.failed.length) {
        for (const f of a.stored.failed.slice(0, 5)) say(`     失败：${f}`);
      }
      const settings = await page.evaluate(async () => (await chrome.storage.local.get('settings')).settings || {});
      const rootId = String(settings.targetRoot || '1');
      const expectRootName = a.after.roots[rootId];
      say(`  目标根：id=${rootId} 名称=${expectRootName}`);
      const r = assertPlaced({ stored: a.stored, after: a.after, expectRootName, label: name });
      bad.push(...r.bad);
      say(`  落位核对：${r.total - r.bad.length}/${r.total} 条正确`);

      const r2 = await runPreview(page, { timeout: 60000 });
      say(`  执行后再预览：待移动=${r2.move}（期望 0）`);
      if (r2.move !== 0) bad.push(`${name}: 执行后仍有 ${r2.move} 条待移动 —— 不幂等`);
    }
  } catch (e) {
    bad.push(`${name}: 抛异常 ${e && e.message ? e.message : e}`);
  } finally {
    await ctx.close();
  }
  return bad;
}

const main = async () => {
  const want = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SCENARIOS);
  const report = [];
  for (const name of want) {
    if (!SCENARIOS[name]) { say(`跳过未知场景 ${name}`); continue; }
    say(`\n═══ 场景：${name} ═══`);
    const bad = await runScenario(name);
    if (bad.length) { for (const b of bad) say(`  🔴 ${b}`); }
    else say(`  🟢 通过`);
    report.push({ name, bad });
  }
  say('\n═══════════ 汇总 ═══════════');
  let red = 0;
  for (const r of report) {
    if (r.bad.length) { red += r.bad.length; say(`🔴 ${r.name} — ${r.bad.length} 条不通过`); }
    else say(`🟢 ${r.name}`);
  }
  say(red ? `\nRED: 共 ${red} 条` : '\nGREEN: 全部场景通过');
  writeFileSync('tests/.matrix.txt', LOG.join('\n'), 'utf8');
  process.exitCode = red ? 1 : 0;
};

main().catch((e) => {
  console.error('FATAL', e);
  writeFileSync('tests/.matrix.txt', LOG.concat([`FATAL ${e && e.stack ? e.stack : e}`]).join('\n'), 'utf8');
  process.exitCode = 1;
});
