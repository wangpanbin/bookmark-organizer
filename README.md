# 书签整理助手

[![CI](https://github.com/wangpanbin/bookmark-organizer/actions/workflows/ci.yml/badge.svg)](https://github.com/wangpanbin/bookmark-organizer/actions/workflows/ci.yml)
[![Chrome 116+](https://img.shields.io/badge/Chrome-116%2B-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

Chrome MV3 扩展。按「功能」把已收集的书签自动归类到两层中文文件夹，**先预览、确认后再写入**，全程可回滚。

业务源码零构建：原生 ES Module，不引打包器。`load unpacked` 直接跑。

> **唯一例外是 `src/vendor/pi-ai.js`**（约 601KB），它由 `npm run build:vendor`
> 用 esbuild 从 npm 依赖 `@earendil-works/pi-ai` 打成的一个本地文件。
> 扩展解析不了裸模块名，这是唯一的办法。
> **产物提交进版本库** —— CI 用 Node 20 且不装依赖，产物不进库它无从校验；
> 另存一份目录拷到别的电脑也要能直接加载。
> 改了 `src/ai/vendor-entry.js` **必须**重跑 `npm run build:vendor`，
> `tests/unit/vendor-path.test.js` 会拦住「改了没重建」。
> 除这个产物外，仓库其余部分仍然是零构建原生 ESM。

---

## 深入阅读

本 README 是入口与产品说明。**深度参考与历史在 `docs/`**：

| 文档 | 什么时候去看 |
|---|---|
| [docs/testing.md](docs/testing.md) | 三类闸门（正向 / 证伪 / E2E）各自守什么、怎么跑、跑之前必须知道什么、**当前的覆盖缺口** |
| [docs/acceptance-thresholds.md](docs/acceptance-thresholds.md) | 每个数字为什么是这个数字，以及**它到底校准过没有** |
| [docs/lessons-learned.md](docs/lessons-learned.md) | 症状对得上时按症状查（大部分坑表现为「某个功能就是不工作」，根因在别处） |
| [docs/semantic-calibration.md](docs/semantic-calibration.md) | 语义去重阈值怎么用真实数据校准 |
| [AGENTS.md](AGENTS.md) | 改代码前的硬约束（agent 与新人的权威副本） |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 提 issue / PR 之前 |

---

## 安装

1. 打开 `chrome://extensions`
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」，选择本目录（含 `manifest.json` 的那一层）
4. 点扩展图标 → 「打开整理面板」

> 另存一份目录拷到别的电脑也能直接加载，扩展不依赖任何本机文件。
> 需要的权限只有 `bookmarks` / `storage` / `unlimitedStorage`。
> **host 权限是按需申请的可选项**，不开 LLM 兜底时一个网站访问权限都不需要。

## 用法

1. **读取并预览** —— 读书签树、存一份备份、算好「哪条从哪搬到哪」。**这一步不动你的任何书签。**
2. 看清单。逐条核对：
   - 点 **✗ 改** 选正确分类 → 当场改判，并**沉淀成规则**，下次更准
   - 点 **✓** → 告诉词典这条判得准，也会固化成规则
   - 勾 **锁** → 这条不会被移动（按 URL 记录，移动过位置也不失效）
3. 去「重复项」页逐条过一遍要删的，**不放心的那条勾「不删」**。
4. **执行整理** → 二次确认弹窗会写明：移动几条、新建几个文件夹、删几条重复项
5. 不满意 → **恢复备份**（Chrome 没有原生撤销，这是唯一退路）

「其他 / 待归类」是给你留的归口。第一轮跑完若有几十条落在这里，
在「设置 → 类目结构」里把它改名或拆开，重跑即可，不用重装扩展。

## 手动整理（只整理你勾选的书签）

全量整理的前提是你**接受整棵树都会被重新分类**。不接受的话走「手动整理」页：
先勾选，再预览，最后执行。清单之外的书签一条都不会移动。

1. 切到 **手动整理** 页，点 **选择书签**
2. 勾选。**勾一个文件夹 = 勾它里面的书签**，在勾的那一刻展开成快照，
   之后那个文件夹增删都不影响已经勾好的清单
3. 点 **加入清单** → **预览选中**
4. 核对计划表（就是「计划明细」那一页，**只列清单里的书签**）→ 点 **执行整理**

### 它承诺了什么

| 承诺 | 靠什么做到 |
|---|---|
| 清单之外的书签一条都不移动 | 执行器逐条搬运前再核对一次「在不在清单里」，不在就跳过并记进报告 |
| 清单之外的书签一条都不删除 | 手动模式下删除清单恒为空。去重仍然会算、仍然在「重复项」页可见，只是不进入执行载荷 |
| 分类行为与全量整理一致 | 同一套规则、同一个类目树、同一个执行器。手动模式只是换了一组输入条目 |
| 勾错了不会误伤别的 | 清单里失效的书签标成「已失效」并跳过，**不会按网址去认领另一条同网址的书签** |

### 清单的四种状态

| 状态 | 含义 | 怎么办 |
|---|---|---|
| 待整理 | 还没成功整理过 | 点「预览选中」 |
| 已整理 | 移动成功并回读确认过 | 留着当记录，或用「清空已整理」划掉 |
| 失败 | 这条没搬成，原因在行内 | 点「重试失败项」，只重跑失败的那些 |
| 已失效 | 这条书签在树上找不到了 | 行内写着它勾选时在哪个文件夹，你可以自己判断 |

清单是**数据**不是设置，所以它跨会话保留，关掉面板再打开还在。

### ⚠️ 三个必须知道的边界

- **回滚仍然是全树的。** 手动整理照样会先存一份全树快照，点「恢复备份」会把整棵书签树恢复到那一刻的样子，不只清单里的这几条。
- **移动设备书签动不了。** 那个根是只读的，勾选区里它整片是灰的，行内写明原因。
- **清单里存的是书签 id。** 你把书签删掉再重建，id 会变，那一条就标成「已失效」。这是刻意的：宁可跳过并让你看见，也不替你猜哪一条是「原来那条」。

### 为什么「不在清单里就跳过」要查两遍

面板在预览时已经用清单裁过一遍计划。执行器再核一次不是为了重复劳动，而是因为
计划载荷和你当时勾的东西之间隔着好几层：storage 里的残留计划、面板的旧状态、
中途被别的预览覆盖、浏览器把后台脚本回收后续跑。

这个功能存在的**全部理由**就是「范围外的东西一条都不能动」。把这条保证只押在
上游裁剪上，等于让它建立在一个纯逻辑的正确性上；一旦哪一层漏了，后果是
**静默搬动你没勾的书签，而且报告上显示 100% 成功**。

## 分类是怎么判的

优先级从高到低，首个命中即返回：

| 顺序 | 依据 | 置信度 |
|---|---|---|
| 0 | 面板上手改（`manual:assignments`） | 高 |
| 1 | 人工沉淀的规则（`rules:learned`） | 高 |
| 2 | 域名精确匹配 | 高 |
| 3 | 域名后缀匹配（按点边界） | 中 |
| 4 | 路径关键词 | 中 |
| 5 | 标题关键词 | 低（UI 标黄待确认） |
| 6 | 云端 LLM 兜底（仅对上面都没命中的） | 中 |
| 7 | 落进「其他 / 待归类」 | 低 |

规则表是**纯数据**（`src/classify/dict.js`，37 条规则、804 个域名），不写进任何提示词 ——
确定性、可审计、可单测、零延迟零成本。后缀匹配必须按点边界，
`a.github.com` 命中 `github.com`，但 `notgithub.com` 不会。

## 去重的安全边界

同一页面收藏多次会自动去重，**保留一条、删除其余**。这里最容易出事，所以：

- **保留 hash 路由**。`example.com/#/settings` 与 `example.com/#/profile` 是两个不同页面，
  只有 `#top` / `#_` / `#!` 这类「跳到顶部」的纯锚点才会被剥。
  剥掉 hash 会把不同页面判成重复，进而删掉你真收藏的条目。
- **只剥跟踪参数白名单**（`utm_*` / `from` / `spm` / `share*` 等）。`?id=1` 与 `?id=2` 保留为不同。
- **`http` 与 `https` 视为同一资源**。
- 浏览器内部页（`chrome://`）、本机地址（`localhost`）不参与去重。
- **所有待删条目都会逐条出现在「重复项」清单里，每条都能单独勾「不删」**。
  勾上的条目不进删除清单，确认弹窗会同时显示「已标记为不删」的条数 ——
  勾了却看不到任何变化，就等于没给否决权。
  否决按**条目 id** 记录而不是 URL：同一组的重复项 URL 相同，
  按 URL 记会把保留项也一起保住，去重等于没做。
  执行器在删除前会**再查一次**否决名单，不只信面板的过滤 ——
  面板那一遍可能被上一轮残留的 payload 绕过去，而删除不可逆。

## 备份与回滚

`chrome.bookmarks` **没有导入导出 API**（已核对官方 API 参考页），所以：

- 备份 = `getTree()` 整体序列化 → `chrome.storage.local`（需 `unlimitedStorage`）
- 恢复 = 按快照归位 + 把之后新增的书签移回「其他书签」+ 清掉本次新建的空文件夹 + 重建被删的重复项
- 默认保留最近 10 份，超出按时间淘汰

恢复是**「归位」不是「时间机器」**：它把书签移回快照时的位置，
**不会**撤销你在这期间自己做的编辑。这是能做到的最好程度。

空文件夹的清理由任务记录的 `createdFolders` 精确判定，
不靠「空文件夹」猜 —— 那样分不清是我们建的还是你自己建的。

## 不会自动执行

重排书签树是破坏性操作，扩展**永远不会自动重排**：

- `onCreated` 只累加「待分类 N 条」计数并提示
- 一次 HTML 导入期间会抑制 `onCreated`（官方文档明确要求，
  否则一次导入会触发上千次无效计数）
- 真正整理永远需要你点「执行整理」

## LLM 兜底

规则没命中、落进「待归类」的那一小撮才会发给云端模型 —— **不会外发整个书签列表**。

- 供应商：默认 **DeepSeek**（OpenAI 兼容协议），面板里可切**阿里云百炼**、**Moonshot Kimi（国内）**、**OpenAI**、**MiniMax（国内）**
- ⚠️ **MiniMax 走的是 `anthropic-messages` 协议，不是 OpenAI 兼容**，
  而且它的 baseUrl 是 `https://api.minimaxi.com/anthropic`（带 `/anthropic` 后缀，不是 `/v1`）。
  因此 JSON 模式对它自动关闭 —— Anthropic 请求体里没有 `response_format` 这个字段。
  详见 `src/ai/provider-registry.js` 与 `src/ai/vendor-entry.js` 的注释
- 默认 `baseUrl` = `https://api.deepseek.com`，`model` = `deepseek-flash`，均可改
- 供应商与模型目录统一由 `src/ai/provider-registry.js` 提供，面板下拉由它派生
- 加供应商**不需要**改 `manifest.json`：`optional_host_permissions` 里已有 `https://*/*`，
  Chrome 官方文档写明此时可以请求任意 https 来源（协议匹配即可）
- **默认开启**（`llmEnabled: true`）。想完全不发数据，去「设置」把它关掉；
  关闭后扩展不需要任何 host 权限
- **API key 只存本机 `chrome.storage.local`**，不进 manifest、不进代码、不进 git
- 权限**按需申请**：点「授权访问该域名」才弹窗；host 权限是
  `optional_host_permissions`，用哪个服务商的才申请哪个

### 底层换成了 `@earendil-works/pi-ai`（2026-10-06）

模型访问走 `src/ai/`，实际发请求由 `src/ai/runtime.js` 委托
`@earendil-works/pi-ai`。**你看到的行为没有变**，变的只是底下那一层：

- 30 秒超时、重试与指数退避、400 时降级 JSON 模式、按需权限门控、
  注入的 key 不落盘 —— **全部原样保留**，一条没丢
- `src/ai/errors.js` 里的错误文案逐字未动。它们是逐个对着真实服务商报错写的：
  百炼的 key 与区域强绑定，跨区调返回的 401 看起来和「key 无效」一模一样，
  但修法完全相反（一个改区域，一个换 key）

改动过程中实测到三件与直觉相反、且都会**静默走错**的事，都写进了代码注释：

1. `models.complete()` 失败时**不 reject**，而是 resolve 一个
   `{ stopReason:'error', content:[] }`。当成成功读，401/429/5xx 会全部退化成
   「模型返回了空内容」，整套错误诊断整条消失。
2. 错误被压成扁平字符串（实测就是 `"Connection error."`），**没有状态码也没有响应体**。
   所以 `runtime.js` 注入自定义 `fetch` 把两者截下来，诊断才拿得到。
3. `openaiProvider()` 是 `openai-responses` 而非 openai-completions；
   `minimaxCnProvider()` 是 `anthropic-messages` 而非 OpenAI 兼容。
   协议走错不报错，只会拿到莫名其妙的 404/400。

> `minimax` 暂未接进来：它在 pi-ai 里走 Anthropic 协议，要多带一个 SDK。
> 要接的话只改 `src/ai/vendor-entry.js` + 注册表两处。

### key 从哪来（两级，优先用面板里手填的）

1. **面板手填** —— 存 `chrome.storage.local`
2. **本机环境变量注入** —— `python tools/inject_key.py` 从环境变量读一次，
   写进 `src/llm-key.local.js`。扩展运行时读不到 OS 环境变量（没有 `process`），
   只能在加载前由本机脚本读一次。
   该文件**已 gitignore、不进发布包**，换台电脑没有它也属正常：
   `llm.js` 用动态 `import()` + `catch` 读它，缺文件会安静退化成「无 key」。

⚠️ key 与区域/服务商**强绑定**：用错端点会 401 或 404。
DeepSeek 官方格式是 `https://api.deepseek.com`（不带 `/v1` 也能通）。
模型名变动较频繁且官方说法互相矛盾（`deepseek-chat` 已公告弃用），
所以给了默认值 + 面板预设列表 + 逐类错误提示，不押注单个名字。
模型被要求**只能用给定类目、不许自造**，返回里不存在的类目会被丢弃。

## 移动失败日志

书签没搬成时，失败原因会记到本机 **`F:\logs\bookmark-organizer\<日期>.jsonl`**，
一行一条（JSON Lines，方便 `grep` 或直接喂 Python）。

> **⚠️ `F:\logs\...` 是作者本机的默认路径，多数人没有 F 盘。**
> 换一个目录即可，接收器起动时会用 `--dir`：
>
> ```bash
> python tools/fail_log_sink.py --dir "D:\某目录\bookmark-organizer-logs"
> ```
>
> 目录不存在会自动创建；指定路径所在盘不可用时**启动即报错退出**并说清原因，
> 不会静默换个地方写。不需要日志功能就整个别起接收器 ——
> 扩展在没拿到授权时不会往外发任何东西。

### 为什么需要「本机接收器」

**Chrome 扩展没有任意写本地文件的能力。** MV3 没有文件系统 API，
service worker 里连 `showSaveFilePicker` 都不存在（那只在有 DOM 的面板页，
而且必须由用户手势触发）。所以要把日志落到 `F:\logs`，必须由**本机进程**写 ——
这就是 `tools/fail_log_sink.py` 的全部理由。

### 怎么用

```bash
npm run log:sink              # 起接收器（前台）
npm run log:sink:selftest     # 自检：写一条再读回，证明 F 盘真能落盘
```

或直接双击 `tools\start_fail_log_sink.bat`。然后在「设置 → 移动失败日志」里点一次
**「授权本机日志接收器」**（权限按需申请，和 LLM 兜底同一套做法）。

日志在哪儿、什么格式：

```
F:\logs\bookmark-organizer\2026-10-05.jsonl
{"ts":"…","kind":"move","id":"1234","title":"…","url":"https://…",
 "error":"移动后回读：实际在「收集箱」而不是「开发与技术」…",
 "fromPath":["书签栏","收集箱"],"toPath":["开发与技术","前端"],
 "batch":1759679130000,"chrome":"139.0.7258.67","ext":"1.0.0"}
```

- `error` 直接用执行器的 `explainMoveError()` 文案，**已经是可操作的中文**
  （说清实际落在哪、目标在哪、下一步查什么），不用再翻译一遍。
- `batch` 是本轮任务的 `startedAt`：日志按天追加、跨批次混在一起，
  没有它就没法把某一次执行的失败从整月记录里摘出来。
- `kind` 只记失败：`move`（没搬成）与 `delete`（重复项没删掉）。
  **成功条目不记** —— 800 条规模会刷屏，而排查用不上。

### 接收器没开怎么办

**静默降级，不打断整理。** 失败记录会留在扩展的 `chrome.storage.local` 缓冲里
（上限 200 条），在「设置 → 移动失败日志」点 **「重新导出」** 手动存一份。
执行结束时还会再兜底补发一次。

> 「以为记上了、其实没记」是这个项目栽过最多的坑类型，所以面板上永远有一行
> **接收器状态**（在线 / 离线 / 未授权）。那行是判断「到底写没写进去」的唯一依据。

### 端口

`8731`。它只出现在两个地方：扩展侧 `src/fail-log.js` 的 `SINK_PORT`，
接收器侧 `tools/fail_log_sink.py` 的 `DEFAULT_PORT`。**改端口要同时改两侧**，
否则症状是「状态一直显示离线」。

### ⚠️ 两个必须知道的坑

1. **`Access-Control-Allow-Private-Network: true` 不能少。**
   扩展 origin（`chrome-extension://…`）请求 `127.0.0.1` 属于
   「公开来源访问私有网络」（PNA）。少这个响应头，浏览器会**在 service worker 里
   直接把 `fetch` 掐掉**，现象是「失败明明发生了、日志文件一直没生成」——
   和没接一样。`--selftest` 第一步就查这个头。
2. **新模块名不要以写操作模块名结尾。** 零写入闸门是**后缀匹配**
   （`spec.endsWith(bad)`）：把日志缓冲模块叫 `fail-log-storage.js`，
   会被 `storage.js` 命中而报错。日志模块因此只叫 `fail-log.js`。

---

## 链接健康（死链 / 改链 / 元数据补全）

定时探你书签里的 URL，识别 404、改址与超时，并把页面的作者、发布时间、站点类型、og 图补齐。

> ⚠️ **默认关闭。** 要用请在「链接健康」页点一次「授权访问网站」。
>
> **启用后扩展会做什么**：访问**你书签里的那些 URL**，读它们的 HTTP 状态码、跳转目标与页面头部信息；死链会去 archive.org 查有没有存档快照。
> **不会做什么**：不向任何第三方上传你的书签数据；**不改你的书签**——任何替换都要你在面板上逐条确认后亲自执行。
>
> 这段话不是免责套话：扩展会在你没打开面板时访问几百个域名，
> 用户从 Network 面板看到的就是「这扩展在偷偷联网上上下」。

### 怎么算「死链」

**连续 3 次 404/410，且距上次成功探测 ≥24 小时。**

两条都不是随手定的：

- **只有 404 与 410 算「链接没了」。** 403（要登录）、429（限流）、5xx（服务端抽风）、超时全都不算。把它们算进去，一次网络抖动就能让一批书签集体变死链。
- **为什么是「距上次成功 ≥24h」而不是「最近 3 次」。** Chrome 的 `chrome.alarms` 官方文档写明它 "may delay them an arbitrary amount more"（[官方文档](https://developer.chrome.com/docs/extensions/reference/api/alarms)）——丢一轮时，后者的语义是错的。
- **从来没成功打开过的链接不算死链。** 那不叫「已经死了」，叫「还没探明白」——否则你刚收藏一条拼错的 URL，它就会被建议替换。

### 改址只自动建议同站的

跳到**同一个站**的新路径 → 面板上给「采纳替换」按钮。
跳到**别的站** → 一律标「需人工判断」，**不给按钮**。品牌改名和跳登录页从 URL 上完全无法区分，盲信会毁掉你真收藏的地址。

**扩展永远不会替你改书签。** 同站改址那一行给你新地址，可点开、可复制，你自己决定换不换；死链那一行给存档快照与经探测验证过的候选地址。

> 曾经这里有个「采纳替换」按钮，它登记一条提案、toast 还承诺「到计划明细确认后执行」——
> 而全仓库没有任何代码读那个提案。**界面承诺一件永远不会发生的事，比功能缺失更伤。**
> 为什么不把 URL 改写做成一种计划项接进 `plan.js`：既有 E2E 闸门断言「每条计划项都落在它承诺的文件夹里」，
> 而 URL 改写不落文件夹。要做必须另起工单重新设计它的预览与撤销。

「AI 找新地址」默认**关闭**，要在「链接健康」页手动勾选 —— 开启后会把死链的标题与地址发给你配置的模型服务商。存档快照的查询不经过模型。

### 「疑似软 404」是启发式，不是判定

有的站返回 200 但内容写着「页面不存在」。扩展会标出来，但**明确标注为启发式**，且**不计入失败计数**——特征串匹配一定会误伤一篇讲「HTTP 404 怎么排查」的文章。宁可多让你看一眼。

### 元数据补全

抓 `<title>` / `og:*` / 作者 / 发布时间，并按域名与路径规则识别站点类型（文档 / 视频 / 工具 / 论文 / 代码 / 新闻 / 网页）。**规则认不出来就说认不出来**（标「未识别」），不猜。

> favicon 走 Chrome 自己的 `_favicon` 接口，不额外发请求；取不到才降级到抓 `/favicon.ico`。

---

## 内容归档（防链接腐烂）

「重要页存永久副本，原站挂了也能读」。

**为什么落本机磁盘而不是扩展存储**：扩展一卸载，扩展存储就全没了——那和「永久」在语义上直接互斥。而且 800 条 × 平均正文 100KB ≈ 80MB，本机磁盘才装得下。

```bash
python tools/archive_sink.py --selftest    # 自检：写一条再读回，证明真能落盘
python tools/archive_sink.py              # 起接收器（前台）
```

- 端口 `8732`，**只出现在三处**（改端口要同时改）：`tools/archive_sink.py` 的 `DEFAULT_PORT`、`src/archive/client.js` 与 `src/dedupe/embedding-client.js` 的 `SINK_PORT`（后者用 `/text` 取归档正文喂 embedding）
- 落在 `--dir` 指定的目录，默认 `F:\archive\bookmark-organizer`
- **分级**：全部存 HTML；**只有标记为「重要」的**才额外渲染 PDF 与整页截图
- PDF/截图由 `tools/render_archive.js` 调本机已有的 Chromium 渲染
- ⚠️ 接收器离线时**不静默降级**——面板上直接说「没起接收器」。这与失败日志的静默降级刻意不同：日志丢了只影响排查，而归档是整个功能的全部价值

---

## 语义去重（不同 URL 但同内容）

用 embedding 判断「同一个页面被收藏成好几个 URL」（镜像站、转载站、官方文档与它的镜像）。

> ⚠️ **结果只进「建议合并」，永不进删除清单。**

URL 归一化判重敢自动删，是因为同一组条目的 URL 字符串完全相同。而 embedding 判重完全不同：两篇不同文章语义相近是**常态**，而「站点不同内容同构」在真实世界大量存在。误删你真收藏的内容是这个项目里最贵的错误。

> ⚠️ **默认关闭**，要在「链接健康」页手动勾选。
> 它要把**标题 + 正文摘要**发到百炼做向量化 —— 这是比 LLM 分类更敏感的一类外发，
> 因为向量本身就是你书签的指纹。开启时面板上会明说这一点。
> 归档侧车没开时自动退回「只用标题」，不报错。

在「链接健康」页点「跑一轮语义去重」，结果按相似度排序显示，**刻意没有「合并」「删除」按钮** —— 唯一能做的就是看一眼。

- 模型：百炼 `text-embedding-v4`，1024 维
- ⚠️ **单次最多 10 条**（官方硬限制，超了是 400）
- 输入：**标题 + URL + 正文摘要约 300 字**（正文来自归档侧车；侧车没开就自动退回只用标题）
- 成本：800 条约一毛二，免费额度 100 万 token
- 向量存 IndexedDB（`Float32Array`），**不进 `storage.local`**——后者存 800×1024 维的 JSON 数字是 8MB 字符串，每次读写都要整体序列化
- 换了模型或维度后要点「清空向量缓存」，否则新旧向量会混在一起比

> 🔴 **相似度阈值 0.92 未经真实数据校准。** 它是设计时拍板的保守档初值，
> 不是量出来的 —— 至今没有任何一次真实数据验证过它准不准。
> 采集方案见 [docs/semantic-calibration.md](docs/semantic-calibration.md)。
>
> 顺带一个可能反直觉的实现细节：**URL 被拼进了 embedding 文本**。
> 这会**把镜像站的分数往下拉**（同一篇文章在 A 站和 B 站，向量里带着两个不同的域名串）。
> 如果实际用下来「镜像站老漏判」，第一个该怀疑的就是这里。

---

## 开发

```bash
npm install          # 只装 Playwright（跑 E2E 才需要）
npm test             # 单元测试（Node 内置 test runner，零依赖）
npm run test:falsify # 产品级证伪：改坏真实源码重跑整套，确认闸门会红
npm run test:e2e     # E2E（默认 headless，不弹窗）
npm run test:scope    # 手动指定书签范围的 E2E
node tests/e2e/diagnose.js   # 诊断：打印执行过程中任务状态的推进与失败原因
```

E2E 走系统 Chrome/Edge 的**无头模式**，跑起来不会弹窗。
想肉眼看着它跑：`BO_E2E_HEADED=1 npm run test:e2e`。

### 三类闸门，缺一不可

| 闸门 | 命令 | 守什么 | 成本 |
|---|---|---|---|
| **正向** | `npm test` | 断言正确行为 | 2 秒，零浏览器 |
| **证伪** | `npm run test:falsify` | 造坏实现，**确认闸门确实会红** | 分钟级 ⚠️ **会改源码** |
| **E2E** | `npm run test:e2e` | 真实浏览器 + 真实用户路径 | 分钟级，开有头浏览器 |

```bash
python tools/verify_all.py   # 全套（5 步，结束时必须 rc=0）
```

> ⚠️ **证伪不是只读的。** 它会**修改真实源文件**、跑一遍整套、再还原，
> 所以**不能和任何编辑或测试并发**。跑它的时候：**什么都不做，等它自己结束。**
>
> 它结束时**必须 rc=0**：退化全红但有一处关键字没匹配上时脚本同样返回 1 ——
> 那不是闸门失灵，是**量具没对准**，看输出里的「实际标题」那一行去改关键字。

**绿灯本身不算证据。一道从来没红过的闸门，和没有闸门是一样的。**
2026-10-06 之前 `ui_contract_gate.py` 与 `contrast_gate.py` 两个文件都存在、都能跑、
都全绿，却**没接在任何地方** —— 170 条单测与 10 处证伪点从来没被要求跑过，
于是「全绿」和「没跑」长得一模一样。现在两者都接进了 `precommit.py --all`
与 `verify_all.py` 第 0 步。

`precommit.py` 已接成本机 `.git/hooks/pre-commit`（2 秒、零浏览器，每次提交自动跑）。
⚠️ `.git/` 不进版本库，**每台机器要装一次**。E2E 与证伪**故意不**进钩子 ——
它们分钟级，塞进每次提交会变成没人愿意等的门。

**闸门体系的全貌、每条守什么、跑之前必须知道什么、以及当前的覆盖缺口**，
见 **[docs/testing.md](docs/testing.md)**。其中有一条缺口值得先知道：
`tests/e2e/` 对链接健康 / 内容归档 / 语义去重三块面板**零覆盖**，
归档链的最后一跳（渲染 PDF/截图）**至今从未实跑过**。

## 目录

```
manifest.json
src/
  normalize.js        URL 归一化与去重键（纯函数）
  dedupe.js           重复检测与 keeper 策略（纯函数）
  plan.js             计划生成，零写入（纯函数）
  classify/
    taxonomy.js       类目树 + 用户覆盖合并（纯函数）
    dict.js           预置规则词典（纯数据）
    rules.js          规则匹配器（纯函数）
    llm.js            云端兜底编排（提示词 / 分批 / 权限门控 / 降级）
  ai/                 ← 2026-10-06 新增：模型访问分层
    provider-registry.js  供应商与模型目录（纯数据+纯函数，MODEL_PRESETS 由它派生）
    errors.js             HTTP 错误诊断文案（纯函数）
    context.js            Context 构造 / 结果判定（纯函数）
    credential-store.js   按 providerId 的凭据读写（走 storage.js 的串行锁）
    runtime.js            ⚠️ 唯一 import vendor 产物的模块
    vendor-entry.js       esbuild 入口
  vendor/
    pi-ai.js          esbuild 产物（提交进版本库，改入口后跑 npm run build:vendor）
  storage.js          storage 封装：读-改-写全程持串行锁
  tree.js             getTree 扁平化
  roots.js            书签根 id 的解析（根名随界面语言变，不能硬编码）
  scope-list.js       手动范围的清单纯逻辑：展开/对账/裁子集（纯函数，不碰 chrome）
  backup.js           快照与回滚
  apply.js            逐条执行 + 断点续跑（在 service worker 里跑）
  fail-log.js         失败记录：本机缓冲 + 送本机接收器（写操作模块）
  listener.js         变更监听（导入期抑制）
  background.js       service worker 入口
  scan/               链接健康（死链/改链 + 元数据补全）
    verdict.js          探测结果 → 面板状态（重定向优先于死链）
    dead-threshold.js   死链判据：连续 3 次 404/410 且距上次成功 ≥24h
    extract-meta.js     HTML → og:/作者/发布时间（正则，不建 DOM）
    soft404.js          软 404 识别（只标不判）
    classify-site.js    站点类型（规则优先，认不出来就说认不出来）
    probe.js            单条探测 + 并发受限的批量探测
    runner.js           扫描循环：逐条落盘、可中断可续跑
    scheduler.js        chrome.alarms 接线
    permission.js       <all_urls> 按需授权 + 出网说明
    alternatives.js     Wayback 快照 + AI 候选（候选必须逐个验证）
  dedupe/             语义去重（不同 URL 但同内容）
    semantic.js         余弦、粗筛、建议合并（纯函数）
    embedding-client.js 百炼 text-embedding-v4 客户端（单次最多 10 条）
    semantic-runner.js  编排 + IndexedDB 向量存储
  archive/             内容归档（防链接腐烂）
    client.js           送正文给本机接收器（离线时明说，不静默假装）
    run.js              归档循环：每片 20 条、游标落盘，增量 + 守卫写回
    important.js        「重要页」星标（存 URL，与 LOCKS 刻意不合并）
ui/
  options.html/js/css 主面板（全屏）
  popup.html/js       工具栏弹窗（极简）
tests/
  fixtures/samples.js 命中率闸门的样本集
  helpers/            源码静态扫描（纯链路 / 能力 / storage 读-改-写判据共用）
  unit/               单元测试 + 证伪用例
  e2e/                Playwright（harness.js / run.js / diagnose.js）
  product_falsification.py
tools/
  verify_all.py       全套验证（面板契约 + 单测 + 证伪 + E2E + 压缩包真加载）
  precommit.py        提交前闸门（语法/JSON + 单测），已接成 .git/hooks/pre-commit
  ui_contract_gate.py 面板 DOM 契约：E2E 靠数行数/按下标读字段的隐式耦合，改 DOM 前先看它
  contrast_gate.py    前景/背景对比度（暗色模式下链接原本不可读）
  privacy_gate.py     隐私闸门：扫所有将推送的 blob，查真 key / 真实书签数据
  package.py          打包产物
  archive_sink.py     归档接收器（端口 8732，--selftest 自检落盘与文件名稳定性）
  render_archive.js   用本机 Chromium 把重要页渲染成 PDF + 整页截图
  inject_key.py       从本机环境变量把 API key 注入 src/llm-key.local.js（已 gitignore）
  fail_log_sink.py    失败日志接收器：接住扩展 POST，写 F:\logs\bookmark-organizer\<日期>.jsonl
  start_fail_log_sink.bat  双击启动接收器
docs/                  深度参考（README 只留导航，见「深入阅读」）
```

### 三条硬约束在代码里的位置

**`plan.js` 不 import 任何写操作模块。** 这是 dry-run 零写入的全部依据，
由 `tests/unit/plan.test.js` 的静态断言守着（扫源码里的 import）。
import 扫描器覆盖具名/默认/namespace/**副作用导入**/re-export 五种写法 ——
漏掉副作用导入的话，`import './apply.js'` 能整条绕过。

**`storage.js` 的读-改-写在同一个串行临界区内。**
不是「内存累积 + hydrate」——那种写法要防的竞态（并发覆盖、
新 worker 用旧内存态盖掉 storage）恰恰是它自己引入的。
把 `get` 放进临界区后风险整类消失：不存在「内存态」这个可能过期的副本。

**`toPath` 不含根名，`fromPath` 含。** 根归到哪是「写到哪儿」的问题，
由 `settings.targetRoot` 决定，所以 `plan.js` 保持纯函数、不依赖任何设置。
「是否已在位」的比较必须**剥掉 fromPath 的根名**再比，否则两边永远不等，幂等直接失效。
写盘时再把根**名**补回 `toPath`，并由根**名**反查根 **id**（根名随界面语言变，不能硬编码）。

## 已知限制

- **移动设备书签是只读的**，`move()` 进去/出来都会失败，已在扁平化阶段就标出并跳过。
- 分类只吃 **URL + 标题 + 已有文件夹路径**，不抓正文。既是隐私边界，也让几百条书签能秒级完成。
  （链接健康会抓正文，但那是用户显式开启后才抓的另一个功能。）
- 只处理**两层**类目（顶层 / 子类）。要更深就在类目名里自己带分隔语义。
- **死链判据保守**：需要登录（403）、被限流（429）、服务端故障（5xx）与超时的链接
  **一律不算死链**，也不计入失败计数。所以一份报告里的「可疑」可能包含不少其实活着的页面。
- **软 404 是启发式**，只标不判 —— 一篇讲「HTTP 404 怎么排查」的文章会被特征串误伤。
- **跨站重定向不给「采纳替换」按钮**。品牌改名与跳登录页从 URL 上完全无法区分，
  盲信会毁掉真收藏的地址。
- **链接健康的超时与并发没有 UI**，要改得编辑 storage（8000ms / 6）。
- **语义去重的阈值 0.92 未经真实数据校准**，方法见
  [docs/semantic-calibration.md](docs/semantic-calibration.md)。
- **归档 `--dir` 有 bug**：接收器 spawn 时不传环境变量，落盘位置永远回落到 `F:rchive`。
- **链接健康 / 归档 / 语义去重三块面板没有 E2E 覆盖**（见
  [docs/testing.md](docs/testing.md) 的覆盖缺口一节）。
- 恢复不是时间机器（见上）。
- **手动整理的回滚仍然是全树的**：`restoreSnapshot` 是五步全树流程，
  不按任务切分。手动整理期间你自己在 Chrome 里做的其他归类，回滚时会被一并撤销。
- **手动整理的清单只认书签 id**。书签删掉再重建会让 id 失效，那一条会标成
  「已失效」而不是被自动认回来。这是刻意的取舍：宁可跳过并让你看见，
  也不替你猜「哪一条才是原来那条」。
- **手动整理的勾选区是懒渲染**，一次最多铺 `SCOPE_TREE_CHUNK` 项；
  树特别大时需要用搜索或逐层展开。这是性能取舍，不是丢数据（被截断时会有明确提示）。
- 不上架 Chrome 商店，自用 unpacked 加载。

**全部验收阈值及其校准状态**：见
[docs/acceptance-thresholds.md](docs/acceptance-thresholds.md)。

## 参与

- 提 issue / PR 前先看 [CONTRIBUTING.md](CONTRIBUTING.md)（含提交前闸门和三条硬约束）
- 报告安全问题请走 [SECURITY.md](SECURITY.md) 的私密通道，**不要开公开 issue**
- 提交前跑一次 `python tools/precommit.py`；改动 E2E 夹具后另跑
  `python tools/privacy_gate.py`

## License

[MIT](LICENSE) © 2026 wangpanbin
