/**
 * link-scan 编排层的单测：权限门控、扫描循环、断点续跑、替代方案。
 *
 * 全部用**替身**，不碰网络、不起浏览器。
 * 判据一律是「面板上能看见的东西」或「落盘的内容」，
 * 不是内部变量 —— 仓库前科：面板报 100% 成功、书签栏一点没变。
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── chrome 替身：必须在 import 被测模块之前装好 ──
function installChromeStub() {
  const store = new Map();
  const clone = (v) => (v === undefined ? undefined : structuredClone(v));
  const perm = { contains: true, removed: false };
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
    permissions: {
      contains: async () => perm.contains,
      request: async () => perm.contains,
      remove: async () => { perm.removed = true; perm.contains = false; return true; },
    },
    alarms: {
      _list: new Map(),
      async create(name, info) { this._list.set(name, { name, periodInMinutes: info.periodInMinutes }); },
      async clear(name) { return this._list.delete(name); },
      async get(name) { return this._list.get(name); },
      onAlarm: { addListener() {} },
    },
  };
  return { store, perm };
}

const stub = installChromeStub();
beforeEach(() => { stub.store.clear(); stub.perm.contains = true; });

const S = await import('../../src/scan/runner.js');
const P = await import('../../src/scan/permission.js');
const SCH = await import('../../src/scan/scheduler.js');
const ALT = await import('../../src/scan/alternatives.js');
const { K, set } = await import('../../src/storage.js');
const { VERDICT, VERDICT_LABEL } = await import('../../src/scan/verdict.js');

const T0 = 1_800_000_000_000;
const H = 3600_000;

/** 伪造探测器：按 url 决定返回什么，避免真的联网 */
function stubFetch(map) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const key = Object.keys(map).find((k) => String(url).includes(k));
    const spec = key ? map[key] : { status: 200 };
    const res = {
      status: spec.status,
      url: spec.finalUrl || String(url),
      redirected: spec.redirected === true,
      ok: spec.status >= 200 && spec.status < 300,
      async text() { return spec.html || '<html><head><title>T</title></head><body>x</body></html>'; },
    };
    return res;
  };
  return calls;
}

const SETTINGS = { linkScanTimeoutMs: 100, linkScanConcurrency: 2 };

// ═══════════ 权限 ═══════════

test('权限：默认已授权时 has 返回 true', async () => {
  assert.equal(await P.hasScanPermission(), true);
});

test('权限：未授权时 request 走用户手势路径，revoke 之后变 false', async () => {
  stub.perm.contains = false;
  assert.equal(await P.hasScanPermission(), false);
  stub.perm.contains = true;
  assert.equal(await P.requestScanPermission(), true);
  assert.equal(await P.revokeScanPermission(), true);
  assert.equal(await P.hasScanPermission(), false);
});

test('权限：两条 origin 都要申请 —— 少一条就漏掉一半站点', () => {
  assert.ok(P.ALL_ORIGINS.includes('http://*/*'));
  assert.ok(P.ALL_ORIGINS.includes('https://*/*'));
});

test('权限：出网说明必须写明「不上传」与「不写入书签」', () => {
  const d = P.OUTBOUND_DISCLOSURE;
  assert.match(d, /不向任何第三方上传/, '用户从 Network 面板看到的就是偷偷联网上 —— 许可会变成被墙');
  // ⚠️ 判据从字面量 `/不改你的书签/` 改成了语义。
  //    那条字面量把**措辞**钉死了，于是 2026-10-06 把文案改成更强的
  //    「不写入你的书签，一个字都不改」时它红了 —— 红灯是真的，
  //    而红的原因与被测性质无关（说辞变强了，不是承诺变弱了）。
  //    误报的闸门比没有闸门更糟：它只会教会人忽略自己。
  //    现在接受任何「明确否认写入」的诚实措辞，但**不接受**含糊说法。
  assert.match(
    d,
    /(不改|不写入|一个字都不改|不会改)[^。\n]*书签/,
    '出网说明没有明确写「不会写入你的书签」—— 这是许可与信任之间唯一的桥',
  );
  // 新增的不变量：说明里不许再承诺那个不存在的「逐条确认」步骤（2026-10-06 评审）
  assert.doesNotMatch(d, /逐条确认/,
    '出网说明承诺「逐条确认后亲自执行」，而面板里没有任何确认步骤 —— '
    + '界面承诺一件永远不会发生的事，比功能缺失更伤');
  assert.ok(d.length > 80, '说明太短等于没写');
});

