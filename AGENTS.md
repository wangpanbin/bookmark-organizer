# AGENTS.md

Chrome MV3 书签整理扩展。原生 ES Module，零构建，`load unpacked` 直接跑。

- 完整产品说明、目录结构、踩坑记录与验收阈值见 `README.md` —— **改代码前先读它**，本文件不重复。
- 重排书签树是破坏性操作，只由用户在面板点「执行整理」触发，扩展**永远不会自动执行**。

## Commands

| 命令 | 作用 |
|---|---|
| `npm test` | 单元测试（Node 内置 test runner，零依赖） |
| `npm run test:falsify` | 产品级证伪：备份源码、打坏补丁、跑整套、断言变红、再还原 |
| `npm run test:e2e` | E2E（需要完整 chromium + 有头模式） |
| `npm run test:all` | 全套验证 |
| `npm run package` | 打包产物 |

本机 `node --test <目录>` 会把目录当模块解析报 `MODULE_NOT_FOUND`，脚本里已改用 glob。

## 三条不可破的约束

1. **`plan.js` 不 import 任何写操作模块。** 这是 dry-run 零写入的全部依据，由 `tests/unit/plan.test.js` 的静态断言守着（import 扫描要覆盖具名/默认/namespace/副作用/re-export 五种写法，漏掉副作用导入就能整条绕过）。
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
