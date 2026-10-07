/**
 * E2E：「只整理勾选的书签」—— 两组对照夹具。
 *
 * ═══ 为什么必须是两组 ═══
 * docs/testing.md 有一条硬警告：一组对照不够，**一个「什么都不做」的实现也能变绿**。
 * 这个功能的全部价值是「清单之外一条都不动」，所以只断言「没动」是不够的 ——
 * 一个把执行器整个短路掉的实现也能通过。
 *
 * 因此这里同一轮里同时验两种行为：
 *   A 组（2 条，勾选）→ **必须**被移动到 taxonomy 分类文件夹下
 *   B 组（4 条，没勾）→ parentId 必须与执行前**逐条相同**
 * 两种行为在同一轮里都被验到，「该动的动了」与「不该动的没动」缺一不可。
 *
 * 另外还钉一条：手动模式**不删任何书签**。夹具里放了一对真重复项，
 * 若实现把去重清单漏进执行载荷，这一对会少一条。
 *
 * ⚠️ 断言走真实用户路径：切页签 → 点「选择书签」→ 搜索 → 勾选 → 加入清单
 *    → 点「预览选中」→ 点「执行整理」。只有造夹具和读书签树用 chrome.* API。
 *    直接往 storage 塞清单再断言，等于绕过了整个勾选 UI，
 *    那些「勾选区渲染」「按钮接线」的问题一条都验不到。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  launchWithExtension, openPanel, seedBookmarks, cleanupAll, waitForExecutionDone,
} from './harness.js';

process.on('exit', cleanupAll);
process.on('SIGINT', () => { cleanupAll(); process.exit(130); });

/**
 * A 组 = 规则能命中的两个已知站点（保证它们**会**产生移动计划）
 * B 组 = 长尾未命中站点（保证它们也有可能产生计划，只差「没被勾选」这一条）
 * 末尾一对是真重复项，专门用来盯住「手动模式不删」。
 */
const SCOPE_FIXTURES = [
  { title: '范围组-会动-1', url: 'https://github.com/scope-fixture/move-one' },
  { title: '范围组-会动-2', url: 'https://redis.io/docs/scope-fixture-move-two' },
  { title: '范围组-不动-1', url: 'https://unknown-scope-keep-1.example.org/page' },
  { title: '范围组-不动-2', url: 'https://unknown-scope-keep-2.example.org/page' },
  { title: '范围组-不动-3', url: 'https://unknown-scope-keep-3.example.org/page' },
  { title: '范围组-不动-4', url: 'https://unknown-scope-keep-4.example.org/page' },
  // 真重复项：两条 URL 只差跟踪参数，执行器若收窄了去重清单就会少一条
  { title: '范围组-重复-保留', url: 'https://dup-scope.example.com/same' },
  { title: '范围组-重复-待删', url: 'https://dup-scope.example.com/same?utm_source=wx' },
];

const MOVE_TITLES = ['范围组-会动-1', '范围组-会动-2'];
const KEEP_TITLES = ['范围组-不动-1', '范围组-不动-2', '范围组-不动-3', '范围组-不动-4'];

/** 读「标题 → parentId」的全量映射。这是本文件所有断言的基准。 */
const readParents = (page) => page.evaluate(async () => {
  const out = {};
  const walk = async (id) => {
    for (const c of await chrome.bookmarks.getChildren(id)) {
      if (c.url) out[c.title] = String(c.parentId);
      else await walk(c.id);
    }
  };
  await walk('1');
  await walk('2');
  return out;
});

/** 读某条书签当前的父节点 id */
const parentOf = (page, id) => page.evaluate(
  (nid) => chrome.bookmarks.get(nid).then((r) => (r && r[0] ? String(r[0].parentId) : null)),
  id,
);

/** 读书签总条数，用来抓「少了东西」（删除是不可逆的） */
const countUrls = (page) => page.evaluate(async () => {
  let n = 0;
  const walk = async (id) => {
    for (const c of await chrome.bookmarks.getChildren(id)) {
      if (c.url) n += 1; else await walk(c.id);
    }
  };
  await walk('1');
  await walk('2');
  return n;
});

