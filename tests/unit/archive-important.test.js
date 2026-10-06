/**
 * 归档「重要」标记 + 归档切片循环的单测。
 *
 * ═══ 这组测试在防什么 ═══
 *
 * ① **G4 分级曾经整条是死的。**
 *    `archiveOne({important})` 接受参数、接收器认这个参数会渲染 PDF 与截图，
 *    但面板上**没有任何东西能设它** —— 于是 important 恒为 false，
 *    800 页一页 PDF 都不会出，而单测全绿。
 *
 * ② **「归档队列里的正文」按钮曾经归档 0 条。**
 *    队列 `link:queue` 里存的是 `{url, bytes, at}`，**没有正文**
 *    （src/scan/runner.js 有意不落 80MB），而 background.js 读的是 `e.html`。
 *    于是每条都撞上「没有正文 → skipped」，面板显示「已归档 0/800」。
 *    一个承诺归档、实际归档 0 条的按钮，比没有这个按钮更伤。
 *
 * ③ **星标不是锁。** `K.LOCKS` 是「不要移动这条书签」，存 id；
 *    星标存 URL，语义是「归档时多渲染一份 PDF」。合并过一次的后果是
 *    用户为归档打个星，那条书签从此不敢动，而界面上看不出来。
 *
 * 所以下面每条 test() 的名字里都带 ⚠️：它们防的是「功能看起来正常、实际没生效」。
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

function installChromeStub() {
  const store = new Map();
  const clone = (v) => (v === undefined ? undefined : structuredClone(v));
  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          if (keys == null) return Object.fromEntries(store);
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of list) if (store.has(k)) out[k] = clone(store.get(k));
          return out;
        },
        async set(obj) { for (const [k, v] of Object.entries(obj)) store.set(k, clone(v)); },
        async remove(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k); },
      },
    },
  };
  return { store };
}
const stub = installChromeStub();
beforeEach(() => { stub.store.clear(); });

const IMP = await import('../../src/archive/important.js');
const RUN = await import('../../src/archive/run.js');
const { K, toggleDedupeVeto, getDedupeVeto } = await import('../../src/storage.js');

const PAGE = '<html><head><title>正文标题</title></head><body><p>这是一段正文</p></body></html>';

/** 队列条目的真实形状：**只有指针，没有正文**。别在测试里偷偷给它加 html。 */
const q = (url, bytes = 1024) => ({ url, bytes, at: 1 });

/**
 * 装一个 fetch 替身，把「探测（出网）」与「送接收器（127.0.0.1）」分开。
 * @param {{dead?:string[], bodies?:object[]}} opts dead 里的 URL 模拟「这会儿已经打不开」
 */
function installFetch({ dead = [], bodies = [] } = {}) {
  const deadSet = new Set(dead);
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('http://127.0.0.1')) {
      if (u.includes('/health')) {
        return { ok: true, status: 200, async json() { return { ok: true, written: 0, dir: 'D:\\a' }; } };
      }
      bodies.push(JSON.parse(init.body));
      return { ok: true, status: 200, async text() { return JSON.stringify({ ok: true, file: 'x.html' }); } };
    }
    if (deadSet.has(u)) throw Object.assign(new Error('net::ERR_CONNECTION_REFUSED'), { name: 'TypeError' });
    return {
      ok: true, status: 200, url: u, redirected: false,
      async text() { return PAGE; },
    };
  };
  return bodies;
}

// ═══════════ 标记本身 ═══════════

test('⚠️ 点星标 → 真的落进 storage；再点 → 移除', async () => {
  const url = 'https://a.com/p';
  const r1 = await IMP.toggleImportant(url);
  assert.equal(r1.marked, true);
  assert.deepEqual(r1.urls, [url]);
  assert.deepEqual(stub.store.get(K.ARCHIVE_IMPORTANT), [url],
    '必须真写进 chrome.storage，而不是只活在内存里');

  const r2 = await IMP.toggleImportant(url);
  assert.equal(r2.marked, false);
  assert.deepEqual(await IMP.getImportantUrls(), []);
  assert.deepEqual(stub.store.get(K.ARCHIVE_IMPORTANT), []);
});

