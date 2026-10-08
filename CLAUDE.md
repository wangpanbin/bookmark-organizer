# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 这是什么

Chrome MV3 书签整理扩展（`bookmark-organizer`）。按「功能」自动把已收集的书签归类到两层中文文件夹，先预览再写入，全程可回滚。业务源码零构建，原生 ES Module，`load unpacked` 直接跑。

> 这是一个**有强烈产品安全承诺**的项目：
> 「dry-run 零写入」「清单之外的书签一条都不动」「面板说什么就一定能做到」。
> 改这块代码前必须读完下文「必读」。

---

## 必读（按顺序）

1. **`README.md`** —— 产品说明 + 踩坑记录 + 验收阈值。先建立领域感。
3. **`AGENTS.md`** —— 编号 0–12 的硬约束。这是**给 agent 的权威副本**，
   不是建议。约束本身没写在别处，细节解释在 `docs/`。
4. **`CONTRIBUTING.md`** —— 开发流程、Conventional Commits、提交信息怎么写。
5. **`docs/testing.md`** —— 三类闸门（正向/证伪/E2E）各自守什么、跑之前必须知道什么、**当前的覆盖缺口**。
6. **`docs/lessons-learned.md`** —— 症状对得上某条历史 bug 时按症状 Ctrl+F；大部分坑表现为「某个功能就是不工作」，根因在别处。

> ⚠️ 文档是分层的。**README 是产品视角的入口**；深度参考都在 `docs/`；
> 同一规则不抄到第三个地方。`AGENTS.md` 的 `⚠️ 三个必须知道的边界` 一节
> 列出了「改之前先看哪份文档」的对照。

---

## 一句话架构

```
chrome.bookmarks ──read──▶ plan.js (pure, no chrome)
                              │         │
                              │         ├── classify/ (规则/词典/LLM 兜底)
                              │         ├── dedupe.js (URL 归一化)
                              │         └── scope-list.js (手动范围清单)
                              ▼
                          storage.js (串行锁 RMW)
                              ▲
                              │   user clicks "执行整理"
                              │
                          apply.js (在 service worker 里逐条跑 + 续跑)
                              │
                              ├── backup.js (先存全树快照)
                              └── fail-log.js (失败送本机接收器)

ui/options.html ── fetch ──▶ docs/panel-help.md  (帮助页签内容)
ui/options.js   ── post  ──▶ background.js ──▶ plan.js / apply.js
```

**关键不变量**：
- `plan.js` 是**纯函数模块**，**不** import 任何写操作模块（`storage.js`/`apply.js`/…）。这是 dry-run 零写入的全部依据，由 `tests/unit/plan.test.js` 的静态 import 扫描守护。
- `storage.js` 的读-改-写在**同一个串行临界区内**——不存在「内存累积 + hydrate」这种东西。
- `toPath` 不含根名，`fromPath` 含（根归到哪是写盘的问题，由 `settings.targetRoot` 决定）。
- `src/vendor/pi-ai.js` (~601KB) 是 `npm run build:vendor` 打的 esbuild 产物，**提交进版本库**。**只有** `src/ai/runtime.js` 允许 import 它。改了 `src/ai/vendor-entry.js` 必须重跑 build，否则 `tests/unit/vendor-path.test.js` 红。

**MV3 service worker 随时会被回收**：`resumeExecution` 是新进程从 storage 读回 task 的，所以 `task.scopeIds` 必须**落盘**——这是为什么「手动整理的范围校验」要在 `apply.js` 的 `isInScope` 里再核一次。

---

## 命令（先想清楚再跑）

| 命令 | 干什么 | 何时跑 |
|---|---|---|
| `npm test` | 单元测试（Node 内置 test runner，零三方依赖，2 秒） | 每次改动必跑 |
| `npm run test:falsify` | **产品级证伪**：备份源码 → 打坏补丁 → 跑整套 → 断言变红 → 还原 | 改闸门/扫描器后 |
| `npm run test:e2e` | E2E（**默认 headless，不弹窗**；调试用 `BO_E2E_HEADED=1`） | 提交前 |
| `npm run test:scope` | 手动指定书签范围的 E2E（两组对照 + 确认弹窗文案 + 失效不按 URL 认领） | 改 `scope-list.js` / `apply.js` 后 |
| `npm run build:vendor` | esbuild 重打 `src/vendor/pi-ai.js` | 改了 `src/ai/vendor-entry.js` 后 |
| `npm run gate:ui` | 面板 DOM 契约（`tools/ui_contract_gate.py`） | 改 `ui/options.html` DOM id 后 |
| `npm run gate:contrast` | 前景/背景对比度 | 改色板后 |
| `npm run gate:privacy` | 隐私闸门：扫推送 blob，查真 key / 真实书签数据 | 改 E2E 夹具后 |
| `python tools/precommit.py` | 提交前闸门：语法 + JSON + U+FFFD + 单测 + 两道静态闸门 | 已经接成 `.git/hooks/pre-commit` |
| `python tools/precommit.py --all` | 跑全 `src/ ui/ tests/ tools/ docs/`（CI 走这条） | CI / 提交前 |