// ═══════════ 扫描循环 ═══════════

test('runSlice：探一条并落盘，游标前进', async () => {
  stubFetch({ 'ok.test': { status: 200 } });
  await S.startRound([{ id: '1', url: 'https://ok.test/a' }], { now: T0 });
  const r = await S.runSlice({ settings: SETTINGS, now: T0 });
  assert.equal(r.processed, 1);
  assert.equal(r.done, true);
  const rec = await S.getRecord('1');
  assert.equal(rec.status, 200);
  assert.equal(rec.verdict, VERDICT.OK);
  assert.equal(rec.url, 'https://ok.test/a', 'URL 丢失 → 面板上那行就没法告诉你它在探什么');
});

test('runSlice：404 一轮只记可疑，两轮不成死链', async () => {
  stubFetch({ 'gone.test': { status: 404 } });
  await S.startRound([{ id: '1', url: 'https://gone.test/a' }], { now: T0 });
  await S.runSlice({ settings: SETTINGS, now: T0 });
  let rec = await S.getRecord('1');
  assert.equal(rec.verdict, VERDICT.SUSPECT, '一次 404 就判死链 = 一次网络抖动毁掉一批书签');
  assert.equal(rec.failStreak, 1);

  await S.startRound([{ id: '1', url: 'https://gone.test/a' }], { now: T0 + 6 * H });
  await S.runSlice({ settings: SETTINGS, now: T0 + 6 * H });
  rec = await S.getRecord('1');
  assert.equal(rec.verdict, VERDICT.SUSPECT, '6 小时内 2 次仍未跨 24h，不该判死');
  assert.equal(rec.failStreak, 2);
});

test('runSlice：跨 24h 的第 3 次 404 才判死链', async () => {
  stubFetch({ 'gone.test': { status: 404 }, 'fine.test': { status: 200 } });
  // 先好过一次（lastOkAt 有值），再坏掉 —— 这才是「链接腐烂」的真实剧本
  await S.startRound([{ id: '1', url: 'https://fine.test/a' }], { now: T0 });
  await S.runSlice({ settings: SETTINGS, now: T0 });
  assert.equal((await S.getRecord('1')).verdict, VERDICT.OK);

  for (const [i, t] of [1, 7, 26].entries()) {
    stubFetch({ 'gone.test': { status: 404 } });
    await S.startRound([{ id: '1', url: 'https://gone.test/a' }], { now: T0 + t * H });
    await S.runSlice({ settings: SETTINGS, now: T0 + t * H });
    const v = (await S.getRecord('1')).verdict;
    if (i < 2) assert.notEqual(v, VERDICT.DEAD, `第 ${i + 1} 次失败就判死了（间隔 ${t}h）`);
  }
  const rec = await S.getRecord('1');
  assert.equal(rec.verdict, VERDICT.DEAD);
  assert.equal(rec.failStreak, 3);
  assert.equal(rec.lastOkAt, T0, 'lastOkAt 是「跨 24h」的起点，被冲掉判据就废了');
});

test('⚠️ 从没成功过的链接不得判死链', async () => {
  // lastOkAt=0 表示「从来没打开成功过」。那不叫「已经死了」，叫「还没探明白」——
  // 否则你刚收藏一条拼错的 URL，它就会被标成死链并建议替换。
  stubFetch({ 'never.test': { status: 404 } });
  for (const t of [0, 6, 26, 50]) {
    await S.startRound([{ id: '1', url: 'https://never.test/a' }], { now: T0 + t * H });
    await S.runSlice({ settings: SETTINGS, now: T0 + t * H });
  }
  const rec = await S.getRecord('1');
  assert.equal(rec.lastOkAt, 0);
  assert.equal(rec.verdict, VERDICT.SUSPECT, '从没成功过的链接被判成死链了');
});

