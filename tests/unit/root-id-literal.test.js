/**
 * 闸门：根 id 绝不许被当成常量写死。
 *
 * ═══ 这道闸门为什么存在 ═══
 * 2026-10-05，45 条书签整理全军覆没，45 条报同一句 `Can't find bookmark for id.`。
 * 根因不是「目标根选错了」，而是代码把「书签栏 = id '1'」当成**固定契约**。
 * 而根 id 根本不是常量：本机 Chrome 154 的账号书签模型实测是
 *   书签栏=279 / 其他书签=280 / 移动设备=281
 *
 * ⚠️⚠️ **同一条根因已经犯过两次，且两次的藏身处不同**：
 *   第一次在 `storage.js` 的 targetRoot 默认值、`options.html` 的 option value、
 *   `apply.js` 的兜底 —— 那三处由 `target-root.test.js` 的闸门守着。
 *   第二次在 `src/backup.js`：它压根没读设置，自己定义了
 *   `ROOT_ID = { BAR:'1', OTHER:'2', MOBILE:'3' }`，注释还写着
 *   「根 id 是固定契约，只有标题随语言变」。
 *   **第一道闸门对此全绿** —— 它量的是一个没有覆盖到出问题那条路径的指标。
 *
 *   而 backup.js 那处的症状比 targetRoot 更隐蔽：`ROOT_ID.OTHER` 那条 move
 *   必然打到不存在的 id，chrome.bookmarks.move 抛错被 restoreSnapshot 的 catch
 *   收进 failures —— **不报错、清单上也看不出来**，只是「恢复完快照，
 *   新出现的那几条书签不知道去哪了」。
 *
 * 判据两侧都必须有（docs/testing.md）：
 *   「必须抓到」防止闸门变成摆设
 *   「不得误报」防止闸门被人学会忽略 —— 尤其要放过 roots.js 里那段
 *   **刻意的**旧设置迁移映射（读用户存的 '1'，不是写死一个 id 给 API 用）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findHardcodedRootIds } from '../helpers/sourceScan.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ───────────────── 扫描器自身：必须抓得住 ─────────────────

test('抓得住 backup.js 那处：ROOT_ID 常量', () => {
  const bad = findHardcodedRootIds([
    { rel: 'src/backup.js', text: "const ROOT_ID = Object.freeze({ BAR: '1', OTHER: '2' });\n" },
  ]);
  assert.equal(bad.length, 1);
  assert.match(bad[0], /ROOT_ID/);
});

test('抓得住 backup.js 那处：parentId 写死成根 id', () => {
  const bad = findHardcodedRootIds([
    { rel: 'src/backup.js', text: "await chrome.bookmarks.move(e.id, { parentId: '2' });\n" },
  ]);
  assert.equal(bad.length, 1);
  assert.match(bad[0], /parentId/);
  assert.match(bad[0], /'2'/);
});

test('抓得住 ui/options.js 那处：路径退化成 [\'2\']', () => {
  const bad = findHardcodedRootIds([
    { rel: 'ui/options.js', text: "path: src?.path || ['2'],\n" },
  ]);
  assert.equal(bad.length, 1);
  assert.match(bad[0], /options\.js/);
});

test('报错里带行号，方便直接跳过去改', () => {
  const bad = findHardcodedRootIds([
    { rel: 'src/backup.js', text: 'line1\nline2\nconst ROOT_ID = 1;\n' },
  ]);
  assert.match(bad[0], /第 3 行/);
});

// ───────────────── 扫描器自身：不得误报 ─────────────────

test('⚠️ 放过 roots.js 的旧设置迁移映射（读用户存的 1/2，不是写死 id 给 API）', () => {
  // 这段是**正确**的：旧版本把 targetRoot 存成了 '1'，这里翻译成语义键。
  // 它必须过 pickRootKey 再解析，绝不能被当成「写死根 id」。
  const src = "  if (v === '1') return ROOT_BAR;\n  if (v === '2') return ROOT_OTHER;\n";
  assert.deepEqual(findHardcodedRootIds([{ rel: 'src/roots.js', text: src }]), [],
    '迁移映射被误伤了 —— 闸门第一次跑就会对正确的代码报红');
});

test('放过按位置解析出来的变量', () => {
  const src = [
    "const otherId = rootIdByKeyFromTops(tops, ROOT_OTHER);",
    "await chrome.bookmarks.move(e.id, { parentId: otherId });",
    "await chrome.bookmarks.move(e.id, { parentId: String(parentId) });",
  ].join('\n');
  assert.deepEqual(findHardcodedRootIds([{ rel: 'src/backup.js', text: src }]), []);
});

test('放过注释里引用的旧坏代码（闸门会对着注释报红是典型误报）', () => {
  const src = [
    "// 早先这里是 ROOT_ID.OTHER，而那是个硬编码字面量 '2'",
    "// 早先这里是 ensurePath(d.path || ['2'], tops)",
    "const otherId = rootIdByKeyFromTops(tops, ROOT_OTHER);",
  ].join('\n');
  assert.deepEqual(findHardcodedRootIds([{ rel: 'src/backup.js', text: src }]), []);
});

test('放过正常的数字下标与数组下标（它们不是根 id）', () => {
  const src = [
    "const hit = tops[1];",
    "const acc = pathArr.slice(1);",
    "const n = Number(item.count) + 1;",
  ].join('\n');
  assert.deepEqual(findHardcodedRootIds([{ rel: 'src/x.js', text: src }]), []);
});

test('容忍空输入', () => {
  assert.deepEqual(findHardcodedRootIds([]), []);
  assert.deepEqual(findHardcodedRootIds(null), []);
});

// ───────────────── 真实仓库 ─────────────────

/** 递归列出业务源码（排除 vendor 产物与测试数据本身） */
function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) {
      if (name === 'vendor' || name === 'node_modules') continue;
      collect(abs, out);
      continue;
    }
    if (!/\.(js|mjs)$/.test(name)) continue;
    out.push({ rel: relative(ROOT, abs).split('\\').join('/'), text: readFileSync(abs, 'utf8') });
  }
  return out;
}

test('⚠️ 真实 src/ 与 ui/ 里没有把根 id 写成常量', () => {
  const sources = [...collect(join(ROOT, 'src')), ...collect(join(ROOT, 'ui'))];
  assert.ok(sources.length >= 40, `扫到的文件太少（${sources.length}），路径可能变了`);
  assert.deepEqual(
    findHardcodedRootIds(sources),
    [],
    '根 id 必须由 src/roots.js 按位置运行时解析。'
    + '写死的后果是「移动到不存在的 id」而 Chrome 只回一句零信息量的报错，'
    + '备份恢复那几处更糟：throw 被 catch 吞掉，用户什么都看不出来。',
  );
});