/**
 * E2E 脚手架。
 *
 * ═══ 四条硬约束（全部来自本机已实证的坑，不是风格偏好）═══
 * 1. **`chromium_headless_shell` 不支持加载扩展**，而 Playwright 自带的
 *    chromium 在 `headless: true` 时用的正是它。
 *    但走 `channel`（系统 Chrome/Edge）时，`headless: true` 用的是**真实浏览器
 *    的新 headless 模式**，扩展照常工作（本机 Edge 154 实测 service worker 正常出现）。
 *    → 所以本 harness 走 channel，**默认 headless**，跑测试不再弹窗。
 *      要肉眼调试用 `BO_E2E_HEADED=1`。
 * 2. **走 channel 时 Chrome 155 已移除 `--load-extension`**（Edge 154 仍支持），
 *    且**扩展路径不能含空格**。两件事都由 resolveExtPath() 与下面的通道链兜住。
 * 3. 必须 `launch_persistent_context` + **每次全新 user_data_dir**。
 *    改扩展产物做证伪时若复用同一 context，Chrome 会命中扩展资源缓存，
 *    补丁写了但页面跑的仍是旧脚本，看着像「闸门无效」其实是坏实现从未运行。
 *    ⚠️ 但**扩展副本的路径必须在进程内稳定**（unpacked 扩展 id 由绝对路径哈希而来，
 *    路径一变 id 就变，`chrome.storage.local` 跟着换分区）。
 * 4. 断言走**真实用户路径**（点按钮、读表格 DOM），不要直接调应用内部函数 ——
 *    内部函数可能压根没被用户路径触达。
 *    只有「造夹具」和「读书签树」这两件必须绕不过去的事，才用 chrome.* API。
 */

