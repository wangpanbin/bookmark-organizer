/**
 * 「死代码不可达」闸门。
 *
 * ═══ 这道闸门为什么存在 ═══
 * 2026-10-06 的评审抓到一个反复出现的失败模式：
 * 模块写了、单测也绿了，但**没有任何地方 import 或调用它** ——
 * `runSemanticDedupe` / `getSuggestions` / `archiveMany` / `archiveOne` / `clearVectors`
 * 五个导出全是零调用点。
 *
 * 它的危险之处在于**单测全绿**：给一个没人调用的函数写 10 条单测，
 * 测试跑得再漂亮也证明不了任何东西 —— 测的是一个孤岛。
 * 而「模块存在 + 测试通过」看起来非常像「功能完成」，
 * 于是汇报里就写上了「已完成」。这是最难自己发现的一类 bug。
 *
 * 判据很窄也很硬：**`src/` 下每个模块里的每个 export，
 * 必须至少被 `src/` 或 `ui/` 里的另一个文件引用。**
 *
 * ⚠️ 局限（明说，别假装它是完美的）：
 *   · 它只看静态 import/调用文本，看不出通过消息表间接可达的情况
 *   · 一条「导出但只用给自己拼 API 门面」的模式会被误报，
 *     所以本文件只列**必须可达**的那些，不做全目录扫描
 *   · 用 grep 文本而不是 AST：宁可误报也不要漏报，误报可以人工确认
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SRC = join(ROOT, 'src');
const UI = join(ROOT, 'ui');

/**
 * 必须可达的导出。**只列「可达才算完成」的那些** ——
 * 一个新模块如果还没接线，就该被这里抓住，而不是等评审。
 */
const MUST_BE_REACHABLE = [
  // F2 语义去重：整条链路都曾经是孤岛
  ['dedupe/semantic-runner.js', 'runSemanticDedupe', 'F2 的入口，用户在面板上点「跑一轮语义去重」'],
  ['dedupe/semantic-runner.js', 'getSuggestions', '刷新面板时要读上次的建议'],
  ['dedupe/semantic-runner.js', 'clearVectors', '换模型/维度后必须清缓存'],
  ['dedupe/semantic.js', 'suggestMerges', '编排层的核心'],
  ['dedupe/embedding-client.js', 'embedAll', '批量取向量'],
  ['dedupe/embedding-client.js', 'fetchArchivedText', '取归档正文喂 embedding'],
  // F3 归档
  ['archive/client.js', 'archiveMany', '归档按钮背后'],
  ['archive/client.js', 'probeSink', '面板上那行「接收器状态」'],
  // F3 归档：G4 分级（重要页多渲染 PDF/截图）的唯一入口。
  // ⚠️ 漏登记的后果是「打星按钮能显示、但归档时 important 恒为 false」，
  //    而那种功能在单测里看起来完全正常。
  ['archive/important.js', 'getImportantUrls', '面板恢复星标状态 + 归档读它'],
  ['archive/important.js', 'toggleImportant', '明细表里那颗星的点击'],
  ['archive/important.js', 'clearImportant', '「全部取消标记」按钮'],
  ['archive/run.js', 'archiveSlice', '归档循环的一整片，循环本体在面板页'],
  // F1 链接健康
  ['scan/alternatives.js', 'findAlternatives', '死链的「找替代」按钮背后'],
  ['scan/scheduler.js', 'installAlarmListener', 'SW 启动时接闹钟'],
  ['scan/permission.js', 'requestScanPermission', '用户点「授权访问网站」'],
  ['scan/extract-meta.js', 'faviconUrlFor', '表格里的图标'],
  ['scan/classify-site.js', 'classifySite', '站点类型识别'],
  ['scan/soft404.js', 'looksLikeNotFound', '软 404'],
  ['scan/verdict.js', 'summarize', '面板汇总卡'],
  // 之前的 AI 接入改造
  ['ai/runtime.js', 'completeWithRetry', 'LLM 分类与找新地址都经它'],
  ['ai/credential-store.js', 'createCredentialStore', 'runtime 解析 key 时用它'],
  ['ai/provider-registry.js', 'resolveTarget', 'baseUrl → provider'],
  // ⚠️ 这个导出的价值全在**被调用**上：它是一道「别给 anthropic 协议发 response_format」
  //    的闸门。留着一个没人调用的纯函数，等于这道闸门不存在。
  ['ai/provider-registry.js', 'resolveJsonMode', 'runtime 用它决定要不要注入 response_format'],
  // 刻意**不列**同文件内部 helper（archiveOne、verifyCandidates）：
  // 它们被本文件的上层导出调用，可达性是传递的。
  // 列进来只会让这道闸门天天为正确的代码报红 —— 而误报的闸门等于没有闸门。
];

