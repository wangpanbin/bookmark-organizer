# AGENTS.md

Chrome MV3 书签整理扩展。原生 ES Module，零构建，`load unpacked` 直接跑。

- 完整产品说明、目录结构、踩坑记录与验收阈值见 `README.md` —— **改代码前先读它**，本文件不重复。
- 重排书签树是破坏性操作，只由用户在面板点「执行整理」触发，扩展**永远不会自动执行**。

## Commands

| 命令 | 作用 |
|---|---|
| `npm test` | 单元测试（Node 内置 test runner；需 Python 做文件枚举） |
| `npm run test:falsify` | 产品级证伪：备份源码、打坏补丁、跑整套、断言变红、再还原 |
| `npm run test:e2e` | E2E（需要完整 chromium + 有头模式） |
| `npm run test:all` | 全套验证 |
| `npm run package` | 打包产物 |
| `npm run gate:privacy` | 隐私闸门：扫所有将推送的 blob，查真 key / 真实书签数据 |

单测由 `tools/precommit.py` 枚举 `tests/unit/*.test.js` 后**显式**交给 node。两条别踩：
- **别把 glob 当单个参数传给 `node --test`**（`node --test "tests/unit/*.test.js"`）——
  只有 Node 22+ 认，Node 20 上会静默地什么都不跑，退出码还可能是 0。CI 首次实跑就是这么红的。
- **别传目录**（`node --test tests/unit`）—— 本机会报 `MODULE_NOT_FOUND`。

`python tools/precommit.py` 是**提交前闸门**：暂存区的 `.js`/`.mjs` 过 `node --check`、`.json` 过 parse，再跑一遍单测（2 秒、零浏览器）。已接成本机 `.git/hooks/pre-commit`，每次 `git commit` 自动跑。
⚠️ `.git/` 不进版本库，所以**每台机器要装一次**：把下面这行写成 `.git/hooks/pre-commit` 并 `chmod +x`（Windows 用 Git 自带的 bash）——
`exec python "$(git rev-parse --show-toplevel)/tools/precommit.py"`
不接线的代价是实测过的：170 条单测与 10 处证伪点从来没被要求跑过，于是「全绿」和「没跑」长得一模一样。
E2E 与证伪**故意不**进钩子——它们要开浏览器、分钟级，塞进每次提交会变成没人愿意等的门。

本机 `node --test <目录>` 会把目录当模块解析报 `MODULE_NOT_FOUND`，脚本里已改用 glob。

## 三条不可破的约束

0. **`fail-log.js` 同属写操作模块。** 它会发网络请求（本机接收器），
   被纯链路 import 就意味着 dry-run 不再零外发。已进 `FORBIDDEN_IN_PURE_CHAIN`。
   ⚠️ 那个列表是**文件名后缀匹配**：新模块名不要以 `storage.js` / `apply.js` /
   `llm.js` / `tree.js` / `backup.js` / `background.js` / `fail-log.js` 结尾 ——
   `xxx-storage.js` 会**因为名字**被判成 `storage.js`。
1. **`plan.js` 不 import 任何写操作模块。** 这是 dry-run 零写入的全部依据，由 `tests/unit/plan.test.js` 的静态断言守着。扫描器（`tests/helpers/sourceScan.js`）必须同时覆盖：具名 / 默认 / namespace / 副作用 / re-export / **跨行子句** / **动态 import**，且**扫描前先去掉注释**。
   - 漏掉副作用导入 → `import './apply.js'` 整条绕过。
   - 子句正则用 `[^;\n]*?` → `import {\n a,\n} from './apply.js'` 整类绕过。
   - 不去注释 → JSDoc 里的 `{import('./x.js')}` 被当真导入，闸门**因为错误的原因而红**。
   - 三条都有对应的长期回归：`npm run test:falsify` 里的跨行/动态两个用例，加 `falsification.test.js` 里的误报用例。
2. **`storage.js` 的读-改-写在同一个串行临界区内。** 不采用「内存累积 + hydrate」，那种写法要防的竞态恰是它自己引入的。
3. **去重保留 hash 路由、只剥跟踪参数白名单。** `example.com/#/settings` 与 `example.com/#/profile` 是两个页面；过度归一化会把它们判成重复，进而删掉用户真收藏的条目。

> 绿灯本身不算证据。一道从来没红过的闸门，和没有闸门是一样的。
> 改闸门时至少跑一次 `npm run test:falsify`，确认它确实会红。

## Agent skills

### Issue tracker

Issues and specs live as local markdown under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles kept as-is: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.
