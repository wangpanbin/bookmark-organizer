/**
 * 闸门：`tools/inject_key.py` 写入的路径，必须是 `llm.js` 真的能读到的路径。
 *
 * ═══ 这道闸门为什么存在 ═══
 * 踩过的坑：注入脚本把 key 写到 `src/llm-key.local.js`，
 * 而 `src/classify/llm.js` 里写的是 `import('./llm-key.local.js')` ——
 * 相对 `src/classify/` 解析，指向 `src/classify/llm-key.local.js`，那个文件从来不存在。
 * 再加上原来的 `.catch(() => ({}))` 把加载失败整个吞掉，
 * 于是「注入了却读不到」和「压根没注入」报同一句话，
 * 面板一直说「没有 API key」，用户按提示检查环境变量一切正常，
 * 只能判定扩展在骗人 —— 而 LLM 兜底其实**一次都没跑过**。
 *
 * 这种 bug 靠读代码看不出来（两处单看都没错），
 * 也不适合靠「key 文件在不在」来测 —— 那个文件是 gitignore 的，
 * 换台电脑就没有了，测试会变成随机红。
 * 所以这里测的是**契约**：两个文件约定的路径必须对得上。
 *
 * 判据（两个方向都钉）：
 *   ① 注入脚本写的相对路径，从 llm.js 所在目录解析后，必须命中候选列表之一
 *   ② 候选列表里不能出现「一定解析不到」的路径（防有人又加回那个错路径）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments, readSource } from '../helpers/sourceScan.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const LLM_JS = resolve(ROOT, 'src', 'classify', 'llm.js');
const INJECT_PY = resolve(ROOT, 'tools', 'inject_key.py');

const LLM_DIR = posix.dirname('src/classify/llm.js');
/** 一条候选 spec 解析后是不是注入脚本写的那个文件 */
const resolvesToInjected = (spec, injectedRel) =>
  posix.normalize(posix.join(LLM_DIR, spec)) === injectedRel;

test('inject_key.py 写入的路径能被 llm.js 的候选列表命中', () => {
  // ① 从注入脚本里解析出它写的目标路径
  const py = readSource(INJECT_PY);
  const m = py.match(/TARGET\s*=\s*os\.path\.join\(\s*ROOT\s*,\s*([\s\S]*?)\)/);
  assert.ok(m, 'inject_key.py 里找不到 TARGET = os.path.join(ROOT, ...)');

  const segs = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  assert.ok(segs.length >= 2, `解析出的路径片段不合理: ${JSON.stringify(segs)}`);
  const injectedRel = segs.join('/');
  assert.match(injectedRel, /^src\/llm-key\.local\.js$/,
    `注入脚本写的路径变了: ${injectedRel} —— 如果是有意改的，请同步改 llm.js 的 INJECTED_CANDIDATES 与本测试`);

  // ② 从 llm.js 里解析出候选列表
  const js = readSource(LLM_JS);
  const c = js.match(/INJECTED_CANDIDATES\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(c, 'llm.js 里找不到 INJECTED_CANDIDATES');
  const candidates = [...c[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.ok(candidates.length > 0, 'INJECTED_CANDIDATES 是空的');

  // ③ 关键比对：至少有一个候选真的落在注入文件上
  assert.ok(candidates.some((spec) => resolvesToInjected(spec, injectedRel)),
    `没有任何候选能读到注入文件。\n`
    + `  注入脚本写入: ${injectedRel}\n`
    + `  llm.js 候选:  ${JSON.stringify(candidates)}（相对 ${LLM_DIR}/ 解析）\n`
    + `  → 面板会一直报「没有 API key」，LLM 兜底一次都不会跑。`);

  // ④ 防回退：**首个**候选必须就是能读到的那个。
  //    只要求「至少一个命中」不够 —— 靠遍历兜底能跑对，但把错路径放在第一位
  //    意味着每次加载都要先失败一次再成功，白白多一个失败的 import。
  //    （不要求「全部候选都能解析」：次选路径是留给将来挪目录用的，
  //      现在解析不到是正常的，强求会让这道闸门变成噪声。）
  assert.ok(resolvesToInjected(candidates[0], injectedRel),
    `首个候选 ${candidates[0]} 解析不到注入文件 ${injectedRel}，`
    + `会先失败一次再靠后面的候选兜住。应把能用的路径放在最前面。`);
});

test('llm.js 加载注入文件失败时必须带原因，不能静默退化成空对象', () => {
  // ⚠️ 必须先去注释：本文件里有一段注释**故意引用了出错的旧写法**
  //    来记录这个坑的历史。不去注释的话，闸门会对着注释报红，
  //    而实现其实是对的 —— 那正是「闸门因为错误的原因而红」。
  const js = stripComments(readSource(LLM_JS));
  assert.ok(!/\.catch\(\s*\(\)\s*=>\s*\(\{\}\)\s*\)/.test(js),
    'llm.js 里仍有 .catch(() => ({})) —— 加载失败会再次被无声吞掉，'
    + '"读不到"和"没注入"会再次报同一句话');
  assert.match(js, /tried/, 'llm.js 没有记录加载尝试明细，无法在面板上自证「为什么读不到 key」');
});

test('fetch 必须带超时：LLM 兜底是 await 在主流程上的', () => {
  const js = stripComments(readSource(LLM_JS));
  assert.match(js, /AbortController/, 'llm.js 里没有 AbortController —— 挂住的请求会永久冻结面板');
  assert.match(js, /REQUEST_TIMEOUT_MS/, 'llm.js 里没有定义请求超时');

  // 允许且仅允许一处裸 fetch()：就在 fetchWithTimeout 内部。
  // 它必须带 signal；带 signal 的那处是唯一被豁免的。
  const helper = js.match(/async function fetchWithTimeout\([\s\S]*?\n}/);
  assert.ok(helper, 'llm.js 里找不到 fetchWithTimeout 实现');
  assert.match(helper[0], /signal:\s*controller\.signal/, 'fetchWithTimeout 没有把 signal 传给 fetch');

  const all = [...js.matchAll(/(?<![.\w])fetch\(/g)].length;
  const inHelper = [...helper[0].matchAll(/(?<![.\w])fetch\(/g)].length;
  assert.equal(all, inHelper,
    `llm.js 里有 ${all} 处 fetch( 调用，其中只有 ${inHelper} 处在 fetchWithTimeout 内。`
    + `其余 ${all - inHelper} 处没有超时保护 —— 一挂住整个面板就废了。`);
});
