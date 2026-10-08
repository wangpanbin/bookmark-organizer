/**
 * 计划表的渲染契约：skipped 条目的 toPath 是 null，界面必须能画出来。
 *
 * ═══ 事故（2026-10-08）═══
 * 用户点「读取并预览」，报 `Cannot read properties of null (reading 'join')`，
 * 整张计划表渲染不出来。根因是 ui/options.js:1507 写着 `it.toPath.join(' / ')`，
 * 而 src/plan.js 对三类条目**故意**留 `toPath: null`：
 *
 *   · excluded —— chrome:// 等内部页、localhost、畸形 URL
 *   · locked   —— 人工锁定
 *   · readonly —— 移动设备书签
 *
 * 它们 status='skipped'、压根没有「要去哪」，于是 toPath 从没被赋值。
 * 任何人只要书签里有一条 chrome:// 页面（几乎必然）就一定炸，
 * 而书签一条都没动、备份也存了 —— 是**纯读**环节抛的异常。
 *
 * ⚠️ 为什么这道闸门是**静态扫描 + 形状断言**两条腿：
 *   · 形状断言（buildPlan 真跑一遍）证明「null 确实是契约的一部分」，
 *     将来谁把 excluded/locked/readonly 改成给 toPath，这半条会提醒你
 *     界面上那句「（不移动）」也就跟着过期了。
 *   · 静态扫描证明「渲染处不许再出现裸的 it.toPath.join」——
 *     真正的 bug 在 ui/options.js 里，而那个文件 import 一进来就会跑
 *     init() 并摸 chrome.*，Node 单测里**没有可用的接缝**去调它。
 *     这是本仓库早就承认的架构限制（见 reachability.test.js 的「局限」一节），
 *     所以这里选静态判据，而不是假装能单测 renderPlan()。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildPlan, setRules, REASON } from '../../src/plan.js';
import { DEFAULT_RULES } from '../../src/classify/dict.js';
import { DEFAULT_TAXONOMY, pathString } from '../../src/classify/taxonomy.js';
import { buildUrlRule } from '../../src/classify/learned.js';
import { stripComments, stripStrings } from '../helpers/sourceScan.js';

setRules(DEFAULT_RULES);

const HERE = dirname(fileURLToPath(import.meta.url));
const OPTIONS_JS = join(HERE, '..', '..', 'ui', 'options.js');

const B = (id, url, extra = {}) => ({
  id,
  type: 'url',
  url,
  title: extra.title ?? '',
  path: extra.path ?? ['书签栏'],
  readOnly: extra.readOnly ?? false,
});

/** 一份必然同时含 pending 与三类 skipped 的计划 */
function mixedPlan() {
  return buildPlan({
    entries: [
      B('1', 'https://github.com/a/b'),
      B('2', 'chrome://extensions'),
      B('3', 'http://localhost:8080/x'),
      B('4', 'not a url at all'),
      B('5', 'https://github.com/locked/repo'),
      B('6', 'https://m.example.com/p', { readOnly: true }),
    ],
    taxonomy: DEFAULT_TAXONOMY,
    locks: ['https://github.com/locked/repo'],
  });
}

// ───────────────────── 形状：null 是契约，不是意外 ─────────────────────

test('⚠️ skipped 条目的 toPath 真的是 null —— 界面因此必须容错', () => {
  const { items } = mixedPlan();
  const nullToPath = items.filter((i) => i.toPath === null);

  assert.ok(
    nullToPath.length > 0,
    '这份计划里没有 toPath 为 null 的条目。若真如此，说明 plan.js 改成给 skipped 也填目标了 —— '
    + '那么 ui/options.js 里的「（不移动）」文案已经过期，需要一起改。',
  );

  // 三类 skipped 必须都在场：少一类就说明有人动了 plan.js 的提前 return 分支。
  for (const reason of [REASON.EXCLUDED, REASON.LOCKED, REASON.READONLY]) {
    assert.ok(
      nullToPath.some((i) => i.reason === reason),
      `没有 reason=${reason} 的 toPath=null 条目。这类跳过理由的行为变了。`,
    );
  }

  // 分类过的条目（含 IN_PLACE / 未归类）必须有目标，否则界面上全是「（不移动）」。
  for (const it of items) {
    if (it.reason === REASON.EXCLUDED || it.reason === REASON.LOCKED || it.reason === REASON.READONLY) continue;
    assert.ok(
      Array.isArray(it.toPath) && it.toPath.length > 0,
      `id=${it.id} reason=${it.reason} 是要分类的条目却没有 toPath`,
    );
  }
});

