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
  validateAssignments, resolveConfig, MODEL_PRESETS,
} from '../src/classify/llm.js';
import {
  getPending, clearPending, probeSink, toJsonl,
  requestSinkPermission, revokeSinkPermission,
} from '../src/fail-log.js';

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
  $('tabPlanCount').textContent = plan ? plan.items.length : 0;
  $('tabDupCount').textContent = state.groups.length;

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
  body.textContent = '';

  if (!state.plan || !state.plan.items.length) {
    empty.hidden = false;
    empty.textContent = state.plan ? '没有需要移动的条目 —— 书签已经在正确的位置上了。' : '还没有预览。先点「读取并预览」。';
    more.hidden = true;
    return;
  }
  empty.hidden = true;

  const onlyChanged = $('onlyChanged').checked;
  const onlyLow = $('onlyLow').checked;
  let rows = state.plan.items;
  if (onlyChanged) rows = rows.filter((i) => i.status === 'pending');
  if (onlyLow) rows = rows.filter((i) => i.confidence === 'low');

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
    cb.addEventListener('change', () => toggleLock(it.id, cb.checked));
    tdLock.append(cb);

    // 书签
    const tdItem = document.createElement('td');
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = it.title || '(无标题)';
    const url = document.createElement('div');
    url.className = 'url';
    url.textContent = it.url || '';
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
    const [label, cls] = REASON_LABEL[it.reason] || [it.reason, ''];
    const badge = document.createElement('span');
    badge.className = `badge ${cls}`;
    badge.textContent = label;
    const conf = document.createElement('span');
    conf.className = 'badge';
    conf.style.marginLeft = '4px';
    conf.textContent = { high: '高', medium: '中', low: '低' }[it.confidence] || it.confidence;
    tdWhy.append(badge, conf);

    // 反馈
    const tdFb = document.createElement('td');
    const fb = document.createElement('span');
    fb.className = 'fb';
    const ok = document.createElement('button');
    ok.textContent = '✓';
    ok.title = '这条分得对';
    ok.addEventListener('click', () => markRight(it.id));
    const bad = document.createElement('button');
    bad.textContent = '✗ 改';
    bad.title = '分错了，选正确分类';
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
  if (!state.groups.length) { empty.hidden = false; return; }
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
    liKeep.textContent = `保留：${g.keeper.title || g.keeper.url} — ${displayPath(g.keeper.path)}`;
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
        ? `不删：${d.title || d.url} — ${displayPath(d.path)}`
        : `删除：${d.title || d.url} — ${displayPath(d.path)}`;

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
  $('tabSnapCount').textContent = snaps.length;
  if (!snaps.length) { empty.hidden = false; return; }
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
    restore.addEventListener('click', () => doRestore(s));
    const del = document.createElement('button');
    del.textContent = '删除';
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
      li.textContent = `${f.url} — ${f.error}`;
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
 * @returns {Promise<{id: string, name: string}>}
 */
async function resolveTargetRoot() {
  const settings = await getSettings();
  const id = String(settings.targetRoot || '1');
  try {
    const trees = await chrome.bookmarks.getTree();
    const hit = (trees?.[0]?.children || []).find((t) => String(t.id) === id);
    // 兜底只能给 id 契约下的默认值 —— 根标题是本地化的，不能硬编码中文名
    return { id, name: hit ? (hit.title || id) : '书签栏' };
  } catch {
    return { id, name: '书签栏' };
  }
}

async function doExecute() {
  const plan = state.plan;
  if (!plan) return;
  const dups = state.dupPayload;
  const root = await resolveTargetRoot();

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
  execBarReset = false;   // 新任务从 0 开始，撤掉上一轮的完成凭据
  const res = await send('startExecution', {
    plan,
    duplicates: dups,
    snapshotTs: state.snapshotTs,
  });
  if (!res.ok) {
    toast(`启动失败：${res.error}`, true);
    syncExecuteButton();
    return;
  }
  // ⚠️ 后端「拒绝启动」时返回的是 `{ok:true, result:{started:false, reason}}` ——
  //    ok 只代表消息送达了，不代表整理真的跑起来了。
  //    早先只判 res.ok，于是「已在执行中 / 计划为空」这两种拒绝
  //    都会弹「已开始执行」，然后什么都不发生 —— 从用户看就是「点了没反应」。
  if (res.result && res.result.started === false) {
    toast(`没有开始整理：${res.result.reason || '未知原因'}`, true);
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
      + ' —— 失败原因见下方红色明细', true);
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
    .map((f) => `<li>${escapeHtml(f.title || f.url || f.id)} —— ${escapeHtml(String(f.error || ''))}</li>`)
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
  custom.textContent = '— 自定义（在下面手填 base URL 与模型）—';
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
  $('targetRoot').value = s.targetRoot;
  $('llmEnabled').checked = !!s.llmEnabled;
  $('llmBaseUrl').value = s.baseUrl;
  $('llmModel').value = s.model;
  $('llmApiKey').value = s.apiKey;

  // 预选当前配置对应的预设项
  const cur = `${s.baseUrl}::${s.model}`;
  const match = MODEL_PRESETS.find((p) => `${p.baseUrl}::${p.model}` === cur);
  $('llmPreset').value = match ? cur : '';

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
    : `尚未授权访问 ${host}。启用 LLM 前需要先点「授权访问该域名」—— 权限是按需申请的，不开 LLM 就不需要。`;
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
    el.textContent = '接收器状态：未授权 —— 点下面的「授权本机日志接收器」一次即可。';
    el.classList.add('warn-text');
  } else if (p.state === 'online') {
    el.textContent = `接收器状态：在线（本次会话已写入 ${p.lines} 条）→ ${p.dir}`;
    el.classList.remove('warn-text');
  } else {
    el.textContent = '接收器状态：离线 —— 先在本机开 npm run log:sink。'
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

// ───────────────────────── 启动 ─────────────────────────

async function init() {
  // 标签页
  for (const btn of $('tabs').querySelectorAll('button')) {
    btn.addEventListener('click', () => {
      for (const b of $('tabs').querySelectorAll('button')) b.classList.toggle('active', b === btn);
      for (const p of document.querySelectorAll('.panel')) {
        p.classList.toggle('active', p.dataset.panel === btn.dataset.tab);
      }
    });
  }

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
      ok ? '已授权本机日志接收器' : '未授权（需要在弹窗里点允许）—— 失败记录会存在扩展里，可随时重新导出',
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
