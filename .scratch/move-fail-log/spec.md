# Spec：移动失败日志落盘到 F:\logs

Status: ready-for-agent
Date: 2026-10-05
Feature slug: `move-fail-log`

---

## 1. 目标（用户原话）

> 如果移动失败，怎么把日志记录在 F 盘 logs 新建一个文件夹下面

拷问后定下的四条决策（用户拍板）：

| 决策 | 选定 |
|---|---|
| 落盘机制 | 本机 Python 接收器：扩展 POST 给 `127.0.0.1`，脚本写 F 盘 |
| 记录范围 | **只记失败条目明细**（不记成功条目、不记批次汇总行） |
| 目录与切分 | `F:\logs\bookmark-organizer\2026-10-05.jsonl`，按天一个文件 |
| 写不进去时 | 静默降级，面板留一个「重新导出」按钮 |

## 2. 现状（先说清楚，避免重写已有能力）

失败记录**已经存在**：

- `src/apply.js:454` 把失败塞进 `task.failed[]`（`{id, url, title, error}`）
- `src/apply.js:493` 去重删除失败也塞进同一个数组
- `ui/options.js:840` 面板主视图有红色失败横幅，`ui/options.js:573` 执行报告里有失败明细
- `apply.js:338 explainMoveError()` 已把 Chrome 原话翻成可操作中文

**缺的只有一件事：把失败记录落成 F 盘上的文件。** 本次不重做记录、不改失败文案、不动失败横幅。

## 3. 硬约束（决定了架构，不是偏好）

**Chrome 扩展无法写任意本地路径。** MV3 没有文件系统 API，service worker 里连
`showSaveFilePicker` 都不存在（那只在有 DOM 的面板页、且必须用户手势）。
所以「F:\logs 下的新文件夹」必须经由本机进程落地 —— 这是选 Python 接收器的根本原因。

三个技术坑，实现时必须按本文处理：

1. **`fail-log.js` 绝不能被纯链路 import。** `tests/helpers/sourceScan.js` 的
   `FORBIDDEN_IN_PURE_CHAIN` 是**文件名后缀匹配**（`spec.endsWith(bad)`）。
   新模块名一旦以 `storage.js` / `apply.js` / `llm.js` 结尾（例：`fail-log-storage.js`）
   就会**因为名字**被当成写操作模块。本次用 `fail-log.js`，并把它加进
   `FORBIDDEN_IN_PURE_CHAIN`，让这条命名地雷变成闸门。
2. **本地网络访问（PNA）**：extension origin → `127.0.0.1` 属跨源 + 私有网络访问。
   接收器**必须**回 CORS 头 **且**回 `Access-Control-Allow-Private-Network: true`，
   并正确处理 `OPTIONS` 预检，否则 SW 里的 `fetch` 会被浏览器直接掐掉。
   这是「日志明明有失败、文件却没生成」最可能的根因。
3. **MV3 SW 空闲 30 秒即被回收。** POST 不能做成「攒着以后再说」的内存队列，
   必须在失败当场发；未发成功的部分落 `chrome.storage.local` 兜底。

## 4. 设计

```
apply.js 失败点 ──► src/fail-log.js
                     │  ① buildRecord()  组装（纯函数，可单测）
                     │  ② appendPending() 落本机缓冲 chrome.storage.local
                     │  ③ flush()  POST http://127.0.0.1:8731/log（1.5s 超时）
                     ▼
              本机缓冲（重新导出的数据源，也是「静默降级」的兑现处）
                     │  best-effort：失败不抛、不弹窗、只 console.warn
                     ▼
        tools/fail_log_sink.py ──► F:\logs\bookmark-organizer\2026-10-05.jsonl
```

### 4.1 记录格式（jsonl，一行一条）

```json
{"ts":"2026-10-05T21:45:33.120+08:00","kind":"move","id":"1234","title":"…","url":"https://…","error":"…可操作中文文案…","fromPath":["收集箱"],"toPath":["开发与技术","前端"],"batch":1759679130000,"chrome":"139.0.7258.67","ext":"1.0.0"}
```

- `error` 直接用 `explainMoveError(e)` 的输出，**不重新翻译**。
- **不额外回读实际落点**：`assertMoved()` 抛出的错误文案里已经带
  「实际在 X 而不是 Y」两个可读名字（`apply.js:390`）。为每条失败再加一次
  `chrome.bookmarks.get()` 换不到新信息，只增加 API 调用。
- `batch` = 本轮 `task.startedAt`。日志按天追加、跨批次混在一起，没有这个字段
  就无法把一次执行的失败从整月记录里摘出来。**这是失败明细的一个字段，不是汇总行。**

### 4.2 扩展侧（`src/fail-log.js`）

| 导出 | 作用 |
|---|---|
| `buildRecord(input)` | 纯函数，拼记录对象。**不含 chrome 调用** |
| `recordFailure(input)` | 失败点入口：组装 → 落缓冲 → flush。全程不抛 |
| `flushPending()` | 把缓冲里未发的全发一遍；成功即从缓冲移除 |
| `getPending()` | 面板「重新导出」的数据源 |
| `clearPending()` | 导出成功后清缓冲 |
| `probeSink()` | `GET /health` → 面板状态 chip 用 |
| `hasSinkPermission()` / `requestSinkPermission()` | 镜像 `llm.js:139/154` 的按需权限范式 |

约束：

- `recordFailure()` **绝不 throw**，绝不 reject 出去。内部 try/catch 全包，
  失败只 `console.warn`。整理主流程的时序与成功率不受日志功能影响。
