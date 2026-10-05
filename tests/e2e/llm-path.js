/**
 * LLM 兜底路径专项验证。
 *
 * 为什么单独写：harness 的 openPanel() 每次都 forceLlmOff()，
 * 所以现有 9 道 E2E 闸门 + 我的场景矩阵**全都绕开了 LLM 路径**。
 * 而真实用户那边 llmEnabled 默认是 true，本机还注了真 key
 * （src/llm-key.local.js 存在，指向 api.deepseek.com）——
 * 也就是说「默认配置」正好落在这条没被测过的路径上。
 *
 * 三个变体：
 *   ok        模型正常返回 → 断言 LLM 判的类目真的被用上
 *   netFail   fetch 直接 reject → 断言降级正常，预览与执行仍可用
 *   hang      fetch 永不 settle（连接挂住）→ 断言面板会不会被拖死
 *
 * 用法：node tests/e2e/llm-path.js
 */

import { launchWithExtension, openPanel, seedBookmarks, runPreview, cleanupAll } from './harness.js';
import { writeFileSync } from 'node:fs';

process.on('exit', cleanupAll);

const LOG = [];
const say = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  LOG.push(line);
  console.log(line);
};

const readTreeState = (page) =>
  page.evaluate(async () => {
    const out = {};
    const walk = (node, p) => {
      out[String(node.id)] = [...p];
      const here = [...p, node.title || ''];
      for (const c of node.children || []) walk(c, here);
    };
    const tree = await chrome.bookmarks.getTree();
    for (const top of tree[0].children || []) walk(top, []);
    return out;
  });

