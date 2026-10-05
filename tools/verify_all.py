"""一键全量验证：单元 + 产品级证伪 + E2E + 压缩包可加载性。

用法：python tools/verify_all.py
结果同时写到 tests/.final.txt（本机控制台是 GBK，直接 print 中文会乱码）。
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ZIP = os.path.join(os.path.dirname(PROJ), "bookmark-organizer-v1.0.0.zip")
ENV = dict(os.environ, NO_COLOR="1", NODE_DISABLE_COLORS="1", PYTHONIOENCODING="utf-8")

lines = []


def say(s=""):
    lines.append(str(s))


def counts(tap):
    out = {}
    for k in ("tests", "pass", "fail"):
        m = re.search(r"^# " + k + r" (\d+)$", tap, re.M)
        if m:
            out[k] = int(m.group(1))
    return out


def run(cmd, timeout=900):
    return subprocess.run(cmd, cwd=PROJ, capture_output=True, env=ENV, timeout=timeout)


def main():
    unit_ok = falsify_ok = e2e_ok = zip_ok = False

    # 1) 单元
    r = run(["node", "--test", "--test-reporter=tap", "tests/unit/*.test.js"])
    tap = r.stdout.decode("utf-8", "replace") + r.stderr.decode("utf-8", "replace")
    c = counts(tap)
    unit_ok = c.get("fail") == 0 and r.returncode == 0
    say(f"[1] 单元测试        tests={c.get('tests')} pass={c.get('pass')} "
        f"fail={c.get('fail')}  exit={r.returncode}")

    # 2) 产品级证伪：改坏真实源码，确认整套测试会红
    r = run(["python", "tests/product_falsification.py"])
    fals = r.stdout.decode("utf-8", "replace")
    red = len(re.findall(r"\[RED", fals))
    defer = len(re.findall(r"\[DEFERRED", fals))
    falsify_ok = "每处退化都让整套测试变红" in fals and red > 0 and defer == 0
    say(f"[2] 产品级证伪      变红 {red} 处 / 延后 {defer} 处  成立={falsify_ok}  exit={r.returncode}")

    # 3) E2E
    r = run(["node", "--test", "--test-reporter=tap", "tests/e2e/run.js"])
    tap = r.stdout.decode("utf-8", "replace") + r.stderr.decode("utf-8", "replace")
    c = counts(tap)
    e2e_ok = c.get("fail") == 0 and r.returncode == 0
    say(f"[3] E2E            tests={c.get('tests')} pass={c.get('pass')} "
        f"fail={c.get('fail')}  exit={r.returncode}")
    for line in tap.split("\n"):
        m = re.match(r"^(not ok|ok) \d+ - (.*)", line)
        if m:
            say(f"      {m.group(1):6s} {m.group(2)[:52]}")

    # 4) 压缩包可加载性：解压到临时目录，用 Playwright 真加载一次
    # ⚠️ 校验脚本必须放在【项目目录】里跑 —— 解压出来的目录没有 node_modules，
    #    `import { chromium } from 'playwright'` 会解析不到。扩展路径指向解压目录即可。
    say("[4] 压缩包可加载性")
    tmp = tempfile.mkdtemp(prefix="bo-zipcheck-")
    try:
        with zipfile.ZipFile(ZIP) as z:
            z.extractall(tmp)
        check = os.path.join(PROJ, "tests", ".zipload.mjs")
        with open(check, "w", encoding="utf-8", newline="\n") as f:
            f.write(
                "import { chromium } from 'playwright';\n"
                f"const dir = {tmp!r};\n"
                "const ctx = await chromium.launchPersistentContext(dir + '/__profile', {\n"
                "  channel: 'chromium', headless: false,\n"
                "  args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`,\n"
                "         '--no-first-run', '--no-default-browser-check'],\n"
                "});\n"
                "let [sw] = ctx.serviceWorkers();\n"
                "if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });\n"
                "const id = new URL(sw.url()).host;\n"
                "const page = await ctx.newPage();\n"
                "await page.goto(`chrome-extension://${id}/ui/options.html`, { waitUntil: 'domcontentloaded' });\n"
                "await page.waitForSelector('body[data-ready=\"1\"]', { timeout: 20000 });\n"
                "const stats = await page.evaluate(() => document.getElementById('stTotal').textContent.trim());\n"
                "console.log('LOADED id=' + id + ' stTotal=' + stats);\n"
                "await ctx.close();\n"
            )
        r = run(["node", "tests/.zipload.mjs"], timeout=240)
        out = (r.stdout.decode("utf-8", "replace") + r.stderr.decode("utf-8", "replace")).strip()
        say(f"      exit={r.returncode}  {out.splitlines()[-1] if out else '(无输出)'}")
        zip_ok = r.returncode == 0 and "LOADED" in out
    except Exception as e:
        zip_ok = False
        say(f"      异常: {e}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    say()
    say(f"单元={unit_ok}  证伪={falsify_ok}  E2E={e2e_ok}  压缩包可加载={zip_ok}")
    allok = unit_ok and falsify_ok and e2e_ok and zip_ok
    say("总判定：" + ("全部通过" if allok else "存在失败项"))

    text = "\n".join(lines)
    with open(os.path.join(PROJ, "tests", ".final.txt"), "w", encoding="utf-8", newline="\n") as f:
        f.write(text + "\n")
    return 0 if allok else 1


if __name__ == "__main__":
    sys.exit(main())