- flush 带 1500ms `AbortController` 超时。失败路径才付这个时间成本。
- 缓冲用 `storage.js` 的 `mutate()`（持串行锁），新增键 `K.FAIL_LOG_PENDING`。
  缓冲上限 200 条，超出丢最旧的 —— 日志不是数据资产，不许无限涨。
- 权限未授予时**不发请求**，记录照留缓冲（这样「重新导出」始终有数据）。

### 4.3 权限

- `manifest.json` 的 `optional_host_permissions` 增加 `http://127.0.0.1:8731/*`。
  **不加** `"host_permissions"`，不装任何东西，不改 Chrome 设置。
- 沿用 LLM 兜底那套「点一下才弹窗」的按需申请，在设置里给一个授权按钮。
- 端口 `8731` 只在两处出现（`src/fail-log.js` 常量 + `tools/fail_log_sink.py` 默认值），
  README 记明。实现时先验本机该端口未被占用。

### 4.4 接收器（`tools/fail_log_sink.py`）

- Python 3 标准库，零依赖（与 `tools/inject_key.py` 同路子）。
- `ThreadingHTTPServer` 绑 `127.0.0.1:8731`。
- `GET  /health` → `{"ok":true,"dir":"…","lines":N}`
- `POST /log`    → 收 `{"records":[…]}`，追加写 `F:\logs\bookmark-organizer\<date>.jsonl`，
  自动建目录，UTF-8，回 `{"ok":true,"written":N}`
- `OPTIONS *`    → 回 CORS + `Access-Control-Allow-Private-Network: true`
- `--dir` 默认 `F:\logs\bookmark-organizer`；F 盘不存在时**启动即报错退出**并说清原因，
  不静默改写到别处（静默换目录 = 又一次「以为记上了其实没记」）。
- `--selftest`：自己起服务、POST 一条、读回文件、断言行数与字段，然后退出。
  这是证明 F 盘真能落盘的最便宜手段。
- `tools/start_fail_log_sink.bat`：双击启动（`chcp 65001` 防中文日志乱码）。

### 4.5 面板（`ui/options.js`）

- **「重新导出」按钮**：有未发送记录时出现。走 `showSaveFilePicker`（用户手势，
  不新增任何权限）存成 `bookmark-organizer-failures-<date>.jsonl`；
  API 不可用时降级为 Blob + `<a download>`（落到 Chrome 下载目录）。
  导出成功后清缓冲。
- **接收器状态 chip**：`probeSink()` 显示「在线（已写入 N 条）/ 离线」。
  静默（不 toast），因为用户选了静默降级；但**没有它就无法判断「到底写没写进去」** ——
  这正是本项目踩坑最多的那类问题。
- 设置项 `failLogEnabled`（默认 `true`），可一键关掉整个功能。

## 5. 我自己拍的三个决定（要否决请现在说）

1. **去重删除的失败也记**（`kind: "delete"`）。它在同一个 `task.failed[]` 里、
   在同一个红色横幅里，面板上算失败、日志里没有会自相矛盾。成本 1 行。
2. **加接收器状态 chip**。理由见 4.5：静默降级必须配一个不打扰的判据。
3. **加 `failLogEnabled` 开关**。1 行，避免用户不想要时只能卸扩展。

## 6. 非目标（明确不做）

- 不记成功条目、不记批次汇总行（用户只选了失败明细）
- 不装计划任务 / Windows 服务，不做开机自启 —— 接收器由用户自己开
- 不做日志轮转与清理（按天切分已够）
- 不改 `explainMoveError` 的文案，不改失败横幅
- 不给 Chrome 装扩展/改下载目录/加任何全局权限

## 7. 验收

| 闸门 | 判据 |
|---|---|
| 记录组装 | `buildRecord` 字段齐全，jsonl 一行可 `JSON.parse` |
| 缓冲语义 | POST 成功 → 出缓冲；POST 失败/超时/无权限 → 留缓冲，**不抛** |
| 纯链路零写入 | `fail-log.js` 进 `FORBIDDEN_IN_PURE_CHAIN`，且**先证伪**：故意在 `plan.js` 里 import 它，确认闸门会红 |
| 接收器自检 | `python tools/fail_log_sink.py --selftest` 通过，且 `F:\logs\bookmark-organizer\` 下真的多出文件 |
| 端到端 | 真实 chromium（`channel:'chromium'` + 有头 + 全新 profile）造一次失败移动，**断言 F 盘 jsonl 里出现该条**。判据是磁盘文件，不是接口返回 |
| 回归 | `npm test` 全绿；`npm run test:falsify` 全绿 |

> E2E 判据必须是磁盘上的文件。接口返回 200 不等于落盘成功 ——
> 这条项目里已经有「面板报 100% 成功、书签栏一点没变」的前科。

## 8. 已知风险

| 风险 | 应对 |
|---|---|
| PNA 掐掉 fetch | 接收器回 CORS+PNA 头并处理 OPTIONS；E2E 会暴露 |
| F 盘不可用 | 接收器启动即报错；扩展侧静默留缓冲，导出按钮兜底 |
| SW 被回收 | 失败当场发 + 落盘缓冲，不依赖内存队列 |
| 端口被占 | 实现时先验；`--port` 可覆盖，两侧需同时改（README 记明） |
| 工作区有未提交改动 | `README.md` / `src/apply.js` / `ui/options.js` 本次之前就是 modified，提交前须与用户确认是否一起提交 |

## Comments
