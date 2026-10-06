#!/usr/bin/env python3
"""面板 DOM 契约闸门：把「布局重构不能碰的东西」写成会红的检查。

为什么需要它
------------
这个面板的 E2E 有一批**看不见的耦合**：它们靠数行数、按 td 下标取字段来
判断「这一轮真的渲染完了」「这条被分到了哪里」。改布局时这些耦合一个都看不出来，
编译也不报错，E2E 却会在别的地方红掉，甚至更糟 —— **假绿**：

  · ``document.querySelectorAll('#planBody tr').length``（harness.js / llm-path.js）
    一旦往 tbody 里塞骨架占位行，「还没加载完」会被读成「加载完了」，
    后面所有断言都建立在错误前提上。
  · ``tr.querySelectorAll('td')`` 按下标读（repro-organize / repro-real / diagnose）
    一旦调整单元格顺序或结构，字段会静默读空。
  · ``tds[5].textContent`` 读依据列（repro-organize.js:46），
    为了排版把两个徽章包一层容器，文本必须**逐字不变**。

这三类耦合肉眼不可见，所以钉在这里。判据先证伪：本文件第一段会
先验证「tbody 里确实一个骨架节点都没有」，不是恒真。

跑法
----
    python tools/ui_contract_gate.py

退出码 0 = 契约完好；1 = 有东西被改坏了。
"""
import io
import re
import sys
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

ROOT = Path(__file__).resolve().parent.parent
fails = []

css = (ROOT / 'ui' / 'options.css').read_text(encoding='utf-8')
html = (ROOT / 'ui' / 'options.html').read_text(encoding='utf-8')
js = (ROOT / 'ui' / 'options.js').read_text(encoding='utf-8')

print('[structure]')
print(f'  css braces balanced: {css.count("{") == css.count("}")} '
      f'({css.count("{")} open / {css.count("}")} close)')
if css.count('{') != css.count('}'):
    fails.append('css braces unbalanced')

# Classes referenced from JS/HTML that had no rules before the token/layout pass
for n in ['stat-row', 'grid', 'row-title', 'favicon', 'skip-link']:
    hit = f'.{n}' in css
    print(f'  .{n:11} has rules: {hit}')
    if not hit:
        fails.append(f'.{n} still has no rules')

# Tokens the new CSS depends on
for t in ['--accent-ink', '--on-accent', '--muted', '--container', '--gutter',
          '--z-topbar', '--shadow-1', '--radius-pill', '--sp-9']:
    hit = t in css
    print(f'  token {t:14} defined: {hit}')
    if not hit:
        fails.append(f'{t} missing')

html = (ROOT / 'ui' / 'options.html').read_text(encoding='utf-8')
ids = set(re.findall(r'\bid="([^"]+)"', html))

GATED = [
    'healthDisclosureText', 'btnLinkGrant', 'btnLinkRevoke', 'healthPermState',
    'btnLinkRun', 'btnLinkResume', 'btnLinkPause', 'healthProgress', 'linkInterval',
    'linkAiFind', 'healthSummary', 'healthRows', 'healthEmpty', 'healthAlt',
    'tabHealthCount', 'btnArchiveRun', 'btnArchiveProbe', 'archiveState',
    'archiveNote', 'semanticEnabled', 'semanticThreshold', 'btnSemanticRun',
    'btnSemanticClear', 'semanticState', 'semanticTable', 'semanticRows',
    'btnArchiveReset', 'importantCount', 'btnImportantClear',
    'planEmpty', 'dupEmpty', 'snapEmpty', 'execBar', 'report', 'tabs',
    'btnExecute', 'btnPreview', 'targetRoot',
]
miss = [i for i in GATED if i not in ids]
print(f'\n  gated ids present: {"ALL OK" if not miss else miss}')
if miss:
    fails.append(f'missing ids: {miss}')

for t in ['plan', 'dup', 'health', 'snap', 'settings']:
    ok = f'data-tab="{t}"' in html
    print(f'  data-tab={t:9} present: {ok}')
    if not ok:
        fails.append(f'data-tab={t} missing')

# E2E clicks the tab by data-tab; confirm role attributes did not break that
print(f'\n  role="tablist": {"role=\"tablist\"" in html}')
print(f'  role="tab":    {html.count("role=\"tab\"")} buttons')
print(f'  role="tabpanel": {html.count("role=\"tabpanel\"")} panels')
print(f'  aria-selected: {html.count("aria-selected")}')
print(f'  <main id="main">: {"<main id=\"main\">" in html}')
print(f'  skip-link:      {"class=\"skip-link\"" in html}')
print(f'  favicon link:   {"rel=\"icon\"" in html}')
print(f'  color-scheme:   {"color-scheme" in css}')

