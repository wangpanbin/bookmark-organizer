# AGENTS.md

Chrome MV3 书签整理扩展。业务源码是原生 ES Module，`load unpacked` 直接跑。

唯一例外：`src/vendor/pi-ai.js`（约 601KB）由 `npm run build:vendor` 用 esbuild
从 `@earendil-works/pi-ai` 打成并**提交进版本库**。改 `src/ai/vendor-entry.js`
后必须重跑，否则新注册的 provider 会在运行时「凭空消失」。
`src/ai/runtime.js` 是**唯一** import 这个产物的模块 —— 第二个模块碰它，
单元测试就会在 Node 下加载那 601KB，红灯的含义会从「逻辑坏了」变成「产物坏了」。

> 601KB 里有 215KB 是 2026-10-06 接入 MiniMax 时带进来的 `@anthropic-ai/sdk`。
> esbuild 没开 `--splitting`，`*.lazy.js` 里那个动态 `import()` 会被**内联**，
> 所以「lazy」在本项目里是失效的。**再加一家 T2 供应商（Anthropic / Google）之前**
> 先读 `src/ai/vendor-entry.js` 顶部关于 splitting 的说明 —— 那时要改的是
> 「单文件」这个前提本身，不是把红线抬高一格。红线在 `vendor-path.test.js`（800KB）。

- 完整产品说明、目录结构、踩坑记录与验收阈值见 `README.md` —— **改代码前先读它**，本文件不重复。
- 重排书签树是破坏性操作，只由用户在面板点「执行整理」触发，扩展**永远不会自动执行**。

## Commands

| 命令 | 作用 |
|---|---|
| `npm run build:vendor` | 重建 `src/vendor/pi-ai.js`。**改了 `src/ai/vendor-entry.js` 就必须跑** |
| `python tools/archive_sink.py --selftest` | 归档接收器自检：写一条再读回，判据是磁盘上真的多出文件、**且文件名跨进程稳定** |
| `npm test` | 单元测试（Node 内置 test runner；需 Python 做文件枚举） |
| `npm run test:falsify` | 产品级证伪：备份源码、打坏补丁、跑整套、断言变红、再还原。⚠️ **不是只读**，不能与任何编辑/测试并发 |
| `npm run test:e2e` | E2E（需要完整 chromium + 有头模式） |
| `npm run test:all` | 全套验证 |
| `npm run package` | 打包产物 |
| `npm run gate:privacy` | 隐私闸门：扫所有将推送的 blob，查真 key / 真实书签数据 |

单测由 `tools/precommit.py` 枚举 `tests/unit/*.test.js` 后**显式**交给 node。两条别踩：
- **别把 glob 当单个参数传给 `node --test`**（`node --test "tests/unit/*.test.js"`）——
  只有 Node 22+ 认，Node 20 上会静默地什么都不跑，退出码还可能是 0。CI 首次实跑就是这么红的。
- **别传目录**（`node --test tests/unit`）—— 本机会报 `MODULE_NOT_FOUND`。

`python tools/precommit.py` 是**提交前闸门**：暂存区的 `.js`/`.mjs` 过 `node --check`、`.json` 过 parse，再跑一遍单测（2 秒、零浏览器）。
`--all` 模式额外跑**两个亚秒级静态闸门**（面板 DOM 契约 + 前景/背景对比度）。
已接成本机 `.git/hooks/pre-commit`，每次 `git commit` 自动跑。
⚠️ `.git/` 不进版本库，所以**每台机器要装一次**：把下面这行写成 `.git/hooks/pre-commit` 并 `chmod +x`（Windows 用 Git 自带的 bash）——
`exec python "$(git rev-parse --show-toplevel)/tools/precommit.py"`
不接线的代价是实测过的：170 条单测与 10 处证伪点从来没被要求跑过，于是「全绿」和「没跑」长得一模一样。
E2E 与证伪**故意不**进钩子——它们要开浏览器、分钟级，塞进每次提交会变成没人愿意等的门。

本机 `node --test <目录>` 会把目录当模块解析报 `MODULE_NOT_FOUND`，脚本里已改用 glob。

## 三条不可破的约束

