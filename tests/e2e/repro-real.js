/**
 * 复现：用户真实数据版。
 *
 * ⚠️ 夹具已脱敏（2026-10-06 发布前处理）：原始数据取自用户 2026-10-05 的三张截图，
 *   ① 确认弹窗：移动 45 条 / 新建 16 个文件夹 / 删除 0 条重复项
 *   ② 计划明细：真实 URL、真实「当前位置」（文档 / 工作）、真实依据（标题低 / AI 中 / 域名高 / 已改判高）
 *   ③ 书签栏：resource, tools, ai, 接口文档, 文档, 工作, 生活, 工具
 *
 * 与既有 matrix 的关键差异：
 *   - **LLM 兜底是开着的**（截图里依据列有「AI 中」→ 兜底真的在跑）
 *   - 夹具是真实的校内/办公站点，含带 %2F %3A 编码的嵌套重定向 URL
 *   - 书签栏已有一堆中文/英文混合文件夹
 *
 * 判据（用户可见）：执行后书签栏**必须**多出「工作办公 / 学习资料 / 其他」这类新顶层文件夹。
 * 只要一个都没多出来，就精确复现了用户的症状。
 *
 * 用法：node tests/e2e/repro-real.js [--llm on|off]
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

const argLlm = (() => {
  const i = process.argv.indexOf('--llm');
  return i >= 0 ? process.argv[i + 1] : 'on';
})();

/**
 * 面板顶部「归入位置」。
 *
 * ⚠️ 这里传的是**语义键**（bar / other），不是根 id。
 *    根 id 不是常量 —— Chrome 154 的账号书签模型里书签栏是 279、其他书签是 280，
 *    早先传 '1' / '2' 正是 2026-10-05 那次 45 条全军覆没的同源问题。
 */
const argRoot = (() => {
  const i = process.argv.indexOf('--root');
  const v = i >= 0 ? process.argv[i + 1] : 'bar';
  // 兼容旧命令行：--root 1 / --root 2 直接翻成语义键
  if (v === '1') return 'bar';
  if (v === '2') return 'other';
  return v;
})();

/** 截图③：书签栏原有文件夹 */
const BAR_FOLDERS = ['resource', 'tools', 'ai', '接口文档', '文档', '工作', '生活', '工具'];

/** 截图②：真实书签。parent 表示所在文件夹（null = 书签栏根） */
const REAL = [
  { parent: '文档', title: '首页 - 飞书云文档', url: 'https://demo7f3k9q.feishu.cn/wiki/Qa7mXv2LpRt9Bk4Nwz8Hs1Dc6Yf' },
  { parent: '文档', title: '第一章. Python启航 - 飞书云文档', url: 'https://demo7f3k9q.feishu.cn/wiki/Tb3nKg6YhFd0Ws9XcVr2Jm5Pqn' },
  { parent: '文档', title: '课程说明 - 飞书云文档', url: 'https://demo4m8p2v.feishu.cn/wiki/Wk9tRb4XcNv7Qs2LpJd6Yh1Fg' },
  { parent: '工作', title: 'demo-univ', url: 'https://jxgl.demo-univ.edu.cn/jsxsd/framework/xsMainV.htmLx' },
  { parent: '工作', title: '学习者中心', url: 'https://portal.demo-train.org/zh/' },
  { parent: '工作', title: '牛客网 - 找工作神器|笔试题库|面试经验|实习招聘内推，求职就业一站解决-牛客网', url: 'https://www.nowcoder.com/' },
  // 带 %2F / %3A 编码的嵌套重定向 URL —— 归一化链路最容易在这里出事
  { parent: '工作', title: '统一身份认证平台', url: 'https://authserver.demo-univ.edu.cn/authserver/login?service=https%3A%2F%2Fauthserver.demo-univ.edu.cn%2Flogin%3FportalService%3Dhttps%3A%2F%252F%252Fjxgl.demo-univ.edu.cn' },
  { parent: null, title: '中国大学MOOC', url: 'https://www.icourse163.org/' },
  { parent: null, title: '哔哩哔哩', url: 'https://www.bilibili.com/' },
  { parent: null, title: '知乎', url: 'https://www.zhihu.com/' },
  { parent: null, title: '掘金', url: 'https://juejin.cn/' },
];

/**
 * 读书签树。**barKids 装的是根(id=1)的直接子节点标题** ——
 * ⚠️ 这里踩过一次：早先只记 `tree[0].children` 的标题（书签栏/其他书签/移动设备书签），
 *    那三个是**根**，永远不变，于是「新增顶层文件夹 0 个」恒成立，
 *    闸门对着一个执行完全成功的实现报了「复现成功」。
 *    新建的类目文件夹是**书签栏的子节点**，必须读子节点。
 */
