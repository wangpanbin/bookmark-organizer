#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""移动失败日志接收器：接住扩展 POST 过来的失败记录，落成 F 盘上的 jsonl。

为什么需要这个脚本
------------------
Chrome 扩展**没有任意写本地文件的能力**：MV3 没有文件系统 API，
service worker 里连 showSaveFilePicker 都不存在。所以「把失败日志写到
F:\\logs 下面的新文件夹」只能由本机进程干 —— 这就是本脚本。

协议
----
    GET  /health  -> {"ok": true, "dir": "...", "lines": N}
    POST /log     <- {"records": [ {...}, ... ]}
                 -> {"ok": true, "written": N, "file": "..."}
    OPTIONS *     -> 204 + CORS/PNA 头

⚠️ 为什么每个响应都要回 Access-Control-Allow-Private-Network
    扩展的 origin（chrome-extension://…）请求 127.0.0.1 属于
    「公开来源访问私有网络」（PNA / Local Network Access）。
    缺这个头，浏览器会**在 service worker 里直接把 fetch 掐掉**，
    现象是「失败明明发生了、日志文件却一直没生成」—— 和没配一样。
    这是本脚本最容易漏、且漏了最难查的一个头。

零依赖：只用 Python 3 标准库。用法见 --help。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DEFAULT_DIR = r"F:\logs\bookmark-organizer"
DEFAULT_PORT = 8731
HOST = "127.0.0.1"
MAX_BODY = 4 * 1024 * 1024
SELFTEST_SUBDIR = ".selftest"

# 进程内共享状态：日志目录 + 已写行数 + 写锁
STATE: dict = {"dir": Path(DEFAULT_DIR), "lines": 0}
LOCK = threading.Lock()


def log(msg: str) -> None:
    """带时间戳打印。stdout 重编码过，中文不会在 cp936 控制台上炸。"""
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def fail(msg: str) -> "NoReturn":  # type: ignore[name-defined]
    print(f"错误：{msg}", file=sys.stderr, flush=True)
    raise SystemExit(2)


def resolve_dir(raw: str) -> Path:
    """检查并准备日志目录。

    ⚠️ 盘符不存在时**直接退出**，不静默改写到别处。
       静默换目录 = 又一次「以为记上了、其实没记」，
       而这个项目已经在这类问题上栽过好几次。
    """
    p = Path(raw)
    drive = p.drive
    if drive and not Path(drive + os.sep).exists():
        fail(
            f"日志目录所在的盘 {drive} 不存在。\n"
            f"       目标：{p}\n"
            f"       请插上该盘，或用 --dir 指定别的位置（例如 --dir .\\fail-logs）。\n"
            f"       不会自动改写到其它盘 —— 记到别处而不告诉你，比不记更糟。"
        )
    try:
        p.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        fail(f"建不了日志目录 {p}：{e}")
    return p


class SinkHandler(BaseHTTPRequestHandler):
    server_version = "BookmarkFailLogSink/1.0"
    protocol_version = "HTTP/1.1"

    # ── 公共头 ──
    def _send_cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        # 少了这一行，扩展 SW 里的 fetch 会被浏览器掐掉（见模块 docstring）
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._send_cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args) -> None:  # 静音默认的逐行访问日志
        return

    # ── 路由 ──
    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._send_cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self.path.split("?")[0] != "/health":
            self._json(404, {"ok": False, "error": "unknown path"})
            return
        with LOCK:
            lines = STATE["lines"]
        self._json(200, {"ok": True, "dir": str(STATE["dir"]), "lines": lines})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.split("?")[0] != "/log":
            self._json(404, {"ok": False, "error": "unknown path"})
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self._json(400, {"ok": False, "error": "bad content-length"})
            return
        if length <= 0 or length > MAX_BODY:
            self._json(400, {"ok": False, "error": f"bad body size: {length}"})
            return

        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as e:
            self._json(400, {"ok": False, "error": f"bad json: {e}"})
            return

        records = self._extract_records(payload)
        if not records:
            self._json(400, {"ok": False, "error": "no usable records"})
            return

        # 一条坏记录只丢那一条，不整批丢 —— 丢整批的话，
        # 一条脏数据就能让当天所有失败原因都消失。
        lines: list[str] = []
        skipped = 0
        for rec in records:
            if isinstance(rec, dict):
                lines.append(json.dumps(rec, ensure_ascii=False))
            else:
                skipped += 1
        if not lines:
            self._json(400, {"ok": False, "error": "all records unusable"})
            return

        target_dir: Path = STATE["dir"]
        # 按**到达时间**的本地日期切文件，不看记录里的 ts
        target = target_dir / f"{datetime.now():%Y-%m-%d}.jsonl"
        try:
            with LOCK:
                with open(target, "a", encoding="utf-8", newline="\n") as f:
                    f.write("\n".join(lines) + "\n")
                STATE["lines"] += len(lines)
        except OSError as e:
            self._json(500, {"ok": False, "error": f"write failed: {e}"})
            return

        log(
            f"写入 {len(lines)} 条 -> {target.name}"
            + (f"（丢弃 {skipped} 条非法记录）" if skipped else "")
            + f"｜累计 {STATE['lines']} 条"
        )
        self._json(200, {"ok": True, "written": len(lines), "skipped": skipped, "file": str(target)})

    @staticmethod
    def _extract_records(payload) -> list:
        if isinstance(payload, dict):
            if isinstance(payload.get("records"), list):
                return payload["records"]
            # 容错：直接 POST 一条记录
            if "id" in payload or "error" in payload:
                return [payload]
        return []


