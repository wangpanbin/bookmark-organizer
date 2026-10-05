# 02 · 本机 Python 接收器

Status: ready-for-agent
Spec: ../spec.md
Blocked by: —

## 做什么

`tools/fail_log_sink.py`（Python 3 标准库、零依赖，与 `tools/inject_key.py` 同路子）：

- `ThreadingHTTPServer` 绑 `127.0.0.1:8731`，`daemon_threads = True`
- `GET  /health` → `{"ok":true,"dir":"…","lines":N}`
- `POST /log` → 收 `{"records":[…]}`，追加写 `<dir>\<YYYY-MM-DD>.jsonl`，自动建目录，UTF-8
- `OPTIONS` → 回 CORS 头 **+ `Access-Control-Allow-Private-Native-Network` 拼写正确的
  `Access-Control-Allow-Private-Network: true`**
- `--dir` 默认 `F:\logs\bookmark-organizer`；F 盘不可用时**启动即非零退出并说清原因**
- `--port` 默认 8731
- `--selftest`：自己起服务 → POST 一条 → 读回文件 → 断言行数与字段 → 关服务 → 退出码 0/1

配套 `tools/start_fail_log_sink.bat`：`chcp 65001` → cd 到脚本目录 → `python fail_log_sink.py`。

## 关键点

- **PNA 头是最容易漏、且漏了之后现象是「静默不落盘」的地方**（spec §3.2）。
  头拼错等于没加。
- 日志按天切分，日期取**本机**时间。
- 每写一行 print 一行（含字节数），用户能一眼看出在写。

## 验收

```bash
python tools/fail_log_sink.py --selftest
```
通过，且 `F:\logs\bookmark-organizer\` 下确实多出 `*.jsonl` 且内容可 `json.loads`。

## Comments