test('⚠️ 两组对照：勾的 2 条被移动，没勾的 4 条 parentId 一条都不变', async () => {
  const { ctx, extensionId } = await launchWithExtension();
  try {
    const page = await openPanel(ctx, extensionId);
    const seeded = await seedBookmarks(page, SCOPE_FIXTURES);
    const before = await readParents(page);
    const countBefore = await countUrls(page);

    const idOf = (title) => seeded.find((s) => s.title === title).id;
    assert.deepEqual(MOVE_TITLES.map(idOf).filter(Boolean).length, 2, 'A 组夹具没建全');

    // ── 走真实用户路径 ──
    await page.click('#tabs button[data-tab="scope"]');
    await page.click('#btnScopePick');
    await page.waitForSelector('#scopePicker:not([hidden])');

    // 勾选区是懒渲染的，直接找会找不到行。用搜索把它逼出来 ——
    // 这条路径顺带也验证了搜索确实在起作用。
    await page.fill('#scopeSearch', '会动');
    await page.waitForSelector('[data-scope-check]');
    for (const title of MOVE_TITLES) {
      await page.check(`[data-scope-check="${idOf(title)}"]`);
    }
    await page.click('#btnScopeAddPicked');
    await page.waitForFunction(
      () => document.querySelectorAll('#scopeList .scope-item').length === 2,
      undefined,
      { timeout: 10000 },
    );

    // ── 预览 ──
    await page.click('#btnScopePreview');
    await page.waitForFunction(
      () => document.getElementById('planScopeChip')
        && document.getElementById('planScopeChip').dataset.mode === 'scope',
      undefined,
      { timeout: 30000 },
    );

    // ⚠️ 这一条是防「点预览选中没反应」的：两个入口写同一个 state.plan，
    //    若 mode 没翻过来，用户看到的仍是上一次的**全量**计划，
    //    那么后面所有断言都会建立在一个错误的前提上。
    const planRows = await page.evaluate(() => document.querySelectorAll('#planBody tr').length);
    assert.ok(planRows > 0, '子集预览没有渲染出任何计划行');

    // ⚠️ 切回「手动整理」页，必须仍然有一条通往执行的入口。
    //    这条是被真实用户报出来的洞：「执行整理」只存在于 hero 区，
    //    而 hero **只在「计划明细」页 sticky**，在手动整理这一页会随页面滚走。
    //    于是用户勾完、预览完，本页找不到任何执行入口，
    //    症状是「勾了半天，没地方执行」，而界面上没有任何一处提示为什么。
    await page.click('#tabs button[data-tab="scope"]');
    await page.waitForSelector('#scopeReady:not([hidden])', { timeout: 10000 });
    const readyText = await page.textContent('#scopeReadyText');
    assert.match(readyText, /不会被动/, '跳转条没有说明「清单之外不会被动」这条承诺');

    // 点它：应当切到计划明细页并滚回顶部，让 hero 里那个唯一的执行按钮进视野
    await page.click('#btnScopeGoExecute');
    await page.waitForFunction(
      () => document.querySelector('#tabs button[data-tab="plan"]')?.classList.contains('active'),
      undefined, { timeout: 5000 },
    );
    const execVisible = await page.isVisible('#btnExecute');
    assert.ok(execVisible, '点了「去执行整理」，但「执行整理」按钮仍不在视野里');

    // ── 执行 ──
    await page.click('#btnExecute');   // confirm() 由 harness 自动接受
    await waitForExecutionDone(page, 60000);

    const after = await readParents(page);
    const countAfter = await countUrls(page);

    // ① A 组：动了
    for (const title of MOVE_TITLES) {
      assert.notEqual(after[title], before[title],
        `${title} 是勾选进去的，本该被移动，但 parentId 没变（${before[title]} → ${after[title]}）`);
    }

    // ② B 组：一条都不许动。这一组才是「怕误伤」真正在防的那件事。
    for (const title of KEEP_TITLES) {
      assert.equal(after[title], before[title],
        `${title} 没有被勾选，却被移动了：${before[title]} → ${after[title]}。`
        + '「清单之外一条都不动」这条承诺破了。');
    }

    // ③ 一条都不许少：删除不可逆，而去重清单是从整棵树独立算出来的
    assert.equal(countAfter, countBefore,
      `书签总数从 ${countBefore} 变成 ${countAfter}。`
      + '手动模式必须不删任何书签（夹具里那对重复项不该被动）。');

    await ctx.close();
  } catch (e) {
    await ctx.close();
    throw e;
  }
});

