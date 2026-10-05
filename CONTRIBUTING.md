# 贡献指南

零构建项目：原生 ES Module，没有打包器，改完 `load unpacked` 就能跑。
上手前先读 [`README.md`](README.md)（产品说明 + 踩坑记录 + 验收阈值）
和 [`AGENTS.md`](AGENTS.md)（给 agent 的硬约束）。

## 环境

只需要 Node（跑测试）和 Python 3（跑证伪脚本、日志接收器、打包）。
**不需要 `npm install` 才能跑单测** —— 用的是 Node 内置 test runner，零依赖。

```bash
node --version    # 需要能跑 --test 的版本（18+ / 20+ / 24 都可）
python --version
```

E2E 需要 Playwright 的 chromium；不装也不影响单测与证伪。

## 提交前必过

```bash
python tools/precommit.py     # 语法 + JSON + 全部单测
```

这个闸门已经挂在 git 的 `pre-commit` 上，正常 `git commit` 会自动跑。
它拦住的是**语法错**和**单测红**，拦不住 E2E —— E2E 要开有头浏览器，太慢。

想手动全跑：`npm run test:all`。

## 两类闸门，缺一不可

| 闸门 | 命令 | 作用 |
|---|---|---|
| 单元测试 | `npm test` | 纯函数级别的契约 |
| 产品级证伪 | `npm run test:falsify` | **备份源码 → 打坏补丁 → 跑整套 → 断言变红 → 还原** |
| E2E | `npm run test:e2e` | 真浏览器 + 真书签树 |

> 绿灯本身不算证据。一道从来没红过的闸门，和没有闸门是一样的。
>
> **改了闸门（测试/扫描器）就必须跑一次 `npm run test:falsify`**，
> 确认它确实会因为你注入的缺陷而变红。没红过就等于没写。
> `tests/product_falsification.py` 里那 10 个用例就是干这个的。

## 三条不可破的约束

改动碰到这些区域时，先读 `AGENTS.md` 对应段落：

1. **`src/plan.js` 不 import 任何写操作模块。** 这是 dry-run 零写入的全部依据，
   由 `tests/unit/plan.test.js` 的静态断言守着。改这个文件等于改产品的安全承诺。
2. **`src/storage.js` 的读-改-写在同一个串行临界区内。** 不要改成「内存累积 + hydrate」。
3. **去重保留 hash 路由、只剥跟踪参数白名单。** `example.com/#/settings` 和
   `example.com/#/profile` 是两个页面，过度归一化会删掉用户真收藏的条目。

另外 `src/fail-log.js` 同属**写操作**模块（它会发网络请求），
名字也不能以 `storage.js` / `apply.js` / `llm.js` / `tree.js` / `backup.js` /
`background.js` / `fail-log.js` 结尾 —— 那个禁用列表是**文件名后缀匹配**，
`xxx-storage.js` 会因为名字被判成 `storage.js`。

## 提交信息

[Conventional Commits](https://www.conventionalcommits.org/)：

```
feat(dedupe): 去重逐条否决，补 import 扫描洞
fix(apply): 计划里的书签 id 失效时按 URL 自愈
docs(readme): 补两条本轮真实踩的坑
chore(privacy): E2E 夹具脱敏
```

写清楚**为什么**，不只写改了什么。这个仓库的 commit message 本身就是排障记录，
读一遍能省你几天。

## 别提交的东西

| 内容 | 为什么 |
|---|---|
| `src/llm-key.local.js` | 注入的 API key。已被 `.gitignore` 挡住，**永远别 `git add -f`** |
| `F:\logs\bookmark-organizer\*.jsonl` | 失败日志里有**用户的真实书签 URL** |
| `tests/.` 开头的文件 | 测试运行产物，每次都不一样 |
| `dist/`、`*.zip` | 打包产物 |
| 任何真实书签数据 | 见下 |

**如果不小心提交了密钥或真实数据，改文件是不够的** ——
`git log -S<内容>` 仍能把明文从历史里捞出来。必须重写历史，并且**轮换密钥**。

### E2E 夹具为什么要脱敏

`tests/e2e/repro-real.js` 的夹具**必须**长得像真的（私租户 wiki、28 位不透明 token、
`%2F`/`%3A` 嵌套重定向、校内私有域），否则这个回归测试就变成空转。
但里面**不能是用户的真实书签** —— 私租户的 wiki token 等于文档访问凭证。

所以约定：**形状保留，身份全换**。租户名、学校名、品牌、token 一律用合成值。
新增合成值时同步更新隐私闸门的白名单，否则闸门会红（这是刻意留的摩擦）。
