#!/usr/bin/env python3
"""调色板对比度闸门：把「亮色模式不达标」这件事变成会红的检查。

为什么需要它
------------
重构前这套色板的问题不是「看起来不够精致」，是**亮色模式下一片 AA 不达标**：
`--muted` 4.05:1、`.card` 标签 3.84:1、`.tabs .active` 3.40:1、
白字压在 `--accent` 上 3.40:1（暗色 2.36:1）。这些数字肉眼很难判断，
但 WCAG AA 的门槛是确定的，所以把它写成脚本。

判据是**先证伪**：脚本第一段故意用**旧值**跑一遍，并要求它们必须红。
没有这一段，一个恒真的检查等于没有检查 —— 它会一直「通过」，
而实际色板早就坏了。

跑法
----
    python tools/contrast_gate.py

退出码 0 = 新值全部达标；1 = 有回归。
"""

import sys

# ── 底色（两套模式各自独立取色，不是自动反色）────────────────────
BASE = {
    'light': {
        'bg': '#f1f5ee',
        'surface': '#ffffff',
        'sunken': '#e9f0e5',
        'ok-soft': '#e6f3ea',
    },
    'dark': {
        'bg': '#121813',
        'surface': '#1a211c',
        'sunken': '#222a24',
        'ok-soft': '#16301f',
    },
}

# ── 重构后的墨色（与 ui/options.css 的 :root 逐项对应）─────────────
INK = {
    'light': {
        'muted': '#5c6a60',
        'accent-ink': '#1c6b40',
        'warn': '#8a5a10',
        'danger': '#a32d24',
        'ok': '#16663f',
        'accent': '#2f9e5e',
        'accent-soft': '#e2f1e6',
        'warn-soft': '#fbf3e0',
    },
    'dark': {
        'muted': '#9aac9f',
        'accent-ink': '#7fd6a8',
        'warn': '#e5bd66',
        'danger': '#f2907f',
        'ok': '#4fbf88',
        'accent': '#4fbf88',
        'accent-soft': '#1c2e23',
        'warn-soft': '#332a15',
    },
}

# 压在填充色上的文字色
ON = {
    'light': {'on-accent': '#ffffff', 'on-danger': '#ffffff', 'on-ok': '#ffffff'},
    'dark': {'on-accent': '#0f1712', 'on-danger': '#0f1712', 'on-ok': '#0f1712'},
}

# 重构前的旧值，仅用于负控
OLD = {
    'light': {
        'bg': '#f1f5ee', 'surface': '#ffffff', 'sunken': '#e9f0e5',
        'muted': '#6c7b70', 'accent-ink': '#2f9e5e', 'warn': '#b7791f',
        'danger': '#c0392b', 'ok': '#1e7f4f', 'accent': '#2f9e5e',
    },
    'dark': {
        'bg': '#121813', 'surface': '#1a211c', 'sunken': '#222a24',
        'muted': '#96a39a', 'accent-ink': '#5cc98d', 'warn': '#e0b050',
        'danger': '#ef7a6d', 'ok': '#5cc98d', 'accent': '#5cc98d',
    },
}

# (墨色, 底色, 最低比值, 说明)
TEXT_PAIRS = [
    ('muted', 'bg', 4.5, '.hint body text'),
    ('muted', 'surface', 4.5, '.hint on card'),
    ('muted', 'sunken', 4.5, '.card label on sunken'),
    ('accent-ink', 'bg', 4.5, 'primary metric on body'),
    ('accent-ink', 'surface', 4.5, '.tabs .active on card'),
    ('accent-ink', 'sunken', 4.5, 'primary metric on sunken'),
    ('warn', 'bg', 4.5, '.warn-text on body'),
    ('warn', 'surface', 4.5, '.warn-text on card'),
    ('warn', 'sunken', 4.5, 'unclassified metric on sunken'),
    ('danger', 'bg', 4.5, '.fail-banner text on body'),
    ('danger', 'surface', 4.5, '.danger-ghost on card'),
    ('danger', 'sunken', 4.5, 'duplicate metric on sunken'),
    ('ok', 'surface', 4.5, 'kept entry on card'),
    ('ok', 'ok-soft', 4.5, 'learned badge on soft fill'),
]

# (文字色名, 填充色名, 最低比值, 说明)
FILL_PAIRS = [
    ('on-accent', 'accent-ink', 4.5, 'label on primary button'),
    ('on-danger', 'danger', 4.5, 'label on execute button'),
    ('on-ok', 'ok', 4.5, 'label on learned badge'),
]


