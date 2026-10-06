/**
 * 主面板逻辑。
 *
 * 分工（重要）：
 *   - 读树 / 分类 / 生成计划：options 页面自己直接调 chrome.*，**不经 service worker**。
 *     这样 dry-run 完全不碰 SW，SW 被 30 秒回收也不影响预览。
 *   - 只有「执行」才发给 SW —— 只有它能扛住这个页面被关掉。
 *   - 进度轮询直接读 storage，不经 SW：MV3 的 SW 随时可能被回收，
 *     只读内存的接口在真实使用中恒为空。
 */

import { readFlatTree } from '../src/tree.js';
import { listRoots, pickRootKey, resolveRoot } from '../src/roots.js';
import { findDuplicates, toRemovalList, dedupeStats } from '../src/dedupe.js';
import { buildPlan, setRules, selectForLlm, REASON } from '../src/plan.js';
import { DEFAULT_RULES } from '../src/classify/dict.js';
import {
  getTaxonomy, isKnownPath, fallbackPath, allPaths, pathString, DEFAULT_TAXONOMY,
} from '../src/classify/taxonomy.js';
import { dedupeKey, hostOf, parseUrl, isExcludedUrl } from '../src/normalize.js';
import {
  get, set, mutate, K, getSettings, updateSettings, getTask, TASK_STATUS,
  getDedupeVeto, isDedupeVetoed, toggleDedupeVeto, clearDedupeVeto,
} from '../src/storage.js';
import { createSnapshot, listSnapshots, restoreSnapshot, deleteSnapshot } from '../src/backup.js';
import {
  classifyBatch, hasLlmPermission, requestLlmPermission, revokeLlmPermission,
  validateAssignments, resolveConfig, MODEL_PRESETS, resolveTarget,
} from '../src/classify/llm.js';
import {
  getPending, clearPending, probeSink, toJsonl,
  requestSinkPermission, revokeSinkPermission,
} from '../src/fail-log.js';
import {
  getImportantUrls, isMarkedImportant, toggleImportant, clearImportant,
} from '../src/archive/important.js';

const MAX_ROWS = 300;

const $ = (id) => document.getElementById(id);

/** 执行进度条的重置标记。
 *  「新的预览」和「新的执行」会把它翻回去 —— 用户已经拿到一份新计划，
 *  上一次的完成凭据留着只会误导。只活在内存里，刷新即回初始值。 */
let execBarReset = false;

/** 页面状态 */
const state = {
  entries: [],
  byId: new Map(),
  plan: null,
  groups: [],
  dupPayload: [],
  veto: [],          // 被否决「不删」的重复项条目 id
  taxonomy: DEFAULT_TAXONOMY,
  snapshotTs: null,
  llmErrors: [],
  picked: null, // 当前正在改判的条目
  seq: 0,       // 渲染完成计数，供 E2E 判断「这一轮真的跑完了」
};

// ───────────────────────── 工具 ─────────────────────────

function toast(msg, isErr = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('err', isErr);
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, isErr ? 7000 : 3200);
}

function busy(text) {
  const el = $('busy');
  if (!text) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = text;
}

/** 填一个组合式空状态：标记 / 主句 / 引导。
 *
 * ⚠️ 为什么不复述已有按钮：hero 上「读取并预览」、健康页「立即检测一次」
 *    都已经在那儿了。空状态里再摆一个同名按钮，用户反而要犹豫点哪个。
 *    这里只说「现在是什么状态」和「下一步会发生什么」。 */
function fillEmpty(el, mark, title, hint) {
  el.textContent = '';
  const m = document.createElement('span');
  m.className = 'empty-mark';
  m.setAttribute('aria-hidden', 'true');
  m.textContent = mark;
  const t = document.createElement('span');
  t.className = 'empty-title';
  t.textContent = title;
  const h = document.createElement('span');
  h.className = 'empty-hint';
  h.textContent = hint;
  el.append(m, t, h);
}

/** 骨架屏。形状照着最终布局裁，不做通用转圈。
 *  ⚠️ 骨架只填**兄弟**容器，绝不塞进 #planBody / #healthRows ——
 *     E2E 数这两个容器的行数来判定「渲染完了」，塞占位行会假绿。 */
function showSkeleton(hostId, rows = 6, on = true) {
  const host = $(hostId);
  if (!host) return;
  host.textContent = '';
  if (on) {
    for (let i = 0; i < rows; i += 1) {
      const row = document.createElement('div');
      row.className = 'skeleton-row';
      // 宽度按计划表的真实列比例错开，避免 6 条一模一样的横杠
      const widths = ['c1', 'c2', 'c3', 'c1', 'c3', 'c2'];
      for (const w of widths) {
        const bar = document.createElement('i');
        bar.className = `skeleton-bar ${w}`;
        row.append(bar);
      }
      host.append(row);
    }
  }
  host.hidden = !on;
}

/** 页签计数。非 0 才让 CSS 画药丸，0 保持纯灰字。 */
function setTabCount(id, n) {
  const el = $(id);
  if (!el) return;
  el.textContent = n;
  el.dataset.n = String(n);
}

/** 整理进行中：把会互相打架的按钮按住。
 *
 * ⚠️ 为什么需要它：此前只有 #btnExecute 被 disable，「恢复备份」「立即备份」
 *    「读取并预览」在执行循环跑着的时候仍然可点。三者都会改书签或改 task，
 *    与执行循环并发时结果不可预期，而界面上看不出正在跑。
 *    快照列表里的「恢复到这份 / 删除」是动态生成的，所以用 data-exec-guard
 *    统一挂住，而不是在这里逐个 find。 */
let execBusy = false;

function setExecBusy(on) {
  execBusy = !!on;
  for (const id of ['btnPreview', 'btnRestore', 'btnSnapshot']) {
    const el = $(id);
    if (el) el.disabled = !!on;
  }
  for (const el of document.querySelectorAll('#snapList button')) {
    el.disabled = !!on;
  }
}

/** 发消息给 service worker */
function send(type, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, payload }, (res) => {
      if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
      resolve(res || { ok: false, error: '无响应' });
    });
  });
}

/** 路径数组 → 展示用（去掉最外层根名） */
function displayPath(pathArr) {
  if (!Array.isArray(pathArr) || !pathArr.length) return '';
  const rest = pathArr.slice(1);
  return rest.length ? rest.join(' / ') : pathArr[0];
}

const REASON_LABEL = {
  [REASON.LEARNED]: ['人工规则', 'learned'],
  [REASON.RULE_DOMAIN]: ['域名', 'high'],
  [REASON.RULE_PATH]: ['路径', 'medium'],
  [REASON.RULE_TITLE]: ['标题', 'low'],
  [REASON.LLM]: ['AI', 'medium'],
  [REASON.MANUAL]: ['已改判', 'learned'],
  [REASON.UNCLASSIFIED]: ['未命中', 'low'],
};

// ───────────────────────── 主流程 ─────────────────────────

/**
 * 读取 → 备份 → 分类 → 计划。
 * @param {{backup:boolean}} opts backup=false 时只重算，不再存新快照（改判/锁定后用）
 */
async function loadAndClassify(opts) {
  // 这一步要读整棵书签树、可能还带一次 LLM 兜底，实测能到十几秒。
  // 表的形状是已知的（7 列），所以摆骨架；不放进 #planBody，
  // 因为 E2E 靠数它的行数判断这一轮渲染完了没有。
  showSkeleton('planSkeleton', 6, true);
  $('planTable').hidden = true;
  $('planEmpty').hidden = true;

  busy('正在读取书签树…');
  state.entries = await readFlatTree();
  state.byId = new Map(state.entries.map((e) => [e.id, e]));

  if (opts.backup) {
    busy('正在备份当前书签树…');
    const snap = await createSnapshot({ note: '预览时自动备份' });
    state.snapshotTs = snap.ts;
  }

  busy('正在分类…');
  const [settings, learned, locks, manual, taxOverride, veto] = await Promise.all([
    getSettings(),
    get(K.RULES_LEARNED, []),
    get(K.LOCKS, []),
    get(K.MANUAL_ASSIGNMENTS, {}),
    get(K.TAXONOMY_OVERRIDE, null),
    getDedupeVeto(),
  ]);
  state.taxonomy = getTaxonomy(taxOverride);
  state.veto = veto;

  setRules(DEFAULT_RULES);
  let plan = buildPlan({
    entries: state.entries,
    taxonomy: state.taxonomy,
    learnedRules: learned,
    locks,
    manualAssignments: manual,
  });

  // LLM 兜底：只对规则未命中的那一小撮发请求
  //
  // ⚠️ 这一段必须自己兜住，不能让它把 loadAndClassify 整个带崩。
  //    loadAndClassify 是面板上**所有**交互的入口：预览、改判、锁定、
  //    去重否决、恢复备份全都 await 它。它一旦抛错，调用方又没有统一的
  //    try/catch，结果是：计划表停在**上一次**的旧数据上、也不弹任何提示，
  //    用户接着点「执行整理」——执行器忠实地把书签搬到**旧分类**里去，
  //    看起来就是「分类没按我改的来」。
  //    LLM 是兜底，兜底坏了应该降级成「纯规则分类」，而不是拖垮主流程。
  state.llmErrors = [];
  if (settings.llmEnabled) {
    try {
      const todo = selectForLlm(plan, state.entries, locks);
      if (todo.length) {
        busy(`LLM 兜底分类中（${todo.length} 条待判）…`);
        const res = await classifyBatch(todo, {
          taxonomy: state.taxonomy,
          settings,
          onProgress: ({ done, total }) => busy(`LLM 兜底分类中… ${done}/${total}`),
        });
        state.llmErrors = res.errors || [];
        const { valid } = validateAssignments(res.assignments, state.taxonomy, isKnownPath);
        plan = buildPlan({
          entries: state.entries,
          taxonomy: state.taxonomy,
          learnedRules: learned,
          locks,
          manualAssignments: manual,
          llmAssignments: valid,
        });
      }
    } catch (e) {
      // 降级：继续用规则分类的结果，并把原因摆到台面上
      state.llmErrors = [`LLM 兜底异常，已降级为纯规则分类：${e && e.message ? e.message : e}`];
    }
  }

  // 去重
  state.groups = settings.dedupeEnabled ? findDuplicates(state.entries) : [];
  // 被否决的条目不进执行载荷 —— README 承诺「待删条目逐条可否决」，
  // 过滤放在这里才能让确认弹窗的删除数和真正会删的数一致。
  state.dupPayload = toRemovalList(state.groups)
    .filter((d) => !isDedupeVetoed(d.id, state.veto))
    .map((d) => {
      const src = state.byId.get(d.id);
      return { id: d.id, url: d.url, title: d.title, path: src?.path || ['2'], keepId: d.keepId };
    });

  state.plan = plan;
  await set(K.LAST_PLAN, { plan, duplicates: state.dupPayload, snapshotTs: state.snapshotTs });

  busy('');
  await render();
  // 渲染完成计数。E2E 用它判断「这一轮预览真的跑完了」。
  // ⚠️ 之前靠等 #planEmpty 是否可见来判断是错的：它在 init() 之后就一直可见，
  //    点击后会在新结果渲染出来之前立刻「通过」，读到的还是上一轮的数据。
  state.seq += 1;
  document.body.dataset.previewSeq = String(state.seq);
}