0. **`fail-log.js` 同属写操作模块。** 它会发网络请求（本机接收器），
   被纯链路 import 就意味着 dry-run 不再零外发。已进 `FORBIDDEN_IN_PURE_CHAIN`。
   ⚠️ 那个列表是**相对 `src/` 的精确路径**（2026-10-06 起）。
   早先它是文件名后缀匹配（`spec.endsWith(bad)`），于是新模块名只要**以**
   `storage.js` 之类结尾就会因为名字被误判 —— `fail-log-storage.js` 会被当成
   `storage.js`。那颗雷已经拆掉：**新模块可以放心叫 `probe-storage.js`**，
   前提是它真的不是 `src/storage.js`。别再按老规矩避讳命名。
1. **`plan.js` 不 import 任何写操作模块。** 这是 dry-run 零写入的全部依据，由 `tests/unit/plan.test.js` 的静态断言守着。扫描器（`tests/helpers/sourceScan.js`）必须同时覆盖：具名 / 默认 / namespace / 副作用 / re-export / **跨行子句** / **动态 import**，且**扫描前先去掉注释**。
   - 漏掉副作用导入 → `import './apply.js'` 整条绕过。
   - 子句正则用 `[^;\n]*?` → `import {\n a,\n} from './apply.js'` 整类绕过。
   - 不去注释 → JSDoc 里的 `{import('./x.js')}` 被当真导入，闸门**因为错误的原因而红**。
   - 三条都有对应的长期回归：`npm run test:falsify` 里的跨行/动态两个用例，加 `falsification.test.js` 里的误报用例。
   - ⚠️ **能力闸门同样要去字符串**（`stripStrings`）。本项目的面板文案里到处**提到**
     `chrome.alarms` 这类 API 名，那是字符串不是调用。不去的话闸门会对着说明性文字
     报红 —— 误报是闸门失去可信度的最快方式：大家只会学会忽略它，真违规也一起被忽略。
1b. **纯模块不得触碰的能力不止 chrome.bookmarks / storage**（2026-10-06 扩）。
   `chrome.alarms` / `chrome.permissions` / `chrome.tabs` / `chrome.runtime` /
   `fetch` / `XMLHttpRequest` / `WebSocket` / `sendBeacon` / `importScripts` /
   `indexedDB` 全部在禁用清单里。理由：link-scan 要用的恰好就是这批能力，
   而旧清单对它们**覆盖为零** —— 一道看不见的网等于没有网。
   加新能力时同步在 `falsification.test.js` 补「会红」与「不误报」两个方向的用例。
2. **`storage.js` 的读-改-写在同一个串行临界区内。** 不采用「内存累积 + hydrate」，那种写法要防的竞态恰是它自己引入的。
3. **去重保留 hash 路由、只剥跟踪参数白名单。** `example.com/#/settings` 与 `example.com/#/profile` 是两个页面；过度归一化会把它们判成重复，进而删掉用户真收藏的条目。
4. **链接健康只「建议」，绝不自动改书签。** 死链替代、改址采纳**只登记提案**，
   真正的写入仍走 plan.js 的 dry-run 三段式。
   跨站重定向一律不给「采纳替换」按钮——品牌改名与跳登录页从 URL 上无法区分。
   软 404 是启发式，**不计入失败计数**。
5. **死链判据是「连续 3 次 404/410 且距上次成功 ≥24h」**，不是「最近 3 次」。
   `chrome.alarms` 官方写明 may delay arbitrarily，丢一轮时后者语义是错的；
   且 403/429/5xx/超时**永不**计入 `failStreak`。
6. **归档只落本机磁盘，不进扩展存储。** 「永久副本」与「扩展存储」语义互斥——
   扩展一卸载，后者就没了。接收器离线时**要明说**，不许静默假装存了。
7. **「声明完成」的东西必须真的可达。** 闸门在 `tests/unit/reachability.test.js`：
   导出是否被引用、消息处理器是否真注册进了 `HANDLERS`、面板引用的 DOM id 是否真在 html 里。
   **加新功能时把新导出登记进 `MUST_BE_REACHABLE`** —— 登记了才有保护，不登记下次照样靠评审才发现。

   ⚠️ 这道闸门查的是「名字在别的文件里出现过」，**不是「被调用过」**。
   一行 `import { foo } from './x.js'` 就足以满足它，于是「import 了但没人调」照样全绿
   （2026-10-06 实测：删掉调用点只留 import，18 条相关单测一条没红）。
   关键逻辑要**额外**断言调用 —— 范例见 `provider-registry.test.js` 的
   「runtime.js 真的调用了 resolveJsonMode」：判据找 `foo(`，**括号是关键**，裸名字匹配会再次栽在 import 上。
