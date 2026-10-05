# 03 · 按需权限与 flush

Status: ready-for-agent
Spec: ../spec.md
Blocked by: 01

## 做什么

`src/fail-log.js` 剩余部分：

1. `hasSinkPermission()` / `requestSinkPermission()` —— 镜像 `src/classify/llm.js:139/154`
   （`chrome.permissions.contains/request`，origin `http://127.0.0.1:8731/*`）
2. `flushPending()` —— 把缓冲里未发的全 POST；成功则从缓冲移除
3. `recordFailure(input)` —— 组装 → 落缓冲 → flush
4. `probeSink()` —— `GET /health`，给面板状态 chip 用
5. `manifest.json` 的 `optional_host_permissions` 增 `http://127.0.0.1:8731/*`

## 关键点

- **`recordFailure()` 绝不 throw**：内部全 try/catch，失败只 `console.warn`。
  日志功能不能改变整理主流程的成功率与时序。
- fetch 带 `AbortController` 1500ms 超时；超时算失败，**记录留在缓冲**。
- 权限未授予 → **不发请求**（省掉必然失败的 fetch 与控制台噪音），记录留缓冲。
- flush 成功后只移除**本次确认写入**的那些，不要按索引盲删（并发 flush 会错位）。
- 不加 `"host_permissions"`，不加 `"downloads"` 权限。

## 验收

- 无权限 → 缓冲增长、无 fetch 调用、无异常。
- fetch 抛错 / 超时 / 返回非 2xx → 缓冲**一条不少**。
- 返回 2xx → 缓冲清空。
- 打坏补丁（删掉「成功后清缓冲」）后 `tests/unit/fail-log.test.js` **必须变红**。

## Comments