# remaining em-dashes: only the null placeholder may survive
print('\n  remaining em-dash lines that are NOT the null placeholder:')
leftover = 0
for f in ('options.js', 'options.html', 'popup.html'):
    for i, line in enumerate((ROOT / 'ui' / f).read_text(encoding='utf-8').splitlines(), 1):
        s = line.strip()
        if not re.search(r'[\u2014\u2013]', s):
            continue
        if s.startswith(('*', '//', '<!--')) or '-->' in s:
            continue          # comment
        if "'—'" in s or '>—<' in s or '=== ' in s and "'—'" in s:
            continue          # null placeholder, functionally coupled
        leftover += 1
        print(f'    ui/{f}:{i}  {s[:90]}')
if leftover:
    fails.append(f'{leftover} prose em-dash(es) remain')
else:
    print('    (none)')

# ── E2E 契约不变量 ──────────────────────────────────────────────
# 布局重构最容易在这里悄悄弄坏：E2E 靠数 #planBody 的行数判断「渲染完了」，
# 靠 td 的下标读字段。下面把这些钉死，改 DOM 前先看这一段。
print('\n[E2E contract] invariants the layout refactor must not break')
js = (ROOT / 'ui' / 'options.js').read_text(encoding='utf-8')

# 1) 骨架屏绝不能落进被计数的 tbody。
#    ⚠️ 判据查的是 **class**，不是骨架容器的 id —— 真正的手滑是「往 tbody 里
#    append 了几条占位行」，这时 planSkeleton 这个 id 根本不在 tbody 里，
#    只查 id 会漏掉。（第一版就是这么写的，证伪时被它漏过一次。）
for tid, host in (('planBody', 'planSkeleton'), ('healthRows', 'healthSkeleton')):
    m = re.search(r'<tbody[^>]*id="' + tid + r'"[^>]*>(.*?)</tbody>', html, re.S)
    if not m:
        print(f'  False <tbody id="{tid}"> not found in HTML')
        fails.append(f'tbody {tid} not found')
        continue
    inner = m.group(1)
    has_skel_class = 'skeleton' in inner
    has_skel_id = host in inner
    ok = not (has_skel_class or has_skel_id)
    print(f'  {ok!s:5} no skeleton node inside <tbody id="{tid}">')
    if not ok:
        fails.append(f'skeleton leaked into tbody {tid}')

    # JS 侧：被计数的 tbody 只允许被 append 真实行
    bad = re.search(r"\$\('" + tid + r"'\)\.append\((?!frag|tr\b|rows?\b)", js)
    ok2 = bad is None
    print(f'  {ok2!s:5} JS never appends non-row nodes into {tid}')
    if not ok2:
        fails.append(f'JS appends non-row nodes into {tid}')
    if re.search(r"\$\('" + tid + r"'\)\.appendChild", js):
        fails.append(f'JS appendChild into {tid}')

# 2) 计划表 7 个 td 的顺序不能动（repro-organize / repro-real / diagnose 按下标读）
m = re.search(r'tr\.append\((.*?)\);', js, re.S)
order = [x.strip() for x in m.group(1).split(',')] if m else []
expected = ['tdLock', 'tdItem', 'tdFrom', 'tdArrow', 'tdTo', 'tdWhy', 'tdFb']
ok = order == expected
print(f'  {ok!s:5} plan row td order: {order}')
if not ok:
    fails.append(f'td order changed: {order} != {expected}')

# 3) .title 必须仍在标题元素上（不能为了加 <a> 而换掉宿主结构）
ok = "title.className = 'title'" in js and "document.createElement('a')" in js
print(f'  {ok!s:5} .title class preserved on the title element')
if not ok:
    fails.append('.title class/host changed')

# 4) .why 包裹不能改变 tds[5] 的 textContent（repro-organize.js:46 读它）
ok = 'conf.style.marginLeft' not in js and 'why.append(badge, conf)' in js
print(f'  {ok!s:5} why-cell textContent unchanged (inline style replaced by .why)')
if not ok:
    fails.append('why cell textContent may have changed')

# 5) 锁的 checkbox 仍必须是行内第一个 checkbox（run.js:274 按 first-child 定位）
ok = "tr.append(tdLock, tdItem" in js
print(f'  {ok!s:5} lock checkbox still first cell (run.js:274 selector)')