⚠️ **`npm run test:falsify` 不是只读的**——它会修改真实源文件、跑整套、再还原。
**不能和任何编辑或测试并发**。跑它的时候：什么都不做，等它自己结束。
它结束时**必须 rc=0**：退化全红但有一处关键字没匹配上时脚本同样返回 1——
那不是闸门失灵，是量具没对准，看输出里的「实际标题」那一行去改关键字。

⚠️ `npm test` **不跑静态闸门**（走的是 `--tests-only`）。所以「单测全绿」≠「面板契约和对比度都过」。
全绿只跑 `npm test` 时面板可以烂着。提交前请用 `python tools/precommit.py`。

---

## 架构骨架（按文件）

### 纯函数模块（不在 service worker 里跑、不可碰 chrome.*）
```
src/plan.js                计划生成，零写入 ← 整个产品的安全闸门
src/normalize.js           URL 归一化与去重键
src/dedupe.js              重复检测与 keeper 策略
src/scope-list.js          手动范围的清单纯逻辑
src/classify/
  taxonomy.js              类目树 + 用户覆盖合并
  dict.js                  预置规则词典（37 条规则、804 个域名，纯数据）
  rules.js                 规则匹配器
  llm.js                   云端兜底编排
src/ai/
  provider-registry.js     供应商与模型目录（纯数据+纯函数）
  errors.js                HTTP 错误诊断文案
  context.js               Context 构造 / 结果判定
  vendor-entry.js          esbuild 入口
src/dedupe/semantic.js     余弦 / 粗筛 / 建议合并
src/scan/                  verdicts / 死链判据 / 元数据 / 软 404 / 站点类型 ——
                           都是纯函数，runner.js 才是 chrome 异步入口
```

### 写操作 / chrome.* 模块
```
src/apply.js                逐条执行 + 断点续跑（在 service worker 里跑）
src/storage.js             串行 RMW 封装
src/backup.js              快照与回滚
src/fail-log.js            本机缓冲 + 送本机接收器
src/listener.js            变更监听（导入期抑制）
src/background.js          service worker 入口
src/roots.js               书签根 id 的解析（根名随界面语言变，不能硬编码）
src/tree.js                getTree 扁平化
src/scan/runner.js         扫描循环
src/scan/scheduler.js      chrome.alarms 接线
src/scan/probe.js          单条探测
src/scan/permission.js     <all_urls> 按需授权
src/dedupe/embedding-client.js  百炼 text-embedding-v4 客户端
src/dedupe/semantic-runner.js   IndexedDB 向量存储
src/archive/               内容归档（client.js / run.js / important.js）
src/ai/credential-store.js 按 providerId 的凭据读写（走 storage.js 串行锁）
src/ai/runtime.js          ⚠️ 唯一 import src/vendor/pi-ai.js 的模块
```

### UI
```
ui/options.html / options.js / options.css   主面板（全屏）
ui/popup.html / popup.js                       工具栏弹窗（极简）
ui/markdown.js                                  不碰任何 chrome API，document 是注入参数
ui/theme-boot.js                                必须是 <head> 里经典同步脚本（避免白闪）
```

### 测试
```
tests/unit/*.test.js         单元测试 + 证伪用例
tests/e2e/                   Playwright（harness.js / run.js / diagnose.js / scope-run.js）
tests/helpers/sourceScan.js  源码静态扫描（纯链路 / 能力 / storage RMW 判据共用）
tests/fixtures/samples.js    命中率闸门的样本集
tests/product_falsification.py    产品级证伪
```

---

## 测试闸门速查

