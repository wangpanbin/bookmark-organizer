/**
 * 执行侧范围校验的回归闸门（F4）。
 *
 * ═══ 这道闸门守的是什么 ═══
 * 「只整理我勾选的书签，清单之外一条都不动」是这个功能存在的**全部理由**。
 * 面板侧已经用清单裁过一遍计划，但那只保证了「正常情况下计划 ⊆ 清单」。
 *
 * 真正要守住的是不正常的那条路：计划载荷与清单之间隔着好几层
 * —— storage 里的残留计划、面板的旧内存状态、中途被别的预览覆盖、
 * service worker 被回收后续跑。这些情况下若执行器只信载荷，
 * 它会**静默搬动用户没勾的书签**，而且报告上显示 100% 成功。
 * 用户从界面上完全看不出来。
 *
 * 所以校验被拆成一个纯函数单独测：它必须是「默认拦住、显式放行」的，
 * 而不是「默认放行、看起来在拦」。
 *
 * ⚠️ 这道闸门只测纯函数那一层。真正的落点是 run() 里 move() 之前的
 *    那个分支，由 tests/e2e/scope-run.js 的两组对照夹具在真浏览器里验。
 *    只测纯函数的实现可以写成恒真，而这道闸门**抓不到**恒真 ——
 *    所以 E2E 那两组对照是必须的，不是可选的加强。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isInScope } from '../../src/apply.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ───────────────── 语义：null 与 [] 是两件事 ─────────────────

test('⚠️ null = 全量运行，一条都不限制（整理前的语义必须原样保留）', () => {
  const allowed = null;
  for (const id of ['1', '2', '999999', '', '任意东西']) {
    assert.ok(isInScope(allowed, id), `全量运行时不该拦任何 id（${id} 被拦了）`);
  }
});

test('⚠️ 空数组 = 子集运行而清单是空的：什么都得拦住', () => {
  // 这条最容易写错。把 `!allowed.length` 当成「没限制」的话，
  // 清单空着就变成了「整棵树随便动」—— 与这个功能的承诺正好相反。
  const allowed = new Set([]);
  assert.equal(isInScope(allowed, '1'), false);
  assert.equal(isInScope(allowed, '999999'), false);
});

test('清单里的放行，清单外的拦住', () => {
  const allowed = new Set(['101', '102']);
  assert.equal(isInScope(allowed, '101'), true);
  assert.equal(isInScope(allowed, '102'), true);
  assert.equal(isInScope(allowed, '201'), false);
  assert.equal(isInScope(allowed, '999999'), false);
});

test('id 一律按字符串比较', () => {
  // plan 里的 id 是字符串，Set 里也是字符串，但两边来源不同。
  // 用 === 比数字会静默失配 —— 表现为「清单里有它，却说不在清单里」。
  const allowed = new Set(['101']);
  assert.equal(isInScope(allowed, 101), true);
});

// ───────────────── 落点：校验必须真的在 move 之前 ─────────────────

test('⚠️ run() 里校验必须排在 chrome.bookmarks.move 之前', () => {
  const src = readFileSync(join(REPO, 'src', 'apply.js'), 'utf8');
  const guardAt = src.indexOf('isInScope(allowed, next.id)');
  const moveAt = src.indexOf('await chrome.bookmarks.move(next.id');

  assert.ok(guardAt > 0, '执行循环里找不到范围校验 —— 这一步是不是被删掉了');
  assert.ok(moveAt > 0, '执行循环里找不到 move 调用');
  assert.ok(guardAt < moveAt,
    '范围校验排在 move **之后**。那样它拦不住任何东西，只是事后记账。');
});

test('⚠️ scopeIds 必须落进 task，否则 worker 被回收后续跑就没有范围限制了', () => {
  const src = readFileSync(join(REPO, 'src', 'apply.js'), 'utf8');
  const taskBlock = src.slice(src.indexOf('const task = {'), src.indexOf('await set(K.TASK_CURRENT, task)'));
  assert.ok(/scopeIds\s*,/.test(taskBlock),
    'task 里没有 scopeIds。MV3 service worker 空闲 30 秒即被回收，'
    + 'resumeExecution 是新进程从 storage 读回这个 task 的，'
    + '只把它留在内存里等于续跑时完全没有范围校验，而界面上看不出区别。');
});

test('⚠️ 范围只能来自载荷，不许执行器自己去读清单', () => {
  const src = readFileSync(join(REPO, 'src', 'apply.js'), 'utf8');
  // 执行器读清单会与面板的写操作抢同一个键，还要额外加锁才能保证一致。
  // 设计上刻意让它只认启动时那份快照：用户执行期间改清单，不影响正在跑的任务。
  const runBody = src.slice(src.indexOf('async function run()'));
  assert.ok(!/getScopeList|K\.SCOPE_LIST/.test(runBody),
    '执行器去读清单了。范围必须只来自启动时的载荷快照，'
    + '否则用户执行期间改清单就会与执行器抢同一个键。');
});

test('⚠️ 子集运行的删除清单恒为空 —— 唯一的护栏在面板侧，这里守住它不被改回去', () => {
  const js = readFileSync(join(REPO, 'ui', 'options.js'), 'utf8');
  assert.ok(/state\.dupPayload\s*=\s*scoped\s*\?\s*\[\]\s*:/.test(js),
    '面板里那句「手动模式删除清单恒为空」不见了。'
    + '去重清单是从整棵树独立算出来的，不挡这一下就是：勾 5 条、删掉全树的重复项。');
});