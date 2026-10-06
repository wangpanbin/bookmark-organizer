/**
 * link-scan 纯函数层的单测。
 *
 * 这个模块里每一条断言都对应 spec 里的一条硬约束，不是「测覆盖率」：
 *   · 死链判据用「距上次成功 ≥24h」而不是「最近 3 次」—— alarms 会任意延迟
 *   · 只有 404/410 计入失败计数 —— 403/429/5xx 都不是「链接没了」
 *   · 软 404 只标不判，不进 failStreak
 *   · 跨站重定向一律不给「一键采纳」
 *   · 认不出来的站点返回 unknown，不瞎猜
 *
 * 本文件会被 01 号工单的能力闸门同时检查：这里**不能**出现 chrome.* / fetch / indexedDB。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEAD_MIN_STREAK, DEAD_MIN_SPAN_MS, isGoneStatus, shouldMarkDead, advanceFailState,
} from '../../src/scan/dead-threshold.js';
import {
  VERDICT, VERDICT_LABEL, classifyProbe, canAutoReplace, summarize,
} from '../../src/scan/verdict.js';
import { looksLikeNotFound, SOFT404_LABEL } from '../../src/scan/soft404.js';
import { extractMeta, decodeEntities } from '../../src/scan/extract-meta.js';
import { classifySite, KIND, providersOf } from '../../src/scan/classify-site.js';

const H = 60 * 60 * 1000;
const T0 = 1_800_000_000_000;

// ═══════════ 死链阈值 ═══════════

test('只有 404 与 410 算「资源没了」', () => {
  assert.equal(isGoneStatus(404), true);
  assert.equal(isGoneStatus(410), true);
  // 这几个都是「现在不行」而不是「没了」——算进去就是一次网络抖动毁掉一批书签
  for (const s of [200, 301, 302, 400, 401, 403, 429, 500, 502, 503, 0, -1]) {
    assert.equal(isGoneStatus(s), false, `状态码 ${s} 被当成了死链`);
  }
});

test('⚠️ 3 次 404 但间隔不足 24h → 不得判死', () => {
  // alarms 官方写明 may delay arbitrarily，所以 3 次可以挤在 6 小时内
  assert.equal(shouldMarkDead({ failStreak: 3, lastOkAt: T0, now: T0 + 6 * H }), false);
});

test('3 次 404 且跨 24h → 判死', () => {
  assert.equal(shouldMarkDead({ failStreak: 3, lastOkAt: T0, now: T0 + 25 * H }), true);
});

test('⚠️ 从没成功探测过 → 不得判死', () => {
  // lastOkAt=0 表示「从来没成功过」，那不叫「已经死了」，叫「还没探明白」
  for (const lastOkAt of [0, undefined, NaN, -1]) {
    assert.equal(shouldMarkDead({ failStreak: 99, lastOkAt, now: T0 }), false,
      `lastOkAt=${lastOkAt} 时被判死了`);
  }
});

test('次数与跨度都要够，只满足一条不判死', () => {
  assert.equal(shouldMarkDead({ failStreak: 2, lastOkAt: T0, now: T0 + 99 * H }), false, '次数不够');
  assert.equal(shouldMarkDead({ failStreak: 99, lastOkAt: T0, now: T0 }), false, '跨度不够');
  assert.equal(DEAD_MIN_STREAK, 3);
  assert.equal(DEAD_MIN_SPAN_MS, 24 * H);
});

test('⚠️ 403/429/5xx 永不进 failStreak', () => {
  let st = { failStreak: 0, firstFailAt: 0 };
  for (const status of [403, 429, 500, 502, 503]) {
    const next = advanceFailState(st, { status, now: T0 });
    assert.equal(next.failStreak, 0, `状态码 ${status} 让 failStreak 涨了`);
  }
});

test('⚠️ 5xx 既不增长也不清零已有计数', () => {
  const st = { failStreak: 2, firstFailAt: T0 };
  const next = advanceFailState(st, { status: 503, now: T0 + H });
  assert.equal(next.failStreak, 2, '一次 500 把之前攒的失败抹了 —— 一次抖动毁掉两次真信号');
  assert.equal(next.firstFailAt, T0, 'firstFailAt 被冲掉了，跨 24h 的起点就丢了');
});

test('404 让计数增长，并保留首次失败时间', () => {
  const a = advanceFailState({ failStreak: 0, firstFailAt: 0 }, { status: 404, now: T0 });
  assert.deepEqual(a, { failStreak: 1, firstFailAt: T0 });
  const b = advanceFailState(a, { status: 410, now: T0 + 2 * H });
  assert.equal(b.failStreak, 2);
  assert.equal(b.firstFailAt, T0, '首次失败时间必须保留，它是跨 24h 判据的起点');
});

test('一次成功把计数与起点一起清掉', () => {
  const next = advanceFailState({ failStreak: 2, firstFailAt: T0 }, { ok: true, now: T0 + 5 * H });
  assert.deepEqual(next, { failStreak: 0, firstFailAt: 0 });
});

// ═══════════ verdict ═══════════

test('verdict：重定向优先于死链与软 404', () => {
  // 一个 URL 完全可能「跳了 + 落地页还是 404 + 落地页写着页面不存在」，
  // 而「它搬到哪去了」才是你要的答案
  const rec = {
    checkedAt: T0, status: 404, redirected: true, sameSite: true,
    failStreak: 99, lastOkAt: T0 - 100 * H, soft404: true,
  };
  assert.equal(classifyProbe(rec, { now: T0, shouldMarkDead }), VERDICT.REDIRECT_SAME);
  assert.equal(classifyProbe({ ...rec, sameSite: false }, { now: T0, shouldMarkDead }), VERDICT.REDIRECT_CROSS);
});

test('verdict：未探测 / 正常 / 可疑 / 死链 / 网络错误', () => {
  assert.equal(classifyProbe({ checkedAt: 0 }), VERDICT.UNCHECKED);
  assert.equal(classifyProbe(null), VERDICT.UNCHECKED);
  assert.equal(classifyProbe({ checkedAt: T0, status: 200 }), VERDICT.OK);
  assert.equal(classifyProbe({ checkedAt: T0, status: 404, failStreak: 1, lastOkAt: T0 }, { now: T0, shouldMarkDead }), VERDICT.SUSPECT);
  assert.equal(classifyProbe({ checkedAt: T0, status: 404, failStreak: 3, lastOkAt: T0 - 30 * H }, { now: T0, shouldMarkDead }), VERDICT.DEAD);
  assert.equal(classifyProbe({ checkedAt: T0, status: 0, error: 'timeout' }), VERDICT.NET_ERROR);
});

test('⚠️ 网络错误不会被当成死链，哪怕 status 是 0', () => {
  const v = classifyProbe({ checkedAt: T0, status: 0, error: 'net::ERR_TIMED_OUT' }, { now: T0, shouldMarkDead });
  assert.equal(v, VERDICT.NET_ERROR);
  assert.notEqual(v, VERDICT.DEAD);
});

test('⚠️ 只有同站重定向可一键采纳，跨站一律不行', () => {
  // D7 拍板的安全边界：跨站可能是品牌改名，也可能是跳登录页，
  // 这两类从 URL 上完全无法区分。盲信会毁掉用户真收藏的地址。
  assert.equal(canAutoReplace(VERDICT.REDIRECT_SAME), true);
  for (const v of [VERDICT.REDIRECT_CROSS, VERDICT.DEAD, VERDICT.SUSPECT, VERDICT.SOFT404, VERDICT.OK, VERDICT.NET_ERROR]) {
    assert.equal(canAutoReplace(v), false, `${v} 不该允许一键采纳`);
  }
});

test('每个 verdict 都有面板文案', () => {
  for (const v of Object.values(VERDICT)) {
    assert.equal(typeof VERDICT_LABEL[v], 'string', `${v} 没有文案，面板会渲染成空白`);
  }
  // ⚠️ 判据是「文案**披露了**这件事」，不是逐字匹配某个词。
  //    原来写死 `/启发式/`，于是把标签改写成同样诚实的「仅供参考、未必准」
  //    就会红 —— 红灯是真的，与被测性质（有没有披露不确定性）无关。
  //    同一条要求早先还在 scan-runner.test.js 里重复了一份，已删；
  //    这里是唯一的家。
  assert.match(
    VERDICT_LABEL[VERDICT.SOFT404],
    /启发式|推测|仅供参考|未必|不一定/,
    `软 404 的文案必须披露这是启发式判断（AGENTS.md 第 4 条）：${VERDICT_LABEL[VERDICT.SOFT404]}`,
  );
  // 跨站跳转同理：必须让用户知道这要他自己判断，而不是扩展能决定
  assert.match(
    VERDICT_LABEL[VERDICT.REDIRECT_CROSS],
    /人工|自己|你|判断/,
    `跨站跳转的文案必须说明要人工判断：${VERDICT_LABEL[VERDICT.REDIRECT_CROSS]}`,
  );
});

test('summarize 统计总数与「需要你动手」的条数', () => {
  const s = summarize([
    { verdict: VERDICT.OK }, { verdict: VERDICT.OK },
    { verdict: VERDICT.DEAD }, { verdict: VERDICT.REDIRECT_SAME }, { verdict: VERDICT.REDIRECT_CROSS },
    { verdict: VERDICT.UNCHECKED },
  ]);
  assert.equal(s.total, 6);
  assert.equal(s.byVerdict[VERDICT.OK], 2);
  assert.equal(s.byVerdict[VERDICT.UNCHECKED], 1);
  assert.equal(s.actionable, 3, '死链 + 同站改址 + 跨站 都要人看');
  assert.deepEqual(summarize([]).byVerdict[VERDICT.OK], 0);
});

// ═══════════ 软 404 ═══════════

test('软 404：常见的中英文特征串能命中', () => {
  assert.equal(looksLikeNotFound('<html><head><title>404 Not Found</title></head></html>'), true);
  assert.equal(looksLikeNotFound('<title>页面不存在</title>'), true);
  assert.equal(looksLikeNotFound('<title>该内容已被移除</title>'), true);
  assert.equal(looksLikeNotFound('<html><body><h1>404</h1>Page not found</body></html>'), true);
  assert.equal(looksLikeNotFound('<title>正常的一篇文章</title><p>内容</p>'), false);
  assert.equal(looksLikeNotFound(''), false);
  assert.equal(looksLikeNotFound(null), false);
});

test('⚠️ 软 404 只在很靠前的位置命中 —— 深处提到不算', () => {
  // 一篇讲「HTTP 404 怎么排查」的文章，正文深处满是这些词。
  // 它必须被判成「不是软 404」，否则启发式就会去动用户的正常书签。
  const article = `<html><head><title>HTTP 404 排查指南</title></head><body>`
    + '<p>正文开始</p>'.repeat(120)
    + '<p>这里说到 page not found 与页面不存在 的区别，以及 404 page not found 的成因。</p>'
    + '</body></html>';
  assert.equal(looksLikeNotFound(article), false, '一篇讲 404 的正常文章被误判成软 404');
});

test('⚠️ 软 404 不得影响 failStreak', () => {
  const st = { failStreak: 0, firstFailAt: 0 };
  const next = advanceFailState(st, { status: 200, now: T0 });
  assert.equal(next.failStreak, 0);
  // 软 404 是 200，advanceFailState 本来就不该碰它 —— 这条断言钉住「只标不判」
  assert.equal(SOFT404_LABEL.includes('启发式'), true, '面板上必须写明这是启发式判断');
});

// ═══════════ 元数据抽取 ═══════════

test('extractMeta 取 og: 优先于普通 meta', () => {
  const html = `<html><head>
    <title>HTML 标题</title>
    <meta property="og:title" content="OG 标题">
    <meta name="description" content="普通描述">
    <meta property="og:description" content="OG 描述">
    <meta property="og:site_name" content="某站点">
    <meta property="og:type" content="article">
  </head></html>`;
  const m = extractMeta(html, 'https://a.example/p/1');
  assert.equal(m.pageTitle, 'OG 标题');
  assert.equal(m.description, 'OG 描述');
  assert.equal(m.siteName, '某站点');
  assert.equal(m.ogType, 'article');
});

test('extractMeta 没有 og: 时回落到 title 与普通 meta', () => {
  const m = extractMeta('<title>只有标题</title><meta name="description" content="只有描述">', 'https://a.example/');
  assert.equal(m.pageTitle, '只有标题');
  assert.equal(m.description, '只有描述');
});

test('og:image 的相对路径按 baseUrl 解析成绝对', () => {
  const m = extractMeta('<meta property="og:image" content="/img/a.png">', 'https://a.example/p/1');
  assert.equal(m.ogImage, 'https://a.example/img/a.png');
  const abs = extractMeta('<meta property="og:image" content="https://cdn.example/b.png">', 'https://a.example/');
  assert.equal(abs.ogImage, 'https://cdn.example/b.png');
});

test('发布时间能从 article:published_time 与 <time datetime> 两种写法取到', () => {
  assert.equal(
    extractMeta('<meta property="article:published_time" content="2026-10-06T10:00:00Z">', '').publishedAt,
    '2026-10-06T10:00:00Z',
  );
  assert.equal(
    extractMeta('<time datetime="2026-10-06">10月6日</time>', '').publishedAt,
    '2026-10-06',
  );
});

test('作者能从多个 meta 变体里取到', () => {
  assert.equal(extractMeta('<meta name="author" content="张三">', '').author, '张三');
  assert.equal(extractMeta('<meta property="article:author" content="李四">', '').author, '李四');
});

test('缺字段返回空串而不是 undefined —— 面板直接渲染，不做存在性判断', () => {
  const m = extractMeta('<html><body>什么都没有</body></html>', 'https://a.example/');
  for (const k of ['pageTitle', 'description', 'siteName', 'ogImage', 'author', 'publishedAt', 'ogType', 'canonical']) {
    assert.equal(m[k], '', `${k} 是 ${JSON.stringify(m[k])} 而不是空串`);
  }
  assert.doesNotThrow(() => extractMeta(null, null));
  assert.doesNotThrow(() => extractMeta('<html>', '不是 URL'));
});

test('属性顺序打乱也要能取到', () => {
  const m = extractMeta(`<meta content="倒序" property="og:title">`, '');
  assert.equal(m.pageTitle, '倒序');
});

test('decodeEntities 处理常见实体', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#65;'), 'a & b <c> "d" A');
});

// ═══════════ 站点类型 ═══════════

test('classifySite 认出各家主力站点', () => {
  const cases = [
    ['github.com', '/foo/bar', { kind: KIND.CODE, provider: 'github' }],
    ['youtu.be', '/abc', { kind: KIND.VIDEO, provider: 'youtube' }],
    ['www.youtube.com', '/watch?v=x', { kind: KIND.VIDEO, provider: 'youtube' }],
    ['arxiv.org', '/abs/2401.00001', { kind: KIND.PAPER, provider: 'arxiv' }],
    ['项目.readthedocs.io', '/zh/latest/', { kind: KIND.DOC, provider: 'readthedocs' }],
  ];
  for (const [host, path, want] of cases) {
    const got = classifySite(host, path);
    assert.equal(got.kind, want.kind, `${host}${path} 的 kind`);
    assert.equal(got.provider, want.provider, `${host}${path} 的 provider`);
    assert.equal(got.confidence, 'rule');
  }
});

test('⚠️ host 后缀按点边界匹配 —— notgithub.com 不能命中 github.com', () => {
  assert.equal(classifySite('notgithub.com', '/a/b').kind, KIND.WEB);
  assert.equal(classifySite('notarxiv.org', '/abs/1').provider, null);
  assert.equal(classifySite('mygithub.com', '/x').kind, KIND.WEB);
});

test('classifySite 看 og:type', () => {
  assert.equal(classifySite('news.example', '/', { ogType: 'article' }).kind, KIND.NEWS);
  assert.equal(classifySite('v.example', '/', { ogType: 'video.other' }).kind, KIND.VIDEO);
  assert.equal(classifySite('b.example', '/', { ogType: 'book' }).kind, KIND.PAPER);
});

test('⚠️ 认不出来的站点返回 unknown，**不瞎猜**', () => {
  // 一个看起来很确定的错答案，比一个诚实的「未识别」有害得多：
  // 用户会以为扩展在胡说，而诚实的 unknown 没人会怪
  const got = classifySite('some-random-blog.example', '/post/1', {});
  assert.equal(got.kind, KIND.WEB);
  assert.equal(got.confidence, 'unknown');
  assert.equal(got.provider, null);
});

test('providersOf 去重且排序', () => {
  assert.deepEqual(providersOf([{ provider: 'github' }, { provider: null }, { provider: 'arxiv' }, { provider: 'github' }]),
    ['arxiv', 'github']);
  assert.deepEqual(providersOf([]), []);
});