| 想验证什么 | 跑哪个 |
|---|---|
| 我刚写的纯函数 | `npm test` |
| 改了 `ui/options.html` 的 DOM id / 改了 `docs/panel-help.md` | `npm run gate:ui` |
| 改了三处面板里的色板（`ui/options.css` / `ui/popup.html` / `contrast_gate.py` 的 `INK`/`BASE`） | `npm run gate:contrast` |
| 改了闸门 / 扫描器 / 关键字 | `npm run test:falsify` |
| 改了 `apply.js` / `plan.js` / `storage.js` / `scope-list.js` | `npm run test:e2e` + `npm run test:scope` |
| 改了 E2E 夹具（`tests/e2e/repro-real.js` 等） | `npm run gate:privacy` |
| 改了 `src/ai/vendor-entry.js` | `npm run build:vendor` + `npm test`（`tests/unit/vendor-path.test.js` 守） |

---

## 改代码前要核的清单

- [ ] 我改的是 `plan.js` 的 import 区吗？→ **停下来**，读 `AGENTS.md` 约束 1。import 扫描器覆盖具名/默认/namespace/**副作用**/re-export/**跨行子句**/**动态 import** 六种写法，且**扫描前先去掉注释**、**字符串也去**（面板文案里到处提到 `chrome.alarms`）。
- [ ] 我改的是 `storage.js` 的 RMW 形状吗？→ **停下来**，读 `AGENTS.md` 约束 2。需要 RMW 模式就写 `storage-rmw-ok: <理由>` 注释，**理由不能为空**。
- [ ] 我改的是面板 DOM id 吗？→ 两份白名单要同步：`tools/ui_contract_gate.py` 的 `GATED` + `tests/unit/reachability.test.js` 的 `NEW`。漏改的后果是点按钮没反应、且没有任何报错。
- [ ] 我改的是色板吗？→ 一份色板有**四处副本**：`ui/options.css`（亮+两块暗色，逐字相同）、`ui/popup.html` 的内联 `:root`、`tools/contrast_gate.py` 的 `INK`/`BASE`。`ui_contract_gate.py` 三处互校。
- [ ] 我改的是 `docs/panel-help.md` 吗？→ 路径写死三处要同步：`ui/options.js` 的 `HELP_DOC_URL`、`tools/package.py` 的 `INCLUDE_DOCS`、`tests/e2e/harness.js` 的 `RUNTIME_DOCS`。漂了的症状统一是「帮助页签空白」。
- [ ] 我改的是写操作模块名吗？→ 不要以 `storage.js` / `apply.js` / `llm.js` / `tree.js` / `backup.js` / `background.js` / `fail-log.js` 结尾——纯链路闸门是**后缀匹配**。`fail-log-storage.js` 会被当成 `storage.js`。
- [ ] 我改了闸门吗？→ 至少跑一次 `npm run test:falsify`，确认它确实会红。**绿灯本身不算证据**。
- [ ] 我放宽了判据（删 bug、改正则、改字面量）吗？→ 双向证伪：正向改动不该红（误报 = 闸门失去可信度），坏改动必须红。

---

## 已知会让闸门 FAIL 的项目事实

- **扩展路径不能含空格**：浏览器正常启动、扩展根本没加载，只表现为 `waitForEvent('serviceworker')` 超时。极易误判成「扩展坏了」。
- **Chrome 155 已移除 `--load-extension`**（Edge 154 仍支持）；E2E 通道链只对「二进制缺失」回退，其他错误必须立刻抛。
- **unpacked 扩展 id 由绝对路径哈希而来**：路径一变 id 就变，`chrome.storage.local` 按 id 分区。
- **`F:\logs\...` 是作者本机的默认路径**——多数人没有 F 盘。日志接收器必须用 `--dir` 指定。

---

## 不要做的事

- 不要承诺界面上做不到的事。面板文案就是产品承诺。`AGENTS.md` 约束 8 是**没有自动闸门**的承诺守卫——靠评审 + 前科留在注释里。
- 不要自动 `git commit` 或 `git push`，除非用户明确要求。提交前先展示将要提交的变更摘要。
- 不要把扩展路径放到含空格的路径下。
- 不要跑 `npm run test:falsify` 的同时跑任何其他测试或编辑。
- 不要在 issue/PR 正文里贴真实书签标题/URL、key、token、本机绝对路径（仓库是 public）。`npm run gate:privacy` 也会扫同样的规则。
- 不要把 `src/vendor/pi-ai.js` 当源码改——它是构建产物。