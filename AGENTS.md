# AGENTS.md

Chrome MV3 书签整理扩展。业务源码（`src/` 与 `ui/`）是原生 ES Module，`load unpacked` 直接跑。

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

> **文档是分层的，别把 README 当唯一入口**（2026-10-06 起拆开）：
> `README.md` = 产品说明 + 导航；深度参考在 `docs/`。
> **改代码前**先读 `README.md` 的相关功能节；下列场景直接去 `docs/`：
>
> | 场景 | 去哪 |
> |---|---|
> | 症状对得上某条历史 bug | `docs/lessons-learned.md`（按症状 Ctrl+F） |
> | 要改闸门 / 加判据 | `docs/testing.md` |
> | 要改任何阈值 | `docs/acceptance-thresholds.md` |
> | 要动语义去重阈值 | `docs/semantic-calibration.md` |
> | 要改面板上给用户看的说明 | `docs/panel-help.md` —— **它就是面板「帮助」页签的内容**，见下面「面板」一节 |
| **改面板的 DOM id** | 两份白名单要同步：`tools/ui_contract_gate.py` 的 `GATED` 与 `tests/unit/reachability.test.js` 的 `NEW`。漏改的后果是**点按钮没反应、且没有任何报错** |
| **改配色** | 一份色板有**四处副本**：`ui/options.css` 的亮色块、`ui/options.css` 的**两块**暗色块（手动切换 / 系统偏好，逐字相同）、`ui/popup.html` 的内联 `:root`、`tools/contrast_gate.py` 的 `INK`/`BASE`。`ui_contract_gate.py` 会逐项对拍，四处任何一处漂了都会红 |
>
> 还在讨论的 spec / issue 草稿在 `.scratch/`（已 gitignore）。**别把它们当既定设计引用**，
> 也不必为「文档缺失」报问题 —— 定稿后才进 `docs/`。
>
> 本文件（硬约束）与 `docs/testing.md`（闸门体系）是**两份不同职责的权威**，
> 别把同一条规则抄到第三个地方 —— 已经开始沉积过一轮了。
> 规则本体一律写在本文件，细节与解释写 `docs/`。
>
> 重排书签树是破坏性操作，只由用户在面板点「执行整理」触发，扩展**永远不会自动执行**。

## Commands

| 命令 | 作用 |
|---|---|
| `npm run build:vendor` | 重建 `src/vendor/pi-ai.js`。**改了 `src/ai/vendor-entry.js` 就必须跑** |
| `python tools/archive_sink.py --selftest` | 归档接收器自检：写一条再读回，判据是磁盘上真的多出文件、**且文件名跨进程稳定** |
| `npm test` | 单元测试（Node 内置 test runner；需 Python 做文件枚举）。⚠️ **不跑静态闸门**，见下 |
| `npm run gate:ui` | 面板 DOM 契约（`tools/ui_contract_gate.py`），亚秒静态 |
| `npm run gate:contrast` | 前景/背景对比度（`tools/contrast_gate.py`），亚秒静态 |
| `npm run test:falsify` | 产品级证伪：备份源码、打坏补丁、跑整套、断言变红、再还原。⚠️ **不是只读**，不能与任何编辑/测试并发 |
| `npm run test:e2e` | E2E（**默认 headless，不弹窗**；需要开窗调试用 `BO_E2E_HEADED=1`，见约束 12） |
| `npm run test:scope` | 手动指定书签范围的 E2E：两组对照 + 确认弹窗文案 + 失效不按 URL 认领（同样默认 headless） |
| `npm run test:all` | 全套验证。⚠️ **不含** `test:scope`，也**不含**对比度闸门 |
| `npm run package` | 打包产物 |
| `npm run gate:privacy` | 隐私闸门：扫所有将推送的 blob，查真 key / 真实书签数据 |

单测由 `tools/precommit.py` 枚举 `tests/unit/*.test.js` 后**显式**交给 node。两条别踩：
- **别把 glob 当单个参数传给 `node --test`**（`node --test "tests/unit/*.test.js"`）——
  只有 Node 22+ 认，Node 20 上会静默地什么都不跑，退出码还可能是 0。CI 首次实跑就是这么红的。