test('runSlice：网络错误不计入失败计数', async () => {
  globalThis.fetch = async () => { throw Object.assign(new Error('boom'), { name: 'TimeoutError' }); };
  await S.startRound([{ id: '1', url: 'https://slow.test/a' }], { now: T0 });
  await S.runSlice({ settings: SETTINGS, now: T0 });
  const rec = await S.getRecord('1');
  assert.equal(rec.verdict, VERDICT.NET_ERROR);
  assert.equal(rec.failStreak, 0, '超时把失败计数推上去了');
});

test('runSlice：同站改址归 redirect_same，跨站归 redirect_cross', async () => {
  stubFetch({
    'moved.test': { status: 200, redirected: true, finalUrl: 'https://moved.test/new' },
    'jump.test': { status: 200, redirected: true, finalUrl: 'https://other.test/x' },
  });
  await S.startRound([
    { id: 'a', url: 'https://moved.test/old' },
    { id: 'b', url: 'https://jump.test/old' },
  ], { now: T0 });
  await S.runSlice({ settings: SETTINGS, now: T0 });
  assert.equal((await S.getRecord('a')).verdict, VERDICT.REDIRECT_SAME);
  assert.equal((await S.getRecord('a')).sameSite, true);
  assert.equal((await S.getRecord('b')).verdict, VERDICT.REDIRECT_CROSS);
  assert.equal((await S.getRecord('b')).sameSite, false);
});

test('runSlice：把 200 但内容像不存在的页标成软 404，且不动失败计数', async () => {
  stubFetch({ 'ghost.test': { status: 200, html: '<html><head><title>404 Not Found</title></head></html>' } });
  await S.startRound([{ id: '1', url: 'https://ghost.test/a' }], { now: T0 });
  await S.runSlice({ settings: SETTINGS, now: T0 });
  const rec = await S.getRecord('1');
  assert.equal(rec.verdict, VERDICT.SOFT404);
  assert.equal(rec.failStreak, 0, '软 404 是启发式，不许参与计数');
  // ⚠️ 这里早先还断言了一句 `VERDICT_LABEL[SOFT404]` 含「启发式」——
  //    已删。那是**标签文案**的要求，唯一的家在 scan-logic.test.js 的
  //    「每个 verdict 都有面板文案」里；同一件事在两个文件各写一遍，
  //    改标签时两处都要动，而其中一处（本文件）根本不关心文案。
  //    上面那句 failStreak 才是这个文件真正要钉的实质性质。
});

test('runSlice：正文入队但不落盘 —— 80MB 不是扩展存储该装的东西', async () => {
  stubFetch({ 'p.test': { status: 200, html: '<html>' + 'x'.repeat(5000) + '</html>' } });
  await S.startRound([{ id: '1', url: 'https://p.test/a' }], { now: T0 });
  await S.runSlice({ settings: SETTINGS, now: T0 });
  const q = stub.store.get(K.LINK_QUEUE);
  assert.ok(q && q['https://p.test/a'], '队列里没有这条，F3 就没东西可归档');
  assert.equal(q['https://p.test/a'].bytes, 5013, '字节数对不上，F3 那边会算错配额');
  // 正文本身不许出现在 storage 里
  const dump = JSON.stringify(Object.fromEntries(stub.store.entries()));
  assert.ok(!dump.includes('xxxxxxxxxx'), '正文落进了扩展存储');
});

test('⚠️ 断点续跑：游标持久化，中断后接着跑而不是从头再来', async () => {
  stubFetch({ 'a.test': { status: 200 }, 'b.test': { status: 200 } });
  await S.startRound([{ id: '1', url: 'https://a.test/1' }, { id: '2', url: 'https://b.test/2' }], { now: T0 });
  await S.runSlice({ settings: SETTINGS, now: T0 });

  let st = await S.getLinkState();
  assert.equal(st.cursor, 2, '游标没存住 —— 被回收后整轮重来');

  // 模拟「SW 被回收后重新唤醒」：模块内存全丢，只剩 storage
  stub.store.set(K.LINK_STATE, { ...st, status: 'paused' });
  assert.equal(await S.hasUnfinished(), true, '面板没有「继续未完成的检测」可显示');

  await S.resumeLinkScan();
  assert.equal((await S.getLinkState()).status, 'running');
});

