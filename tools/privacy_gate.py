#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
发布前隐私闸门：穷举 git 即将推送的每一个 blob，搜敏感串。

为什么不满足于 `git grep` / `git log -S`：
    那两个只看**当前工作树**或**某个 diff 触点**。真正的判据是
    「git push 到底会把哪些对象送出去」= 所有 ref 可达的全部 blob。
    一个曾在历史里出现过的文件，其**旧 blob** 只要还挂在某个 ref 上
    （refs/original/、某个 tag、误开的分支）就会一起被推上去。
    所以这里直接枚举对象，而不是搜文件。

⚠️ 闸门不能把自己变成泄露源
    本文件必须扫描它自己（排除自己 = 一个藏污纳垢的盲区）。所以：
      · 待查的真实字面值一律 **base64 存放、运行时解码**，磁盘上不留明文；
      · 自检用的坏样本全部**程序化拼装**，且刻意使用**不在白名单里**的
        合成值 —— 这样既证明闸门会红，也证明白名单不是「一律放行」。
    写完请用 `python tools/privacy_gate.py` 自查，别让闸门红在自己身上。

用法
    python tools/privacy_gate.py             # 扫所有 ref 可达的 blob（发布前）
    python tools/privacy_gate.py --staged    # 只扫已跟踪文件（快，提交前自查）
    python tools/privacy_gate.py --selftest  # 只验闸门本身会不会红

判据
    绿灯 = 所有将推送的 blob 都不含敏感串，且自检通过。
    自检先跑：拿已知坏样本喂给匹配器，**必须命中**。
    一个从来没红过的闸门，和没有闸门是一样的。
