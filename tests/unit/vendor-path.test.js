/**
 * 契约测试：`src/ai/runtime.js` 指向的 vendor 产物，必须真的被构建出来。
 *
 * ═══ 为什么这道闸门必须存在 ═══
 * 同一个 bug 在本项目已经真实发生过一次：
 * `llm.js` 写 `import('./llm-key.local.js')`，相对 `src/classify/` 解析后
 * 指向 `src/classify/llm-key.local.js` —— 那个文件从来不存在；
 * 再加上 `.catch(() => ({}))` 把失败整个吞掉，于是「注入了却读不到」
 * 和「压根没注入」报同一句话，**LLM 兜底其实一次都没跑过**，面板却在骗人。
 * 那种 bug 读代码看不出来，两处单看都没错。
 *
 * 换成 npm 包之后同一类风险更隐蔽：路径是相对的、产物是构建出来的、
 * 少跑一次 `npm run build:vendor` 就没有那个文件。
 * 所以这里测的是**契约**：`runtime.js` 里的 specifier 必须能解析到磁盘上真实的文件。
 *
 * 附带钉住另一条边界：`runtime.js` 必须是**唯一** import vendor 的模块。
 * 一旦有第二个模块碰它，单元测试就会在 Node 下加载那 600KB，
 * 于是「单测变红」再也无法区分「业务逻辑坏了」与「打包产物坏了」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { dirname, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, readFileSync } from 'node:fs';
import { stripComments, readSource, extractImports } from '../helpers/sourceScan.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const RUNTIME_JS = resolve(ROOT, 'src', 'ai', 'runtime.js');
const VENDOR_ENTRY = resolve(ROOT, 'src', 'ai', 'vendor-entry.js');

/** esbuild 的 outfile —— 必须与 package.json 里的 build:vendor 脚本一致 */
const VENDOR_OUT = resolve(ROOT, 'src', 'vendor', 'pi-ai.js');

const RUNTIME_DIR = posix.join('src', 'ai');

test('runtime.js 的 VENDOR_SPECIFIER 真的指向磁盘上存在的文件', () => {
  const js = readSource(RUNTIME_JS);
  const m = js.match(/export const VENDOR_SPECIFIER\s*=\s*'([^']+)'/);
  assert.ok(m, 'runtime.js 里找不到 VENDOR_SPECIFIER —— vendor 路径成了散落的字面量');

  const spec = m[1];
  // 相对 runtime.js 所在目录解析，和 ESM 的实际解析规则一致
  const resolved = posix.normalize(posix.join(RUNTIME_DIR, spec));
  assert.equal(resolved, 'src/vendor/pi-ai.js',
    `VENDOR_SPECIFIER 解析到 ${resolved}，与构建产物 src/vendor/pi-ai.js 不一致`);

  // 判据是磁盘真相，不是「import 能跑」—— 产物没构建时 import 才会失败，
  // 而失败信息会混进网络/超时诊断里，排查方向完全跑偏
  assert.ok(
    existsSync(VENDOR_OUT),
    'vendor 产物不存在。先跑 npm run build:vendor —— 产物是提交进版本库的，'
    + '缺它就意味着 load unpacked 之后 LLM 兜底永远静默跳过。',
  );
  assert.ok(statSync(VENDOR_OUT).size > 1024, 'vendor 产物小得可疑，可能是空壳或构建中断');
});

test('vendor 产物与 vendor-entry.js 来自同一次构建（产物不是陈旧的）', () => {
  // 改了 vendor-entry.js 却忘了重新构建，是这套架构最容易犯的错：
  // 症状是「代码里明明注册了 provider，运行时说没有」。
  const entry = statSync(VENDOR_ENTRY).mtimeMs;
  const out = statSync(VENDOR_OUT).mtimeMs;
  assert.ok(out >= entry,
    'vendor 产物比 vendor-entry.js 旧 —— 改过入口但没跑 npm run build:vendor。'
    + '这会让新注册的 provider 在运行时「凭空消失」。');
});

test('⚠️ runtime.js 是唯一 import vendor 产物的模块', () => {
  // 唯一性是「行为零变化能被单测证明」的前提：
  // 第二个模块碰 vendor，单元测试就要在 Node 下加载它，红灯的含义会变得含糊。
  const SRC = resolve(ROOT, 'src');
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const abs = resolve(dir, name);
      if (statSync(abs).isDirectory()) { walk(abs); continue; }
      if (!name.endsWith('.js')) continue;
      const rel = abs.slice(SRC.length + 1).split('\\').join('/');
      for (const spec of extractImports(readFileSync(abs, 'utf8'))) {
        if (/vendor\/pi-ai\.js$/.test(spec) && rel !== 'ai/runtime.js') {
          offenders.push(`${rel} → ${spec}`);
        }
      }
    }
  };
  walk(SRC);
  assert.deepEqual(offenders, [],
    `这些模块也 import 了 vendor 产物：${offenders.join('; ')}。`
    + '只有 runtime.js 可以碰它 —— 否则单测变红时无法判断是逻辑坏了还是产物坏了。');
});