- **别传目录**（`node --test tests/unit`）—— 本机会报 `MODULE_NOT_FOUND`。

`python tools/precommit.py` 是**提交前闸门**：暂存区的 `.js`/`.mjs` 过 `node --check`、`.json` 过 parse，
**再查一遍编码损坏（U+FFFD）**，然后跑两个亚秒级静态闸门，最后跑一遍单测（2 秒、零浏览器）。
开关只有两个：`--all` 查 `src/ ui/ tests/ tools/ docs/` 全部文件（CI 走这条），
`--fast` 跳过静态闸门。⚠️ **`npm test` 走的是 `--tests-only`，它把静态闸门整段跳过** ——
于是「单测全绿」与「面板契约和对比度都过」是两件事，只跑 `npm test` 时面板可以烂着。
已接成本机 `.git/hooks/pre-commit`，每次 `git commit` 自动跑。
⚠️ `.git/` 不进版本库，所以**每台机器要装一次**：把下面这行写成 `.git/hooks/pre-commit` 并 `chmod +x`（Windows 用 Git 自带的 bash）——
`exec python "$(git rev-parse --show-toplevel)/tools/precommit.py"`
不接线的代价是实测过的：单测与十几处证伪点从来没被要求跑过，于是「全绿」和「没跑」长得一模一样。
E2E 与证伪**故意不**进钩子——它们是分钟级的真实浏览器流程，塞进每次提交会变成没人愿意等的门。

那道 U+FFFD 检查不是洁癖：一次会话里写文件把中文截断出 7 处 `�`，
**全套单测全绿、语法检查全过**，靠另一个 agent 做字节级扫描才发现。写完中文注释别指望肉眼。

本机 `node --test <目录>` 会把目录当模块解析报 `MODULE_NOT_FOUND`，脚本里已改用 glob。
**条数别写进任何文档** —— `docs/testing.md` 明写「写死的数字会变成没人更新的谎话」，
要当前条数看闸门自己的输出。

## 不可破的约束（编号 0–12）

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
   `chrome.debugger` / `fetch` / `XMLHttpRequest` / `WebSocket` / `sendBeacon` /
   `importScripts` / `indexedDB` 全部在 `FORBIDDEN_RUNTIME` 里。理由：link-scan 要用的恰好就是这批能力，
   而旧清单对它们**覆盖为零** —— 一道看不见的网等于没有网。
   加新能力时同步在 `falsification.test.js` 补「会红」与「不误报」两个方向的用例。