test('⚠️ 星标状态从 storage 恢复，不是内存态（面板刷新后还在）', async () => {
  // 绕过所有模块函数直接改 storage —— 等价于「另一个上下文写进去」，
  // 比如面板被关掉重开、或 service worker 被回收后重建。
  await stub.store.set(K.ARCHIVE_IMPORTANT, ['https://x.com/1']);
  assert.deepEqual(await IMP.getImportantUrls(), ['https://x.com/1'],
    'getImportantUrls 读的是缓存而不是 storage → 面板一刷新星标就没了');
});

test('⚠️ 星标与「不要移动这条书签」的锁互不干扰', async () => {
  // 这条是工单点名要的证伪：把星标误写进 K.LOCKS 时它必须红。
  assert.notEqual(K.ARCHIVE_IMPORTANT, K.LOCKS, '两个键位必须是分开的');

  await toggleDedupeVeto('42', true);
  await IMP.toggleImportant('https://a.com/p');

  assert.deepEqual(await getDedupeVeto(), ['42'], '锁列表里混进了 URL');
  assert.deepEqual(await IMP.getImportantUrls(), ['https://a.com/p'], '星标列表里混进了书签 id');

  await IMP.clearImportant();
  assert.deepEqual(await getDedupeVeto(), ['42'], '取消标记把锁也一起清了');
});

test('「全部取消标记」清空后归档不再带 important', async () => {
  await IMP.toggleImportant('https://a.com/p');
  await IMP.clearImportant();
  assert.deepEqual(await IMP.getImportantUrls(), []);
  const bodies = installFetch();
  await RUN.archiveSlice({ queue: [q('https://a.com/p')], sink: { online: true } });
  assert.equal(bodies[0].important, false);
});

test('⚠️ 脏数据不会让无关页面被判成重要', async () => {
  // storage 里的值可能来自旧版本或被手改过。空串进 Set 之后
  // `importantSet.has('')` 恒为真，而每条 body 的 url 都可能是空串。
  await stub.store.set(K.ARCHIVE_IMPORTANT, ['', '  ', 'https://a.com', 'https://a.com', null, 42]);
  assert.deepEqual(await IMP.getImportantUrls(), ['https://a.com', '42']);
});

test('⚠️ isMarkedImportant 边界：空值与脏列表不能判成已标记', () => {
  assert.equal(IMP.isMarkedImportant('', ['']), false);
  assert.equal(IMP.isMarkedImportant('https://a.com', undefined), false);
  assert.equal(IMP.isMarkedImportant('https://a.com', 'not-an-array'), false);
  assert.equal(IMP.isMarkedImportant('  https://a.com  ', ['https://a.com']), true,
    '前后空白不该让用户的标记凭空失效');
});

// ═══════════ G4 分级真的生效 ═══════════

test('⚠️ 归档请求体里 important 只对被标记的为 true（工单验收 2）', async () => {
  await IMP.toggleImportant('https://a.com/p');
  const bodies = installFetch();
  const r = await RUN.archiveSlice({
    queue: [q('https://a.com/p'), q('https://b.com/q')],
    sink: { online: true },
  });

  assert.equal(r.finished, true);
  assert.equal(r.done, 2, '两条都该落盘');
  const a = bodies.find((b) => b.url === 'https://a.com/p');
  const b = bodies.find((b) => b.url === 'https://b.com/q');
  assert.ok(a && b, `请求体少了一条：${JSON.stringify(bodies)}`);
  assert.equal(a.important, true, '被标记的必须是 true —— 否则接收器不会渲染 PDF');
  assert.equal(b.important, false, '没标记的必须是 false');
});