8. **不许承诺界面上做不到的事。** 这条**没有自动闸门** —— 「界面在说什么」静态查不了，
   只能靠评审时读一遍文案，外加把前科留在代码注释里：
   `ui/options.js` 的 `linkSuggestionCell` 与 `src/background.js` 里 `linkPropose` 被删掉的那段，
   记着「采纳替换」按钮为什么必须拿掉。**界面承诺一件永远不会发生的事，比功能缺失更伤** ——
   用户会据此安排自己的工作。宁可没有那个按钮，并把缺口写进文档。
   （能自动化的那部分已经自动化了：`ui_contract_gate.py` 禁止「采纳替换」类按钮回来，
   并禁止文案里再出现「逐条确认」这个不存在的步骤。）
9. **读一个设置项之前先确认它被定义了。** `s.linkScanAiFind !== false` 在
   `DEFAULT_SETTINGS` 里没有该项时是**恒真**的 —— 功能「正常」，只是没人能关掉它。
   `tests/unit/falsification.test.js` 现在扫全 `src/` 找这种读法。

> ⚠️ **`npm run test:falsify` 不是只读的。** 它会**修改真实源文件**、跑一遍整套、
> 再还原。所以它**不能和任何编辑或测试并发** —— 你今天已经因此拿到过一次假失败
> （证伪正在给 `normalize.js` 注入 `indexedDB`，而你同时跑了 `npm test`，
> 纯链路闸门理所当然地红了）。
>
> 跑它的时候：**什么都不做，等它自己结束。** 它的单次运行是分钟级。
> 另外它结束时**必须 rc=0**：25 处退化全红但有一处关键字没匹配上时，
> 脚本同样返回 1 —— 那不是「闸门失灵」，是**量具没对准**，
> 看输出里的「实际标题」那一行去改关键字。

> 绿灯本身不算证据。一道从来没红过的闸门，和没有闸门是一样的。
> 改闸门时至少跑一次 `npm run test:falsify`，确认它确实会红。
>
> **放宽判据要双向证伪。** 收紧容易，**放宽**才是真正危险的那一半 ——
> 删掉一条断言就能让自己「变绿」，而删断言永远不会被任何东西拦。
> 所以每次放宽（改语义正则、删字面量、把「某句话」换成「某个性质」），
> 两侧都要各跑一次并把结果记下来：
>
> | 方向 | 判据 | 2026-10-06 的实例 |
> |---|---|---|
> | **该绿** | 一次**正当**的改动不得变红 | 措辞改得更强（「不改你的书签」→「一个字都不改」）、超时常量 30s→45s |
> | **该红** | 一次**坏**改动必须变红 | 措辞改成含糊的「会谨慎处理书签」、超时被说成「请求失败」 |
>
> 只有「该红」那一侧是容易糊弄过去的 —— 它通常会红，因为坏改动确实更坏。
> **「该绿」那一侧才是判据的真正考验**：一条写死字面量的判据会在正当改动上红，
> 而那种红是**误报**，误报的闸门比没有闸门更糟（大家只会学会忽略它，真违规也一起被忽略）。
> 记不住时问一句：**这条判据防的失效变了吗，还是只是措辞变了？**

## Agent skills

### Issue tracker

Issue 走 **GitHub Issues**（`gh` CLI，仓库 `wangpanbin/bookmark-organizer`）。
五个 triage label 在远端**已存在**，`triage` 直接 `--add-label`，不必新建。
`.github/ISSUE_TEMPLATE/*.yml` 只对**网页端人工填报**生效；`gh issue create` 会**绕过**模版，
所以 agent 建 issue 必须自己带 `--label`。
⚠️ 仓库是 **public**：issue 正文里**绝不**贴真实书签标题/URL、key、token、本机绝对路径。
`Status:` 行约定随本地 markdown 一同退役，见 `docs/agents/issue-tracker.md`。

### Triage labels

Five canonical roles kept as-is: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: 词汇表在根 `CONTEXT.md`，决策记录在 `docs/adr/`。
**这两个都还不存在** —— 按 `docs/agents/domain.md` 的约定，「不存在就静默跳过」，
既不要报缺失，也不要预先创建。改 `src/` 之前先读 `README.md`，那里已有全部领域知识。