/**
 * 面板内部所有「小改动后重算」的统一入口：改判、锁定、去重否决、
 * 清空人工干预、恢复备份、执行完刷新。
 *
 * ⚠️ 为什么不直接调 loadAndClassify：
 *    它会抛错（读树失败、storage 写失败……），而这些调用点原来都没有
 *    try/catch。抛错的后果比报错本身严重得多 ——
 *    计划表会**静默地停留在上一次的数据**上，也不弹任何提示。
 *    用户看到的仍是正确的旧清单，点「执行整理」就按旧分类搬了，
 *    于是「我明明改对了，整理出来的还是老样子」。
 *
 *    这里保证两件事：
 *      ① 失败一定有可见提示（红 toast），不再无声无息
 *      ② 无论成败都重新渲染，面板不会卡在不一致的中间态
 */
async function safeReload(opts = { backup: false }) {
  try {
    await loadAndClassify(opts);
    return true;
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    console.error('[options] 重新分类失败', e);
    toast(`重新分类失败：${msg}`, true);
    // 关键：即使失败也要把界面刷回自洽状态，别让用户对着陈旧清单做决策
    try {
      busy('');
      await render();
    } catch { /* 渲染失败就算了，至少错误已经提示过 */ }
    return false;
  }
}

// ───────────────────────── 渲染 ─────────────────────────

/**
 * 渲染全部面板。
 *
 * ⚠️ 这里必须 await 异步的那几个（renderSnapshots / renderCounts / renderReport）。
 *    它们各自 await 一次 storage 读，原来全是「发射后不管」，
 *    于是 DOM 里的执行报告可能停在上一次的数字上 ——
 *    用户看到「成功移动 0 / 10」就以为整理没生效，
 *    而实际上 task 早就 10/10 完成了。
 *    「面板显示的数字」本身就是用户判断有没有成功的唯一依据，不能是半旧的。
 */
async function render() {
  renderStats();
  renderPlan();
  renderDup();
  await renderSnapshots();
  await renderCounts();
  await renderReport();
  syncExecuteButton();
}

function renderStats() {
  const urls = state.entries.filter((e) => e.type === 'url');
  const plan = state.plan;
  $('stTotal').textContent = urls.length;
  $('stMove').textContent = plan ? plan.items.length : '—';
  $('stInPlace').textContent = plan ? (plan.stats.byReason[REASON.IN_PLACE] || 0) : '—';
  $('stUnclassified').textContent = plan ? (plan.stats.byReason[REASON.UNCLASSIFIED] || 0) : '—';
  $('stDup').textContent = state.groups.length ? dedupeStats(state.groups).removable : '—';
  $('stFolders').textContent = plan ? plan.newFolders.length : '—';
  setTabCount('tabPlanCount', plan ? plan.items.length : 0);
  setTabCount('tabDupCount', state.groups.length);
  // 语义配色只给真实数字。还没数据时那些卡里是「—」占位符，
  // 涂成琥珀/红会看着像报错（「重复项」是红的，最误导），
  // 实际上只是「还没数据」。所以给占位符打个标记，让 CSS 收成中性。
  for (const b of document.querySelectorAll('.stats .card > b')) {
    b.parentElement.dataset.empty = b.textContent === '—' ? '1' : '0';
  }

  // 展示管线：把「整理完成度」发布给 hero 环。
  // 不参与任何状态机 / 消息协议 / 持久化，删掉它只影响一个圆环。
  const ring = $('heroRing');
  if (ring) {
    const inPlace = plan ? (plan.stats.byReason[REASON.IN_PLACE] || 0) : null;
    const pct = (inPlace === null || !urls.length) ? null : Math.round((inPlace / urls.length) * 100);
    ring.style.setProperty('--pct', String(pct ?? 0));
    // 没预览过就显示「未预览」而不是 0% —— 0% 会被读成「一条都没整理好」。
    ring.dataset.state = pct === null ? 'unknown' : 'ready';
    $('heroRingVal').textContent = pct === null ? '未预览' : `${pct}%`;
  }
}

function syncExecuteButton() {
  const has = state.plan && (state.plan.items.length > 0 || state.dupPayload.length > 0);
  $('btnExecute').disabled = !has;
}

function renderPlan() {
  const body = $('planBody');
  const empty = $('planEmpty');
  const more = $('planMore');
  const table = $('planTable');
  body.textContent = '';
  showSkeleton('planSkeleton', 6, false);

  if (!state.plan || !state.plan.items.length) {
    table.hidden = true;
    empty.hidden = false;
    if (state.plan) {
      fillEmpty(empty, '✓', '没有需要移动的条目',
        '书签已经在正确的位置上了。这一步不需要你做任何事。');
    } else {
      fillEmpty(empty, '○', '还没有预览',
        '点上面的「读取并预览」。扩展会读一遍书签树，先给出分类方案，一条都不改。');
    }
    more.hidden = true;
    return;
  }
  empty.hidden = true;
  table.hidden = false;

  const onlyChanged = $('onlyChanged').checked;
  const onlyLow = $('onlyLow').checked;
  let rows = state.plan.items;
  if (onlyChanged) rows = rows.filter((i) => i.status === 'pending');
  if (onlyLow) rows = rows.filter((i) => i.confidence === 'low');

  // 筛选后一条不剩时不能只剩一张空表头。此前这里直接往下走，
  // 结果是一张有表头、零行的表 —— 用户看不出是筛没了还是没数据。
  if (!rows.length) {
    table.hidden = true;
    empty.hidden = false;
    fillEmpty(empty, '○', '筛选后没有匹配的条目',
      `这份计划有 ${state.plan.items.length} 条，但当前筛选下没有一条符合。`
      + '取消上面的「只看将要移动的」或「只看低置信」再看一次。');
    more.hidden = true;
    return;
  }
  empty.hidden = true;
  table.hidden = false;

  const shown = rows.slice(0, MAX_ROWS);
  const frag = document.createDocumentFragment();

  for (const it of shown) {
    const tr = document.createElement('tr');
    if (it.confidence === 'low') tr.classList.add('is-low');
    if (it.status !== 'pending') tr.classList.add('is-skipped');

    // 锁
    const tdLock = document.createElement('td');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!it.locked;
    cb.title = '锁定后这条不会被移动';
    cb.setAttribute('aria-label', `锁定这条，整理时不移动：${it.title || it.url || ''}`);
    cb.addEventListener('change', () => toggleLock(it.id, cb.checked));
    tdLock.append(cb);

    // 书签：标题与地址都可直接点开。
    // ⚠️ .title 挂在 <a> 本身而不是外套一层元素：E2E 有多处按
    //    `tr.querySelectorAll('td')` 的位置取 td[1]，换结构会让断言读空。
    const tdItem = document.createElement('td');
    const title = document.createElement('a');
    title.className = 'title';
    title.textContent = it.title || '(无标题)';
    const url = it.url
      ? document.createElement('a')
      : document.createElement('div');
    url.className = 'url';
    url.textContent = it.url || '';
    if (it.url) {
      url.href = it.url;
      url.target = '_blank';
      url.rel = 'noreferrer';
      url.title = it.url;   // 长地址被 break-all 截断时，悬停能看到完整值
    }
    tdItem.append(title, url);

    // 当前位置
    const tdFrom = document.createElement('td');
    const pf = document.createElement('span');
    pf.className = 'path';
    pf.textContent = displayPath(it.fromPath) || '（根目录）';
    tdFrom.append(pf);

    const tdArrow = document.createElement('td');
    tdArrow.textContent = '→';

    // 目标位置
    const tdTo = document.createElement('td');
    const pt = document.createElement('span');
    pt.className = 'path';
    pt.textContent = it.toPath.join(' / ');
    tdTo.append(pt);

    // 依据
    const tdWhy = document.createElement('td');
    const why = document.createElement('span');
    why.className = 'why';
    const [label, cls] = REASON_LABEL[it.reason] || [it.reason, ''];
    const badge = document.createElement('span');
    badge.className = `badge ${cls}`;
    badge.textContent = label;
    const conf = document.createElement('span');
    conf.className = 'badge';
    conf.textContent = { high: '高', medium: '中', low: '低' }[it.confidence] || it.confidence;
    why.append(badge, conf);
    tdWhy.append(why);

    // 反馈
    const tdFb = document.createElement('td');
    const fb = document.createElement('span');
    fb.className = 'fb';
    const ok = document.createElement('button');
    ok.textContent = '✓';
    ok.title = '这条分得对';
    // ⚠️ 光有 title 不算数：title 不是可访问名，图标按钮的读屏文本经常是空的。
    //    这两个按钮的可见文案只有符号，必须补 aria-label。
    ok.setAttribute('aria-label', '这条分得对，标记为正确');
    ok.addEventListener('click', () => markRight(it.id));
    const bad = document.createElement('button');
    bad.textContent = '✗ 改';
    bad.title = '分错了，选正确分类';
    bad.setAttribute('aria-label', '这条分错了，选正确分类');
    bad.addEventListener('click', () => openPicker(it.id));
    fb.append(ok, bad);
    tdFb.append(fb);

    tr.append(tdLock, tdItem, tdFrom, tdArrow, tdTo, tdWhy, tdFb);
    frag.append(tr);
  }
  body.append(frag);

  more.hidden = rows.length <= MAX_ROWS;
  if (!more.hidden) more.textContent = `还有 ${rows.length - MAX_ROWS} 条未显示（完整清单在执行前可导出）。`;
}

function renderDup() {
  const box = $('dupList');
  const empty = $('dupEmpty');
  box.textContent = '';
  // 三态：没检测过 / 检测过且一个没有 / 有结果。
  // ⚠️ 此前只要 state.groups 为空就显示「没有发现重复项」，而 state.groups
  //    在用户点「读取并预览」之前本来就是空的。于是每次打开面板都先被告知
  //    一个根本没跑出来的结论 —— 比没有空状态更糟，用户会以为已经查过了。
  if (!state.plan) {
    empty.hidden = false;
    fillEmpty(empty, '○', '还没检测',
      '点上面的「读取并预览」，去重会跟着一起跑，重复的书签会列在这里等你逐条确认。');
    return;
  }
  if (!state.groups.length) {
    empty.hidden = false;
    fillEmpty(empty, '✓', '没有发现重复项',
      '每条书签的归一化地址都不重复。归一化只剥「纯顶部锚点」白名单里的 hash，'
      + 'SPA 路由（#/a 与 #/b）一律保留，不会误判。');
    return;
  }
  empty.hidden = true;

  const frag = document.createDocumentFragment();
  for (const g of state.groups) {
    const div = document.createElement('div');
    div.className = 'dup';
    const key = document.createElement('div');
    key.className = 'key';
    key.textContent = g.key;
    const ul = document.createElement('ul');

    const liKeep = document.createElement('li');
    liKeep.className = 'keep';
    liKeep.textContent = `保留：${g.keeper.title || g.keeper.url}（${displayPath(g.keeper.path)}）`;
    ul.append(liKeep);

    for (const d of g.duplicates) {
      const vetoed = isDedupeVetoed(d.id, state.veto);
      const li = document.createElement('li');
      li.className = vetoed ? 'drop vetoed' : 'drop';
      // data-dup-id 供 E2E 精确定位某一条，不靠文本匹配
      li.dataset.dupId = String(d.id);

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'veto';
      cb.checked = vetoed;
      cb.title = '勾上=这条不删';
      cb.addEventListener('change', () => onVeto(d.id, cb.checked));

      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = vetoed
        ? `不删：${d.title || d.url}（${displayPath(d.path)}）`
        : `删除：${d.title || d.url}（${displayPath(d.path)}）`;

      li.append(cb, label);
      ul.append(li);
    }
    div.append(key, ul);
    frag.append(div);
  }
  box.append(frag);
}