test('⚠️ 归档时正文是重抓的（队列里根本没有正文）', async () => {
  // 这条钉住那个真 bug：队列条目只有 {url, bytes, at}。
  // 任何「直接读 e.html」的写法都会让 html 为空 → 每条 skipped → 归档 0 条。
  const bodies = installFetch();
  const r = await RUN.archiveSlice({ queue: [q('https://a.com/p')], sink: { online: true } });

  assert.equal(r.done, 1, '归档 0 条说明正文没送到 —— 队列里本来就没有正文');
  assert.equal(bodies.length, 1);
  assert.match(bodies[0].html, /这是一段正文/, '送出去的不是正文');
  assert.equal(bodies[0].title, '正文标题');
  assert.ok(bodies[0].html.length <= 512 * 1024, '正文上限 512KB');
});

test('⚠️ 归档时页面已打不开，如实记成 fetchFailed 而不是静默丢', async () => {
  const bodies = installFetch({ dead: ['https://gone.com/p'] });
  const r = await RUN.archiveSlice({
    queue: [q('https://gone.com/p'), q('https://a.com/p')],
    sink: { online: true },
  });
  assert.equal(r.done, 1, '活着的那条要成功');
  assert.equal(r.fetchFailed, 1, '挂掉的那条必须被如实计数，不能悄悄消失');
  assert.equal(bodies.length, 1);
});

test('⚠️ 接收器离线要说清楚怎么起，不静默假装存了', async () => {
  const r = await RUN.archiveSlice({ queue: [q('https://a.com/p')], sink: { online: false } });
  assert.match(r.reason, /archive_sink\.py/, '没告诉用户怎么把接收器起起来');
  assert.equal(r.done, 0);
});

test('队列为空时明说原因，不报「已归档 0/0」', async () => {
  const r = await RUN.archiveSlice({ queue: [], sink: { online: true } });
  assert.match(r.reason, /队列是空的/);
});

// ═══════════ 游标能续跑 ═══════════

test('⚠️ 归档游标能续跑，跑完后再点不会从头重来', async () => {
  const queue = [q('https://a.com/1'), q('https://a.com/2'), q('https://a.com/3')];
  installFetch();

  const r1 = await RUN.archiveSlice({ queue, sink: { online: true }, slice: 2 });
  assert.equal(r1.finished, false);
  assert.equal(r1.done, 2);
  assert.equal(r1.remaining, 1);

  const r2 = await RUN.archiveSlice({ queue, sink: { online: true }, slice: 2 });
  assert.equal(r2.finished, true);
  assert.equal(r2.done, 3);

  // SW 被回收后再点一次：应该直接报完成，而不是把 3 条重抓一遍重发
  const bodies = [];
  installFetch({ bodies });
  const r3 = await RUN.archiveSlice({ queue, sink: { online: true }, slice: 2 });
  assert.equal(r3.finished, true);
  assert.equal(bodies.length, 0, '已经跑完的归档又被重跑了一遍');
});

test('清掉进度后下一次从头开始', async () => {
  const queue = [q('https://a.com/1'), q('https://a.com/2')];
  installFetch();
  await RUN.archiveSlice({ queue, sink: { online: true }, slice: 1 });
  assert.equal((await RUN.getArchiveRun()).cursor, 1);

  await RUN.resetArchiveRun();
  assert.equal(await RUN.getArchiveRun(), null);

  const bodies = [];
  installFetch({ bodies });
  const r = await RUN.archiveSlice({ queue, sink: { online: true }, slice: 1 });
  assert.equal(r.cursor, 1);
  assert.equal(bodies.length, 1, '清进度后应该重新发第一条');
});

test('summarize 把四类结果分开，不合并成一个数字', async () => {
  const s = RUN.summarize({
    cursor: 10, total: 20, done: 6, fetchFailed: 2, postFailed: 1, skipped: 1, rendered: 3,
  });
  assert.equal(s.remaining, 10);
  assert.equal(s.finished, false);
  // 合并成一个「已归档 6/20」就会把 4 条没存上的藏起来
  assert.notEqual(s.done + s.fetchFailed + s.postFailed + s.skipped, s.total);
});