import { chromium } from 'playwright';
import { mkdtempSync, rmSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const EXT_PATH = resolve(HERE, '..', '..');

const userDataDirs = [];
const tempRoots = [];

/**
 * 把扩展复制到**无空格**的临时路径。
 *
 * ⚠️ 为什么非做不可（本机实测，2026-10-07）：
 *    `--load-extension=F:\test\Label Management\bookmark-organizer` 里那个空格
 *    会让 Chrome 解析不了这个参数，表现为**浏览器正常启动、扩展根本没加载**，
 *    于是 `waitForEvent('serviceworker')` 20 秒超时。
 *    症状极具误导性：看起来像「扩展起不来」，而真实原因是一个路径空格。
 *
 *    探针结论（同机实测，别凭记忆改）：
 *      · 原路径（含空格）· Chrome  → 无 SW
 *      · 无空格副本   · Chrome    → 无 SW
 *      · 无空格副本   · msedge    → ✅ SW 出现
 *    也就是说**两件事同时成立**：Chrome 155 已移除 `--load-extension`，
 *    而 Edge 154 仍支持但路径不能带空格。
 *
 * ⚠️⚠️ 副本路径必须**在进程内稳定**，绝不能每次 launch 重新 mkdtemp。
 *    unpacked 扩展的 id 由**绝对路径**哈希而来，路径一变 id 就变，
 *    而 `chrome.storage.local` 是按扩展 id 分区的 ——
 *    于是「跑一半关掉浏览器、同 profile 重开继续跑」这条用例会读到空的
 *    `task:current`，症状是「执行记录整个消失了」，
 *    而真实原因是一个没人会想到的临时目录名。
 *    这条就是被它坑出来的：断点续跑用例一次要开三次浏览器。
 *
 * 可用 BO_E2E_EXT_PATH 跳过复制（CI 上扩展已在无空格路径时用）。
 */
let extCopyCache = null;
function resolveExtPath() {
  const forced = process.env.BO_E2E_EXT_PATH;
  if (forced) return forced;
  if (!/\s/.test(EXT_PATH)) return EXT_PATH;
  if (extCopyCache) return extCopyCache;      // ← 进程内稳定，扩展 id 才稳定

  const root = mkdtempSync(join(tmpdir(), 'boext-'));
  tempRoots.push(root);
  const dest = join(root, 'ext');
  // ⚠️ docs/panel-help.md 必须留在副本里：面板「帮助」页签在运行时 fetch 它。
  //    2026-10-07 之前这条过滤把整个 docs/ 都排掉（为了少拷几 MB 工程文档），
  //    加上帮助页签之后那会让每一次 E2E 的帮助用例都 404 ——
  //    而症状是「帮助页签空白」，看起来像渲染器坏了，真因是副本里没这个文件。
  //    判据：只放行 docs/panel-help.md 这一个文件，其余 docs/ 一律不拷。
  const RUNTIME_DOCS = new Set(['panel-help.md']);
  cpSync(EXT_PATH, dest, {
    recursive: true,
    // vendor 产物是构建出来的、本机才有；node_modules 里也没有 E2E 需要的东西。
    filter: (p) => {
      const rel = p.slice(EXT_PATH.length).replace(/^[\\/]+/, '');
      if (!rel) return true;
      const parts = rel.split(/[\\/]/);
      if (parts[0] === 'docs') {
        // ⚠️ 目录本身必须放行：cpSync 先问目录再问它的子项，
        //    目录返回 false 会把整棵子树剪掉，panel-help.md 根本没机会被访问到。
        //    这正是第一版的写法：它排掉了 docs 目录，于是帮助页签永远是空白。
        if (parts.length === 1) return true;
        return parts.length === 2 && RUNTIME_DOCS.has(parts[1]);
      }
      return !/(^|[\\/])(node_modules|\.git|tests|docs|\.scratch)([\\/]|$)/.test(p);
    },
  });
  // 副本必须与 tools/package.py 的 INCLUDE_DOCS 保持一致：
  // 那边的白名单排掉了它，这边也排掉，两边同进同退。
  if (!existsSync(join(dest, 'docs', 'panel-help.md'))) {
    throw new Error(
      '扩展副本里没有 docs/panel-help.md —— 面板「帮助」页签在 E2E 里必然空白。'
      + '它必须与 tools/package.py 的 INCLUDE_DOCS 同步。',
    );
  }
  if (!existsSync(join(dest, 'manifest.json'))) {
    throw new Error(`扩展副本不完整（缺 manifest.json）：${dest}`);
  }
  extCopyCache = dest;
  return dest;
}

/**
 * 这个通道的浏览器在吗？
 * ⚠️ 只对「二进制不存在」这一类错回退；其他错误立刻抛 ——
 *    把真问题（例如扩展加载失败）当成「换个浏览器再试试」，
 *    是那种能把排查带偏一整轮的降级。
 */
function isMissingBinary(err) {
  const msg = String((err && err.message) || '');
  return /Executable doesn't exist|please run the following command to download/i.test(msg);
}

/**
 * 要不要开窗口？
 *
 * ⚠️ 默认 **headless**，因为「跑一次 E2E 弹一次窗、界面一闪一闪」
 *    是真的会让人烦的，而且那条规则原来是默认**有头**的 ——
 *    理由早已过时：它继承自「chromium_headless_shell 不支持加载扩展」。
 *
 *    但那条限制**只对 Playwright 自带的 chromium 成立**：
 *    走 channel（系统 Chrome/Edge）时，`headless: true` 用的是
 *    **真实浏览器的新 headless 模式**，扩展完全支持。
 *    本机实测（Edge 154 + headless:true）→ service worker 正常出现。
 *
 *    所以：默认 headless（安静），要肉眼调试时用 BO_E2E_HEADED=1 或
 *    `launchWithExtension({ headed: true })` 临时开窗。
 *
 * @param {{headed?: boolean}} opts
 * @returns {boolean}
 */
function wantHeaded(opts = {}) {
  if (opts.headed === true) return true;
  if (opts.headed === false) return false;
  return process.env.BO_E2E_HEADED === '1';
}

/**
 * 启动带扩展的浏览器上下文。
 * @param {{headed?: boolean, reuseUserDataDir?: string, channel?: string}} [opts]
 */
export async function launchWithExtension(opts = {}) {
  const headed = wantHeaded(opts);
  const userDataDir = opts.reuseUserDataDir || mkdtempSync(join(tmpdir(), 'bo-e2e-'));
  if (!opts.reuseUserDataDir) userDataDirs.push(userDataDir);

  const ext = resolveExtPath();
  const args = [
    `--disable-extensions-except=${ext}`,
    `--load-extension=${ext}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];

  const want = opts.channel || process.env.BO_E2E_CHANNEL || 'msedge';
  const chain = [want, ...['msedge', 'chrome', 'chromium'].filter((c) => c !== want)];

  let ctx = null;
  let used = null;
  const tried = [];
  for (const channel of chain) {
    try {
      ctx = await chromium.launchPersistentContext(userDataDir, { channel, headless: !headed, args });
      used = channel;
      break;
    } catch (e) {
      tried.push(`${channel}: ${isMissingBinary(e) ? '二进制缺失' : String(e.message).slice(0, 100)}`);
      if (!isMissingBinary(e)) break;
    }
  }
  if (!ctx) {
    throw new Error(`没有可用的浏览器通道：\n  ${tried.join('\n  ')}\n可设 BO_E2E_CHANNEL 指定。`);
  }
  if (used !== want) console.warn(`[harness] 期望 channel="${want}"，实际用了 "${used}"`);

  // service worker 是扩展的「活着」信号：拿不到它 = 扩展没起来。
  // ⚠️ 别把这个超时当成「扩展坏了」——本机实测它也可能是路径含空格，
  //    或 Chrome 版本已移除该开关。resolveExtPath 与上面的通道链就是为此存在的。
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  const extensionId = new URL(sw.url()).host;

  return { ctx, sw, extensionId, userDataDir, channel: used, extPath: ext };
}

/** 打开主面板 */
export async function openPanel(ctx, extensionId) {
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  await page.goto(`chrome-extension://${extensionId}/ui/options.html`, { waitUntil: 'domcontentloaded' });
  // ⚠️ 必须等 init() 跑完（data-ready），不能只等按钮出现。
  //    按钮在 HTML 解析时就存在，那时模块脚本还没执行、监听器还没绑。
  //    早点击会静默丢失；而「dry-run 零写入」会因为「什么都没发生」而假绿。
  await page.waitForSelector('body[data-ready="1"]', { state: 'attached', timeout: 20000 });
  await forceLlmOff(page);
  return page;
}

/**
 * 强制关掉 LLM，让 E2E 与机器环境解耦。
 *
 * 为什么必须做：
 *   LLM 兜底默认开启，而 settings 里的 key 可能来自 tools/inject_key.py
 *   注入的 src/llm-key.local.js —— 那是**本机环境状态**，不该影响测试结果。
 *   现状下即使开着也不会真发请求（optional host permission 在全新 profile 里
 *   从未授予，classifyBatch 会提前返回），但那依赖「权限恰好没被授予」这个
 *   隐含前提；一旦哪天测试 profile 继承了权限，就会变成真的联网调用。
 *   显式关掉，把前提写死在代码里。
 *
 * loadAndClassify 是在**预览时**才读 settings 的，所以这里写完立即生效，无需 reload。
 */
export async function forceLlmOff(page) {
  await page.evaluate(async () => {
    const got = await chrome.storage.local.get('settings');
    const cur = got.settings || {};
    await chrome.storage.local.set({ settings: { ...cur, llmEnabled: false } });
  });
}

/**
 * 造夹具书签（固定种子，可重复）。
 * ⚠️ 绝不用改磁盘 Bookmarks 文件的方式造夹具 —— 那样夹具会和真实状态漂移，
 *    E2E 红了就分不清是代码缺陷还是夹具漂移。
 * @param {import('playwright').Page} page
 * @param {Array<{title:string,url:string,parentId?:string}>} items
 */
export async function seedBookmarks(page, items) {
  return page.evaluate(async (list) => {
    const created = [];
    for (const it of list) {
      const node = await chrome.bookmarks.create({
        parentId: it.parentId || '1',
        title: it.title,
        url: it.url,
      });
      created.push({ id: node.id, title: node.title, url: node.url });
    }
    return created;
  }, items);
}

/** 读整棵书签树的结构签名（忽略 id，便于跨会话比较） */
export async function treeSignature(page) {
  return page.evaluate(async () => {
    const walk = (nodes) =>
      nodes
        .map((n) => ({
          t: n.title,
          u: n.url || null,
          c: Array.isArray(n.children) && n.children.length ? walk(n.children) : null,
        }))
        .sort((a, b) => (a.t + (a.u || '')).localeCompare(b.t + (b.u || '')));
    const tree = await chrome.bookmarks.getTree();
    return JSON.stringify(walk(tree[0].children));
  });
}

/** 固定种子夹具集：覆盖规则命中、未命中、重复、SPA 路由等场景 */
export function makeFixtures(n = 40) {
  const list = [];
  const known = [
    ['GitHub 某仓库', 'https://github.com/some/repo'],
    ['Vue 文档', 'https://cn.vuejs.org/guide/introduction.html'],
    ['MDN Web Docs', 'https://developer.mozilla.org/zh-CN/docs/Web/CSS'],
    ['Redis 文档', 'https://redis.io/docs/latest/'],
    ['Docker 入门', 'https://docs.docker.com/get-started/'],
    ['arXiv 论文', 'https://arxiv.org/abs/1706.03762'],
    ['ChatGPT', 'https://chatgpt.com/'],
    ['Notion', 'https://www.notion.so/workspace'],
    ['力扣', 'https://leetcode.cn/problemset/'],
    ['哔哩哔哩', 'https://www.bilibili.com/'],
    ['网易云音乐', 'https://music.163.com/'],
    ['IT之家', 'https://www.ithome.com/'],
    ['知乎', 'https://www.zhihu.com/'],
    ['雪球', 'https://xueqiu.com/'],
    ['淘宝', 'https://www.taobao.com/'],
    ['美团', 'https://www.meituan.com/'],
    ['Dribbble', 'https://dribbble.com/shots/popular'],
    ['Figma', 'https://www.figma.com/files/recent'],
    ['iconfont', 'https://www.iconfont.cn/collections/index'],
    ['CSDN', 'https://blog.csdn.net/'],
  ];
  for (const [title, url] of known) {
    if (list.length >= n) break;
    list.push({ title, url });
  }
  // 补齐到 n 条：长尾未命中项
  for (let i = list.length; i < n; i++) {
    list.push({ title: `未知站点 ${i}`, url: `https://unknown-tail-${i}.example.org/page` });
  }
  return list;
}

/** 造一组明确的重复项（同一 URL 收藏两次） */
export function makeDuplicateFixtures() {
  return [
    { title: '重复 A', url: 'https://dup.example.com/same?utm_source=wx' },
    { title: '重复 A2', url: 'https://dup.example.com/same' },
    { title: 'SPA 设置页', url: 'https://spa.example.com/#/settings' },
    { title: 'SPA 个人页', url: 'https://spa.example.com/#/profile' },
  ];
}

/**
 * 「去重逐条否决」闸门的夹具：**两组**重复项。
 *
 * 为什么要两组：只造一组的话，把唯一那条待删项勾掉之后执行器一条都不删，
 * 这条闸门就只能证明「没删」，证明不了「该删的还照删」——
 * 也就是说，一个「无论勾什么都全跳过」的实现也能让它变绿。
 * B 组不作任何操作当对照，A 组勾一条，两种行为必须在同一轮里同时被验到。
 *
 * 每组两条的 URL 只有跟踪参数不同（utm_source / spm 都在剥离白名单里），
 * 所以两条确实是重复项；但它们的**原始 URL 不相同**，
 * 执行后才能按 URL 区分「哪条活下来了」。
 */
export function makeVetoFixtures() {
  return [
    { title: '否决组-保留', url: 'https://veto-a.example.com/same' },
    { title: '否决组-待删', url: 'https://veto-a.example.com/same?utm_source=wx' },
    { title: '对照组-保留', url: 'https://veto-b.example.com/same' },
    { title: '对照组-待删', url: 'https://veto-b.example.com/same?spm=abc' },
  ];
}

/**
 * 点「读取并预览」并等这一轮真的跑完。
 *
 * ⚠️ 判据用的是页面上的 previewSeq（每次渲染完成自增），
 *    不是「表格有没有行」或「空态文案有没有出现」。
 *    后两者在 init() 之后就已经是那个状态了 —— 会在新结果渲染出来之前
 *    立刻判定通过，然后读到上一轮的旧数据。
 *    更糟的是：点击若丢失（监听器还没绑），这个条件天然成立，
 *    「dry-run 零写入」那条就会因为「什么都没发生」而假绿。
 *    previewSeq 单调递增，点击丢失时它不动 → 超时报红，绝不假绿。
 */
export async function runPreview(page, opts = {}) {
  const before = await page.evaluate(() => Number(document.body.dataset.previewSeq || 0));
  await page.click('#btnPreview');
  await page.waitForFunction(
    (n) => Number(document.body.dataset.previewSeq || 0) > n,
    before,
    { timeout: opts.timeout || 30000 },
  );

  const rendered = await page.evaluate(() => ({
    move: document.getElementById('stMove').textContent.trim(),
    total: document.getElementById('stTotal').textContent.trim(),
    rows: document.querySelectorAll('#planBody tr').length,
  }));
  if (!/^\d+$/.test(rendered.total)) {
    throw new Error(`预览后统计卡未渲染（total="${rendered.total}"）`);
  }
  return { move: Number(rendered.move), total: Number(rendered.total), rows: rendered.rows };
}

/**
 * 等执行推进到「已完成 >= min 条」。
 *
 * ⚠️ 不要用 page.waitForFunction + 异步谓词：Playwright 对 Promise 返回值的
 *    真值判断不可靠，会在 Promise 对象上直接判真，于是立刻返回并拿不到数据，
 *    表现为「执行没有产生任何进度」。改成 Node 侧显式轮询，行为完全确定。
 *
 * 直接读落盘的 task:current —— 这才是断点续跑真正依赖的数据源。
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{done:number,total:number,status:string}>}
 */
export async function waitForPartialProgress(page, min = 1, timeout = 30000) {
  const readOnce = () =>
    page.evaluate(async () => {
      const got = await chrome.storage.local.get('task:current');
      const task = got['task:current'];
      if (!task || !task.plan) return null;
      const items = task.plan.items || [];
      return {
        done: items.filter((i) => i.status === 'done').length,
        total: items.length,
        status: task.status,
      };
    });

  const deadline = Date.now() + timeout;
  let last = null;
  for (;;) {
    last = await readOnce();
    if (last && last.done >= min) return last;
    if (Date.now() > deadline) {
      throw new Error(
        `等待执行进度超时（min=${min}）。最后一次读到：${JSON.stringify(last)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 40));
  }
}

/** 读统计卡 */
export async function readStats(page) {
  return page.evaluate(() => ({
    total: document.getElementById('stTotal').textContent,
    move: document.getElementById('stMove').textContent,
    inPlace: document.getElementById('stInPlace').textContent,
    unclassified: document.getElementById('stUnclassified').textContent,
    dup: document.getElementById('stDup').textContent,
    folders: document.getElementById('stFolders').textContent,
  }));
}

/**
 * 等执行结束。
 *
 * ⚠️ 判据必须是 #reportStatus 单元格的**值**，不能对报告全文做子串匹配 ——
 *    报告里有一行标签就叫「失败」，全文匹配 /失败/ 会在任务刚建立时就命中，
 *    于是「等执行结束」立刻返回，后续断言全建立在「已经跑完」的错误前提上。
 *    （这个坑真的踩过：幂等用例在只搬了 4 条时就断言「二次预览应为 0 变更」。）
 */
const TERMINAL_STATUS = ['已完成', '失败', '已暂停'];

export async function waitForExecutionDone(page, timeout = 60000) {
  await page.waitForFunction(
    (terminal) => {
      const el = document.getElementById('reportStatus');
      const v = el ? (el.textContent || '').trim() : '';
      return terminal.includes(v);
    },
    TERMINAL_STATUS,
    { timeout, polling: 100 },
  );
  return readReportStatus(page);
}

/** 读执行状态（只看状态单元格） */
export async function readReportStatus(page) {
  return page.evaluate(() => (document.getElementById('reportStatus')?.textContent || '').trim());
}

/**
 * 等报告状态变成指定值。
 *
 * ⚠️ 续跑场景必须用它，不能直接用 waitForExecutionDone：
 *    「已暂停」本身就是 waitForExecutionDone 认定的终态，点「继续」之前
 *    状态就已经是终态，于是等待立即返回，后续断言建立在「还没开始跑」的前提上。
 *    先显式等 '执行中' 证明续跑真的启动了，再等终态。
 */
export async function waitForReportStatus(page, expected, timeout = 60000) {
  await page.waitForFunction(
    (want) => {
      const el = document.getElementById('reportStatus');
      const v = el ? (el.textContent || '').trim() : '';
      return v === want;
    },
    expected,
    { timeout, polling: 100 },
  );
  return readReportStatus(page);
}


/** 清理临时 profile 与扩展副本 */
export function cleanupAll() {
  for (const d of userDataDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
  userDataDirs.length = 0;
  for (const r of tempRoots) {
    try { rmSync(r, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
  tempRoots.length = 0;
  extCopyCache = null;
}