2. **`storage.js` 的读-改-写在同一个串行临界区内。** 不采用「内存累积 + hydrate」，那种写法要防的竞态恰是它自己引入的。

   **网络操作一律在临界区之外**，结果压成一份 `delta` 再进 `mutate` 基于**当前**值累加
   （`mutate` 的 fn 内不许 await 长耗时操作，见 `storage.js` 的 `serialize` 注释）。
   凡是「读 → 改 → 写同一个键」的形状，闸门在 `tests/unit/falsification.test.js`
   的「storage 读-改-写闸门」一节，判据是 `findStorageRmw`（`tests/helpers/sourceScan.js`）：
   > 同一个键先 `get` 进变量、改、再把这个变量 `set` 回去。
   >
   > **整份写入不算违规**（`set(K.LINK_STATE, {...})` 建新一轮状态是绝大多数正当写法），
   > 禁得越宽闸门越快被学会忽略。确实需要豁免就写 `storage-rmw-ok: <理由>`，**理由不能为空**。

   ⚠️ **游标类状态还要多一道守卫**，只用 `mutate` 不够：
   两个调用（双击按钮 / 闹钟与面板重叠）会读到**同一个**游标，各自推进后整份覆盖，
   中间那批条目被**永久跳过**，面板显示「扫完了」而它们从没被处理。
   所以 `mutate` 的 fn 里要校验「当前值仍是我出发时看到的那个值」，不符就返回 `SKIP` 不写 ——
   宁可这一片不计数（下一片重做，探测是幂等的 GET），也不推进别人的游标。
   范例：`src/scan/runner.js` 的 `advanceCursor`（round + cursor 双指纹）、
   `src/archive/run.js` 的 `archiveSlice`（cursor 指纹）。
   `scheduler.js` 里那条防范「两个游标互相覆盖」的注释，防的正是这两处 ——
   一道自己模块不遵守的注释不叫防线。
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
   ⚠️ 表里的路径**相对仓库根**解析（2026-10-07 起，之前一律 `join(SRC, rel)`），
   所以 `ui/` 的模块也登记得进来。写 `ui/markdown.js` 时就是照旧写法只填了文件名，
   规则说「要登记」而登记入口对 `ui/` 是不开的，于是帮助页签的渲染器就漏出去了。

   ⚠️ 这道闸门查的是「名字在别的文件里出现过」，**不是「被调用过」**。
   一行 `import { foo } from './x.js'` 就足以满足它，于是「import 了但没人调」照样全绿
   （2026-10-06 实测：删掉调用点只留 import，18 条相关单测一条没红）。
   关键逻辑要**额外**断言调用 —— 范例见 `provider-registry.test.js` 的
   「runtime.js 真的调用了 resolveJsonMode」：判据找 `foo(`，**括号是关键**，裸名字匹配会再次栽在 import 上。
8. **不许承诺界面上做不到的事。**
    「界面在说什么」多数静态查不了，靠评审读文案 + 前科留在代码注释里：
    `ui/options.js` 的 `linkSuggestionCell` 与 `src/background.js` 里 `linkPropose`
    被删掉的那段，记着「采纳替换」按钮为什么必须拿掉。**界面承诺一件永远不会发生的事，
    比功能缺失更伤** —— 用户会据此安排自己的工作。宁可没有那个按钮，并把缺口写进文档。
    （能自动化的部分已自动化，且 2026-10-08 补上了一处**真实缺口**：
    判据 11 只扫 `options.html`，而面板文案大量写在 **`ui/options.js`** 里 ——
    「需逐条确认」正是从 JS 的 `textContent` 溜过去的。
    现在由判据 15「动作出口」覆盖 `js + html` 两侧，
    扫描范围同样含 **`docs/panel-help.md`**（它在运行时被渲染进 `options.html`，
    就是面板内容本身；只扫 `ui/` 等于给承诺留了一条侧门。））
9. **读一个设置项之前先确认它被定义了。** `s.linkScanAiFind !== false` 在
   `DEFAULT_SETTINGS` 里没有该项时是**恒真**的 —— 功能「正常」，只是没人能关掉它。
   `tests/unit/falsification.test.js` 现在扫全 `src/` 找这种读法。
10. **「用户圈定的范围」这条承诺，不能只押在上游裁剪上。**

   手动整理（F4）的全部价值是「清单之外的书签一条都不动」。面板已经用清单裁过一遍计划，
   但计划载荷与你当时勾的东西之间隔着好几层：storage 里的残留计划、面板的旧状态、
   中途被别的预览覆盖、service worker 被回收后续跑。任何一层漏了，
   后果是**静默搬动用户没勾的书签，而且报告上显示 100% 成功**。

   所以执行器（`apply.js` 的 `isInScope`）必须在每次 `move` 之前再核一次，
   与 `processDuplicates` 复核 `dedupe:veto` 是同一个道理：
   **「用户明确说了不动的条目被执行器动了」是不可逆损失，执行侧必须自己认名单。**

   配套三条推论，改这块时别踩：
   - `task.scopeIds` **必须落盘**。SW 空闲 30 秒即被回收，`resumeExecution` 是
     **新进程**从 storage 读回这个 task 的，只留在内存里等于续跑时没有范围校验，
     而界面上看不出任何区别。
   - 执行器**不许**自己去读 `scope:list`。范围只认启动时那份载荷快照，
     这样用户执行期间改清单不会与执行器抢同一个键，也不需要额外加锁。
   - `scopeIds` 的 `null` 与 `[]` 是**两件不同的事**：`null` = 全量、不限制；
     `[]` = 子集而清单是空的、什么都别动。写成 `!scopeIds.length` 会让
     「清单空着」变成「整棵树随便动」。

