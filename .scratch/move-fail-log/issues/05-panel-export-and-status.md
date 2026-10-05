# 05 · 面板：重新导出 + 接收器状态

Status: ready-for-agent
Spec: ../spec.md
Blocked by: 01, 03

## 做什么

`ui/options.html/js`：

1. **「重新导出」按钮** —— 放在失败横幅（`ui/options.js:840` 附近）与执行报告区，
   仅当 `getPending()` 非空时可见。
   - 主路径：`showSaveFilePicker`（用户手势，无需新增权限）存 `bookmark-organizer-failures-<date>.jsonl`
   - 降级：API 不可用 → Blob + `<a download>`（落 Chrome 下载目录）
   - 成功后 `clearPending()`
2. **接收器状态 chip** —— `probeSink()` 显示「在线（已写入 N 条）」/「离线」/「未授权」。
   **静默**：不 toast、不打断（用户选了静默降级）。
3. **授权按钮** —— 未授权时提供「授权本机日志接收器」，走按需申请。
4. 设置项 `failLogEnabled`（默认 `true`），关掉后不再 POST。

## 关键点

- `showSaveFilePicker` 必须**在用户点击处理函数里直接调用**，不能 `await` 别的之后再来
  —— 那会丢用户手势，弹窗直接不出现。
- 用户取消保存（`AbortError`）不是错误，不要弹红 toast。
- 状态 chip 只在面板打开时探一次 + 点「刷新」时探，**不要轮询**。

## 验收

- 缓冲非空 → 按钮可见；点一下 → 文件存盘成功、缓冲清空、按钮消失。
- 点「取消」→ 缓冲**仍在**，无报错弹窗。
- 接收器没开 → chip 显示「离线」，整理流程一切正常，无任何 toast。

## Comments