test('vendor 产物里没有 Node 内置模块残留', () => {
  // esbuild 用 --platform=browser 打。万一某个 Node 专用依赖
  // （http-proxy-agent / @smithy/node-http-handler 之类）漏进来，
  // 症状是扩展一加载就白屏，而报错信息往往指向完全无关的文件。
  const code = readFileSync(VENDOR_OUT, 'utf8');
  const bad = [...code.matchAll(/(?:require\(|from\s*)["']node:([a-z_]+)["']/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(bad)], [],
    `vendor 产物里残留 Node 内置模块: ${[...new Set(bad)].join(', ')} —— 在浏览器里会直接炸`);
});

test('⚠️ vendor 产物没有越过体积红线', () => {
  // 为什么这道闸门存在
  // ------------------
  // 2026-10-06 接入 MiniMax（`minimaxCnProvider`，协议是 anthropic-messages）时，
  // 产物从 386KB 涨到 601KB —— **+215KB 全是 `@anthropic-ai/sdk`**。
  //
  // 原因值得写下来：`anthropic-messages.lazy.js` 里写的是
  // `lazyApi(() => import("./anthropic-messages.js"))`，看起来是按需加载，
  // 但本项目的 esbuild 命令**没开 `--splitting`**，而不开 splitting 时
  // 动态 import 会被**内联进同一个文件**。也就是说「lazy」在这里是失效的，
  // 每加一家 T2 供应商就实打实多几百 KB，而这件事在 git diff 里只是一个大数字。
  //
  // 现状：601.4KB（deepseek/moonshot/openai/百炼 + minimax）。
  // 红线 800KB。再接 anthropic 或 google（依赖 @google/genai）必然顶破，
  // 那时唯一的正解是先改用 code splitting —— 一次产出十几个哈希命名的 chunk，
  // 届时必须同步改：package.json 的 build:vendor、tools/package.py 的产物校验、
  // 本文件「单文件 + mtime」这两个前提，以及 AGENTS.md 里关于单文件的说明。
  //
  // 判据是**磁盘上的真实大小**，不是「有没有报错」——
  // 体积变大从来不会让任何现有测试变红，这就是它需要一道自己的闸门的原因。
  const MAX_BYTES = 800 * 1024;
  const size = statSync(VENDOR_OUT).size;
  assert.ok(size <= MAX_BYTES,
    `vendor 产物 ${(size / 1024).toFixed(1)}KB 超过红线 ${MAX_BYTES / 1024}KB。`
    + '多半是又接了一家 T2（依赖 @anthropic-ai/sdk 或 @google/genai）。'
    + '先读 src/ai/vendor-entry.js 顶部那段关于 splitting 的说明，别直接抬红线。');
});

test('vendor 产物语法合法，且导出 runtime 需要的那些面', async () => {
  const m = await import('../../src/vendor/pi-ai.js');
  for (const name of ['createModels', 'createProvider', 'hasApi', 'openAICompletionsApi']) {
    assert.equal(typeof m[name], 'function', `vendor 产物缺导出 ${name}`);
  }
  // provider 工厂缺一个不会立刻炸，只会在用到那家时静默跳过 ——
  // 所以这里直接对着注册表点一遍名
  const { PROVIDERS } = await import('../../src/ai/provider-registry.js');
  for (const p of PROVIDERS) {
    if (!p.factory) continue;
    assert.equal(typeof m[p.factory], 'function',
      `注册表要用的 ${p.factory}() 没打进产物 —— 改完 vendor-entry.js 要重跑 npm run build:vendor`);
  }
});

test('去注释后的 runtime.js 不含 .catch(() => ({})) 式的静默吞错', () => {
  // 与 inject-path.test.js 同一类判据：加载失败必须带原因。
  const js = stripComments(readSource(RUNTIME_JS));
  assert.ok(!/\.catch\(\s*\(\)\s*=>\s*\(\{\}\)\s*\)/.test(js),
    'runtime.js 里仍有 .catch(() => ({})) —— vendor 加载失败会再次被无声吞掉');
  assert.match(js, /tried/, 'runtime.js 没有记录加载尝试明细');
});