/**
 * 逐条否决/取消否决。
 * 勾上 = 「这条我不要你删」，所以语义上 vetoed = 不进删除清单。
 */
async function onVeto(dupId, on) {
  await toggleDedupeVeto(dupId, on);
  state.veto = await getDedupeVeto();
  // 重新走一遍分类，把过滤后的 dupPayload 和确认弹窗的计数一起对齐
  await safeReload();
  toast(on ? '已标记为不删' : '已恢复为待删除');
}

async function renderSnapshots() {
  const snaps = await listSnapshots();
  const box = $('snapList');
  const empty = $('snapEmpty');
  box.textContent = '';
  setTabCount('tabSnapCount', snaps.length);
  if (!snaps.length) {
    empty.hidden = false;
    fillEmpty(empty, '○', '还没有快照',
      '每次预览和执行前都会自动存一份。Chrome 没有原生撤销，快照是唯一的退路。');
    return;
  }
  empty.hidden = true;

  const frag = document.createDocumentFragment();
  for (const s of snaps) {
    const div = document.createElement('div');
    div.className = 'snap';
    const left = document.createElement('div');
    const when = document.createElement('div');
    when.textContent = `${s.at ? new Date(s.at).toLocaleString() : s.ts}　${s.note || '（无备注）'}`;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${s.urlCount} 条书签 · ${s.count} 个节点 · ${(s.bytes / 1024).toFixed(1)} KB`;
    left.append(when, meta);

    const right = document.createElement('div');
    const restore = document.createElement('button');
    restore.className = 'danger-ghost';
    restore.textContent = '恢复到这份';
    restore.disabled = execBusy;   // 整理进行中不让它和执行循环抢书签
    restore.addEventListener('click', () => doRestore(s));
    const del = document.createElement('button');
    del.textContent = '删除';
    del.disabled = execBusy;
    del.style.marginLeft = '8px';
    del.addEventListener('click', async () => {
      if (!confirm(`删除这份快照？\n\n${s.at ? new Date(s.at).toLocaleString() : s.ts}\n\n删掉之后就无法回到那个时间点了。`)) return;
      await deleteSnapshot(s.ts);
      await renderSnapshots();
      toast('已删除该快照');
    });
    right.append(restore, del);
    div.append(left, right);
    frag.append(div);
  }
  box.append(frag);
}

async function renderCounts() {
  const [locks, learned, manual] = await Promise.all([
    get(K.LOCKS, []), get(K.RULES_LEARNED, []), get(K.MANUAL_ASSIGNMENTS, {}),
  ]);
  $('lockCount').textContent = (locks || []).length;
  $('learnedCount').textContent = (learned || []).length;
  $('manualCount').textContent = Object.keys(manual || {}).length;
}

async function renderReport() {
  const task = await getTask();
  const box = $('report');
  if (!task || !task.plan) {
    box.textContent = '';
    const p = document.createElement('p');
    p.className = 'empty-inline';
    p.textContent = '还没有执行记录。';
    box.append(p);
    $('btnPause').hidden = true;
    $('btnResume').hidden = true;
    $('execBar').hidden = true;
    return;
  }
  const items = task.plan.items || [];
  const done = items.filter((i) => i.status === 'done').length;
  const failed = items.filter((i) => i.status === 'failed').length;
  const pending = items.filter((i) => i.status === 'pending').length;

  // 执行进度条：只反映「本次执行推进」，与 hero 环（整理完成度）语义分离。
  // ⚠️ 文案刻意只报数字、不下结论：「成功还是失败」由 pollProgress() 的 toast
  //    和计划页顶部的失败横幅说（那边已经修过一次「无条件弹整理完成」的 bug）。
  //    也刻意不用「已完成/失败/已暂停」这三个词 —— E2E 的终态判定只读
  //    #reportStatus，但报告全文里永远有一行标签就叫「失败」，
  //    历史上就是全文匹配导致的假绿（见 tests/e2e/harness.js:280-283）。
  //    这里再加一遍同义词，等于给后人留一个同样的坑。
  // ⚠️ 执行循环抛异常时状态是 FAILED 而不是 DONE（src/apply.js:223），
  //    所以「中断」必须单独认，否则崩溃执行会被显示成「暂停中」。
  const bar = $('execBar');
  if (bar) {
    const total = items.length;
    const running = task.status === TASK_STATUS.RUNNING;
    const paused = task.status === TASK_STATUS.PAUSED;
    const broke = task.status === TASK_STATUS.FAILED;
    const missed = (task.failed || []).length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    bar.hidden = execBarReset || (!total && !running && !paused && !broke);
    bar.dataset.state = running ? 'running'
      : paused ? 'paused'
      : broke ? 'failed'
      : missed ? 'partial' : 'done';
    $('execBarFill').style.width = `${pct}%`;
    $('execBarText').textContent = running ? `整理中 · ${done}/${total}`
      : paused ? `暂停中 · ${done}/${total}`
      : broke ? `中断 · ${done}/${total} · 点「继续」接着跑`
      : missed ? `${done}/${total} · ${missed} 条未成功`
      : `${done}/${total}`;
  }

  box.textContent = '';
  const tbl = document.createElement('table');
  const rows = [
    ['状态', { running: '执行中', paused: '已暂停', done: '已完成', failed: '失败', idle: '空闲', reviewing: '待审阅' }[task.status] || task.status],
    ['成功移动', `${done} / ${items.length}`],
    ['未处理', String(pending)],
    ['失败', String(failed)],
    ['备份时间', task.snapshotTs ? new Date(Number(task.snapshotTs)).toLocaleString() : '—'],
    ['开始时间', task.startedAt ? new Date(task.startedAt).toLocaleString() : '—'],
  ];
  for (const [k, v] of rows) {
    const tr = document.createElement('tr');
    const a = document.createElement('td'); a.textContent = k;
    const b = document.createElement('td'); b.textContent = v;
    // 状态单元格给个稳定 id：E2E 靠它精确读值。
    // ⚠️ 之前 E2E 是对报告全文做 /已完成|失败|已暂停/ 匹配，
    //    而报告里**永远有一行标签就叫「失败」** —— 匹配到的是标签不是状态，
    //    于是「等执行结束」在第一条就返回了，整个断言都建立在错误前提上。
    if (k === '状态') b.id = 'reportStatus';
    tr.append(a, b); tbl.append(tr);
  }
  box.append(tbl);

  if (task.failed && task.failed.length) {
    const h = document.createElement('div');
    h.style.marginTop = '10px';
    h.textContent = '失败明细：';
    const ul = document.createElement('ul');
    for (const f of task.failed.slice(0, 20)) {
      const li = document.createElement('li');
      li.style.fontSize = '12px';
      li.textContent = `${f.url}：${f.error}`;
      ul.append(li);
    }
    box.append(h, ul);
  }

  const isRunning = task.status === TASK_STATUS.RUNNING;
  $('btnPause').hidden = !isRunning;
  $('btnResume').hidden = isRunning || !task.plan || task.status === TASK_STATUS.DONE;

  // 待导出条数跟着每次渲染更新。
  // ⚠️ 这里只刷**计数**、不探接收器：renderReport 在轮询里会被反复调用，
  //    而探一次接收器在它没开时要等超时 —— 每次渲染都探会把面板拖卡。
  // ⚠️ 但必须刷：失败是**执行时**才产生的，而按钮状态只在 init 刷过一次 ——
  //    不刷的话「重新导出」会一直是禁用的，用户刷新面板才发现能点。
  refreshPendingCount().catch(() => {});
}

// ───────────────────────── 人工反馈 ─────────────────────────

/**
 * 从一次改判沉淀出一条 learned rule。
 *
 * ⚠️ 粒度必须收窄：不能因为用户纠正了一条 github.com 书签，
 *    就把所有 github.com 书签都改道。所以：
 *      有具体路径 → domains + pathWords（只命中那一个页面）
 *      根路径但有标题 → domains + titleWords
 *      都没有 → 才退到纯域名（此时用户是明确在指正这个站点）
 */
function buildLearnedRule(entry, toPath) {
  const to = pathString(toPath);
  const host = hostOf(entry.url);
  const u = parseUrl(entry.url);
  const pathname = u ? (u.pathname || '/') : '/';
  if (host && pathname && pathname !== '/') {
    return { to, domains: [host], pathWords: [pathname] };
  }
  if (host && entry.title && String(entry.title).trim()) {
    return { to, domains: [host], titleWords: [String(entry.title).trim()] };
  }
  return { to, domains: host ? [host] : [], titleWords: entry.title ? [String(entry.title).trim()] : [] };
}

function sameRuleShape(a, b) {
  const eq = (x, y) => JSON.stringify(x || []) === JSON.stringify(y || []);
  return eq(a.domains, b.domains) && eq(a.pathWords, b.pathWords) && eq(a.titleWords, b.titleWords);
}

async function markWrong(itemId, toPath) {
  const entry = state.byId.get(itemId);
  if (!entry) return;
  const key = dedupeKey(entry.url);
  if (!key) return;

  const to = pathString(toPath);

  // 1) 本次立即生效
  await mutate(K.MANUAL_ASSIGNMENTS, (m) => ({ ...(m || {}), [key]: to }), {});
  // 2) 沉淀成规则，下次直接命中（learned 优先级高于预置词典）
  await mutate(K.RULES_LEARNED, (rs) => {
    const rule = buildLearnedRule(entry, toPath);
    return [...(rs || []).filter((r) => !sameRuleShape(r, rule)), rule];
  }, []);

  await safeReload();
  toast(`已改到「${to}」，并记为规则`);
}

async function markRight(itemId) {
  const it = state.plan?.items.find((i) => i.id === itemId);
  if (!it) return;
  // 判对的条目也固化成规则：点一次「✓」就等于告诉词典这条判得准
  const entry = state.byId.get(itemId);
  if (!entry) return;
  const rule = buildLearnedRule(entry, it.toPath);
  await mutate(K.RULES_LEARNED, (rs) => {
    if ((rs || []).some((r) => r.to === rule.to && sameRuleShape(r, rule))) return rs || [];
    return [...(rs || []), rule];
  }, []);
  it.confidence = 'high';
  renderPlan();
  toast('已记为正确规则');
}

async function toggleLock(itemId, on) {
  const entry = state.byId.get(itemId);
  if (!entry?.url) return;
  await mutate(K.LOCKS, (ls) => {
    const s = new Set(ls || []);
    if (on) s.add(entry.url);
    else s.delete(entry.url);
    return [...s];
  }, []);
  await safeReload();
  toast(on ? '已锁定，这条不会被移动' : '已解锁');
}

function openPicker(itemId) {
  state.picked = itemId;
  const entry = state.byId.get(itemId);
  $('pickerTarget').textContent = `${entry?.title || ''}　${entry?.url || ''}`;

  const cols = $('pickerCols');
  cols.textContent = '';
  for (const top of state.taxonomy) {
    const col = document.createElement('div');
    col.className = 'picker-col';
    const h = document.createElement('h4');
    h.textContent = top.name;
    col.append(h);
    for (const sub of top.children || []) {
      const label = document.createElement('label');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'pick';
      radio.value = `${top.name}/${sub}`;
      label.append(radio, document.createTextNode(sub));
      col.append(label);
    }
    cols.append(col);
  }
  $('pathPicker').showModal();
}

// ───────────────────────── 执行 ─────────────────────────

/**
 * 解析「归入位置」当前指向哪个根，并给出可读名称。
 *
 * ⚠️ 为什么执行相关的每一句话都必须带上它：
 *    根归到哪是 `settings.targetRoot` 决定的，而计划里的 `toPath` **不含根名**
 *    （见 plan.js 的路径模型）。于是同一份清单在「书签栏」和「其他书签」
 *    两个设置下产出**完全一样**，界面上也**看不出区别**。
 *    实测踩过：「归入位置」是「其他书签」时，45 条书签全部搬到其他书签下的
 *    10 个类目文件夹里，原文件夹被搬空但仍留在书签栏 ——
 *    书签栏看上去「一点没变」，面板还弹「整理完成」。
 *    用户只能靠猜「到底搬到哪去了」。所以确认弹窗和完成提示都必须写明根名。
 *
 * @returns {Promise<{ok:boolean, id:string|null, name:string, reason?:string}>}
 */
async function resolveTargetRoot() {
  const settings = await getSettings();
  const root = await resolveRoot(settings.targetRoot);
  return { ok: root.ok, id: root.id, name: root.title || '', reason: root.reason };
}

async function doExecute() {
  const plan = state.plan;
  if (!plan) return;
  const dups = state.dupPayload;
  const root = await resolveTargetRoot();

  // ⚠️ 归入位置解析不出来就地拦下，别让用户点完确认才看结果。
  //    这一条是 2026-10-05 那次全军覆没的直接补丁：根 id 写死成 '1'，
  //    而 Chrome 154 的书签栏是 279，于是 17 个分类文件夹一个没建成、45 条全失败。
  if (!root.ok) {
    toast(`归入位置解析失败，已取消整理：${root.reason || '未知原因'}`
      + '（Chrome 换了书签模型，顶层文件夹 id 不再是固定的 1/2；你的书签都在，没丢）'
      + '请点「读取并预览」重新算一份计划；仍然失败就到 chrome://extensions 重新加载扩展。', true);
    return;
  }

  // 将要新建的**顶层**文件夹名 —— 用户靠它就能预判整理后的书签栏长什么样
  const newTops = [...new Set(plan.newFolders
    .filter((p) => Array.isArray(p) && p.length)
    .map((p) => p[0]))];

  const msg = [
    '即将整理你的书签：',
    '',
    `　移动　　${plan.items.length} 条`,
    `　新建　　${plan.newFolders.length} 个文件夹`,
    `　删除　　${dups.length} 条重复项`,
    // 把否决条数摆出来：用户勾了「不删」却看不到任何变化，
    // 就只能靠猜这份清单到底准不准 —— 那等于没给否决权。
    ...(state.veto.length ? [`　　　　　（其中 ${state.veto.length} 条已被你标记为不删）`] : []),
    '',
    // ⚠️ 这一行是本次修复的重点：整理到**哪个根**是设置决定的，
    //    而计划清单里不含根名，界面上看不出来。不写清楚的话，
    //    「归入位置」不是书签栏的用户会看到「整理完成」却找不到书。
    `归入位置：${root.name}`,
    ...(newTops.length ? [`　将新建顶层文件夹：${newTops.join('、')}`] : []),
    '',
    `快照：${state.snapshotTs ? new Date(Number(state.snapshotTs)).toLocaleString() : '（将自动创建）'}`,
    '',
    '这些操作可以点「恢复备份」回滚。',
    '',
    '确定继续？',
  ].join('\n');
  if (!confirm(msg)) return;

  $('btnExecute').disabled = true;
  setExecBusy(true);
  execBarReset = false;   // 新任务从 0 开始，撤掉上一轮的完成凭据
  const res = await send('startExecution', {
    plan,
    duplicates: dups,
    snapshotTs: state.snapshotTs,
  });
  if (!res.ok) {
    toast(`启动失败：${res.error}`, true);
    setExecBusy(false);
    syncExecuteButton();
    return;
  }
  // ⚠️ 后端「拒绝启动」时返回的是 `{ok:true, result:{started:false, reason}}` ——
  //    ok 只代表消息送达了，不代表整理真的跑起来了。
  //    早先只判 res.ok，于是「已在执行中 / 计划为空」这两种拒绝
  //    都会弹「已开始执行」，然后什么都不发生 —— 从用户看就是「点了没反应」。
  if (res.result && res.result.started === false) {
    toast(`没有开始整理：${res.result.reason || '未知原因'}`, true);
    setExecBusy(false);
    syncExecuteButton();
    return;
  }
  // 执行器会在落盘前把失效的 id 按 URL 重新定位到活着的节点上，
  // 这里必须把这件事说出来 —— 否则用户会以为「只是照原样搬」，
  // 而实际上计划已经被修正过了。
  const rec = Number(res.result?.recovered || 0);
  const gone = Number(res.result?.missing || 0);
  if (rec > 0 || gone > 0) {
    const parts = [];
    if (rec) parts.push(`已按 URL 重新定位 ${rec} 条`);
    if (gone) parts.push(`${gone} 条书签已不存在，已跳过`);
    toast(`已开始整理（${parts.join('；')}），结果会归入「${root.name}」`, gone > 0);
  } else {
    toast(`已开始整理，结果会归入「${root.name}」`);
  }
  pollProgress();
}

/** 轮询进度：直接读 storage，不经 SW（SW 随时可能被回收） */
async function pollProgress() {
  for (;;) {
    const task = await getTask();
    await renderReport();
    if (task.status !== TASK_STATUS.RUNNING) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  // 循环结束（无论 DONE / FAILED / PAUSED）就松开按钮组。
  // 放在两个提前 return 之前，否则中断和失败两条路会一直按着不放。
  setExecBusy(false);
  // 跑完重新读树，刷新计划视图
  await safeReload();
  const task = await getTask();
  if (task.status !== TASK_STATUS.DONE) {
    if (task.status === TASK_STATUS.FAILED) toast('整理中断了，点「继续」可以接着跑', true);
    return;
  }

  // ⚠️ 这里原来无条件弹「整理完成」。但 status=done 只说明**循环跑完了**，
  //    不代表每条都搬成功 —— 全军覆没时同样是 done。
  //    一条都没搬动却弹「整理完成」，用户只会更困惑：
  //    「提示成功了，可书签一点没动」。失败必须自己说出来。
  const items = task.plan?.items || [];
  const doneN = items.filter((i) => i.status === 'done').length;
  const failN = items.filter((i) => i.status === 'failed').length;
  const movedN = items.filter((i) => i.idRelocated).length;
  const goneN = (task.stale || []).length;
  const root = await resolveTargetRoot();

  // 计划被修正过这件事，必须留在**最后**这条提示里。
  // 早先只在开始时提示「已按 URL 重新定位 N 条」，几秒后被「整理完成」覆盖 ——
  // 而用户往往是在最后那条才确认结果，等于白提示。
  const notes = [];
  if (movedN) notes.push(`其中 ${movedN} 条的 id 已失效、按 URL 重新定位后才搬动`);
  if (goneN) notes.push(`${goneN} 条书签确实已不存在，已跳过`);

  if (failN > 0) {
    toast(`整理结束：成功 ${doneN} 条，失败 ${failN} 条`
      + (notes.length ? `（${notes.join('；')}）` : '')
      + '失败原因见下方红色明细', true);
    renderFailures(items, task);
    return;
  }
  toast(`整理完成：${doneN} 条已归入「${root.name}」`
    + (notes.length ? `（${notes.join('；')}）` : ''));
}

/**
 * 把失败明细摆在**主面板**上。
 *
 * ⚠️ 原来失败列表只在「设置 → 执行报告」里。用户点完执行整理，
 *    视线在书签栏和计划表上，不会去翻设置 —— 于是「一条都没搬成」
 *    这种事对用户是完全不可见的。现在在计划页顶部直接挂一条红色横幅。
 */
function renderFailures(items, task) {
  const host = $('failBanner');
  if (!host) return;
  const rows = (task.failed || [])
    .slice(0, 10)
    .map((f) => `<li>${escapeHtml(f.title || f.url || f.id)}：${escapeHtml(String(f.error || ''))}</li>`)
    .join('');
  const more = (task.failed || []).length > 10 ? `<li>…共 ${task.failed.length} 条</li>` : '';
  host.innerHTML =
    `<b>有 ${items.filter((i) => i.status === 'failed').length} 条没能移动</b>`
    + '<p>这些书签还留在原处。常见原因：① 移动被<b>其他扩展或 Chrome 同步改回</b>'
    + '（有「书签」权限的广告拦截器 / 书签整理类插件会在变更时自动重排）；'
    + '② 目标位置不可写；③ 书签已被删除；'
    + '④「归入位置」指向了只读目录（如移动设备书签）。</p>'
    + '可先到 chrome://extensions 临时关掉其他有「书签」权限的扩展，再点「读取并预览」重跑一次。'
    + `<ul>${rows}${more}</ul>`;
  host.hidden = false;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function doRestore(snap) {
  const msg = [
    '恢复到这份快照：',
    `${snap.at ? new Date(snap.at).toLocaleString() : snap.ts}`,
    '',
    '⚠️ 恢复会把快照里有的书签移回原位，把之后新增的书签移回「其他书签」。',
    '⚠️ 这是「归位」不是「时间机器」：你在这期间自己做的编辑不会被撤销。',
    '',
    '确定继续？',
  ].join('\n');
  if (!confirm(msg)) return;

  busy('正在恢复…');
  const res = await send('restoreSnapshot', { ts: snap.ts });
  busy('');
  if (!res.ok) {
    toast(`恢复失败：${res.error}`, true);
    return;
  }
  const r = res.result;
  const failed = r.failures.length;
  toast(
    `恢复完成：归位 ${r.movedBack} 条，新增归口 ${r.movedNew} 条，` +
    `清理空文件夹 ${r.foldersRemoved} 个，重建重复项 ${r.dupRestored} 条` +
    (failed ? `，${failed} 条失败（见执行报告）` : ''),
    failed > 0,
  );
  await safeReload();
  await renderSnapshots();
}

// ───────────────────────── 类目编辑 ─────────────────────────

function renderTaxonomyEditor() {
  const box = $('taxonomyEditor');
  box.textContent = '';
  for (const top of state.taxonomy) {
    const wrap = document.createElement('div');
    wrap.className = 'taxo-top';

    const nameInput = document.createElement('input');
    nameInput.value = top.name;
    nameInput.dataset.role = 'top-name';
    wrap.append(nameInput);

    const subs = document.createElement('div');
    subs.className = 'taxo-subs';
    (top.children || []).forEach((sub) => {
      const row = document.createElement('span');
      row.className = 'taxo-sub';
      const inp = document.createElement('input');
      inp.value = sub;
      inp.dataset.role = 'sub-name';
      const del = document.createElement('button');
      del.textContent = '×';
      del.title = '删除这个子类';
      del.addEventListener('click', () => { row.remove(); });
      row.append(inp, del);
      subs.append(row);
    });
    wrap.append(subs);

    const add = document.createElement('div');
    add.className = 'taxo-add';
    const addInput = document.createElement('input');
    addInput.placeholder = '新增子类…';
    addInput.dataset.role = 'add-sub';
    const addBtn = document.createElement('button');
    addBtn.textContent = '+';
    addBtn.addEventListener('click', () => {
      const v = addInput.value.trim();
      if (!v) return;
      const row = document.createElement('span');
      row.className = 'taxo-sub';
      const inp = document.createElement('input');
      inp.value = v;
      inp.dataset.role = 'sub-name';
      const del = document.createElement('button');
      del.textContent = '×';
      del.addEventListener('click', () => row.remove());
      row.append(inp, del);
      subs.append(row);
      addInput.value = '';
    });
    add.append(addInput, addBtn);
    wrap.append(add);

    box.append(wrap);
  }

  const overridden = state.taxonomy !== DEFAULT_TAXONOMY;
  $('taxonomyState').textContent = overridden
    ? '当前使用你自定义的类目结构。'
    : '当前使用预置类目结构。';
}

function collectTaxonomyFromEditor() {
  const out = [];
  for (const wrap of $('taxonomyEditor').querySelectorAll('.taxo-top')) {
    const nameInput = wrap.querySelector('[data-role="top-name"]');
    const name = nameInput.value.trim();
    if (!name) continue;
    const children = [...wrap.querySelectorAll('[data-role="sub-name"]')]
      .map((i) => i.value.trim())
      .filter(Boolean);
    out.push({ name, children: children.length ? children : ['待归类'] });
  }
  return out;
}

// ───────────────────────── 设置 ─────────────────────────

function renderPresetSelect() {
  const sel = $('llmPreset');
  sel.textContent = '';
  const custom = document.createElement('option');
  custom.value = '';
  custom.textContent = '自定义（在下面手填 base URL 与模型）';
  sel.append(custom);
  for (const p of MODEL_PRESETS) {
    const o = document.createElement('option');
    o.value = `${p.baseUrl}::${p.model}`;
    o.textContent = p.label;
    sel.append(o);
  }
}

async function loadSettingsUi() {
  const s = await getSettings();

  // ── 归入位置：选项由活着的书签树生成 ──
  //
  // ⚠️ 为什么不用 HTML 里写死的选项：根 id 不是常量，标签也随 Chrome 的语言变。
  //    早先这里是 `<option value="1">书签栏</option>`，value 直接当根 id 用 ——
  //    Chrome 154 的书签栏是 279，于是每一次整理的 45 条 move 全部失败。
  //    现在 value 是语义键（bar / other），标签从 live tree 取，
  //    真实 id 每次使用时由 roots.js 现查。
  const sel = $('targetRoot');
  let roots = [];
  try {
    roots = await listRoots();
  } catch { /* 读不到就沿用 HTML 里的兜底选项 */ }

  const writable = roots.filter((r) => r.key);
  if (writable.length) {
    const cur = sel.value;
    sel.textContent = '';
    for (const r of writable) {
      const opt = document.createElement('option');
      opt.value = r.key;
      opt.textContent = r.title || r.key;   // 标签跟随 Chrome 的界面语言
      sel.appendChild(opt);
    }
    // 设置里可能是旧值（'1' / '2' / 某个已失效的 id），统一翻译成语义键
    const key = pickRootKey(s.targetRoot, writable);
    sel.value = writable.some((r) => r.key === key) ? key : writable[0].key;
    // 顺手把旧值就地迁移掉：存着 '1' 迟早还会有人拿它当 id 用
    if (String(s.targetRoot) !== sel.value) {
      await updateSettings({ targetRoot: sel.value });
    }
  } else {
    sel.value = pickRootKey(s.targetRoot, []);
  }

  $('llmEnabled').checked = !!s.llmEnabled;
  $('llmBaseUrl').value = s.baseUrl;
  $('llmModel').value = s.model;
  $('llmApiKey').value = s.apiKey;

  // 预选当前配置对应的预设项
  const cur = `${s.baseUrl}::${s.model}`;
  const match = MODEL_PRESETS.find((p) => `${p.baseUrl}::${p.model}` === cur);
  $('llmPreset').value = match ? cur : '';

  // 当前 base URL 落在哪一家 —— 说清楚是为了排障，不是装饰。
  // 百炼的 key 与区域强绑定，跨区调返回的 401 看起来和「key 无效」一模一样，
  // 看到「自定义端点」就能立刻排除「是不是服务商搞错了」这个方向。
  const provEl = $('llmProviderState');
  const target = resolveTarget({ baseUrl: s.baseUrl, model: s.model });
  if (target.isCustom) {
    provEl.textContent = `当前服务商：自定义端点（${target.baseUrl || '未填写'}）`
      + '，按 OpenAI 兼容协议调用。若它其实是一家已登记的服务商，把 base URL 改成下拉里的写法，'
      + '错误提示会更准。';
    provEl.classList.add('warn-text');
  } else {
    const models = MODEL_PRESETS.filter((p) => p.providerId === target.providerId).map((p) => p.model);
    provEl.textContent = `当前服务商：${target.providerId}`
      + `（可选模型：${models.join('、') || '可自由填写'}）`;
    provEl.classList.remove('warn-text');
  }

  // key 来源要说清楚：手填 / 环境变量注入 / 没有
  const cfg = await resolveConfig(s);
  const stateEl = $('llmKeyState');
  if (cfg.keySource === 'env') {
    stateEl.textContent = `API key：已从本机环境变量注入的 src/llm-key.local.js 读取`
      + '（不写入 storage，只在内存里用）。上面输入框留空即可。';
    stateEl.classList.remove('warn-text');
  } else if (cfg.keySource === 'manual') {
    stateEl.textContent = 'API key：使用上面输入框里的值（保存在本机 chrome.storage.local）。';
    stateEl.classList.remove('warn-text');
  } else {
    stateEl.textContent = 'API key：没有。设环境变量 DEEPSEEK_API_KEY 后跑 '
      + '`python tools/inject_key.py` 注入，或在上面手填。'
      + '没有 key 时 LLM 兜底会自动跳过，未分类条目留在「其他/待归类」。';
    stateEl.classList.add('warn-text');
  }

  const granted = await hasLlmPermission(cfg.baseUrl);
  let host = cfg.baseUrl;
  try { host = new URL(cfg.baseUrl).host; } catch { /* 保持原样 */ }
  $('llmPermState').textContent = granted
    ? `已授权访问：${host}`
    : `尚未授权访问 ${host}。启用 LLM 前需要先点「授权访问该域名」。权限是按需申请的，不开 LLM 就不需要。`;
}

// ───────────────────── 移动失败日志 ─────────────────────

/**
 * 只刷「未送出条数 + 导出按钮可用性」—— 纯 storage 读，不发网络请求。
 * 便宜到可以在每次 renderReport 里调。
 */
async function refreshPendingCount() {
  const pending = await getPending();
  $('pendingCount').textContent = String(pending.length);
  $('btnExportPending').disabled = pending.length === 0;
}

/**
 * 探一次接收器并刷新状态文案。**只在打开面板 / 点「刷新状态」时调**，
 * 因为接收器没开时每次探测都要等超时。
 */
async function refreshSinkState() {
  const p = await probeSink();
  const el = $('sinkState');
  if (p.state === 'no-permission') {
    el.textContent = '接收器状态：未授权。点下面的「授权本机日志接收器」一次即可。';
    el.classList.add('warn-text');
  } else if (p.state === 'online') {
    el.textContent = `接收器状态：在线（本次会话已写入 ${p.lines} 条）→ ${p.dir}`;
    el.classList.remove('warn-text');
  } else {
    el.textContent = '接收器状态：离线。先在本机开 npm run log:sink。'
      + '这不影响整理，失败记录会存在扩展里，随时可以「重新导出」。';
    el.classList.add('warn-text');
  }
}

/**
 * 刷新「移动失败日志」这块 UI。
 *
 * ⚠️ 状态是**静默**的：接收器没开不弹 toast、不打断整理。
 *    但没有它就没法判断「到底写没写进去」—— 而「以为记上了其实没记」
 *    正是这个项目栽过最多的坑。
 */
async function renderFailLogUi() {
  const s = await getSettings();
  $('failLogEnabled').value = s.failLogEnabled === false ? '0' : '1';
  await refreshPendingCount();
  await refreshSinkState();
}

/** 导出缓冲里的失败记录。成功存盘才清缓冲。 */
async function exportPendingFailures() {
  const pending = await getPending();
  if (!pending.length) { toast('没有待导出的失败记录'); return; }

  const stamp = new Date().toISOString().slice(0, 10);
  const name = `bookmark-organizer-failures-${stamp}.jsonl`;
  const blob = new Blob([toJsonl(pending)], { type: 'application/x-ndjson' });

  // ⚠️ showSaveFilePicker 必须在**用户手势里直接**调。
  //    中间 await 过别的东西，浏览器会认为手势已过期，弹窗直接不出现 ——
  //    症状是「点了按钮，什么都没发生，也没有报错」。
  if (typeof window.showSaveFilePicker === 'function') {
    let handle;
    try {
      handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: 'JSON Lines', accept: { 'application/x-ndjson': ['.jsonl'] } }],
      });
    } catch (e) {
      // 用户自己取消保存不是错误，别弹红提示
      if (e && e.name === 'AbortError') return;
      toast(`导出失败：${e.message || e}`, true);
      return;
    }
    const w = await handle.createWritable();
    await w.write(blob);
    await w.close();
  } else {
    // 降级：API 不可用就落 Chrome 下载目录
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  await clearPending();
  await renderFailLogUi();
  toast(`已导出 ${pending.length} 条失败记录`);
}

// ───────────────────────── 链接健康（死链/改链 + 元数据补全）─────────────────────────
//
// ⚠️ 本节的三条纪律来自 spec，E2E 要按 **DOM** 断言它们，不看内部状态：
//   1. 跨站重定向的行里**不许有**「采纳替换」按钮
//   2. 软 404 的行必须标出「启发式」
//   3. 出网范围说明常驻，折叠别处也不消失

import { VERDICT, VERDICT_LABEL, canAutoReplace } from '../src/scan/verdict.js';
import { KIND_LABEL } from '../src/scan/classify-site.js';
import { OUTBOUND_DISCLOSURE } from '../src/scan/permission.js';
import { faviconUrlFor } from '../src/scan/extract-meta.js';

let linkState = null;
let linkIndex = null;
let linkRecords = [];
/** 被标成「重要」的 URL。面板渲染时同步查表，不逐行 await storage。 */
let importantUrls = [];
/** 链接健康页的监听器是否已挂过。见 initLinkHealth 里的说明。 */
let linkHealthWired = false;

async function refreshLinkHealth() {
  const res = await send('linkState');
  if (!res || res.ok === false) return;
  const data = res.result || {};
  linkState = data.state;
  linkIndex = data.index;
  // 星标与探测记录是两份独立数据，都要从 storage 恢复（不是内存态）
  importantUrls = await getImportantUrls();
  renderImportantCount();

  // 逐条读记录可能要几百次 storage 往返，这一秒里表是空的。
  // 摆骨架而不是留白，形状照着真实表格裁。
  showSkeleton('healthSkeleton', 5, true);
  $('healthTable').hidden = true;
  $('healthEmpty').hidden = true;

  const ids = (linkState && linkState.ids) || [];
  linkRecords = [];
  for (const id of ids) {
    const r = await send('linkRecord', { id });
    if (r && r.ok && r.result) linkRecords.push(r.result);
  }
  renderLinkHealth();
}

function renderLinkHealth() {
  $('healthDisclosureText').textContent = OUTBOUND_DISCLOSURE;

  const st = linkState || {};
  const unfinished = st.status === 'running' || st.status === 'paused';
  $('btnLinkResume').hidden = st.status !== 'paused';
  $('btnLinkPause').hidden = !unfinished;

  const total = linkIndex ? linkIndex.total : 0;
  const done = (st && st.cursor) || 0;
  $('healthProgress').textContent = total
    ? (st.status === 'done' ? `已扫完 ${done}/${total}` : `已扫 ${done}/${total}`)
    : '尚未检测';
  setTabCount('tabHealthCount', linkIndex ? linkIndex.actionable : 0);

  // 汇总卡
  const sum = $('healthSummary');
  sum.textContent = '';
  if (linkIndex) {
    const cards = [
      ['总数', linkIndex.total],
      ['正常', linkIndex.byVerdict[VERDICT.OK] || 0],
      ['可疑', linkIndex.byVerdict[VERDICT.SUSPECT] || 0],
      ['死链', linkIndex.byVerdict[VERDICT.DEAD] || 0],
      ['已改址', linkIndex.byVerdict[VERDICT.REDIRECT_SAME] || 0],
      ['跳到别处', linkIndex.byVerdict[VERDICT.REDIRECT_CROSS] || 0],
      ['需你看一眼', linkIndex.actionable],
    ];
    for (const [label, n] of cards) {
      const div = document.createElement('div');
      div.className = 'card';
      const b = document.createElement('b');
      b.textContent = String(n);
      div.append(b, document.createTextNode(label));
      sum.append(div);
    }
  }

  // 明细表
  const tbody = $('healthRows');
  const empty = $('healthEmpty');
  const table = $('healthTable');
  tbody.textContent = '';
  showSkeleton('healthSkeleton', 5, false);

  const interesting = linkRecords
    .filter((r) => r.verdict !== VERDICT.OK && r.verdict !== VERDICT.UNCHECKED)
    .sort((a, b) => String(a.verdict).localeCompare(String(b.verdict)));

  // 三态，别让空表头说话：
  //   没扫过 → 从没跑过检测
  //   扫过但全正常 → 明确说「都活着」，这是个好消息，值得说
  //   有可疑项 → 列表
  if (!linkRecords.length) {
    table.hidden = true;
    empty.hidden = false;
    fillEmpty(empty, '○', '还没有检测结果',
      '点上面「立即检测一次」。扩展会逐条读你书签里那些 URL 的状态码，'
      + '结果只摆在这里等你判断，不会自动改任何书签。');
    return;
  }
  if (!interesting.length) {
    table.hidden = true;
    empty.hidden = false;
    fillEmpty(empty, '✓', '扫完了，没有发现问题',
      `已检查 ${linkRecords.length} 条书签，没有死链，也没有需要改址的跳转。`);
    return;
  }
  empty.hidden = true;
  table.hidden = false;

  for (const r of interesting) {
    const tr = document.createElement('tr');
    tr.dataset.verdict = r.verdict;

    const v = document.createElement('td');
    v.textContent = VERDICT_LABEL[r.verdict] || r.verdict;
    tr.append(v);

    const t = document.createElement('td');
    // favicon 走 Chrome 自己的图标缓存，不发请求；加载失败时静默退化成标题文字
    if (r.url) {
      const box = document.createElement('div');
      box.className = 'row-title';
      const img = document.createElement('img');
      img.className = 'favicon';
      img.width = 16;
      img.height = 16;
      img.alt = '';
      img.loading = 'lazy';
      img.src = faviconUrlFor(r.url, chrome.runtime.id);
      img.addEventListener('error', () => img.remove(), { once: true });
      box.append(img, document.createTextNode(r.pageTitle || r.url));
      t.append(box);
    } else {
      t.textContent = r.pageTitle || '';
    }
    tr.append(t);

    const u = document.createElement('td');
    const a = document.createElement('a');
    a.href = r.url;
    a.textContent = r.url;
    a.target = '_blank';
    a.rel = 'noreferrer';
    u.append(a);
    tr.append(u);

    const k = document.createElement('td');
    k.textContent = (KIND_LABEL[r.kind] || r.kind) + (r.provider ? ` · ${r.provider}` : '');
    tr.append(k);

    const w = document.createElement('td');
    w.textContent = r.checkedAt ? new Date(Number(r.checkedAt)).toLocaleString() : '—';
    tr.append(w);

    tr.append(linkSuggestionCell(r));
    // 「重要」列放最后：前面的 td 下标有 E2E 在按位读，插在中间会静默读错字段
    tr.append(importantCell(r));
    tbody.append(tr);
  }
}

/** 标题旁的标记计数。 */
function renderImportantCount() {
  const n = importantUrls.length;
  $('importantCount').textContent = n ? `已标记 ${n} 页为重要` : '还没标记任何页';
  $('btnImportantClear').disabled = n === 0;
}

/**
 * 「重要」列：每行一颗星。
 *
 * ⚠️ 星标**不是锁**。「不要移动这条书签」是计划表里那个锁（存书签 id），
 *    这里存的是 URL，语义是「归档时多渲染一份 PDF」。
 *    两者合并过一次的后果是用户为归档打个星、那条书签从此不敢动，而界面上看不出来。
 *
 * 点一下切换，不弹窗：这是高频轻操作，弹窗会把标记变成负担。
 */
function importantCell(r) {
  const td = document.createElement('td');
  td.className = 'c-star';
  const on = isMarkedImportant(r.url, importantUrls);
  const btn = document.createElement('button');
  btn.className = 'star';
  btn.type = 'button';
  btn.textContent = on ? '★' : '☆';
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.setAttribute('aria-label', on ? `取消标记 ${r.url} 为重要页` : `标记 ${r.url} 为重要页`);
  btn.title = on ? '已标记：归档时额外存 PDF 与截图' : '标记为重要页：归档时额外存 PDF 与截图';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const res = await toggleImportant(r.url);
      importantUrls = res.urls || [];
      renderImportantCount();
      renderLinkHealth();
    } catch (e) {
      toast('标记没存上：' + (e && e.message ? e.message : e), true);
      btn.disabled = false;
    }
  });
  td.append(btn);
  return td;
}

/**
 * 「建议」列。
 *
 * ⚠️ 这里**曾经**有一个「采纳替换」按钮，它写一条 `link:proposal:<id>` 提案，
 *    toast 还跟用户承诺「到计划明细预览确认后才会真正改书签」。
 *    而全仓库**没有任何代码读那个键** —— 承诺了一件永远不会发生的事。
 *    界面骗人比功能缺失更伤，所以撤掉了。
 *
 * 为什么不把 URL 改写做成一种计划项接进 plan.js：
 * 那会动到 dry-run 的结构 —— 既有 E2E 闸门断言「每条计划项都落在它承诺的文件夹里」，
 * 而 URL 改写不落文件夹。这是本项目自己的红线：不为塞功能去改闸门。
 * 真要做，必须另起一个工单专门设计它的预览与撤销。
 *
 * 现在给的是**真能用的东西**：新地址可直接点开、可复制。
 */
function linkSuggestionCell(r) {
  const td = document.createElement('td');

  if (r.verdict === VERDICT.REDIRECT_SAME && r.finalUrl && r.finalUrl !== r.url) {
    const wrap = document.createElement('div');
    const a = document.createElement('a');
    a.href = r.finalUrl;
    a.textContent = r.finalUrl;
    a.target = '_blank';
    a.rel = 'noreferrer';
    const copy = document.createElement('button');
    copy.className = 'link';
    copy.textContent = '复制新地址';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(r.finalUrl);
        toast('已复制新地址');
      } catch {
        toast('复制失败，地址已在上面，手动选中即可', true);
      }
    });
    const note = document.createElement('span');
    note.className = 'hint';
    note.textContent = '同站改址 · 需你自己替换';
    wrap.append(a, document.createElement('br'), copy, ' ', note);
    td.append(wrap);
    return td;
  }

  if (r.verdict === VERDICT.DEAD || r.verdict === VERDICT.SUSPECT || r.verdict === VERDICT.REDIRECT_CROSS) {
    const btn = document.createElement('button');
    btn.textContent = r.verdict === VERDICT.DEAD ? '找替代（存档快照 / 新地址）' : '查一下';
    btn.addEventListener('click', () => loadAlternatives(r));
    td.append(btn);
    return td;
  }

  const span = document.createElement('span');
  span.className = 'hint';
  // 软 404 必须写明这是启发式（spec 的硬要求）
  span.textContent = r.verdict === VERDICT.SOFT404
    ? '启发式判断，仅供参考，不做任何改动'
    : '—';
  td.append(span);
  return td;
}

/**
 * 加载一条的替代方案。
 *
 * ⚠️ 分组是硬要求：可采纳区只放**已验证**的候选。
 *    AI 没有联网能力，它给的候选是猜的；未验证的直接换上去，
 *    就是把用户真收藏的地址换成一个 404。
 */
async function loadAlternatives(rec) {
  const box = $('healthAlt');
  box.textContent = '';
  box.hidden = false;
  // 骨架而不是一行「正在查…」。这块的结果形状本来就是「若干条链接 + 一句判据」，
  // 摆三条不同宽度的横杠，用户能预期接下来会看到什么。
  const sk = document.createElement('div');
  sk.className = 'skeleton';
  for (const w of ['c1', 'c3', 'c2']) {
    const row = document.createElement('div');
    row.className = 'skeleton-row';
    const bar = document.createElement('i');
    bar.className = `skeleton-bar ${w}`;
    row.append(bar);
    sk.append(row);
  }
  box.append(sk);

  const res = await send('linkAlternatives', { url: rec.url, title: rec.pageTitle || '' });
  box.textContent = '';
  box.append(renderAlternatives(rec, res && res.ok ? res.result : null));
}

function renderAlternatives(rec, alt) {
  const frag = document.createDocumentFragment();
  const h = document.createElement('h3');
  h.textContent = `${rec.pageTitle || rec.url} 的替代方案`;
  frag.append(h);

  if (!alt) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = '查不到替代方案。若是没授权、或网络不通，错误会在下面说明。';
    frag.append(p);
    return frag;
  }

  // 存档快照
  if (alt.snapshot) {
    const p = document.createElement('p');
    const a = document.createElement('a');
    a.href = alt.snapshot.url;
    a.target = '_blank';
    a.rel = 'noreferrer';
    a.textContent = alt.snapshot.url;
    p.append(document.createTextNode('存档快照：'), a);
    // ⚠️ 必须说清「怎么来的」：api 查出来的与 magic URL 跳过来的可靠性不同
    p.append(document.createElement('br'));
    const note = document.createElement('span');
    note.className = 'hint';
    note.textContent = alt.snapshot.method === 'api'
      ? `来自 archive.org 查询（时间戳 ${alt.snapshot.ts}）`
      : 'archive.org 查询接口没通，这是靠 web.archive.org 的跳转链接拿到的，可靠性略低';
    p.append(note);
    frag.append(p);
  } else {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'archive.org 上没有这个 URL 的快照。';
    frag.append(p);
  }

  // 已验证的候选 —— 唯一可以放心用的区
  if (alt.adoptable && alt.adoptable.length) {
    const p = document.createElement('p');
    p.textContent = '候选新地址（已验证能打开）：';
    const ul = document.createElement('ul');
    for (const c of alt.adoptable) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = c.url;
      a.target = '_blank';
      a.rel = 'noreferrer';
      a.textContent = c.url;
      li.append(a, document.createTextNode(` · HTTP ${c.status}`));
      ul.append(li);
    }
    p.append(ul);
    frag.append(p);
  }

  // 未验证的默认折叠 —— 展示，但不诱导
  if (alt.unverified && alt.unverified.length) {
    const d = document.createElement('details');
    const s = document.createElement('summary');
    s.textContent = `${alt.unverified.length} 个未验证的候选（AI 猜的，展开看看）`;
    const ul = document.createElement('ul');
    for (const c of alt.unverified) {
      const li = document.createElement('li');
      li.textContent = `${c.url} · ${c.note || '打不开'}`;
      ul.append(li);
    }
    d.append(s, ul);
    frag.append(d);
  }

  if (alt.aiReason) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = `AI 找新地址：${alt.aiReason}`;
    frag.append(p);
  }

  const p = document.createElement('p');
  p.className = 'hint';
  p.textContent = '这些都只是建议。扩展不会替你改书签。换不换、换成哪条，你自己定。';
  frag.append(p);
  return frag;
}

async function initLinkHealth() {
  const perm = await send('linkPerm', {});
  const has = perm && perm.ok && perm.result && perm.result.has;
  $('healthPermState').textContent = has ? '已授权' : '未授权，此时不会发出任何请求';
  $('btnLinkGrant').hidden = !!has;
  $('btnLinkRevoke').hidden = !has;

  const s = (await getSettings()) || {};
  $('linkInterval').value = String(s.linkScanIntervalMinutes ?? 360);
  $('linkAiFind').checked = s.linkScanAiFind === true;

  // ⚠️ 这些监听器**只挂一次**。
  //    早先每次切到「链接健康」页签都重挂一遍，于是切 3 次页签后
  //    点一下「立即检测一次」会同时触发 3 次 —— 表现是「点了没反应」或
  //    「跑了两遍」，而代码里看不出任何问题。
  //    数据刷新（上面那段 + 末尾的 refreshLinkHealth）每次都要跑，挂载不要。
  if (linkHealthWired) {
    await refreshLinkHealth();
    return;
  }
  linkHealthWired = true;

  $('btnLinkGrant').addEventListener('click', async () => {
    // ⚠️ 必须由用户手势直接触发，否则 Chrome 直接拒绝且不报错
    const r = await send('linkPerm', { action: 'request' });
    toast(r && r.result && r.result.has ? '已授权' : '未授权', !(r && r.result && r.result.has));
    await initLinkHealth();
  });
  $('btnLinkRevoke').addEventListener('click', async () => {
    await send('linkPerm', { action: 'revoke' });
    toast('已撤销');
    await initLinkHealth();
  });

  $('btnLinkRun').addEventListener('click', async () => {
    toast('开始检测…');
    const r = await send('linkStart');
    if (r && r.result && r.result.started === false) {
      toast(r.result.reason || '无法开始', true);
    }
    await refreshLinkHealth();
  });
  $('btnLinkResume').addEventListener('click', async () => {
    await send('linkResume');
    await refreshLinkHealth();
  });
  $('btnLinkPause').addEventListener('click', async () => {
    await send('linkPause');
    await refreshLinkHealth();
  });

  $('linkInterval').addEventListener('change', async (e) => {
    const minutes = Number(e.target.value) || 0;
    await updateSettings({ linkScanIntervalMinutes: minutes, linkScanEnabled: minutes > 0 });
    const r = await send('linkSyncAlarm');
    toast(r && r.result ? r.result.reason : '已更新');
    await refreshLinkHealth();
  });

  $('linkAiFind').addEventListener('change', async (e) => {
    await updateSettings({ linkScanAiFind: e.target.checked === true });
    toast(e.target.checked
      ? '已开启：死链的标题与地址会发给你配置的模型服务商'
      : '已关闭：不再向模型发任何死链数据');
  });

  $('btnImportantClear').addEventListener('click', async () => {
    importantUrls = await clearImportant().then((r) => r.urls);
    renderImportantCount();
    renderLinkHealth();
    toast('已取消全部标记');
  });

  await refreshLinkHealth();
}

// ───────────────────────── 语义去重（F2）─────────────────────────
//
// ⚠️ D6：**结果只进「建议合并」，永不进删除清单。**
//    本节刻意**没有**「合并」「删除」按钮 —— 唯一能做的就是看一眼。
//    URL 归一化去重那一套是另一回事，两者互不替代。

async function initSemantic() {
  const s = (await getSettings()) || {};
  $('semanticEnabled').checked = s.semanticDedupeEnabled === true;
  $('semanticThreshold').value = String(s.semanticThreshold ?? 0.92);

  const r = await send('semanticSuggestions');
  const list = (r && r.ok && r.result && r.result.suggestions) || [];
  renderSemantic(list);

  $('semanticEnabled').addEventListener('change', async (e) => {
    await updateSettings({ semanticDedupeEnabled: e.target.checked === true });
    toast(e.target.checked
      ? '已启用：标题与正文摘要会发到百炼做向量化'
      : '已关闭：不再向百炼发送任何书签数据');
  });
  $('semanticThreshold').addEventListener('change', async (e) => {
    const v = Number(e.target.value);
    if (!Number.isFinite(v) || v < 0.5 || v > 1) {
      toast('阈值要在 0.5 ~ 1 之间', true);
      e.target.value = String(s.semanticThreshold ?? 0.92);
      return;
    }
    await updateSettings({ semanticThreshold: v });
  });
  $('btnSemanticRun').addEventListener('click', async () => {
    $('semanticState').textContent = '正在算…（800 条要分 80 批，请稍候）';
    const res = await send('semanticRun');
    if (!res || res.ok === false) { $('semanticState').textContent = '失败'; return; }
    const d = res.result || {};
    $('semanticState').textContent = d.reason
      || `新增向量 ${d.embedded || 0} 条，建议合并 ${(d.suggestions || []).length} 对`;
    renderSemantic(d.suggestions || []);
  });
  $('btnSemanticClear').addEventListener('click', async () => {
    await send('semanticClear');
    renderSemantic([]);
    $('semanticState').textContent = '已清空。换过模型或维度后必须清，否则新旧向量会混在一起比。';
  });
}

function renderSemantic(list) {
  const tbl = $('semanticTable');
  const tbody = $('semanticRows');
  tbody.textContent = '';
  if (!list || !list.length) { tbl.hidden = true; return; }
  tbl.hidden = false;

  for (const s of list) {
    const tr = document.createElement('tr');
    const cells = [
      String(s.score),
      s.keeper ? (s.keeper.title || s.keeper.url) : '',
      s.loser ? (s.loser.title || s.loser.url) : '',
    ];
    for (const c of cells) {
      const td = document.createElement('td');
      td.textContent = c;
      tr.append(td);
    }
    // 判据要能一眼看懂：光一个 0.93 的数字对用户毫无意义
    const why = document.createElement('td');
    why.textContent = [
      s.evidence && s.evidence.sameTitle ? '标题完全相同' : null,
      s.evidence && s.evidence.fromText ? '含正文比对' : '仅标题比对',
    ].filter(Boolean).join(' · ');
    tr.append(why);
    tbody.append(tr);
  }

  const note = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = 4;
  td.className = 'hint';
  td.textContent = '这些只是建议。扩展不会替你合并或删除任何书签。要处理请自己动手，或用现有的 URL 去重功能。';
  note.append(td);
  tbody.append(note);
}

// ───────────────────────── 内容归档（F3）─────────────────────────

let archiveWired = false;
let archiveBusy = false;

function paintSinkStatus(s) {
  $('archiveState').textContent = s.online
    ? `接收器在线（已写入 ${s.written || 0} 条）`
    : '接收器离线';
  $('archiveState').classList.toggle('warn-text', !s.online);
  $('archiveNote').textContent = s.online
    ? `目录：${s.dir || '未知'}`
    : '先在项目目录跑 python tools/archive_sink.py，再点「检查接收器」。'
      + '离线时扩展不会假装存了：归档是「防链接腐烂」的全部价值所在。';
}

async function refreshSinkStatus() {
  const r = await send('archiveStatus');
  paintSinkStatus((r && r.ok && r.result) || { online: false });
}

/**
 * 跑归档。
 *
 * ⚠️ 循环在**这个页面**里，不在 service worker 里。
 *    一次 `archiveRun` 只处理一个切片（游标落盘），800 条必然跨过好几次 SW 回收；
 *    而 options 页面是真页面，不会被回收。形状与 link-scan 的 linkStart/linkStep 一致。
 *
 * 四类结果分开报，不合并成一个数字：合并就等于把「重新抓取失败」
 * 藏进「已归档 200/800」里，而那正是「以为存了其实没存」的老坑。
 */
async function runArchive() {
  if (archiveBusy) return;
  archiveBusy = true;
  const btn = $('btnArchiveRun');
  btn.disabled = true;
  try {
    // guard 只是防跑飞：正常路径在队列跑完时 finished 置位并 break
    for (let guard = 0; guard < 1000; guard++) {
      const r = await send('archiveRun');
      if (!r || r.ok === false) {
        $('archiveState').textContent = `失败：${(r && r.error) || '后台无响应'}`;
        $('archiveState').classList.add('warn-text');
        return;
      }
      const d = r.result || {};
      if (d.reason) {
        $('archiveState').textContent = d.reason;
        $('archiveState').classList.add('warn-text');
        return;
      }
      if (!d.finished) {
        $('archiveState').textContent = `归档中… 已落盘 ${d.done}，队列共 ${d.total}`;
        $('archiveState').classList.remove('warn-text');
        continue;
      }
      const bad = [];
      if (d.fetchFailed) bad.push(`归档时重新抓取失败 ${d.fetchFailed} 条`);
      if (d.postFailed) bad.push(`接收器拒收 ${d.postFailed} 条`);
      if (d.skipped) bad.push(`无正文跳过 ${d.skipped} 条`);
      $('archiveState').textContent =
        `归档完成：${d.done}/${d.total} 条落盘`
        + (d.rendered ? `，${d.rendered} 条额外出了 PDF 与截图` : '')
        + (bad.length ? `。${bad.join('，')}` : '');
      $('archiveState').classList.toggle('warn-text', bad.length > 0);
      toast(bad.length ? '归档完成，但有没能存上的' : '归档完成');
      break;
    }
  } finally {
    archiveBusy = false;
    btn.disabled = false;
    await refreshSinkStatus();
  }
}

async function initArchive() {
  // 监听器只挂一次，理由同 initLinkHealth
  if (archiveWired) {
    await refreshSinkStatus();
    return;
  }
  archiveWired = true;

  await refreshSinkStatus();

  $('btnArchiveProbe').addEventListener('click', refreshSinkStatus);
  $('btnArchiveRun').addEventListener('click', runArchive);
  $('btnArchiveReset').addEventListener('click', async () => {
    await send('archiveReset');
    $('archiveState').textContent = '进度已清空，下次点「归档队列里的正文」从头开始';
    $('archiveState').classList.remove('warn-text');
    toast('已清空归档进度（磁盘上已有的文件不受影响）');
  });
}

// ───────────────────────── 启动 ─────────────────────────

/** 切到某个页签。
 *
 * 此前只 toggle 一个 .active class：没有 role="tab"、没有 aria-selected、
 * 也没有方向键。读屏用户听到的是 5 个互不相关的按钮。
 * 改法照 WAI-ARIA 的 tabs 模式，但**保留 data-tab 与 click 触发** ——
 * E2E 是按 `#tabs button[data-tab="dup"]` 点的，不能改成别的入口。
 */
function selectTab(btn, { focus = false } = {}) {
  for (const b of $('tabs').querySelectorAll('button')) {
    const on = b === btn;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;      // 漫游 tabindex：一组里只有一个可 Tab 到
  }
  for (const p of document.querySelectorAll('.panel')) {
    p.classList.toggle('active', p.dataset.panel === btn.dataset.tab);
  }
  // hero 只在计划明细页 sticky：它有 250px 高且 z-index 高于卡片，
  // 钉在别的页上会一直压住设置区那几张卡的上沿。CSS 靠这个属性判。
  document.body.dataset.tab = btn.dataset.tab;
  if (focus) btn.focus();

  // 切到链接健康时按需加载一次 —— 那个面板要逐条读记录，
  // 没必要在启动时就把几百条读进内存
  if (btn.dataset.tab === 'health') {
    initLinkHealth().catch(() => {});
    initSemantic().catch(() => {});
    initArchive().catch(() => {});
  }
}

async function init() {
  // 页签：点击 + 方向键（Left/Right 移动，Home/End 跳首尾）
  const tabBtns = [...$('tabs').querySelectorAll('button')];
  // 先落定默认页签，不等用户点一下。CSS 靠 body[data-tab] 决定 hero 钉不钉，
  // 缺这个属性时设置页一打开 hero 就是 sticky 的，正好把卡片上沿盖掉。
  selectTab(tabBtns.find((b) => b.classList.contains('active')) || tabBtns[0]);
  tabBtns.forEach((btn, i) => {
    btn.tabIndex = btn.classList.contains('active') ? 0 : -1;
    btn.addEventListener('click', () => selectTab(btn));
    btn.addEventListener('keydown', (e) => {
      const map = { ArrowRight: 1, ArrowLeft: -1 };
      let next = null;
      if (e.key in map) next = tabBtns[(i + map[e.key] + tabBtns.length) % tabBtns.length];
      else if (e.key === 'Home') next = tabBtns[0];
      else if (e.key === 'End') next = tabBtns[tabBtns.length - 1];
      if (!next) return;
      e.preventDefault();
      selectTab(next, { focus: true });
    });
  });

  $('btnPreview').addEventListener('click', async () => {
    // 新计划出来了，上一次的执行凭据就作废了 —— 否则用户会盯着一条满格进度条
    // 以为已经整理过，其实那是上一轮的结果。
    execBarReset = true;
    $('btnPreview').disabled = true;
    try {
      await loadAndClassify({ backup: true });
      if (state.llmErrors.length) toast(state.llmErrors[0], true);
      else toast(`预览完成：${state.plan.items.length} 条待移动，${state.dupPayload.length} 条重复`);
    } catch (e) {
      busy('');
      // 骨架屏只在 render() 里收。loadAndClassify 抛错时走不到那里，
      // 不显式撤掉的话，计划表会一直停在六条灰杠上，比报错还让人困惑。
      showSkeleton('planSkeleton', 6, false);
      $('planTable').hidden = true;
      $('planEmpty').hidden = false;
      fillEmpty($('planEmpty'), '○', '预览没跑起来',
        '读书签树时出错了。点上面的「读取并预览」重试一次；'
        + '如果反复失败，到 chrome://extensions 重新加载扩展。');
      toast(`预览失败：${e.message || e}`, true);
    } finally {
      $('btnPreview').disabled = false;
    }
  });

  $('btnExecute').addEventListener('click', doExecute);
  $('btnPause').addEventListener('click', () => send('pauseExecution').then(() => renderReport()));
  $('btnResume').addEventListener('click', () => send('resumeExecution').then(() => pollProgress()));
  $('btnRestore').addEventListener('click', async () => {
    const snaps = await listSnapshots();
    if (!snaps.length) { toast('还没有快照可恢复', true); return; }
    doRestore(snaps[0]);
  });
  $('btnSnapshot').addEventListener('click', async () => {
    const s = await createSnapshot({ note: '手动备份' });
    await renderSnapshots();
    toast('已创建快照');
    void s;
  });

  $('onlyChanged').addEventListener('change', renderPlan);
  $('onlyLow').addEventListener('change', renderPlan);

  // 类目保存
  $('btnSaveTaxonomy').addEventListener('click', async () => {
    const tax = collectTaxonomyFromEditor();
    if (!tax.length) { toast('至少要有一个顶层类目', true); return; }
    await set(K.TAXONOMY_OVERRIDE, tax);
    state.taxonomy = tax;
    renderTaxonomyEditor();
    toast('类目已保存。重新预览即可按新结构分类。');
  });
  $('btnResetTaxonomy').addEventListener('click', async () => {
    await set(K.TAXONOMY_OVERRIDE, null);
    state.taxonomy = DEFAULT_TAXONOMY;
    renderTaxonomyEditor();
    toast('已恢复预置类目');
  });

  // LLM 设置
  $('llmPreset').addEventListener('change', (e) => {
    if (!e.target.value) return;
    const [baseUrl, model] = e.target.value.split('::');
    $('llmBaseUrl').value = baseUrl;
    $('llmModel').value = model;
  });
  $('btnSaveLlm').addEventListener('click', async () => {
    await updateSettings({
      llmEnabled: $('llmEnabled').checked,
      baseUrl: $('llmBaseUrl').value.trim(),
      model: $('llmModel').value.trim(),
      apiKey: $('llmApiKey').value.trim(),
    });
    await loadSettingsUi();
    toast('已保存');
  });
  $('btnGrant').addEventListener('click', async () => {
    const baseUrl = $('llmBaseUrl').value.trim();
    const ok = await requestLlmPermission(baseUrl);
    toast(ok ? '已授权' : '未授权（需要你手动在弹窗里点允许）', !ok);
    await loadSettingsUi();
  });
  $('btnRevoke').addEventListener('click', async () => {
    const ok = await revokeLlmPermission($('llmBaseUrl').value.trim());
    toast(ok ? '已撤销授权' : '撤销失败', !ok);
    await loadSettingsUi();
  });

  // 目标根
  $('targetRoot').addEventListener('change', async (e) => {
    await updateSettings({ targetRoot: e.target.value });
    toast('已保存，重新预览即可');
  });

  // 移动失败日志
  $('btnExportPending').addEventListener('click', () => exportPendingFailures());
  $('btnGrantSink').addEventListener('click', async () => {
    const ok = await requestSinkPermission();
    toast(
      ok ? '已授权本机日志接收器' : '未授权（需要在弹窗里点允许）。失败记录会存在扩展里，可随时重新导出',
      !ok,
    );
    await renderFailLogUi();
  });
  $('btnRevokeSink').addEventListener('click', async () => {
    const ok = await revokeSinkPermission();
    toast(ok ? '已撤销授权' : '撤销失败', !ok);
    await renderFailLogUi();
  });
  $('btnProbeSink').addEventListener('click', () => renderFailLogUi());
  $('failLogEnabled').addEventListener('change', async (e) => {
    await updateSettings({ failLogEnabled: e.target.value === '1' });
    toast(e.target.value === '1' ? '已开启失败日志' : '已关闭失败日志');
  });

  // 去重逐条否决
  $('btnClearVeto').addEventListener('click', async () => {
    if (!state.veto.length) { toast('当前没有「不删」标记'); return; }
    await clearDedupeVeto();
    await safeReload();
    toast('已清除全部「不删」标记');
  });

  // 人工干预清理
  $('btnClearLocks').addEventListener('click', async () => {
    await set(K.LOCKS, []);
    await safeReload();
    toast('已全部解锁');
  });
  $('btnClearLearned').addEventListener('click', async () => {
    if (!confirm('清空所有人工沉淀的规则？')) return;
    await set(K.RULES_LEARNED, []);
    await safeReload();
    toast('已清空规则');
  });
  $('btnClearManual').addEventListener('click', async () => {
    if (!confirm('清空所有手动改判？')) return;
    await set(K.MANUAL_ASSIGNMENTS, {});
    await safeReload();
    toast('已清空改判');
  });

  // 改判弹窗
  $('pathPicker').addEventListener('close', async () => {
    if ($('pathPicker').returnValue !== 'ok' || !state.picked) return;
    const chosen = $('pathPicker').querySelector('input[name="pick"]:checked');
    if (!chosen) { toast('没有选择分类', true); return; }
    const id = state.picked;
    state.picked = null;
    await markWrong(id, chosen.value.split('/'));
  });

  await loadSettingsUi();
  renderTaxonomyEditor();
  renderPresetSelect();
  // 探一次接收器。不 await 到主流程外抛错 —— 面板能不能开，
  // 不该取决于 F 盘上那个接收器在不在跑。
  await renderFailLogUi().catch(() => {});
  await render();
  await renderSnapshots();

  // ── 崩溃/回收后的任务认领 ──
  // 浏览器被强杀、service worker 被回收时，task.status 会停在 'running' ——
  // 因为只有执行循环自己知道它停了。但「running」此时与「此刻真的在跑」无法区分，
  // 于是「继续」按钮被隐藏，用户看不到任何恢复入口。
  //
  // 判据用**探针**而不是时间戳：直接问 service worker「你手上真有循环在跑吗」。
  // 消息会唤醒 SW，唤醒后的新实例模块状态重置、答 false，正好说明原循环已不存在。
  // （早先想用「updatedAt 超过 5 秒就算陈旧」，不可靠 —— 浏览器重开只要 2~4 秒，
  //   落在阈值内，中断的任务永远等不到「继续」按钮。）
  // 这条判据同时天然避开「开了两个标签页」：真在跑的那个 SW 会答 true。
  const task = await getTask();
  if (task.status === TASK_STATUS.RUNNING) {
    const probe = await send('probeRunner');
    const active = probe.ok ? !!probe.result?.active : false;
    if (!active) {
      await set(K.TASK_CURRENT, { ...task, status: TASK_STATUS.PAUSED, updatedAt: Date.now() });
      await renderReport();
      toast('检测到上次执行被中断（浏览器可能回收了后台），已切到「已暂停」，点「继续」接着跑');
    }
  }

  // 就绪信号：init() 里所有监听绑完、首次渲染完成才置位。
  // ⚠️ 这个属性不只是调试用的 —— E2E 如果只等 DOM 里的按钮出现（HTML 解析时就有），
  //    会在监听器还没绑上时就点击，点子打进黑洞；而「dry-run 零写入」那条断言
  //    会因为「什么都没发生」而假绿。必须等到真正就绪。
  document.body.dataset.ready = '1';
}

init();