11. **根 id 永远不是常量，而同一个根因会在不同地方各犯一次。**
   2026-10-05 的 45 条书签全军覆没，根因是「书签栏 = id '1'」。第一次犯在
   `targetRoot` 设置项上（`target-root.test.js` 守着），**第二次犯在
   `src/backup.js`** —— 它压根没读设置，自己定义了 `ROOT_ID = { BAR:'1', ... }`，
   注释还写着「根 id 是固定契约」。**第一道闸门对此全绿**，
   因为它量的是一个没有覆盖到出问题那条路径的指标。

   `tests/unit/root-id-literal.test.js` 是为此补的窄判据。
   加新闸门时要记住：**闸门量的是它写的那条路径**，不是问题的全貌。
   判断一个新判据够不够，要问「出问题时它量的是不是同一个指标」。

12. **E2E 默认 headless，不要开窗。**

   `tests/e2e/harness.js` 走 `channel`（系统 Chrome/Edge），
   `headless: true` 用的是**真实浏览器的新 headless 模式**，扩展照常工作
   （本机 Edge 154 实测 service worker 正常出现，主干与手动范围两套全绿且不弹窗）。

   ⚠️ 曾经有一阵规则写着「扩展类 E2E 必须有头模式」，理由是
   `chromium_headless_shell` 不支持加载扩展。**那条限制只对 Playwright 自带的
   chromium 成立**：自带 chromium 在 `headless: true` 时用的正是 headless_shell，
   而走 channel 时不是。两条限制被混成一条，于是「必须弹窗」一直没人质疑。

   要肉眼调试用 `BO_E2E_HEADED=1`（或 `launchWithExtension({ headed: true })`），
   **不要**把默认值改回有头。

   同一处还压着三条环境事实，都不是风格问题而是本机实证的坑：
   - **Chrome 155 已移除 `--load-extension`**（Edge 154 仍支持）。
     通道链只对「二进制缺失」回退，其他错误必须立刻抛 ——
     把真问题降级成「换个浏览器再试」会把排查带偏一整轮。
   - **扩展路径不能含空格**：浏览器正常启动、扩展根本没加载，
     只表现为 `waitForEvent('serviceworker')` 超时。极易误判成「扩展坏了」。
   - **复制扩展时路径必须在进程内稳定**：unpacked 扩展 id 由绝对路径哈希而来，
     路径一变 id 就变，`chrome.storage.local` 按 id 分区 ——
     「跑一半关浏览器、同 profile 重开继续跑」会读到**空的 `task:current`**，
     症状是「执行记录整个消失了」，而真因是一个没人会想到的临时目录名。

## 面板（`ui/`）：颜色、归属、运行时文档

面板重排在 2026-10-07 之后，下面几件事**改一处会漏另一处**，且漏了往往不报任何错。

- **改一个颜色要动三个文件。** `ui/options.css`（真源）、`ui/popup.html`（**手工副本** ——
  它不引 options.css，漏了不会有任何报错，只是主面板和工具栏弹窗成了两个色系）、
  `tools/contrast_gate.py` 的 `INK` / `BASE`（**纯字面量，不读任何文件** ——
  「改 CSS 不改它」时它照样 PASS，一道量着自己字面量的闸门对真实色板一行都量不到）。
  `ui_contract_gate.py` 三处互校，`_sync_map` 就是那张对照表。
  ⚠️ 从 CSS 里删掉一个 token 时，`_sync_map` 里那一行也要删 ——
  两边都读不到时它只报 `None/None`，那不是「不一致」。
- **暗色调色板写了两遍，必须逐字相同**（`:root:not([data-theme="light"])` 与
  `:root[data-theme="dark"]`）—— CSS 没有「媒体查询 + 属性覆盖」的组合选择器。