test('hasUnfinished：跑完后不再提示继续', async () => {
  stubFetch({ 'a.test': { status: 200 } });
  await S.startRound([{ id: '1', url: 'https://a.test/1' }], { now: T0 });
  await S.runSlice({ settings: SETTINGS, now: T0 });
  assert.equal(await S.hasUnfinished(), false);
});

test('buildIndex 逐条读记录算汇总，不是累加计数器', async () => {
  stubFetch({ 'ok.test': { status: 200 }, 'gone.test': { status: 404 } });
  await S.startRound([
    { id: '1', url: 'https://ok.test/1' },
    { id: '2', url: 'https://ok.test/2' },
    { id: '3', url: 'https://gone.test/3' },
  ], { now: T0 });
  await S.runSlice({ settings: SETTINGS, now: T0 });
  const idx = await S.buildIndex(['1', '2', '3']);
  assert.equal(idx.total, 3);
  assert.equal(idx.byVerdict[VERDICT.OK], 2);
  assert.equal(idx.byVerdict[VERDICT.SUSPECT], 1);
  assert.equal(idx.actionable, 1, '死链/改址/可疑/软404 都要人看');
});

// ═══════════ 调度 ═══════════

test('syncAlarm：关闭时不起闹钟', async () => {
  const r = await SCH.syncAlarm({ linkScanEnabled: false, linkScanIntervalMinutes: 360 });
  assert.equal(r.armed, false);
  assert.equal(await SCH.readAlarm(), null);
});

test('syncAlarm：开启时按设置的节奏起闹钟', async () => {
  const r = await SCH.syncAlarm({ linkScanEnabled: true, linkScanIntervalMinutes: 1440 });
  assert.equal(r.armed, true);
  const a = await SCH.readAlarm();
  assert.equal(a.periodInMinutes, 1440, '面板上显示的节奏与 Chrome 实际排的不一致');
});

test('syncAlarm：没授权就不排 —— 排了也只会每轮空转', async () => {
  stub.perm.contains = false;
  const r = await SCH.syncAlarm({ linkScanEnabled: true, linkScanIntervalMinutes: 360 });
  assert.equal(r.armed, false);
  assert.match(r.reason, /权限/);
  assert.equal(await SCH.readAlarm(), null);
});

test('onAlarm：功能关闭时不探', async () => {
  const calls = stubFetch({ 'a.test': { status: 200 } });
  const r = await SCH.onAlarm({});
  assert.ok(r.skipped, '功能关了还在探');
  assert.equal(calls.length, 0);
});

test('⚠️ 暂停后闹钟不得抹掉队列（2026-10-06 两轴评审抓到的丢数据 bug）', async () => {
  // 前科：面板上那个按钮写的是「暂停」，早先的 onAlarm 却落到 else 分支
  // 去 `startRound([])`，而 startRound 是**建新一轮**（整体替换
  // entries/ids/cursor/total）而不是续跑。空数组 = 把整条队列抹成 0，
  // runSlice 紧接着看到 slice 为空就报 done，面板上显示「扫完了」。
  // 路径完全正常：暂停一轮 → 等定时闹钟响一次 → 队列没了。
  const calls = stubFetch({});
  const entries = [
    { id: '1', url: 'https://a.test/1' },
    { id: '2', url: 'https://b.test/2' },
    { id: '3', url: 'https://c.test/3' },
  ];
  // 直接造一个「跑到一半被暂停」的状态：游标在 1，队列还有 2 条没探
  await set(K.LINK_STATE, {
    status: 'paused', round: 5,
    entries, ids: ['1', '2', '3'],
    cursor: 1, total: 3,
    startedAt: T0, updatedAt: T0, finishedAt: 0, lastError: '',
  });
  await set(K.SETTINGS, {
    linkScanEnabled: true, linkScanIntervalMinutes: 360,
    linkScanConcurrency: 1, linkScanTimeoutMs: 1000,
  });

  const r = await SCH.onAlarm();
  assert.ok(r.skipped, '暂停状态下闹钟不该替用户「顺手继续」');
  assert.match(r.skipped, /暂停/, '提示要说清是「你暂停了」，而不是「没有可探测的书签」');

  const after = await S.getLinkState();
  assert.equal(after.status, 'paused', '暂停状态被闹钟改掉了');
  assert.deepEqual(after.ids, ['1', '2', '3'], '队列被闹钟抹掉了');
  assert.deepEqual(after.entries, entries, 'entries 被整体替换了');
  assert.equal(after.total, 3, 'total 被清零');
  assert.equal(after.cursor, 1, '游标被重置 —— 剩下的两条会被当成「已完成」');
  assert.equal(after.round, 5, '轮次被改写');
  assert.equal(calls.length, 0, '暂停状态下仍然发了探测请求');
});