// ───────────────────── 静态：渲染处不许裸 join ─────────────────────

/**
 * 裸 `.join(` 调用的属性链。
 *
 * ⚠️ 刻意**不**把 displayPath / displayToPath 列入白名单式豁免：
 *    这两个函数本身内部就有 join，豁免了它们就等于放过同名调用。
 *    判据只认「直接对可能为 null 的 plan 字段 join」这一种写法：
 *    `it.toPath.join` / `i.toPath.join` / `item.toPath.join` ……
 */
const BARE_TO_PATH_JOIN = /\b(?:it|i|item|row|entry)\.toPath\.join\s*\(/g;

test('⚠️ ui/options.js 不得裸调 it.toPath.join —— skipped 条目会把它打成 null', () => {
  const text = stripStrings(stripComments(readFileSync(OPTIONS_JS, 'utf8')));
  const bad = [...text.matchAll(BARE_TO_PATH_JOIN)];
  assert.deepEqual(
    bad.map((m) => m[0]),
    [],
    'ui/options.js 里出现了裸的 it.toPath.join(...)。skipped 条目的 toPath 是 null，'
    + '这么写会让整张计划表渲染抛错，用户看到「预览失败」。请走 displayToPath()。',
  );
});

test('⚠️ displayToPath 必须存在并容忍 null（2026-10-08 事故的修复点）', () => {
  const text = readFileSync(OPTIONS_JS, 'utf8');
  const m = text.match(/function displayToPath\(toPath\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'ui/options.js 里找不到 displayToPath —— 渲染处是不是又退回裸 join 了？');

  // 从真实源码里取函数，不复制一份假的实现来「验证」修复。
  const displayToPath = new Function(`${m[0]}\nreturn displayToPath;`)();

  assert.equal(displayToPath(null), '');
  assert.equal(displayToPath(undefined), '');
  assert.equal(displayToPath([]), '');
  assert.equal(displayToPath('其他/待归类'), '', '字符串不该被当成数组切着显示');
  // 不剥首段：toPath 不含根名，剥了会把大类名吃掉。
  assert.equal(displayToPath(['其他', '待归类']), '其他 / 待归类');
  assert.equal(displayToPath(['前端']), '前端');

  // 用真实计划跑一遍，逐条都不许抛。
  for (const it of mixedPlan().items) {
    assert.doesNotThrow(
      () => displayToPath(it.toPath) || '（不移动）',
      `id=${it.id} reason=${it.reason} 的渲染表达式抛错了`,
    );
  }
});

// ───────────────────── 同一根因的第二个缺陷 ─────────────────────

test('⚠️ toPath 为 null 的条目点「✓」不得写出 to: "" 的假规则', () => {
  const { items } = mixedPlan();
  const noTarget = items.filter((i) => !Array.isArray(i.toPath) || !i.toPath.length);
  assert.ok(noTarget.length > 0, '样本里没有无目标的条目，测不到这条');

  // 复刻 markRight 在守卫缺失时的后果：pathString(null) → '' → buildUrlRule → { to: '' }
  for (const it of noTarget) {
    const wouldBe = buildUrlRule(it.url, pathString(it.toPath));
    assert.equal(
      wouldBe.to,
      '',
      '这条正是事故的第二个表现：空目标规则会永久落进 RULES_LEARNED，'
      + '匹配时把条目送去兜底桶，看起来像「规则生效了」，实际是把噪声固化了。',
    );
  }

  // 守卫本身：markRight 必须对无目标的条目提前 return。
  const src = stripComments(readFileSync(OPTIONS_JS, 'utf8'));
  const fn = src.match(/async function markRight\(itemId\) \{[\s\S]*?\n\}/);
  assert.ok(fn, '找不到 markRight');
  assert.match(
    fn[0],
    /!Array\.isArray\(it\.toPath\)/,
    'markRight 没有挡 toPath 为 null 的条目 —— 会写出 to: "" 的假规则',
  );
});