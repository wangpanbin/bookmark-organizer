"""内容归档接收器：把扩展抓到的正文落到本机磁盘。

为什么必须有这个进程
--------------------
Chrome 扩展**无法写任意本地路径**。MV3 没有文件系统 API，
service worker 里连 ``showSaveFilePicker`` 都不存在（那只在有 DOM 的面板页，
而且必须用户手势触发）。所以「永久副本」必须经由本机进程落地 ——
这与 ``tools/fail_log_sink.py`` 是同一个理由，但**刻意不合并进那个文件**：
日志是轻量、随时要用的；归档是重量的、且要跑浏览器渲染。
耦合之后，想记日志就得先把归档那套拉起来。

用法
----
    python tools/archive_sink.py                 # 起接收器（前台）
    python tools/archive_sink.py --dir D:\\arch   # 换目录
    python tools/archive_sink.py --selftest      # 自检：写一条再读回

端口
----
    8732。**只出现在三处**，改端口要同时改：
      · 本文件的 ``DEFAULT_PORT``
      · ``src/archive/client.js`` 的 ``SINK_PORT``
      · ``src/dedupe/embedding-client.js`` 的 ``SINK_PORT``（取归档正文喂 embedding）

⚠️ CORS 与 PNA
--------------
扩展 origin（``chrome-extension://…``）请求 ``127.0.0.1`` 属于
「公开来源访问私有网络」（PNA）。少这个响应头，浏览器会**在 service worker 里
直接把 fetch 掐掉**，现象是「明明请求了、什么都没发生」——和没接一样。
``--selftest`` 的第一步就查它。

⚠️ 目录不可用时**启动即报错退出**并说清原因，不静默换个地方写。
   静默换目录 = 又一次「以为记上了其实没记」。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, quote

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_PORT = 8732
DEFAULT_DIR = r"F:\archive\bookmark-organizer"
RENDERER = os.path.join(ROOT, "tools", "render_archive.js")

# 正文超过这个大小就不存了 —— 单页 2MB 已经很离谱，
# 而「全量归档 800 条」的真问题从来不是单页大小，是总量
MAX_BODY = 2 * 1024 * 1024
_lock = threading.Lock()
_written = 0


def safe_name(url: str) -> str:
    """URL → 合法且可读的文件名。

    ⚠️ 刻意把 host 放在前面并加时间戳后缀：同名站点的不同页面
    不能互相覆盖，而「按抓取时间排序」比「按 URL 排序」更符合
    你回头找东西的直觉。

    ⚠️⚠️ 摘要必须是 **sha256**，不能是 `hash()`（2026-10-06 修的真 bug）。
       Python 的 str `hash()` 走 PEP 456 的 siphash，**每个进程随机加盐**
       （PYTHONHASHSEED 不设时），所以：
         · 同一个 URL 在接收器重启后得到**不同的文件名**；
         · `GET /text?url=`（语义去重取正文的唯一来源）永远找不到之前归档的那份；
         · 同一天重复归档会产生一个**新**文件而不是覆盖，
           `index.jsonl` 于是为同一个 URL 堆出一串重复行。
       症状与「以为存了其实没存」是同一类，而且 `--selftest` 查不出来：
       自检只在**一个进程内**写一次再读一次，随机化还没来得及发作。
       判据是跨进程稳定性，不是「文件写出来了」。
    """
    try:
        u = urlparse(url)
        host = (u.netloc or "unknown").replace(":", "_")
        path = (u.path or "/").strip("/").replace("/", "_")[:80]
        digest = int(hashlib.sha256(url.encode("utf-8")).hexdigest()[:12], 16) % (10 ** 10)
    except Exception:
        host, path, digest = "unknown", "page", 0
    stamp = time.strftime("%Y%m%d")
    return f"{stamp}_{digest:010d}_{host}_{path or 'index'}".replace("?", "_").replace("*", "_")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # 静音默认的 stderr 访问日志
        pass

    def _cors(self):
        # ⚠️ Access-Control-Allow-Private-Network 不能少。少了它
        # 浏览器会在 service worker 里直接掐掉 fetch。
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "600")

    def _json(self, code: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path

        if path == "/health":
            self._json(200, {"ok": True, "dir": self.server.archive_dir, "written": _written})
            return

        # 取归档正文（语义去重要靠它拿「标题之外的第二份信息」）
        if path == "/text":
            q = parse_qs(urlparse(self.path).query)
            url = (q.get("url") or [""])[0]
            if not url:
                self._json(400, {"error": "缺 url"})
                return
            html_path = os.path.join(self.server.archive_dir, safe_name(url) + ".html")
            if not os.path.isfile(html_path):
                self._json(200, {"text": ""})
                return
            with open(html_path, "r", encoding="utf-8", errors="replace") as f:
                self._json(200, {"text": f.read(4000)})
            return

        self._json(404, {"error": "no such endpoint"})

    def do_POST(self):
        path = urlparse(self.path).path
        if path != "/archive":
            self._json(404, {"error": "no such endpoint"})
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self._json(400, {"error": "Content-Length 不合法"})
            return
        if length <= 0:
            self._json(400, {"error": "空请求体"})
            return
        if length > MAX_BODY + 65536:
            # 明确告诉扩展「这页太大」而不是收下再丢
            self._json(413, {"error": f"超过 {MAX_BODY} 字节上限", "skipped": True})
            return

        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception as e:
            self._json(400, {"error": f"JSON 解析失败: {e}"})
            return

        url = str(payload.get("url") or "")
        html = str(payload.get("html") or "")
        if not url:
            self._json(400, {"error": "缺 url"})
            return
        if not html:
            self._json(200, {"ok": True, "skipped": True, "reason": "没有正文"})
            return

        name = safe_name(url)
        try:
            with _lock:
                os.makedirs(self.server.archive_dir, exist_ok=True)
                with open(os.path.join(self.server.archive_dir, name + ".html"), "w",
                          encoding="utf-8", errors="replace") as f:
                    f.write(html)
                with open(os.path.join(self.server.archive_dir, name + ".json"), "w",
                          encoding="utf-8") as f:
                    json.dump({
                        "url": url, "bytes": len(html.encode("utf-8")),
                        "title": payload.get("title", ""), "at": int(time.time()),
                    }, f, ensure_ascii=False)
                globals()["_written"] = _written + 1
        except OSError as e:
            self._json(500, {"error": f"落盘失败: {e}"})
            return

        # 索引
        with _lock:
            idx_path = os.path.join(self.server.archive_dir, "index.jsonl")
            with open(idx_path, "a", encoding="utf-8") as f:
                f.write(json.dumps({"url": url, "file": name + ".html",
                                    "bytes": len(html.encode("utf-8")),
                                    "title": payload.get("title", ""),
                                    "at": int(time.time())}, ensure_ascii=False) + "\n")

        # 重要页才渲染 PDF/截图（spec 的分级：全量 HTML，重渲染只给重要的）
        rendered = None
        if payload.get("important"):
            rendered = self._render(name, url)

        self._json(200, {"ok": True, "file": name + ".html", "rendered": rendered})


def _render(name: str, url: str):
    """调 Node 渲染子进程出 PDF + 截图。

    ⚠️ 刻意分成两个进程：接收器是 Python（你的规范：脚本一律 Python），
    而渲染必须真的开一个浏览器 —— 本机已有完整 Chromium
    （E2E 一直在用 Playwright 的 channel:'chromium' + 有头模式，有实测依据）。
    渲染失败**不算归档失败**：HTML 已经落盘了，那是「原站挂了也能读」的底线。
    """
    if not os.path.isfile(RENDERER):
        return {"ok": False, "reason": "找不到 render_archive.js，跳过 PDF/截图"}
    import subprocess
    try:
        p = subprocess.run(
            ["node", RENDERER, "--out", name, "--url", url],
            cwd=os.path.dirname(RENDERER), capture_output=True, timeout=120,
        )
        if p.returncode != 0:
            return {"ok": False, "reason": (p.stderr or b"").decode("utf-8", "replace")[:200]}
        return {"ok": True, "out": name}
    except Exception as e:
        return {"ok": False, "reason": str(e)[:200]}


def serve(port: int, archive_dir: str):
    if not os.path.isdir(os.path.dirname(archive_dir)) and os.path.dirname(archive_dir):
        parent = os.path.dirname(archive_dir)
        if not os.path.isdir(parent):
            print(f"[archive-sink] 启动即失败：上级目录不存在 {parent}")
            print("               换一个 --dir，或先建好目录。静默换地方写=又一次「以为记上了其实没记」。")
            return 2
    os.makedirs(archive_dir, exist_ok=True)

    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    httpd.archive_dir = archive_dir
    print(f"[archive-sink] 监听 127.0.0.1:{port}，归档目录 {archive_dir}")
    print(f"[archive-sink] 渲染子进程 {RENDERER if os.path.isfile(RENDERER) else '（缺失，PDF/截图会被跳过）'}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[archive-sink] 已停止")
    return 0


def selftest(port: int, archive_dir: str):
    """起服务 → POST 一条 → 读盘 → 断言字段 → 退出。

    这是证明「真能落盘」的最便宜手段。判据是**磁盘上的文件**，
    不是接口返回 200 —— 本项目有过「面板报 100% 成功、什么都没变」的前科。
    """
    import urllib.request
    import tempfile
    import shutil

    tmp = tempfile.mkdtemp(prefix="archive-selftest-")
    try:
        rc = serve_in_bg(port + 11, tmp)
        if rc != 0:
            return rc

        url = "https://example.com/selftest-page"
        html = "<html><head><title>自检</title></head><body>hello archive</body></html>"
        body = json.dumps({"url": url, "html": html, "title": "自检"}).encode("utf-8")
        req = urllib.request.Request(
            f"http://127.0.0.1:{port + 11}/archive", data=body,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            out = json.loads(r.read().decode("utf-8"))
        assert out.get("ok"), f"接口没有返回 ok: {out}"

        # 判据：文件真的在磁盘上
        files = os.listdir(tmp)
        htmls = [f for f in files if f.endswith(".html")]
        assert htmls, f"目录里没有 .html：{files}"
        with open(os.path.join(tmp, htmls[0]), "r", encoding="utf-8") as f:
            assert "hello archive" in f.read(), "文件在但内容不对"
        assert any(f.endswith(".json") for f in files), "缺元数据文件"

        # 判据：CORS + PNA 头在（少了 PNA，service worker 里的 fetch 会被直接掐掉）
        hreq = urllib.request.Request(f"http://127.0.0.1:{port + 11}/health")
        with urllib.request.urlopen(hreq, timeout=5) as r:
            assert r.headers.get("Access-Control-Allow-Private-Network") == "true", "缺 PNA 头"
            assert r.headers.get("Access-Control-Allow-Origin") == "*", "缺 CORS 头"

        # ⚠️ 判据：文件名**跨进程稳定**（2026-10-06 补）
        #    上面那次写盘读盘是在**同一个进程内**完成的，所以它抓不到
        #    「用 hash() 当摘要」这个 bug —— str hash 每进程随机加盐，
        #    同一个进程里算两次当然一致。必须换一个 PYTHONHASHSEED
        #    再起一个进程才算跨进程。
        #    症状：`/text?url=` 找不到旧档、同日重复归档堆出一串重复文件。
        import subprocess
        probe = (
            "import sys;sys.path.insert(0, sys.argv[1]);"
            "import importlib.util;"
            "spec=importlib.util.spec_from_file_location('sink', sys.argv[1]+'/tools/archive_sink.py');"
            "m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);"
            "print(m.safe_name(sys.argv[2]))"
        )
        seeds = ("1", "99999")
        names = []
        for s in seeds:
            env = dict(os.environ, PYTHONHASHSEED=s)
            p = subprocess.run([sys.executable, "-c", probe, ROOT, url],
                               capture_output=True, env=env, timeout=30)
            assert p.returncode == 0, f"探针进程失败（PYTHONHASHSEED={s}）：{p.stderr.decode('utf-8','replace')[:200]}"
            names.append(p.stdout.decode("utf-8").strip())
        assert names[0] == names[1], (
            f"同一个 URL 在两个进程里得到不同文件名：{names} —— "
            "摘要不能用 hash()（每进程随机加盐），用 sha256"
        )
        assert names[0] == htmls[0][:-5], (
            f"子进程算出的名字与实际落盘的对不上：{names[0]} != {htmls[0][:-5]}"
        )
        print(f"[archive-sink] 自检通过：写入 {htmls[0]}，CORS/PNA 头齐全，"
              f"文件名跨进程稳定（PYTHONHASHSEED 1/99999 一致）")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


_servers = []


def serve_in_bg(port: int, archive_dir: str) -> int:
    os.makedirs(archive_dir, exist_ok=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    httpd.archive_dir = archive_dir
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    _servers.append(httpd)
    time.sleep(0.3)
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="书签内容归档接收器")
    ap.add_argument("--dir", default=DEFAULT_DIR, help="归档目录")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    sys.exit(selftest(a.port, a.dir) if a.selftest else serve(a.port, a.dir))
