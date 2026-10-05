"""从本机环境变量读取 API key，注入扩展可加载的本地配置文件。

═══ 为什么必须有这一步 ═══
Chrome 扩展的运行时**读不到操作系统环境变量**。MV3 跑在浏览器里，没有
`process` 对象，也没有任何读取 OS 环境的 API —— 在扩展里写
`process.env.DEEPSEEK_API_KEY` 只会得到 `undefined`。
官方文档里的 `process.env.DEEPSEEK_API_KEY` 是给 Node/Python SDK 用的示例。

所以「key 从环境变量获取」只能这样落地：在**装机/加载前**由本机脚本读一次
环境变量，写成一个扩展能加载的模块。key 不进 git、不进发布包、
不进 manifest，只存在于你自己的扩展目录里。

用法
    $env:DEEPSEEK_API_KEY = "sk-..."      # PowerShell
    python tools/inject_key.py            # 注入
    python tools/inject_key.py --check    # 只看当前状态，不写
    python tools/inject_key.py --clear    # 移除注入文件

环境变量优先级：DEEPSEEK_API_KEY > LLM_API_KEY
"""
import argparse
import os
import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGET = os.path.join(ROOT, "src", "llm-key.local.js")

ENV_NAMES = ["DEEPSEEK_API_KEY", "LLM_API_KEY"]

# 注入的默认值。模型名保持可配置 —— DeepSeek 官方文档对「当前该用哪个模型名」
# 存在互相矛盾的说法（api-docs.deepseek.com 说 v4-flash/v4-pro 且 deepseek-chat
# 已于 2026-07-24 弃用；platform.deepseek.com 说用 deepseek-flash），
# 与其押注一个随时可能失效的名字，不如给默认值 + UI 可改。
DEFAULTS = {
    "baseUrl": "https://api.deepseek.com",
    "model": "deepseek-flash",
}


def read_env_key():
    for name in ENV_NAMES:
        v = (os.environ.get(name) or "").strip()
        if v:
            return name, v
    return None, None


def mask(key):
    if not key:
        return "(空)"
    if len(key) <= 8:
        return key[:2] + "****"
    return f"{key[:4]}****{key[-4:]}"


def render(key):
    lines = [
        "/* eslint-disable */",
        "// 本文件由 tools/inject_key.py 自动生成，请勿手改。",
        "// 已加入 .gitignore，且打包时会被排除 —— 它不会进版本库，也不会进发布 zip。",
        "// 删除方式：python tools/inject_key.py --clear",
        "//",
        "// 想换模型 / 换服务商：直接在扩展面板的「设置 → LLM 兜底」里改，",
        "// 面板里的值优先于这里。",
        "export default {",
        f"  source: 'env',",
        f"  envVar: '{ENV_NAMES[0]}',",
        f"  baseUrl: {DEFAULTS['baseUrl']!r},".replace("'", "'"),
        f"  model: {DEFAULTS['model']!r},".replace("'", "'"),
        f"  apiKey: {key!r},".replace("'", "'"),
        "};",
        "",
    ]
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只看状态，不写文件")
    ap.add_argument("--clear", action="store_true", help="移除注入文件")
    args = ap.parse_args()

    if args.clear:
        if os.path.isfile(TARGET):
            with open(TARGET, "r", encoding="utf-8") as f:
                m = re.search(r"apiKey:\s*'([^']*)'", f.read())
            os.remove(TARGET)
            print(f"已移除 {os.path.relpath(TARGET, ROOT)}"
                  + (f"（原 key {mask(m.group(1))}）" if m else ""))
        else:
            print("没有注入文件，无需清理")
        return 0

    name, key = read_env_key()
    exists = os.path.isfile(TARGET)
    existing_key = None
    if exists:
        with open(TARGET, "r", encoding="utf-8") as f:
            mm = re.search(r"apiKey:\s*'([^']*)'", f.read())
            existing_key = mm.group(1) if mm else None

    if args.check:
        print(f"环境变量: {name} = {mask(key) if key else '(未设置)'}")
        print(f"注入文件: {'存在' if exists else '不存在'}  key={mask(existing_key) if existing_key else '(无)'}")
        return 0 if key or existing_key else 1

    if not key:
        print("未找到 API key。设置任一环境变量后重试：", file=sys.stderr)
        for n in ENV_NAMES:
            print(f"  PowerShell:  $env:{n} = \"sk-...\"", file=sys.stderr)
            print(f"  cmd:         set {n}=sk-...", file=sys.stderr)
        if existing_key:
            print(f"（已有注入的 key {mask(existing_key)}，本次未改动）", file=sys.stderr)
        return 1

    with open(TARGET, "w", encoding="utf-8", newline="\n") as f:
        f.write(render(key))

    print(f"已注入 → {os.path.relpath(TARGET, ROOT)}")
    print(f"  来源环境变量: {name}")
    print(f"  key: {mask(key)}")
    print(f"  baseUrl: {DEFAULTS['baseUrl']}")
    print(f"  model: {DEFAULTS['model']}")
    print()
    print("现在可以到 chrome://extensions 重新加载扩展，面板里的 LLM 兜底会自动启用。")
    print("该文件已被 .gitignore 排除，打包时也不会包含。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