def _lin(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def lum(hexstr):
    h = hexstr.lstrip('#')
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    return 0.2126 * _lin(r) + 0.7152 * _lin(g) + 0.0722 * _lin(b)


def ratio(fg, bg):
    a, b = lum(fg), lum(bg)
    if a < b:
        a, b = b, a
    return (a + 0.05) / (b + 0.05)


def _xyz(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def lab(hexstr):
    """sRGB hex -> CIE L*a*b*（D65）。"""
    h = hexstr.lstrip('#')
    r, g, b = (_xyz(int(h[i:i + 2], 16)) for i in (0, 2, 4))
    x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
    y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883

    def f(t):
        return t ** (1 / 3) if t > 216 / 24389 else (841 / 108) * t + 4 / 29

    fx, fy, fz = f(x), f(y), f(z)
    return (116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz))


def delta_e(a, b):
    """CIE76 色差。<2 不可分，>20 一眼可辨。"""
    la, aa, ba = lab(a)
    lb, ab, bb = lab(b)
    return ((la - lb) ** 2 + (aa - ab) ** 2 + (ba - bb) ** 2) ** 0.5


def show(tag, r, need, note, bad):
    ok = r >= need
    if not ok:
        bad.append(f'{note} = {r:.2f} (need {need})')
    print(f'  {"OK " if ok else "NG "} {r:5.2f} (need {need})  {note}')


def main():
    bad = []

    # ── 负控：旧值必须红，否则这道闸门是恒真的 ────────────────────
    print('[negative control] old palette - these MUST fail, else the gate is broken')
    negative_passed = 0
    for mode in ('light', 'dark'):
        for fg, bg in (('muted', 'sunken'), ('muted', 'bg'),
                       ('accent-ink', 'surface'), ('warn', 'surface')):
            r = ratio(OLD[mode][fg], OLD[mode][bg])
            if r < 4.5:
                negative_passed += 1
                print(f'  {mode:5} NG  {r:5.2f}  {fg} on {bg}')
            else:
                print(f'  {mode:5} ??  {r:5.2f}  {fg} on {bg}  <- old value unexpectedly passes')
    # 旧版白字压 accent 是最严重的一处，单独钉死
    for mode, on in (('light', '#ffffff'), ('dark', '#ffffff')):
        r = ratio(on, OLD[mode]['accent'])
        if r < 4.5:
            negative_passed += 1
            print(f'  {mode:5} NG  {r:5.2f}  white on old --accent')
    if OLD['light']['ok'] == OLD['light']['accent']:
        negative_passed += 1
        print('  light COLLISION  --ok == --accent  (high/medium badges indistinguishable)')
    if OLD['dark']['ok'] == OLD['dark']['accent']:
        negative_passed += 1
        print('  dark  COLLISION  --ok == --accent  (identical value)')

    # 期望复现数。逐条对应下面这 7 处，不是拍脑袋写的：
    #   亮色 ink 4 处（muted/sunken、muted/bg、accent/surface、warn/surface）
    #   白字压 accent 2 处（亮 3.40、暗 2.06）
    #   暗色 --ok 与 --accent 同值 1 处
    # 暗色的 4 个 ink 值本来就达标 —— 暗色真正的坑只有「白字压亮绿」和撞色两处。
    # 这个数一旦对不上，说明 OLD 已经和真实历史值脱节，闸门失去证明力。
    EXPECTED_FAILURES = 7

    if negative_passed < EXPECTED_FAILURES:
        print(f'\nFAIL: negative control only produced {negative_passed} failures,'
              f' expected at least {EXPECTED_FAILURES}.')
        print('The old palette no longer reproduces the bugs, so this gate cannot')
        print('prove anything. Update OLD with the current values first.')
        return 1
    print(f'  -> {negative_passed} failures reproduced (expected >= {EXPECTED_FAILURES}),'
          ' gate is falsifiable.\n')

    # 亮色那两个绿虽然不是同值，但只差 1.47:1，靠色相分不开。
    # 达不到硬失败标准，所以只记录，不计入 EXPECTED_FAILURES。
    near = ratio(OLD['light']['ok'], OLD['light']['accent'])
    print(f'[negative control] light --ok vs --accent = {near:.2f}:1'
          f'  (not equal, but too close to tell apart by hue)\n')

    # ── 正控：新值必须全过 ──────────────────────────────────────
    for mode in ('light', 'dark'):
        print(f'[positive control] {mode}')
        base = BASE[mode]
        for fg, bg, need, note in TEXT_PAIRS:
            show(mode, ratio(INK[mode][fg], base[bg]), need, note, bad)
        for on, fill, need, note in FILL_PAIRS:
            show(mode, ratio(ON[mode][on], INK[mode][fill]), need, note, bad)
        print()

    # ── 置信度徽章必须彼此可分 ───────────────────────────────────
    # 高=实心 accent-ink / 中=软底 accent-ink / 低=软底 warn。
    #
    # ⚠️ 这里量的是**两个不同的通道**，一开始量错了：拿墨色去比 WCAG 明度比，
    #    而这套设计本来就不是靠明度分级的。真正的分工是：
    #      填充明度  承载「实心 vs 软底」这一级（用 WCAG 明度比量）
    #      墨色色相  承载「中 vs 低」这一级（用 CIE ΔE 量，明度比在这里无意义，
    #                因为两者的深浅本来就该接近，区别在色相）
    # 两级都得分得开，徽章才在灰度和色觉障碍下都还读得出。
    print('[badge separation] solid-vs-soft by luminance, mid-vs-low by hue')
    for mode in ('light', 'dark'):
        base = BASE[mode]
        soft = INK[mode]['accent-soft']

        # 通道一：实心填充 vs 软底填充，必须一眼看出「填没填」
        for bg_name, bg_val, label in (
            ('accent-soft', soft, 'solid vs medium-soft'),
            ('warn-soft', INK[mode]['warn-soft'], 'solid vs low-soft'),
        ):
            r = ratio(INK[mode]['accent-ink'], bg_val)
            flag = 'OK ' if r >= 3.0 else 'NG '
            if r < 3.0:
                bad.append(f'{mode} {label} fill not distinct enough ({r:.2f})')
            print(f'  {mode:5} {flag} lum {r:5.2f} (need 3.0)  {label}')

        # 通道二：中 vs 低的墨色色相。ΔE 20 是「一眼可辨」的保守门槛。
        d = delta_e(INK[mode]['accent-ink'], INK[mode]['warn'])
        flag = 'OK ' if d >= 20 else 'NG '
        if d < 20:
            bad.append(f'{mode} medium-vs-low ink hue too close (dE {d:.1f})')
        print(f'  {mode:5} {flag} dE  {d:5.1f} (need 20)  medium-ink vs low-ink')
        print()

    if bad:
        print('FAIL:')
        for f in bad:
            print('  -', f)
        return 1
    print('PASS: every foreground/background pair meets WCAG AA in both modes.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