def make_server(port: int, log_dir: Path) -> ThreadingHTTPServer:
    STATE["dir"] = log_dir
    STATE["lines"] = 0
    server = ThreadingHTTPServer((HOST, port), SinkHandler)
    server.daemon_threads = True
    return server


def serve(port: int, log_dir: Path) -> int:
    try:
        server = make_server(port, log_dir)
    except OSError as e:
        fail(
            f"端口 {HOST}:{port} 起不来：{e}\n"
            f"       可能已经有接收器在跑（那就对了，直接关掉本脚本）；\n"
            f"       或者换个端口：--port 8732，同时把 src/fail-log.js 里的 SINK_PORT 也改掉。"
        )

    log(f"日志目录：{log_dir}")
    log(f"监听：http://{HOST}:{port}   （扩展需要在面板里授权一次本机访问）")
    log("按 Ctrl+C 停止")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("停止")
    finally:
        server.server_close()
    return 0


def selftest(log_dir: Path, port: int) -> int:
    """证明这条链路真的能把记录落到盘上。

    写在 <log_dir>/.selftest/ 下面并在结束时删掉 ——
    不往当天的真实日志文件里掺测试行。
    """
    probe_dir = log_dir / SELFTEST_SUBDIR
    if probe_dir.exists():
        shutil.rmtree(probe_dir, ignore_errors=True)
    probe_dir.mkdir(parents=True, exist_ok=True)

    server = make_server(port, probe_dir)
    host, bound = server.server_address[0], server.server_address[1]
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()

    marker = f"selftest-{int(datetime.now().timestamp() * 1000)}"
    record = {
        "ts": datetime.now().isoformat(),
        "kind": "move",
        "id": marker,
        "title": "自检条目",
        "url": "https://example.invalid/selftest",
        "error": "自检写入，不代表真实失败",
        "fromPath": ["书签栏"],
        "toPath": ["自检"],
        "batch": 0,
        "chrome": "0.0.0.0",
        "ext": "1.0.0",
    }

    def req(path: str, body=None):
        data = None if body is None else json.dumps(body).encode("utf-8")
        r = urllib.request.Request(
            f"http://{host}:{bound}{path}",
            data=data,
            headers={"Content-Type": "application/json"} if data else {},
        )
        with urllib.request.urlopen(r, timeout=5) as resp:
            return json.loads(resp.read().decode("utf-8"))

    try:
        # 1) 预检必须带 PNA 头（扩展能不能发起请求就取决于这一条）
        pre = urllib.request.Request(f"http://{host}:{bound}/log", method="OPTIONS")
        with urllib.request.urlopen(pre, timeout=5) as resp:
            if (resp.headers.get("Access-Control-Allow-Private-Network") or "").lower() != "true":
                print("错误：/log 的 OPTIONS 响应缺少 Access-Control-Allow-Private-Network: true", file=sys.stderr)
                return 1

        # 2) 真写一条
        resp = req("/log", {"records": [record]})
        if resp.get("written") != 1:
            print(f"错误：written={resp.get('written')}，期望 1", file=sys.stderr)
            return 1

        # 3) health
        h = req("/health")
        if h.get("ok") is not True or h.get("lines") != 1:
            print(f"错误：health 返回 {h}", file=sys.stderr)
            return 1

        # 4) 读回磁盘上的文件 —— 判据是文件内容，不是接口返回
        found = []
        for f in sorted(probe_dir.glob("*.jsonl")):
            for line in f.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    found.append(json.loads(line))
        hit = [r for r in found if r.get("id") == marker]
        if not hit:
            print(f"错误：磁盘文件里找不到 {marker}，实际读到 {len(found)} 行", file=sys.stderr)
            return 1

        log(f"自检通过：1 条记录已落盘 -> {hit[0]['id']}")
        return 0
    except (urllib.error.URLError, OSError) as e:
        print(f"错误：自检请求失败 {e}", file=sys.stderr)
        return 1
    finally:
        server.shutdown()
        server.server_close()
        shutil.rmtree(probe_dir, ignore_errors=True)


def main(argv: list[str] | None = None) -> int:
    # 控制台按 cp936 打印中文会 UnicodeEncodeError，重编码成 utf-8
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    ap = argparse.ArgumentParser(
        description="书签整理助手 · 移动失败日志接收器",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--dir", default=DEFAULT_DIR, help=f"日志目录（默认 {DEFAULT_DIR}，不存在会自动创建）")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"监听端口（默认 {DEFAULT_PORT}）")
    ap.add_argument("--selftest", action="store_true", help="自检：写一条并读回验证，然后退出")
    args = ap.parse_args(argv)

    log_dir = resolve_dir(args.dir)
    if args.selftest:
        # 端口用 0（临时端口），免得和真在跑的接收器撞
        return selftest(log_dir, 0)
    return serve(args.port, log_dir)


if __name__ == "__main__":
    raise SystemExit(main())
