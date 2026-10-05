/**
 * 字典自检：防止人工维护出错。
 * 这道闸门是自动的 —— 上一次手写字典就漏了 17 个非法域名和 55 处重复归属。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_RULES } from '../../src/classify/dict.js';
import { DEFAULT_TAXONOMY, allPaths } from '../../src/classify/taxonomy.js';

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

test('每个 to 都是类目树里的合法路径', () => {
  const paths = new Set(allPaths(DEFAULT_TAXONOMY));
  const bad = DEFAULT_RULES.filter((r) => !paths.has(r.to)).map((r) => r.to);
  assert.deepEqual(bad, [], '存在指向非法类目的规则');
});

test('domains 里每一项都必须是合法主机名', () => {
  const bad = [];
  for (const r of DEFAULT_RULES) {
    for (const d of r.domains || []) {
      if (typeof d !== 'string' || !HOST_RE.test(d.toLowerCase())) bad.push({ d, to: r.to });
    }
  }
  assert.deepEqual(bad, [], 'domains 里混进了路径、中文或非域名字符串');
});

test('一个域名只能被一条规则声明', () => {
  const owner = new Map();
  const dups = [];
  for (const r of DEFAULT_RULES) {
    for (const d of r.domains || []) {
      const k = d.toLowerCase();
      if (owner.has(k)) dups.push({ domain: k, a: owner.get(k), b: r.to });
      else owner.set(k, r.to);
    }
  }
  assert.deepEqual(
    dups,
    [],
    '重复归属的后一条是死条目（首个命中即返回），且极易悄悄归错类',
  );
});

test('中文品牌名不得出现在 domains', () => {
  const bad = [];
  for (const r of DEFAULT_RULES) {
    for (const d of r.domains || []) {
      if (/[^\x00-\x7F]/.test(d)) bad.push({ d, to: r.to });
    }
  }
  assert.deepEqual(bad, [], '中文站名属于 titleWords，不是域名');
});

test('每条规则至少有一个可匹配特征', () => {
  const empty = DEFAULT_RULES.filter(
    (r) =>
      (r.domains || []).length === 0 &&
      (r.domainSuffixes || []).length === 0 &&
      (r.pathWords || []).length === 0 &&
      (r.titleWords || []).length === 0,
  );
  assert.deepEqual(empty.map((r) => r.to), [], '存在永远匹配不到任何东西的规则');
});

test('⚠️ pathWords 每一项都必须以 / 开头', () => {
  // 这条是给「位置参数错位」上的锁：一旦 pathWords 里混进域名或中文，
  // 现象只是「部分标题匹配不到」，很容易误判成规则写得不好而查错方向。
  const bad = [];
  for (const r of DEFAULT_RULES) {
    for (const w of r.pathWords || []) {
      if (typeof w !== 'string' || !w.startsWith('/')) bad.push({ w, to: r.to });
    }
  }
  assert.deepEqual(bad, [], 'pathWords 里混进了非路径字符串 —— 位置参数可能错位了');
});

test('⚠️ domainSuffixes 每一项都必须是合法主机名', () => {
  const bad = [];
  for (const r of DEFAULT_RULES) {
    for (const s of r.domainSuffixes || []) {
      if (typeof s !== 'string' || !HOST_RE.test(s.toLowerCase())) bad.push({ s, to: r.to });
    }
  }
  assert.deepEqual(bad, [], 'domainSuffixes 里混进了非主机名 —— 位置参数可能错位了');
});

test('⚠️ titleWords 里不应出现路径或主机名', () => {
  const bad = [];
  for (const r of DEFAULT_RULES) {
    for (const w of r.titleWords || []) {
      if (typeof w !== 'string' || w.startsWith('/') || HOST_RE.test(w.toLowerCase())) {
        bad.push({ w, to: r.to });
      }
    }
  }
  assert.deepEqual(bad, [], 'titleWords 里混进了路径或域名 —— 位置参数可能错位了');
});

test('⚠️ titleWords 必须真的落到 titleWords 上（防止整体错位到 pathWords）', () => {
  const withTitle = DEFAULT_RULES.filter((r) => (r.titleWords || []).length > 0);
  assert.ok(
    withTitle.length >= 20,
    `只有 ${withTitle.length} 条规则带 titleWords，词典的标题匹配基本失效了`,
  );
  const withPath = DEFAULT_RULES.filter((r) => (r.pathWords || []).length > 0);
  assert.ok(withPath.length >= 4, `只有 ${withPath.length} 条规则带 pathWords`);
  const withSuffix = DEFAULT_RULES.filter((r) => (r.domainSuffixes || []).length > 0);
  assert.ok(withSuffix.length >= 2, `只有 ${withSuffix.length} 条规则带 domainSuffixes`);
});

// ── 曾经想加但【已否决】的断言 ──
// 「同一主域的子域不得散落在不同规则里」（按最后两段标签归并去重）
// 看着合理，实际是坏闸门：它把 github.io / dair-ai.github.io（共享托管平台）、
// google.com / gemini.google.com（同一公司的不同服务）、
// readthedocs.io / jax.readthedocs.io 一律判成冲突。
// 要让它变绿就只能把所有 *.google.com 塞进同一个类目 —— 那是错误设计。
// 判据：闸门必须能区分真实缺陷与合法设计，分不清的闸门一律删掉，不许为了变绿去掰设计。
// 真正的重复归属由上面「一个域名只能被一条规则声明」按精确字符串守住；
// 子域归属是否合理由 tests/unit/rules.test.js 的 expect 样本集按业务语义守住。

test('覆盖规模不低于 700 个域名（防误删整块内容）', () => {
  let n = 0;
  for (const r of DEFAULT_RULES) n += (r.domains || []).length;
  assert.ok(n >= 700, `只有 ${n} 个域名，词典可能被误清空`);
});