"""
import base64
import os
import re
import subprocess
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ── 真实泄露过的字面值，base64 存放 ──
# 这些值 2026-10-06 已从工作区和 git 历史中彻底移除。
# 保留在闸门里是为了：以后有人把真书签贴回仓库时立刻报红。
# 用 base64 是因为明文写在这里 = 把刚脱敏的东西又发回公开仓库。
_LITERAL_B64 = [
    "aGVhdXFkbXliaw==",                    # 飞书私租户子域名
    "aGFpbmFudQ==",                        # 真实学校名
    "bmlpdC5jb20uY24=",                    # 真实商业品牌的学习中心域
    "SEg5Sndock5VaXN5OXprbEc5U2M0anBoaG5oZQ==",
    "d09iend6OXlXaUFxQThrTlRNeWNRbmZlbm5i",
    "RllOS3diMWk2aTBxd0NrN0xGMmNhRXE1blJl",
]
LITERAL_SECRETS = [base64.b64decode(s).decode() for s in _LITERAL_B64]

# ── 真 key 的形状（防漏：以后再有人硬编码真 key 也能抓到）──
KEY_PATTERNS = [
    ("sk- 形态 key", r"sk-[A-Za-z0-9]{20,}"),
    ("飞书 wiki token", r"feishu\.cn/wiki/[A-Za-z0-9]{20,}"),
    ("gh token", r"gh[pousr]_[A-Za-z0-9]{20,}"),
    ("AWS key", r"AKIA[A-Z0-9]{16}"),
    ("私钥块", r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
]

# ── 合成值白名单 ──
# 形状检测器天然分不出真 token 和假 token。而
# tests/e2e/repro-real.js 的夹具**必须**保留真实 token 的形状 ——
# 私租户 wiki + 28 位不透明 token 正是这个回归测试要复现的东西，
# 换成 example.com 就把测试改成空转了。
# 所以显式登记「已知为合成」的值：闸门继续能抓未来的真 key，
# 又不会对刻意合成的夹具误报。
# 新增合成值必须同时登记到这里，否则闸门会红 —— 这是刻意留的摩擦。
SYNTHETIC = {
    "feishu.cn/wiki/Qa7mXv2LpRt9Bk4Nwz8Hs1Dc6Yf",
    "feishu.cn/wiki/Tb3nKg6YhFd0Ws9XcVr2Jm5Pqn",
    "feishu.cn/wiki/Wk9tRb4XcNv7Qs2LpJd6Yh1Fg",
    "sk-manual",   # tests/unit/llm.test.js 的假 key
    "sk-x",        # tests/unit/llm.test.js 的假 key
}

_LIT = [(s, re.compile(re.escape(s))) for s in LITERAL_SECRETS]
_PAT = [(n, re.compile(p)) for n, p in KEY_PATTERNS]


def match_content(content):
    """返回命中项 [(显示值, 名称, 种类)]"""
    hits = []
    for s, rx in _LIT:
        if rx.search(content):
            hits.append((s, s, "literal"))
    for name, rx in _PAT:
        for m in rx.finditer(content):
            val = m.group(0)
            # 形状命中：整值在白名单里 → 视为已知合成值
            if val in SYNTHETIC:
                continue
            hits.append((val[:40], name, "pattern"))
    return hits


def git(*args):
    r = subprocess.run(["git", "-C", ROOT, *args], capture_output=True,
                       text=True, encoding="utf-8", errors="replace")
    return r.stdout


def selftest():
    """坏样本必须命中，合成值必须放行。两边都对，闸门才可信。

    坏样本刻意用**不在白名单里**的合成值（而不是真 token）：
    既证明形状检测会红，也证明白名单不是「一律放行」。
    literal 检测则直接用解码出来的真实字面值来验。
    """
    bad = [
        # 注意：负控样本一律拆成两段拼接，源码里就不会出现连续的敏感串，
        # 闸门扫描自己时才不会把自己判红。形状检测的是**拼出来的**字符串。
        ("sk-" + "a" * 32, "真 key 形态"),
        ("https://zz9q7k2m.feishu.cn/wiki/" + "Qq7Zz2Mm4Xx7Pp1Vv8Bb3Nn6", "白名单外的 wiki token"),
        ("gho_" + "b" * 36, "gh token"),
        ("AKIA" + "Z7QX2MPL9KD4BN1C", "AWS key"),          # AKIA + 16 位大写字母数字
        ("-----BEGIN RSA " + "PRIVATE KEY-----", "私钥块"),
        (LITERAL_SECRETS[0], "已泄露的真实字面值"),
    ]
    rc = 0
    print("— 负控：这些必须命中 —")
    for text, why in bad:
        n = len(match_content(text))
        ok = n > 0
        rc |= 0 if ok else 1
        print(f"   {'✓' if ok else '✗ 未命中!'} {why:<22} {n} 处")
    print("— 正控：这些必须放行（刻意合成的夹具值）—")
    for text in sorted(SYNTHETIC):
        n = len(match_content(text))
        ok = n == 0
        rc |= 0 if ok else 1
        print(f"   {'✓' if ok else '✗ 误报!'} {n} 处命中  {text[:44]}")
    print(f"\n自检{'通过' if rc == 0 else '失败'} —— 闸门既会红，也不会误报。\n")
    return rc


def scan_refs():
    """扫所有 ref 可达的 blob —— 这就是 git push 会送出去的东西"""
    objs = git("rev-list", "--objects", "--all").splitlines()
    items = []
    for line in objs:
        parts = line.split(maxsplit=1)
        if len(parts) != 2:
            continue
        sha, path = parts
        if git("cat-file", "-t", sha).strip() == "blob":
            items.append((path, git("cat-file", "-p", sha)))
    return _report(items, "所有 ref 可达")


def scan_tracked():
    """快路径：只扫工作区里 git 已跟踪的文件（提交前自查用）"""
    items = []
    for path in git("ls-files").splitlines():
        path = path.strip()
        if not path:
            continue
        full = os.path.join(ROOT, path)
        if os.path.isfile(full):
            with open(full, "r", encoding="utf-8", errors="replace") as f:
                items.append((path, f.read()))
    return _report(items, "已跟踪文件")


def _report(items, label):
    hits = []
    for path, content in items:
        for what, name, kind in match_content(content):
            hits.append((path, what, name, kind))
    print(f"[{label}] 扫描 {len(items)} 个文件 -> "
          + ("🔴 HIT" if hits else "✅ clean"))
    for path, what, name, kind in hits:
        print(f"      {kind:<8} {name:<16} {what[:34]:<36} {path}")
    return len(hits)


def main():
    if "--selftest" in sys.argv:
        return selftest()

    rc = selftest()
    n = scan_tracked() if "--staged" in sys.argv else scan_refs()

    if rc:
        print("\n❌ 自检失败：闸门本身不可信，别据此下结论。")
        return 2
    if n:
        print(f"\n❌ 仍有 {n} 处敏感串，**不要提交 / 不要 push**。")
        print("   真的泄露过密钥的话，改文件不够 —— 必须重写历史并轮换密钥。")
        return 1
    print("\n✅ 未发现敏感串。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
