# 01 · 记录组装与本机缓冲

Status: ready-for-agent
Spec: ../spec.md
Blocked by: —

## 做什么

新增 `src/fail-log.js` 的纯部分：

1. `buildRecord(input)` —— 纯函数，**不得出现 `chrome.` 调用**（会被 `usesChromeApi` 语义波及）。
   字段：`ts / kind / id / title / url / error / fromPath / toPath / batch / chrome / ext`。
   `chrome` 用 `navigator.userAgent` 解析不出版本号，改为从 `chrome.runtime.getManifest().version`
   与 UA 里正则取版本；取不到就写 `null`，**不许写 `undefined`**（jsonl 里 `undefined` 会被吞掉字段）。
2. `storage.js` 的 `K` 增加 `FAIL_LOG_PENDING: 'fail:pending'`。
3. `appendPending(record)` —— 用 `mutate()` 持锁追加，上限 200 条，超出丢最旧。
4. `getPending()` / `clearPending()`。

## 关键点

- 缓冲存**完整记录对象数组**，不是只存 id —— 重新导出时不该再去查已经变了的状态。
- 追加必须走 `mutate()`，不能用 `get`→改→`set`（`storage.js` 顶部的注释就是在讲这个坑）。

## 验收

- `tests/unit/fail-log.test.js` 断言 `buildRecord` 字段齐全、`JSON.parse(JSON.stringify(rec))` 往返后字段不丢。
- 追加 250 条后长度 === 200，且剩下的是**最新的**那 200 条。

## Comments
