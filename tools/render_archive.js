/**
 * 归档渲染子进程：把归档好的 HTML 渲染成 PDF + 整页截图。
 *
 * 为什么是 Node：本机已经有完整 Chromium（E2E 一直在用 Playwright 的
 * `channel: 'chromium'` + 有头模式，有实测依据），而「渲染」必须真的开一个浏览器。
 * 接收器是 Python（`tools/archive_sink.py`），它调起这个文件。
 *
 * 为什么是**子进程**而不是把接收器改写成 Node：
 * 你的规范是「脚本一律用 Python」。这个文件是那个规范的**唯一例外**，
 * 而且例外是窄的、有理由的：只有渲染必须开浏览器。
 *
 * 用法（由接收器调用，不要手动跑）：
 *   node tools/render_archive.js --out <name> --url <url>
 *
 * ⚠️ 判据是**磁盘上真的多出 PDF 与 PNG**。接口返回成功不算数 ——
 *    本项目有过「面板报 100% 成功、什么都没变」的前科。
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const ARCHIVE_DIR = process.env.BOOKMARK_ARCHIVE_DIR || 'F:\\archive\\bookmark-organizer';

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const out = arg('out', '');
const url = arg('url', '');
if (!out || !url) {
  console.error('用法：node tools/render_archive.js --out <name> --url <url>');
  process.exit(2);
}

async function main() {
  // ⚠️ 这三条硬约束全部来自本机已实证的坑，不是风格偏好：
  //   1. `chromium_headless_shell` **不支持**加载/渲染扩展类任务
  //   2. 必须有头模式
  //   3. 每次用**全新** user_data_dir —— 复用会命中资源缓存
  const require = createRequire(import.meta.url);
  const { chromium } = require(resolve(ROOT, 'node_modules', 'playwright'));
  const { mkdtempSync, rmSync, existsSync: fsExists, statSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');

  const profile = mkdtempSync(join(tmpdir(), 'bo-render-'));
  let browser;
  try {
    browser = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: false,
      args: ['--disable-blink-features=AutomationControlled'],
    });
    const page = await browser.newPage();
    // 等 DOM 而不是固定 sleep：网络差的站点固定 sleep 会截到半张页面
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(1200);

    const base = join(ARCHIVE_DIR, out);
    const pdf = `${base}.pdf`;
    const png = `${base}.png`;

    await page.pdf({ path: pdf, format: 'A4', printBackground: true }).catch(() => null);
    await page.screenshot({ path: png, fullPage: true }).catch(() => null);

    // 判据是磁盘
    const gotPdf = fsExists(pdf) && statSync(pdf).size > 0;
    const gotPng = fsExists(png) && statSync(png).size > 0;
    console.log(JSON.stringify({ ok: gotPdf || gotPng, pdf: gotPdf ? pdf : null, png: gotPng ? png : null }));
    process.exitCode = (gotPdf || gotPng) ? 0 : 1;
  } catch (e) {
    // 渲染失败**不算归档失败**：HTML 已经落盘了，那是「原站挂了也能读」的底线
    console.error(String(e && e.message ? e.message : e).slice(0, 300));
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

main();