test('INTERVALS 里必须有「关闭」这一档', () => {
  assert.ok(INTERVALS_has_zero());
  function INTERVALS_has_zero() {
    return SCH.INTERVALS.some((i) => i.value === 0);
  }
});

// ═══════════ 替代方案 ═══════════

test('Wayback：API 给出时间戳时 method=api', async () => {
  globalThis.fetch = async () => ({
    status: 200,
    ok: true,
    url: 'https://archive.org/wayback/available',
    async json() {
      return { archived_snapshots: { closest: { available: true, timestamp: '20240101', url: 'https://web.archive.org/web/20240101/https://x.test/' } } };
    },
  });
  const s = await ALT.findSnapshot('https://x.test/');
  assert.equal(s.method, 'api');
  assert.equal(s.ts, '20240101');
});

test('Wayback：API 挂掉要降级到 magic URL 并如实记 method', async () => {
  let n = 0;
  globalThis.fetch = async (url) => {
    n += 1;
    if (String(url).includes('archive.org/wayback/available')) throw new Error('CORS');
    return { status: 200, ok: true, url: 'https://web.archive.org/web/20240101/https://x.test/', redirected: true };
  };
  const s = await ALT.findSnapshot('https://x.test/');
  assert.equal(s.method, 'magic-url', '降级了却还写 api —— 面板上会让人以为这个地址可靠');
  assert.ok(n >= 2, '没有真的去试降级路径');
});

test('Wayback：API 明确说没有存档时返回 null，不谎称失败', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes('wayback/available')) {
      return { status: 200, ok: true, async json() { return { archived_snapshots: {} }; } };
    }
    return { status: 404, ok: false, url: 'https://web.archive.org/web/2/https://x.test/' };
  };
  assert.equal(await ALT.findSnapshot('https://x.test/'), null);
});

test('⚠️ 候选必须逐个验证，只有 2xx 进可采纳区', async () => {
  // 这是整个功能的安全闸门：漏了它，用户点一下就把真地址换成 404
  stubFetch({
    'good.test': { status: 200 },
    'bad.test': { status: 404 },
  });
  const r = await ALT.verifyCandidates(['https://good.test/new', 'https://bad.test/new']);
  assert.equal(r.length, 2);
  assert.equal(r[0].verified, true);
  assert.equal(r[1].verified, false);
  assert.match(r[1].note, /404/, '未验证的候选要说明为什么，否则用户只能猜');

  const alt = await ALT.findAlternatives(
    { url: 'https://dead.test/a', title: 'A' },
    { aiEnabled: false },
  );
  assert.deepEqual(alt.adoptable, [], 'AI 关掉时不该凭空冒出可采纳项');
});

test('⚠️ 跨站重定向的替代方案不得被当成可自动采纳', async () => {
  // 双重保险：verdict 层已经不让一键采纳，这里再验一次分组
  const { canAutoReplace } = await import('../../src/scan/verdict.js');
  assert.equal(canAutoReplace(VERDICT.REDIRECT_CROSS), false);
  assert.equal(canAutoReplace(VERDICT.REDIRECT_SAME), true);
});