const readBar = (page) =>
  page.evaluate(async () => {
    const tree = await chrome.bookmarks.getTree();
    const out = {};
    const roots = {};
    const walk = (n, p) => {
      out[String(n.id)] = [...p];
      const here = [...p, n.title || ''];
      for (const c of n.children || []) walk(c, here);
    };
    for (const t of tree[0].children || []) {
      walk(t, []);
      roots[String(t.id)] = t.title || '';
    }
    const bar = tree[0].children.find((t) => String(t.id) === '1') || { children: [] };
    return {
      out,
      roots,
      barKids: (bar.children || []).map((c) => c.title || ''),
      otherKids: ((tree[0].children.find((t) => String(t.id) === '2') || { children: [] }).children || [])
        .map((c) => c.title || ''),
    };
  });

const readTask = (page) =>
  page.evaluate(async () => {
    const t = (await chrome.storage.local.get('task:current'))['task:current'];
    if (!t) return { missing: true };
    const items = t.plan?.items || [];
    return {
      status: t.status,
      total: items.length,
      done: items.filter((i) => i.status === 'done').length,
      failedItems: items.filter((i) => i.status === 'failed').length,
      pending: items.filter((i) => i.status === 'pending').length,
      failed: (t.failed || []).slice(0, 8),
      failedCount: (t.failed || []).length,
      createdFolders: (t.createdFolders || []).map((c) => c.path.join('/')),
      folderCache: Object.keys(t.folderCache || {}),
      lastDoneIndex: t.lastDoneIndex,
    };
  });

