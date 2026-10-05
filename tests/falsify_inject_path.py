"""证伪 inject-path 这三道闸门：打上原始坏实现，确认闸门**确实会红**，再还原。

为什么不省这一步：三道闸门全是静态断言，而静态断言最常见的失败模式是
「因为错误的原因而绿」—— 断言写得太松、或匹配到注释里的旧代码，
于是坏实现照样通过。AGENTS.md 里已经记过一次同类教训
（扫描器不去注释 → JSDoc 里的假导入被当真）。

做法与 tests/product_falsification.py 保持一致：备份 → 打坏补丁 → 跑 → 断言红 → 还原。
每一步都检查退出码，任何一步不符合预期就整体失败退出，不留脏工作区。
"""
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
LLM_JS = ROOT / "src" / "classify" / "llm.js"
GATE = ["node", "--test", "tests/unit/inject-path.test.js"]

# (用例名, 说明, 补丁函数)
def break_import_path(text: str) -> str:
    """把候选列表改回原来那个错了一级的路径。"""
    return re.sub(
        r"const INJECTED_CANDIDATES = \[[^\]]*\];",
        "const INJECTED_CANDIDATES = ['./llm-key.local.js'];",
        text,
        count=1,
    )

def break_no_silent_catch(text: str) -> str:
    """把带原因的加载换回静默退化。"""
    return text.replace(
        "if (!injectedPromise) injectedPromise = loadInjected();",
        "if (!injectedPromise) injectedPromise = import('./llm-key.local.js')"
        ".then((m) => (m && m.default) || {}).catch(() => ({}));",
        count=1,
    )

def break_timeout(text: str) -> str:
    """把带超时的 fetch 换回裸 fetch（与加超时之前的实现一致）。"""
    return re.sub(
        r"const res = await fetchWithTimeout\(url, \{",
        "const res = await fetch(url, {",
        text,
        count=1,
    )

CASES = [
    ("import-path", "候选路径退回错一级的 ./llm-key.local.js", break_import_path),
    ("silent-catch", "加载失败重新被静默吞成 {}", break_no_silent_catch),
    ("no-timeout", "fetch 退回无超时的裸调用", break_timeout),
]


def run_gate():
    p = subprocess.run(
        GATE, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def main() -> int:
    backup = Path(tempfile.mkdtemp(prefix="falsify-llm-")) / "llm.js"
    shutil.copy2(LLM_JS, backup)
    original = backup.read_text(encoding="utf-8")

    # 基线：完好实现必须是绿的，否则这道证伪本身没有意义
    code, out = run_gate()
    if code != 0:
        print("基线就是红的 —— 先修好再证伪：")
        print(out[-2000:])
        shutil.rmtree(backup.parent, ignore_errors=True)
        return 1
    print("基线 GREEN（完好实现通过 3 道闸门）")

    failures = []
    try:
        for name, desc, patch in CASES:
            mutated = patch(original)
            if mutated == original:
                failures.append(f"{name}: 补丁没有改动任何内容 —— 闸门可能根本没在检查它")
                print(f"  ❌ {name}: 补丁无效")
                continue
            LLM_JS.write_text(mutated, encoding="utf-8", newline="")
            code, out = run_gate()
            if code == 0:
                failures.append(f"{name}: 打了坏补丁闸门仍然绿 —— 这道闸门是摆设")
                print(f"  ❌ {name}: 仍然 GREEN（{desc}）")
            else:
                failed = re.findall(r"^not ok \d+ - (.+)$", out, re.M)
                print(f"  ✅ {name}: 变红（{desc}）→ {failed or ['(见下)']}")
    finally:
        LLM_JS.write_text(original, encoding="utf-8", newline="")
        shutil.rmtree(backup.parent, ignore_errors=True)

    # 还原后再确认一次是绿的
    code, out = run_gate()
    if code != 0:
        failures.append("还原后仍然红 —— 证伪脚本把源码改坏了")
        print("还原后仍红：")
        print(out[-2000:])
    else:
        print("还原后 GREEN（源码已复原）")

    if failures:
        print("\n证伪未通过：")
        for f in failures:
            print("  -", f)
        return 1
    print("\n3/3 闸门均被证明「确实会红」。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