- **`#hero`（整理栏）只属于「计划明细」页，`#busy` 是全局浮层、不属于任何页。**
  归属靠 `<section>` 的**配对扫描**判定，不能用非贪婪正则 ——
  `#panel-plan` 里有嵌套 `<section>`，非贪婪会在内层 `</section>` 处截断。
  E2E 直接断言「其余页签上这几个 id 一个都不可见」，所以改 DOM 形状前先读
  `ui_contract_gate.py` 里 `_section_span` / `hero_is_inside_plan` / `busy_outside_plan` 三段自检。
- **`ui/theme-boot.js` 必须是 `<head>` 里的经典同步脚本。** MV3 扩展页 CSP 是
  `script-src 'self'`，行内脚本被直接拦掉；而 `options.js` 是 `type="module"`（天生 defer），
  等它跑完第一屏已经用系统偏好画完了，再切暗色就是一次白闪。
  它刻意用 `localStorage` 而不是 `storage.js`：`chrome.storage.local` 是异步的，来不及。
- **`ui/markdown.js` 不碰任何 chrome API**，`document` 是注入参数 —— 这样 Node 下能直接单测。
  它已经因此抓到过两个「浏览器里只表现为排版有点怪」的 bug。一律用 DOM API 拼节点，**禁止 innerHTML**。
- **`docs/panel-help.md` 在运行时被 fetch**，路径写死三处：
  `ui/options.js` 的 `HELP_DOC_URL`、`tools/package.py` 的 `INCLUDE_DOCS`、
  `tests/e2e/harness.js` 的 `RUNTIME_DOCS`。`ui_contract_gate.py` 校这三处一致 ——
  漂了的症状统一是「帮助页签空白」，但会被分别归因到三个不相干的地方。
  另外两处必须同时改，否则症状一样但没人想得到：**打包白名单**（`docs/` 只放行这一个文件，
  多漏一个工程文档就等于发给终端用户）与 **E2E 副本过滤**
  （`cpSync` 的 filter 里 `docs/` **目录本身**必须返回 true，否则整棵子树被剪掉，文件根本没机会被访问）。
  文风也受限：渲染器只认一个 Markdown 子集（**不许表格、不许引用块、不许嵌套列表**，链接只放行 https），
  写在 `docs/panel-help.md` 头部。改它等于改界面文案，要过约束 8 那道承诺闸门。

> ⚠️ **`npm run test:falsify` 不是只读的。** 它会**修改真实源文件**、跑一遍整套、
> 再还原。所以它**不能和任何编辑或测试并发** —— 你今天已经因此拿到过一次假失败
> （证伪正在给 `normalize.js` 注入 `indexedDB`，而你同时跑了 `npm test`，
> 纯链路闸门理所当然地红了）。
>
> 跑它的时候：**什么都不做，等它自己结束。** 它的单次运行是分钟级。
> 另外它结束时**必须 rc=0**：退化全红但有一处关键字没匹配上时，
> 脚本同样返回 1 —— 那不是「闸门失灵」，是**量具没对准**，
> 看输出里的「实际标题」那一行去改关键字。

> 绿灯本身不算证据。一道从来没红过的闸门，和没有闸门是一样的。
> 改闸门时至少跑一次 `npm run test:falsify`，确认它确实会红。
>
> ⚠️ **它验的是什么、不验什么**（2026-10-08 补充，因为它容易被读反）：
> 它验证的是**既有闸门系统自洽** —— 「每处退化能不能让整套测试变红」。
> **它不覆盖**你这次新增的判据：新判据没写进 `tests/product_falsification.py`
> 的用例里，**不会**让它返回 1，也不会让它验证你的新判据。
> 想验新判据，只能在 `npm test` 里跑，或单独写一次「打坏 → 确认变红」。
> 混淆这两件事的典型症状：看到新判据不在用例列表里就断言「这次跑不过」——
> 而它其实会 rc=0，因为新判据根本不在它的职责范围内。
>
13. **闸门自持的副本，必须由另一道检查去比对。**
    `contrast_gate.py` **不读任何文件**，它的色值是硬编码字面量 —— 于是
    「改了 CSS 没改它」时它照样 PASS，一道量着自己字面量的闸门对真实色板
    一行都量不到，而**没有任何东西会红**。症状不是某个对比度超标，
    是整个对比度体系悄悄失效。
    同形的还有色板在 `popup.html` 的手工副本、运行时文档在
    `package.py` / `harness.js` 两份白名单。
    **判据**：凡是「闸门读的不是被闸的那个文件」的复制品，要么让闸门真去读，
    要么由**另一道**检查比对两者。抄进闸门的常量不算保护，只算自我担保。