/** 收集 src/ 与 ui/ 下所有源码文件的文本 */
function collectSources() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) { walk(abs); continue; }
      if (!/\.(js|mjs)$/.test(name)) continue;
      out.push({ abs, text: readFileSync(abs, 'utf8') });
    }
  };
  walk(SRC);
  if (existsSync(UI)) walk(UI);
  return out;
}

const ALL = collectSources();

test('⚠️ 声明为「已完成」的导出必须真的被引用（死代码闸门）', () => {
  const orphans = [];
  for (const [rel, name, why] of MUST_BE_REACHABLE) {
    const abs = join(SRC, rel);
    assert.ok(existsSync(abs), `${rel} 不存在 —— 这张清单过期了，删掉它或补上文件`);
    const self = readFileSync(abs, 'utf8');
    // 引用必须来自**别的**文件，只在自己文件里出现不算
    const used = ALL.some((s) => s.abs !== abs && new RegExp(`\\b${name}\\b`).test(s.text));
    if (!used) orphans.push(`${rel} → ${name}（${why}）`);
  }
  assert.deepEqual(orphans, [],
    `这些导出没有任何地方引用：\n  ${orphans.join('\n  ')}\n`
    + '单测全绿证明不了孤岛 —— 测的是一个没人用的函数。');
});

test('⚠️ 消息处理器必须在 background.js 的 HANDLERS 里真的存在', () => {
  // 面板通过 chrome.runtime.sendMessage 调后台。
  // 处理函数写了却没注册进 HANDLERS，症状是「点了没反应」，
  // 而本地看代码一切正常。
  const bg = readFileSync(join(SRC, 'background.js'), 'utf8');
  const REQUIRED = [
    'getState', 'linkStart', 'linkStep', 'linkState', 'linkResume', 'linkPause',
    'linkPerm', 'linkSyncAlarm', 'linkAlternatives',
    'semanticRun', 'semanticSuggestions', 'semanticClear',
    'archiveStatus', 'archiveRun', 'archiveReset', 'archiveProgress',
  ];
  // 对象字面量的两种写法都要认：`getState: fn` 与简写的 `getState,`
  const missing = REQUIRED.filter((m) => !new RegExp(`\\b${m}\\s*[:,]`).test(bg));
  assert.deepEqual(missing, [],
    `background.js 的 HANDLERS 里没有：${missing.join(', ')} —— 面板调它们会静默无响应`);
});

test('⚠️ 面板上引用的每个 DOM id 都必须真实存在', () => {
  // 「界面上那个 id 拼错了」的表现是点按钮没反应，而没有任何报错。
  const html = readFileSync(join(UI, 'options.html'), 'utf8');
  const js = readFileSync(join(UI, 'options.js'), 'utf8');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  // 只查 link-scan / 归档 / 语义去重这几个新面板用到的
  const NEW = [
    'healthDisclosureText', 'btnLinkGrant', 'btnLinkRevoke', 'healthPermState',
    'btnLinkRun', 'btnLinkResume', 'btnLinkPause', 'healthProgress', 'linkInterval',
    'linkAiFind', 'healthSummary', 'healthRows', 'healthEmpty', 'healthAlt', 'tabHealthCount',
    'btnArchiveRun', 'btnArchiveProbe', 'archiveState', 'archiveNote',
    'btnArchiveReset', 'importantCount', 'btnImportantClear',
    'semanticEnabled', 'semanticThreshold', 'btnSemanticRun', 'btnSemanticClear',
    'semanticState', 'semanticTable', 'semanticRows',
  ];
  const missing = NEW.filter((id) => !ids.has(id));
  assert.deepEqual(missing, [],
    `options.html 里没有这些 id（而 options.js 在用它们）：${missing.join(', ')}`);
  // 反向：js 里新面板引用了 html 中不存在的 id
  const referenced = [...js.matchAll(/\$\('([A-Za-z][A-Za-z0-9_]*)'\)/g)].map((m) => m[1]);
  const ghosts = [...new Set(referenced.filter((id) => !ids.has(id) && /^(health|link|btnLink|archive|semantic|tabHealth)/.test(id)))];
  assert.deepEqual(ghosts, [], `options.js 引用了 html 里不存在的 id：${ghosts.join(', ')}`);
});