test('⚠️ 确认弹窗必须写明范围与清单外条数（界面不许承诺做不到的事）', async () => {
  const { ctx, extensionId } = await launchWithExtension();
  try {
    const page = await openPanel(ctx, extensionId);
    await seedBookmarks(page, SCOPE_FIXTURES);
    await page.click('#tabs button[data-tab="scope"]');
    await page.click('#btnScopePick');
    await page.waitForSelector('#scopePicker:not([hidden])');
    await page.fill('#scopeSearch', '会动');
    await page.waitForSelector('[data-scope-check]');
    // ⚠️ 必须**逐个重新查询**：勾一个框会触发 renderScopePicker() 重建整棵树，
    //    早先一次性 $$ 拿到的句柄在第二次点之前就已经脱离 DOM，
    //    症状是「Element is not attached to the DOM」。
    const ids = await page.$$eval(
      '[data-scope-check]',
      (els) => els.map((e) => e.dataset.scopeCheck),
    );
    for (const id of ids) {
      await page.check(`[data-scope-check="${id}"]`);
    }
    await page.click('#btnScopeAddPicked');
    await page.waitForFunction(() => document.querySelectorAll('#scopeList .scope-item').length > 0);
    await page.click('#btnScopePreview');
    await page.waitForFunction(
      () => document.getElementById('planScopeChip')?.dataset.mode === 'scope',
      undefined, { timeout: 30000 },
    );

    // 拦下确认弹窗，把文案读出来。
    // ⚠️ 必须「装桩 → 点击 → 轮询取值」三步分开。
    //    doExecute 在调 confirm() 之前有一个 await（解析归入位置），
    //    早先把三件事塞进同一个 page.evaluate：evaluate 在 await 处就返回了，
    //    随即把 window.confirm 还原，而真正的 confirm 这时才要跑 ——
    //    抓到的空串，症状看起来像「弹窗里真的一句都没写」。
    await page.evaluate(() => {
      window.__confirmMsg = null;
      window.confirm = (m) => { window.__confirmMsg = String(m); return false; };
    });
    await page.click('#btnExecute');
    await page.waitForFunction(() => window.__confirmMsg !== null, undefined, { timeout: 15000 });
    const text = await page.evaluate(() => window.__confirmMsg);

    assert.match(text, /清单外/, '确认弹窗没有写明「清单外有多少条不动」');
    assert.match(text, /一条都不会移动/, '确认弹窗没有把「清单外不动」这条承诺写出来');
    assert.match(text, /归入位置/, '确认弹窗漏了归入位置（2026-10-05 就是死在这一行上）');
    assert.match(text, /删除\s*0\s*条重复项/, '手动模式的删除条数必须是 0');

    await ctx.close();
  } catch (e) {
    await ctx.close();
    throw e;
  }
});

test('⚠️ 失效条目标「已失效」且不被按 URL 认回来', async () => {
  const { ctx, extensionId } = await launchWithExtension();
  try {
    const page = await openPanel(ctx, extensionId);
    const seeded = await seedBookmarks(page, [
      { title: '会消失的勾选项', url: 'https://github.com/scope-fixture/vanishing' },
      { title: '同URL的替身', url: 'https://github.com/scope-fixture/vanishing' },
    ]);
    const victim = seeded.find((s) => s.title === '会消失的勾选项').id;
    const decoy = seeded.find((s) => s.title === '同URL的替身').id;

    // 替身的原始位置**先记下来**。
    // ⚠️ 不要写成「替身还是不是根 1 的直接子项」：根 id 不是常量
    //    （本机 Chrome 154+ 的账号书签模型里书签栏是 279），
    //    写死 '1' 的判据在换了书签模型的机器上会自己变红。
    //    而且比对对象也错位过一次：parentId 要跟「原来的 parentId」比，
    //    不是跟根下面那些子项的 id 比。
    const decoyParentBefore = await parentOf(page, decoy);

    await page.click('#tabs button[data-tab="scope"]');
    await page.click('#btnScopePick');
    await page.waitForSelector('#scopePicker:not([hidden])');
    await page.fill('#scopeSearch', '会消失');
    await page.waitForSelector(`[data-scope-check="${victim}"]`);
    await page.check(`[data-scope-check="${victim}"]`);
    await page.click('#btnScopeAddPicked');
    await page.waitForFunction(() => document.querySelectorAll('#scopeList .scope-item').length === 1);

    // ⚠️ 夹具漂移的刻意制造：勾完之后把那条书签删掉。
    //    替身与它的 URL 完全相同 —— 若对账按 URL 认领，替身就会被整理，
    //    而替身是用户**没勾**的。这正是决策 13 要挡的那件事。
    await page.evaluate((id) => chrome.bookmarks.remove(id), victim);

    await page.click('#btnScopePreview');
    await page.waitForFunction(
      () => document.getElementById('scopeStale')?.textContent.trim() === '1',
      undefined, { timeout: 30000 },
    );

    const status = await page.evaluate(
      (id) => document.querySelector(`[data-scope-id="${id}"]`)?.dataset.status,
      victim,
    );
    assert.equal(status, 'stale', '被删掉的那条没有标成「已失效」');

    // 替身必须原地不动
    const decoyParentAfter = await parentOf(page, decoy);
    assert.equal(decoyParentAfter, decoyParentBefore,
      '替身被按 URL 认回去并搬动了 —— 它与被删那条同 URL，但用户从来没勾过它。'
      + '这正是「失效条目不许按 URL 认领」要挡的误伤。');

    await ctx.close();
  } catch (e) {
    await ctx.close();
    throw e;
  }
});