14. **改带中文的文件，用脚本做行区间编辑，不要用 shell 整文件写入。**
    本仓库注释几乎全是中文，中文密度高到让**任何整文件覆写**都成为高风险操作。
    真实翻车（2026-10-08）：用 shell 的整文件写入改 `ui/options.html`，
    前一句抛异常、**后面的写入照样执行**，文件被截到 159 字节，473 行丢失。
    靠 `git checkout` 救回来 —— 那是运气，不是设计。
    为什么既有闸门全都放过它：截断后的片段**仍是合法文件**（语法检查过、
    编码没有 U+FFFD、单测不读它）。**所有既有闸门都只检查「文件是否合法」，
    没有一个检查「文件是否还是原来那个文件」。** 现由 `precommit.py` 的
    `check_truncation` 补上，闸门自身：`python tools/precommit.py --selftest`。
    实操：**先写 `.py` 脚本**、跑完再删，别用 `Set-Content` / `WriteAllLines`
    直接落盘。Windows 上 PowerShell 的 `[List[T]].AddRange` 会抛
    `MethodException`，而**异常之前的写入已经生效**。
15. **界面文案不许承诺一个「用户点了就能走通」的动作出口。**
    真实翻车（2026-10-08）：面板写着「N 条低置信……**需逐条确认**」，
    而全仓库**没有任何代码**把 `awaiting-confirm` 放回执行队列 ——
    那个出口根本不存在，用户点不了。症状不是报错，是面板平静地说着假话。
    - 机械判据：`ui_contract_gate.py` 的「动作出口」那条，抓「需/请 + 动作」
      这种**正向承诺**且代码里找不到对应入口的情形。
    - ⚠️ 判据是**点名制**：承诺字样 ↔ 兑现它的入口，一一对应。
      刻意**不**做「面板上有任何入口就放行」—— 首版就是这么写的，
      实测注入坏文案后它照样 PASS：批量改判按钮确实在，但那个按钮
      与「逐条确认」毫无关系。**承诺是具体的，兑现也必须具体**，
      一个不相干的入口不能替另一个承诺背书。
    - 刻意**不**判反向陈述。「扩展不会替你改书签」「永远不会自动删除任何书签」
      是本仓库的好实践（把边界说清），一条都不会误报。
    - 抓的是**形状**，抓不住「承诺的动作存在但实现是错的」—— 那种仍需评审。

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

本仓库配了 skills 工作流，细节在 `docs/agents/`。只有两条是代码工作用得上的：

- **Issue 走 GitHub Issues**（`gh` CLI，仓库 `wangpanbin/bookmark-organizer`）。
  `.github/ISSUE_TEMPLATE/*.yml` 只对网页端人工填报生效，`gh issue create` 会**绕过**模版，
  所以 agent 建 issue 必须自己带 `--label`；五个 triage label 在远端**已存在**，直接 `--add-label`，不要新建。
- ⚠️ 仓库是 **public**：issue 正文里**绝不**贴真实书签标题/URL、key、token、本机绝对路径。

`CONTEXT.md` 与 `docs/adr/` **都还不存在** —— 按 `docs/agents/domain.md` 的约定「不存在就静默跳过」，
既不要报缺失，也不要预先创建。改 `src/` 之前先读 `README.md`，那里已有全部领域知识。