async function main() {
  say(`═══ 用户真实数据复刻（LLM=${argLlm} 归入位置=${argRoot}）═══`);
  const { ctx, extensionId } = await launchWithExtension();
  let red = 0;
  try {
    const page = await openPanel(ctx, extensionId);

    // 抓住确认弹窗的原文 —— 用户点「确定」之前能看到的唯一信息
    let confirmText = '';
    page.on('dialog', async (d) => {
      if (d.type() === 'confirm') { try { confirmText = d.message(); } catch { /* 已关 */ } }
      await d.accept().catch(() => {});
    });

    // 「归入位置」= 面板顶部那个下拉框。用户可能改过，这里显式设定。
    await page.selectOption('#targetRoot', argRoot);
    const rootSetting = await page.evaluate(async () =>
      (await chrome.storage.local.get('settings')).settings?.targetRoot);
    say(`  已设定 归入位置=${rootSetting}`);

    // 书架栏原样造出来
    const folderIds = await page.evaluate(async (names) => {
      const m = {};
      for (const n of names) m[n] = String((await chrome.bookmarks.create({ parentId: '1', title: n })).id);
      return m;
    }, BAR_FOLDERS);

    await seedBookmarks(page, REAL.map((r) => ({
      title: r.title, url: r.url, parentId: r.parent ? folderIds[r.parent] : '1',
    })));

    if (argLlm === 'on') {
      // 还原用户环境：LLM 开着、已授权、模型能返回合法类目
      await page.evaluate(async () => {
        try { chrome.permissions.contains = async () => true; } catch { /* 忽略 */ }
        window.__fetchCalls = 0;
        window.fetch = function (url, opts) {
          window.__fetchCalls += 1;
          return Promise.resolve({
            ok: true, status: 200,
            text: async () => JSON.stringify({
              choices: [{ message: { content: JSON.stringify([
                { key: 'https://jxgl.demo-univ.edu.cn/jsxsd/framework/xsMainV.htmLx', to: '学习资料/考试认证' },
                { key: 'https://portal.demo-train.org/zh/', to: '学习资料/技术课程' },
              ]) } }],
            }),
          });
        };
        const got = await chrome.storage.local.get('settings');
        await chrome.storage.local.set({ settings: { ...(got.settings || {}), llmEnabled: true } });
      });
    }

    const barBefore = await readBar(page);
    say(`  执行前书签栏: ${barBefore.barKids.join(' | ')}`);
    say(`  执行前其他书签: ${barBefore.otherKids.join(' | ') || '(空)'}`);

    const r1 = await runPreview(page, { timeout: 60000 });
    const fetchCalls = await page.evaluate(() => window.__fetchCalls || 0);
    say(`  预览: 待移动=${r1.move} 总数=${r1.total} 行=${r1.rows} LLM调用=${fetchCalls}`);

    const reasons = await page.evaluate(() =>
      [...document.querySelectorAll('#planBody tr')].slice(0, 12).map((tr) => {
        const td = tr.querySelectorAll('td');
        return `${(td[1]?.querySelector('.title')?.textContent || '').slice(0, 22)} | ${td[2]?.textContent.trim()} → ${td[4]?.textContent.trim()} | ${td[5]?.textContent.trim()}`;
      }));
    for (const x of reasons) say(`      ${x}`);

    // 记录执行器拿到的 payload 是否与面板一致
    const payloadInfo = await page.evaluate(() => {
      const p = window.__lastPlanSent;
      return p || null;
    });

    await page.click('#btnExecute');
    const deadline = Date.now() + 120000;
    let st = '';
    while (Date.now() < deadline) {
      st = await page.evaluate(() => (document.getElementById('reportStatus')?.textContent || '').trim());
      if (['已完成', '失败', '已暂停'].includes(st)) break;
      await new Promise((x) => setTimeout(x, 200));
    }
    const task = await readTask(page);
    say(`  执行状态=${st}`);
    say(`  落盘任务: ${JSON.stringify(task, null, 1).slice(0, 2200)}`);

    const barAfter = await readBar(page);
    say(`  执行后书签栏: ${barAfter.barKids.join(' | ')}`);
    say(`  执行后其他书签: ${barAfter.otherKids.join(' | ') || '(空)'}`);

    const newBarKids = barAfter.barKids.filter((t) => !barBefore.barKids.includes(t));
    const newOtherKids = barAfter.otherKids.filter((t) => !barBefore.otherKids.includes(t));
    say(`  书签栏新增 ${newBarKids.length} 个: ${newBarKids.join(' | ') || '(无)'}`);
    say(`  其他书签新增 ${newOtherKids.length} 个: ${newOtherKids.join(' | ') || '(无)'}`);

    // ── 用户的原话：书签栏没有任何变动 ──
    if (newBarKids.length === 0 && newOtherKids.length === 0) {
      say('  🔴 复现成功：两个根下都没多出新文件夹，与用户症状一致');
      red++;
    } else if (newBarKids.length === 0 && newOtherKids.length > 0) {
      // 归入位置不是书签栏时的正常形态。**本身不是缺陷** ——
      // 缺陷是「面板不告诉你」。那一条由下面的披露闸门单独钉，
      // 这里只做记录，免得把合法行为继续当 bug 报。
      say(`  ℹ️ 变体：书签栏没新增，新文件夹都建到了「其他书签」下`);
      say(`     → 这是「归入位置=${argRoot}」的正常结果；`
        + '面板是否如实披露，见下方披露闸门');
    }

    // 逐条核对
    const stored = await page.evaluate(async () => {
      const t = (await chrome.storage.local.get('task:current'))['task:current'];
      return (t?.plan?.items || []).map((i) => ({ id: String(i.id), title: i.title, toStr: i.toStr, status: i.status }));
    });
    let mis = 0;
    for (const it of stored) {
      const p = barAfter.out[it.id] || [];
      const rel = p.slice(1).join('/');
      if (rel !== it.toStr) { mis++; say(`      ❌ 「${String(it.title).slice(0, 24)}」应 [${it.toStr}] 实际 [${rel || '?'}]`); }
    }
    say(`  落位核对：不符 ${mis} / ${stored.length}`);
    if (mis) red++;

    // 每条实际落在哪个根下 —— 用来抓「归入位置」设错
    const rootOfItems = new Set(stored.map((it) => (barAfter.out[it.id] || [])[0]).filter(Boolean));
    say(`  计划项实际落在根: ${[...rootOfItems].join(' | ')}`);

    // 面板报告里的失败明细
    const reportTxt = await page.evaluate(() => (document.getElementById('report')?.textContent || '').replace(/\s+/g, ' ').slice(0, 400));
    say(`  面板报告: ${reportTxt}`);

    // toast 文案是否撒谎
    const toast = await page.evaluate(() => (document.getElementById('toast')?.textContent || '').trim());
    say(`  toast: "${toast}"`);
    // ── 闸门：面板必须自己说清楚「结果落在哪」 ──
    //    用户点完执行整理，视线在书签栏和计划表上。他不该靠猜，
    //    也不该为了看结果去翻「设置」tab。确认弹窗与完成提示
    //    都必须点名归入位置 —— 否则「归入位置=其他书签」的用户
    //    会看到「整理完成」却发现书签栏纹丝不动。
    const expectRootName = argRoot === 'other' ? '其他书签' : '书签栏';
    say(`  确认弹窗文本:\n${confirmText.split('\n').map((l) => '      ' + l).join('\n')}`);
    if (!confirmText.includes(expectRootName)) {
      say(`  🔴 确认弹窗没有写明「归入位置：${expectRootName}」`);
      red++;
    } else {
      say(`  ✓ 确认弹窗写明了归入位置：${expectRootName}`);
    }
    if (!/将新建顶层文件夹/.test(confirmText)) {
      say('  🔴 确认弹窗没有列出将新建的顶层文件夹');
      red++;
    } else {
      say('  ✓ 确认弹窗列出了将新建的顶层文件夹');
    }

    if (!toast.includes(expectRootName)) {
      say(`  🔴 完成提示没有点名归入位置：「${toast}」`);
      red++;
    } else {
      say(`  ✓ 完成提示点名了归入位置：「${toast}」`);
    }
  } catch (e) {
    say(`  ❌ 异常：${e && e.stack ? e.stack : e}`);
    red++;
  } finally {
    await ctx.close();
  }
  say(red ? `\nRED: ${red} 条` : '\nGREEN: 复刻通过（书签栏出现了新文件夹）');
  writeFileSync('tests/.real.txt', LOG.join('\n'), 'utf8');
  process.exitCode = red ? 1 : 0;
};

main().catch((e) => {
  writeFileSync('tests/.real.txt', LOG.concat([`FATAL ${e && e.stack ? e.stack : e}`]).join('\n'), 'utf8');
  console.error('FATAL', e);
  process.exitCode = 1;
});