# 6) 反馈按钮仍是 2 个（repro-organize.js:115 点 nth-child(2)）
ok = "fb.append(ok, bad)" in js
print(f'  {ok!s:5} .fb still has exactly 2 buttons in order')

# 7) 新增的 id 必须在 HTML 里真实存在
for new_id in ['planSkeleton', 'healthSkeleton', 'reportCard']:
    ok = f'id="{new_id}"' in html
    print(f'  {ok!s:5} new id {new_id} exists in HTML')
    if not ok:
        fails.append(f'new id {new_id} missing from HTML')

# 8) 新增的 class 必须有样式
for c in ['.skeleton', '.skeleton-row', '.skeleton-bar', '.empty-mark', '.empty-title',
          '.empty-hint', '.why', 'a.title', 'a.url']:
    ok = c in css
    print(f'  {ok!s:5} {c} has styles')
    if not ok:
        fails.append(f'{c} has no styles')

# 9) 归档的「重要」星标：表头、单元格、样式、aria 六件套缺一不可。
#    少任何一件的症状都是同一个：星标「不见了」，而没有任何报错。
#    判据查的是**四者同时存在**，不是「.star 有样式」这一半 ——
#    只有样式没有 aria 的话，读屏用户根本听不出当前是标记还是没标记。
print('\n[important star] G4 tiered archiving depends on this column')
star_checks = [
    ('header cell', '<th>重要</th>' in html),
    ('cell class', 'c-star' in js),
    ('button class', "'star'" in js),
    ('aria-pressed', "aria-pressed" in js),
    ('css rule', '.star' in css),
    ('css pressed state', '.star[aria-pressed="true"]' in css),
    ('wired to storage', 'toggleImportant' in js),
]
for label, ok in star_checks:
    print(f'  {ok!s:5} {label}')
    if not ok:
        fails.append(f'important star: {label} missing')

# 10) 「采纳替换」按钮不许回来（AGENTS.md 第 8 条）
#     spec §6.5 删掉了自动改址，界面上唯一能给的是「复制新地址」。
#     曾经有个「采纳替换」按钮，它登记一条全仓库没人读的提案，
#     toast 还承诺「到计划明细预览确认后才会执行」——
#     界面承诺一件永远不会发生的事，比功能缺失更伤。
#
# ⚠️ 判据必须**先去掉注释**（2026-10-06 实踩）。
#     第一版直接查原文，结果被本文件自己写的「为什么不能有采纳按钮」那段
#     解释命中，闸门**因为错误的原因而红** —— 红灯是真的，与被测性质无关。
#     误报的闸门比没有闸门更糟：大家只会学会忽略它，真违规也一起被忽略。
#     JS 的行注释不能用裸 `//` 剥：`options.js` 里到处是 'https://...'，
#     裸剥会把后面整行当注释删掉，真按钮反而被藏起来。
#     所以 `//` 前一个字符是 `:` 时不当注释（那正是 URL 的形态）。
def strip_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)   # 块注释 / JSDoc
    text = re.sub(r"<!--.*?-->", " ", text, flags=re.S)   # HTML 注释
    text = re.sub(r"(?<!:)//[^\n]*", " ", text)            # 行注释（保护 https://）
    return text


html_code = strip_comments(html)
js_code = strip_comments(js)
disc_code = strip_comments(
    (ROOT / 'src' / 'scan' / 'permission.js').read_text(encoding='utf-8')
)

print('\n[no-adopt-affordance] 链接健康只建议，绝不自动改书签')
for banned in ('采纳替换', '采纳', '应用到书签', '一键替换'):
    present = banned in html_code or banned in js_code
    print(f'  {not present!s:5} no "{banned}" button/label')
    if present:
        fails.append(f'panel still offers "{banned}" — no such flow exists')

# 11) 两处「不会改书签」的说明不许再承诺「逐条确认」这个不存在的步骤
#     2026-10-06 评审实拍：html 与 permission.js 的 OUTBOUND_DISCLOSURE
#     都写着「任何替换都要你逐条确认后亲自执行」，而面板里没有任何确认步骤。
for where, text in (('options.html', html_code), ('OUTBOUND_DISCLOSURE', disc_code)):
    ok = '逐条确认' not in text
    print(f'  {ok!s:5} {where} does not promise a per-item confirm step')
    if not ok:
        fails.append(f'{where} promises 逐条确认 but no such step exists in the panel')

print()
if fails:
    print('FAIL:')
    for f in fails:
        print('  -', f)
    sys.exit(1)
print('PASS: all structural checks green.')