/** 在页面里装好 fetch 替身 + 绕过权限检查，并把 LLM 打开 */
async function stubFetch(page, mode) {
  await page.evaluate((m) => {
    // hasLlmPermission 走 chrome.permissions.contains，直接短路成「已授权」
    try { chrome.permissions.contains = async () => true; } catch (e) { window.__permStubFailed = String(e); }
    window.__fetchCalls = 0;
    const real = window.fetch;
    window.fetch = function patched(url, opts) {
      window.__fetchCalls += 1;
      if (m === 'netFail') return Promise.reject(new TypeError('Failed to fetch'));
      if (m === 'hang') {
        // 忠实模拟「服务端收下连接但一直不回包」：只有真的收到 signal 才会被 abort 打断。
        // ⚠️ 这里必须认 opts.signal。早先写成 `new Promise(() => {})` —— 那种 Promise
        //    永远不会 settle，于是无论代码有没有传 signal、超时有没有生效，
        //    测试都会判红，量到的是替身的性质而不是实现的性质。
        //    现在还额外留一个后门：**没给 signal 就永远挂着**，
        //    这样「忘了传 signal」这种退化仍然会被抓住。
        return new Promise((_resolve, reject) => {
          const sig = opts && opts.signal;
          if (!sig) { window.__noSignal = true; return; }
          if (sig.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
          sig.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
      }
      if (m === 'ok') {
        const body = {
          choices: [{
            message: {
              content: JSON.stringify([
                { key: 'https://tail-0.example.org/p', to: '影音娱乐/音乐' },
                { key: 'https://tail-1.example.org/p', to: '购物消费/数码产品' },
              ]),
            },
          }],
        };
        return Promise.resolve({
          ok: true, status: 200,
          text: async () => JSON.stringify(body),
        });
      }
      return real(url, opts);
    };
    // 打开 LLM
    return chrome.storage.local.get('settings').then((got) =>
      chrome.storage.local.set({ settings: { ...(got.settings || {}), llmEnabled: true } }));
  }, mode);
}

const SCENARIOS = ['ok', 'netFail', 'hang'];

async function runVariant(mode) {
  const bad = [];
  say(`\n═══ LLM 变体：${mode} ═══`);
  const { ctx, extensionId } = await launchWithExtension();
  try {
    const page = await openPanel(ctx, extensionId);
    await seedBookmarks(page, [
      { title: 'GitHub', url: 'https://github.com/a/b' },
      { title: '长尾0', url: 'https://tail-0.example.org/p' },
      { title: '长尾1', url: 'https://tail-1.example.org/p' },
    ]);
    await stubFetch(page, mode);
    const permStubFailed = await page.evaluate(() => window.__permStubFailed || null);
    if (permStubFailed) say(`  ⚠️ 权限短路失败：${permStubFailed}`);

    // 点「读取并预览」，但**不**用 harness.runPreview —— 它 30s 超时会直接抛，
    // 这里要拿到「面板到底卡在哪」这个事实，而不是一个超时异常。
    const before = await page.evaluate(() => Number(document.body.dataset.previewSeq || 0));
    await page.click('#btnPreview');

    // 观察面板：能不能出预览结果。耐心按变体给足 ——
    // hang 变体要等满「超时(30s) × 重试(2) + 退避」的窗口，
    // 判据是**最终能不能自愈**，不是「多久还没好」。
    const patienceMs = mode === 'hang' ? 180000 : 60000;
    const stepMs = 500;
    const steps = Math.ceil(patienceMs / stepMs);
    let done = false;
    for (let i = 0; i < steps; i++) {
      await new Promise((r) => setTimeout(r, stepMs));
      const s = await page.evaluate(async () => ({
        seq: Number(document.body.dataset.previewSeq || 0),
        busy: (document.getElementById('busy')?.textContent || '').trim(),
        execDisabled: !!document.getElementById('btnExecute')?.disabled,
        rows: document.querySelectorAll('#planBody tr').length,
        move: (document.getElementById('stMove')?.textContent || '').trim(),
        calls: window.__fetchCalls,
      }));
      if (s.seq > before) {
        done = true;
        say(`  ${((i + 1) * stepMs / 1000).toFixed(1)}s 预览完成: 待移动=${s.move} 行=${s.rows} 执行按钮disabled=${s.execDisabled} fetch调用=${s.calls}`);
        break;
      }
      if (i % 20 === 19) say(`  ${((i + 1) * stepMs / 1000).toFixed(1)}s 仍未完成: busy="${s.busy}" 执行按钮disabled=${s.execDisabled} fetch调用=${s.calls}`);
    }
    const noSignal = await page.evaluate(() => !!window.__noSignal);
    if (noSignal) bad.push(`${mode}: fetch 没有收到 signal —— 超时机制根本不会触发`);

    if (!done) {
      const s = await page.evaluate(async () => ({
        busy: (document.getElementById('busy')?.textContent || '').trim(),
        execDisabled: !!document.getElementById('btnExecute')?.disabled,
        calls: window.__fetchCalls,
        rows: document.querySelectorAll('#planBody tr').length,
      }));
      say(`  ❌ 等待 ${patienceMs / 1000}s 后面板仍未出预览结果 —— 请求挂住时没有兜底`);
      say(`     busy="${s.busy}"  执行按钮disabled=${s.execDisabled}  fetch调用=${s.calls}  表格行=${s.rows}`);
      bad.push(`${mode}: 请求挂住 ${patienceMs / 1000}s 面板仍未恢复（fetch 无超时且未降级），执行整理按钮不可用`);
      return bad;
    }

    if (mode === 'ok') {
      const after = await readTreeState(page);
      await page.click('#btnExecute');
      const dl = Date.now() + 60000;
      let st = '';
      while (Date.now() < dl) {
        st = await page.evaluate(() => (document.getElementById('reportStatus')?.textContent || '').trim());
        if (['已完成', '失败', '已暂停'].includes(st)) break;
        await new Promise((r) => setTimeout(r, 150));
      }
      const post = await readTreeState(page);
      const stored = await page.evaluate(async () => {
        const t = (await chrome.storage.local.get('task:current'))['task:current'];
        return (t?.plan?.items || []).map((i) => ({ id: String(i.id), title: i.title, toStr: i.toStr, status: i.status }));
      });
      say(`  执行状态=${st}`);
      for (const it of stored) {
        const p = post[it.id] || [];
        const rel = p.slice(1).join('/');
        const ok = rel === it.toStr;
        say(`    ${ok ? '✓' : '❌'} ${it.title} → [${rel}]  计划要求 [${it.toStr}]${it.reason ? '' : ''}`);
        if (!ok) bad.push(`${mode}: 「${it.title}」应在 [${it.toStr}]，实际 [${rel}]`);
      }
      const tail0 = stored.find((x) => x.title === '长尾0');
      if (tail0 && tail0.toStr !== '影音娱乐/音乐') {
        bad.push(`${mode}: LLM 判的「影音娱乐/音乐」没被采用，实际 toStr=${tail0.toStr}`);
      } else if (tail0) {
        say('    ✓ LLM 判的类目被正确采用');
      }
    }
  } catch (e) {
    bad.push(`${mode}: 抛异常 ${e && e.message ? e.message : e}`);
    say(`  ❌ 异常：${e && e.message ? e.message : e}`);
  } finally {
    await ctx.close();
  }
  return bad;
}

const main = async () => {
  const want = process.argv.slice(2).length ? process.argv.slice(2) : SCENARIOS;
  const all = [];
  for (const m of want) all.push(...(await runVariant(m)));
  say('\n═══════════ 汇总 ═══════════');
  if (all.length) { for (const b of all) say(`🔴 ${b}`); say(`\nRED: ${all.length} 条`); }
  else say('\nGREEN: LLM 三条路径都可用');
  writeFileSync('tests/.llm.txt', LOG.join('\n'), 'utf8');
  process.exitCode = all.length ? 1 : 0;
};

main().catch((e) => {
  writeFileSync('tests/.llm.txt', LOG.concat([`FATAL ${e && e.stack ? e.stack : e}`]).join('\n'), 'utf8');
  console.error('FATAL', e);
  process.exitCode = 1;
});
