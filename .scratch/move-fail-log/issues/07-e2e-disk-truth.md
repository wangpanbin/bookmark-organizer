# 07 · E2E：F 盘真的出现文件

Status: ready-for-agent
Spec: ../spec.md
Blocked by: 02, 03, 04, 05

## 做什么

`tests/e2e/fail-log.js`：复用 `tests/e2e/revert-guard.js` 已有的「搬完就改回」手法
制造一次真实失败移动，然后：

1. 起接收器（子进程，`--dir` 指向临时目录）
2. 授予 `http://127.0.0.1:8731/*` 可选 host 权限
3. 造失败 → 断言 **磁盘上的 jsonl 文件里出现该条**（含 id、url、error）
4. 清理

硬约束（README 已列过，全部来自本机实证）：

- `channel: 'chromium'` 完整 chromium + **有头**，不用 `chromium_headless_shell`
- `launch_persistent_context` + **每次全新 `user_data_dir`**
- 判据是**磁盘文件内容**，不是接口返回码

## 关键点

- 这条闸门是本功能的**唯一真判据**。PNA / CORS / 权限 / SW 回收这四个坑
  只有真实浏览器能暴露，Node 单测一个都测不到。
- 用临时目录（`os.mkdtemp`）而不是真的往 `F:\logs` 写测试垃圾。
  真实的 F 盘路径由 `tools/fail_log_sink.py --selftest` 覆盖。

## 验收

```bash
node tests/e2e/fail-log.js
```
断言从磁盘读回的行里能找到目标书签 id。

## Comments
