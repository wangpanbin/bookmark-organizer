"""一键全量验证：面板契约 + 单元 + 产品级证伪 + E2E + 压缩包可加载性。

用法：python tools/verify_all.py
结果同时写到 tests/.final.txt（本机控制台是 GBK，直接 print 中文会乱码）。

⚠️ 本脚本**不要**与任何编辑或测试并发跑：`product_falsification.py` 会修改
   真实源文件、跑一遍整套、再还原。并发时你会拿到一次假失败
   （证伪正在给 normalize.js 注入 indexedDB，而你同时跑了单测，
   纯链路闸门理所当然地红了）。
"""
import os
import re
import shutil
import glob
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
    unit_ok = falsify_ok = e2e_ok = zip_ok = ui_ok = False

    # 0) 面板 DOM 契约闸门
    #    ⚠️ 排在**最前面**是刻意的：它是纯静态检查，零浏览器、亚秒级。
    #       而 E2E 与证伪是分钟级。把它排在后面等于让人等两分钟才发现
    #       「面板上那个 id 拼错了」这种一秒就能看出的事。
    #    2026-10-06 之前它压根没接在任何地方 —— 也就是「有闸门但从没被要求跑过」，
    #    与 precommit.py 文档里记的那个失败模式一模一样。
    say("[0] 面板契约闸门")
    r = run(["python", os.path.join("tools", "ui_contract_gate.py")], timeout=120)
    out = (r.stdout.decode("utf-8", "replace") + r.stderr.decode("utf-8", "replace"))
    ui_ok = r.returncode == 0
    for line in out.split("\n"):
        # 只摘 False 行、PASS/FAIL 标题与 FAIL 清单，其余三十多条 True 是噪音。
        # ⚠️ FAIL 标题在**行首**（没有缩进），False 行是**缩进**过的 ——
        #    早先的正则 `^\s+(False|FAIL:)` 会把标题漏掉，于是失败清单
        #    孤零零地飘出来而没有 FAIL 三个字，看起来像半截输出。
        if re.search(r"^\s*False\b|^\s+-\s|^FAIL:|^PASS", line):
            say(f"      {line.strip()}")
    say(f"      exit={r.returncode}  成立={ui_ok}")

    # 1) 单元
    # ⚠️ 枚举出显式文件列表，**不要**把 "tests/unit/*.test.js" 当一个参数交给 node。
    #    node 自己展开 glob 只有 Node 22+ 才认；Node 20 上它会当成一个字面文件名，
    #    然后**静默什么都不跑**，而 `counts()` 从空输出里取不到 fail 键 → fail=None，
    #    `None == 0` 为假 → 反而判成失败。两种结局都错：要么假红，要么（更糟）
    #    哪天输出里恰好出现过一个 `# fail 0` 就变成假绿。
    #    这里与 tools/precommit.py 用同一套枚举，两边不会漂移。
    unit_files = sorted(
        os.path.relpath(p, PROJ).replace("\\", "/")
        for p in glob.glob(os.path.join(PROJ, "tests", "unit", "*.test.js"))
    )
    if not unit_files:
        say("[1] 单元测试        一个 tests/unit/*.test.js 都没找到")
        return 1
    r = run(["node", "--test", "--test-reporter=tap", *unit_files])
    tap = r.stdout.decode("utf-8", "replace") + r.stderr.decode("utf-8", "replace")
    c = counts(tap)
    # 绿灯必须真的跑过：TAP 汇总行里的 tests 数必须等于枚举到的文件里至少 1 个用例
    ran = c.get("tests", 0)
    unit_ok = c.get("fail") == 0 and r.returncode == 0 and ran > 0
    say(f"[1] 单元测试        tests={c.get('tests')} pass={c.get('pass')} "
        f"fail={c.get('fail')}  exit={r.returncode}  文件数={len(unit_files)}")
    if ran == 0:
        say("      ⚠️ 汇总行里 tests=0 —— 什么都没跑，不能当通过")

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
    say(f"面板契约={ui_ok}  单元={unit_ok}  证伪={falsify_ok}  "
        f"E2E={e2e_ok}  压缩包可加载={zip_ok}")
    allok = ui_ok and unit_ok and falsify_ok and e2e_ok and zip_ok
    say("总判定：" + ("全部通过" if allok else "存在失败项"))

    text = "\n".join(lines)
    with open(os.path.join(PROJ, "tests", ".final.txt"), "w", encoding="utf-8", newline="\n") as f:
        f.write(text + "\n")
    return 0 if allok else 1


if __name__ == "__main__":
    sys.exit(main())
