/**
 * URL 归一化与去重键的单测。
 * 这里的每一条都是「误删会出事」的高危路径，务必覆盖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeUrl,
  dedupeKey,
  isExcludedUrl,
  hostOf,
  pathQueryOf,
  parseUrl,
} from '../../src/normalize.js';

test('parseUrl：畸形输入返回 null 而不是抛异常', () => {
  assert.equal(parseUrl('not a url'), null);
  assert.equal(parseUrl(''), null);
  assert.equal(parseUrl(null), null);
  assert.equal(parseUrl(undefined), null);
  assert.ok(parseUrl('https://a.com') instanceof URL);
});

test('归一化：去 www.、统一小写、去末尾斜杠', () => {
  assert.equal(normalizeUrl('https://WWW.Example.COM/'), 'https://example.com/');
  assert.equal(normalizeUrl('https://Example.com/docs/'), 'https://example.com/docs');
  // 根路径的斜杠必须保留
  assert.equal(normalizeUrl('https://example.com/'), 'https://example.com/');
  // path 大小写敏感，不得 lower
  assert.equal(normalizeUrl('https://example.com/AbC'), 'https://example.com/AbC');
});

test('⚠️ SPA hash 路由必须保留，不能判成重复', () => {
  const a = normalizeUrl('https://example.com/#/settings');
  const b = normalizeUrl('https://example.com/#/profile');
  assert.notEqual(a, b, '两个不同路由被归一成了同一条 —— 会误删用户收藏的页面');
  assert.equal(a, 'https://example.com/#/settings');
  assert.equal(b, 'https://example.com/#/profile');

  // 无锚点 vs 路由，也必须不同
  assert.notEqual(
    normalizeUrl('https://example.com/dashboard'),
    normalizeUrl('https://example.com/#/dashboard'),
  );
});

test('只有「纯顶部锚点」才剥 hash', () => {
  // 这四个语义都是「跳到页面顶部」，合并它们一定正确
  assert.equal(normalizeUrl('https://example.com/a#top'), 'https://example.com/a');
  assert.equal(normalizeUrl('https://example.com/a#_'), 'https://example.com/a');
  assert.equal(normalizeUrl('https://example.com/a#!'), 'https://example.com/a');
  assert.equal(normalizeUrl('https://example.com/a#'), 'https://example.com/a');

  // 其它任何 hash 都保留 —— 宁可漏判重复也绝不误删
  for (const h of ['#section-2', '#content', '#main', '#p1', '#foo']) {
    assert.equal(
      normalizeUrl(`https://example.com/a${h}`),
      `https://example.com/a${h}`,
      `${h} 不该被剥`,
    );
  }
});

test('跟踪参数被剥，业务参数必须保留', () => {
  assert.equal(
    normalizeUrl('https://example.com/p?utm_source=wx&id=7'),
    'https://example.com/p?id=7',
  );
  assert.equal(
    normalizeUrl('https://example.com/p?from=timeline&spm=a1'),
    'https://example.com/p',
  );
  assert.equal(
    normalizeUrl('https://example.com/p?share_token=xyz&page=2'),
    'https://example.com/p?page=2',
  );

  // id 不同就是不同资源，绝不能合并
  assert.notEqual(
    normalizeUrl('https://example.com/p?id=1'),
    normalizeUrl('https://example.com/p?id=2'),
  );
  // src/source 是真实业务参数，不在跟踪白名单
  assert.equal(
    normalizeUrl('https://example.com/p?src=image01'),
    'https://example.com/p?src=image01',
  );
});

test('query 参数顺序不同视为同一条', () => {
  assert.equal(
    normalizeUrl('https://example.com/p?a=1&b=2'),
    normalizeUrl('https://example.com/p?b=2&a=1'),
  );
});

test('query 值里的 & 和 = 不会破坏去重键', () => {
  const k = dedupeKey('https://example.com/s?q=a&b=c');
  assert.equal(typeof k, 'string');
  assert.ok(!k.includes('&b=c'), '值里的 & 把键结构搞坏了');
});

test('去重键：http 与 https 视为同一资源', () => {
  assert.equal(
    dedupeKey('http://example.com/a'),
    dedupeKey('https://example.com/a'),
  );
});

test('排除浏览器内部页与本机地址', () => {
  for (const u of [
    'chrome://extensions',
    'chrome://bookmarks',
    'edge://favorites',
    'chrome-extension://abcdef/popup.html',
    'about:blank',
    'file:///C:/Users/me/notes.html',
    'http://localhost:3000/app',
    'http://127.0.0.1:8080/',
    'http://my-printer.local/',
    'garbage',
    '',
  ]) {
    assert.equal(isExcludedUrl(u), true, `${u} 应被排除`);
  }
  assert.equal(isExcludedUrl('https://example.com/'), false);
  assert.equal(isExcludedUrl('http://192.168.1.10/'), false, '局域网 IP 不是本机回环');
});

test('hostOf 去 www. 且小写', () => {
  assert.equal(hostOf('https://WWW.GitHub.com/a/b'), 'github.com');
  assert.equal(hostOf('nonsense'), '');
});

test('pathQueryOf 不含主机与 hash', () => {
  assert.equal(pathQueryOf('https://Example.com/A/b?x=1#frag'), '/a/b?x=1');
  assert.equal(pathQueryOf('nonsense'), '');
});
