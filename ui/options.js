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
} from '../src/storage.js';
import { createSnapshot, listSnapshots, restoreSnapshot, deleteSnapshot } from '../src/backup.js';
import {
  classifyBatch, hasLlmPermission, requestLlmPermission, revokeLlmPermission, validateAssignments,
} from '../src/classify/llm.js';

const MAX_ROWS = 300;

const $ = (id) => document.getElementById(id);

/** 页面状态 */
const state = {
  entries: [],
  byId: new Map(),
  plan: null,
  groups: [],
  dupPayload: [],
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
  const [settings, learned, locks, manual, taxOverride] = await Promise.all([
    getSettings(),
    get(K.RULES_LEARNED, []),
    get(K.LOCKS, []),
    get(K.MANUAL_ASSIGNMENTS, {}),
    get(K.TAXONOMY_OVERRIDE, null),
  ]);
  state.taxonomy = getTaxonomy(taxOverride);

  setRules(DEFAULT_RULES);
  let plan = buildPlan({
    entries: state.entries,
    taxonomy: state.taxonomy,
    learnedRules: learned,
    locks,
    manualAssignments: manual,
  });

  // LLM 兜底：只对规则未命中的那一小撮发请求
  state.llmErrors = [];
  if (settings.llmEnabled) {
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
  }

  // 去重
  state.groups = settings.dedupeEnabled ? findDuplicates(state.entries) : [];
  state.dupPayload = toRemovalList(state.groups).map((d) => {
    const src = state.byId.get(d.id);
    return { id: d.id, url: d.url, title: d.title, path: src?.path || ['2'], keepId: d.keepId };
  });

  state.plan = plan;
  await set(K.LAST_PLAN, { plan, duplicates: state.dupPayload, snapshotTs: state.snapshotTs });

  busy('');
  render();
  // 渲染完成计数。E2E 用它判断「这一轮预览真的跑完了」。
  // ⚠️ 之前靠等 #planEmpty 是否可见来判断是错的：它在 init() 之后就一直可见，
  //    点击后会在新结果渲染出来之前立刻「通过」，读到的还是上一轮的数据。
  state.seq += 1;
  document.body.dataset.previewSeq = String(state.seq);
}

// ───────────────────────── 渲染 ─────────────────────────

function render() {
  renderStats();
  renderPlan();
  renderDup();
  renderSnapshots();
  renderCounts();
  renderReport();
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
      const li = document.createElement('li');
      li.className = 'drop';
      li.textContent = `删除：${d.title || d.url} — ${displayPath(d.path)}`;
      ul.append(li);
    }
    div.append(key, ul);
    frag.append(div);
  }
  box.append(frag);
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
    return;
  }
  const items = task.plan.items || [];
  const done = items.filter((i) => i.status === 'done').length;
  const failed = items.filter((i) => i.status === 'failed').length;
  const pending = items.filter((i) => i.status === 'pending').length;

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

  if (task.status === TASK_STATUS.RUNNING) {
    const bar = document.createElement('div');
    bar.className = 'progress-bar';
    const fill = document.createElement('i');
    const pct = items.length ? Math.round((done / items.length) * 100) : 0;
    fill.style.width = `${pct}%`;
    bar.append(fill);
    box.append(bar);
  }

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

  await loadAndClassify({ backup: false });
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
  await loadAndClassify({ backup: false });
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

async function doExecute() {
  const plan = state.plan;
  if (!plan) return;
  const dups = state.dupPayload;

  const msg = [
    '即将整理你的书签：',
    '',
    `　移动　　${plan.items.length} 条`,
    `　新建　　${plan.newFolders.length} 个文件夹`,
    `　删除　　${dups.length} 条重复项`,
    '',
    `快照：${state.snapshotTs ? new Date(Number(state.snapshotTs)).toLocaleString() : '（将自动创建）'}`,
    '',
    '这些操作可以点「恢复备份」回滚。',
    '',
    '确定继续？',
  ].join('\n');
  if (!confirm(msg)) return;

  $('btnExecute').disabled = true;
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
  toast('已开始执行');
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
  await loadAndClassify({ backup: false });
  const task = await getTask();
  if (task.status === TASK_STATUS.DONE) toast('整理完成');
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
  await loadAndClassify({ backup: false });
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

async function loadSettingsUi() {
  const s = await getSettings();
  $('targetRoot').value = s.targetRoot;
  $('llmEnabled').checked = !!s.llmEnabled;
  $('llmBaseUrl').value = s.baseUrl;
  $('llmModel').value = s.model;
  $('llmApiKey').value = s.apiKey;

  const granted = await hasLlmPermission(s.baseUrl);
  $('llmPermState').textContent = granted
    ? `已授权访问：${new URL(s.baseUrl).host}`
    : `尚未授权访问 ${(() => { try { return new URL(s.baseUrl).host; } catch { return s.baseUrl; } })()}。启用 LLM 前需要先点「授权访问该域名」。`;
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

  // 人工干预清理
  $('btnClearLocks').addEventListener('click', async () => {
    await set(K.LOCKS, []);
    await loadAndClassify({ backup: false });
    toast('已全部解锁');
  });
  $('btnClearLearned').addEventListener('click', async () => {
    if (!confirm('清空所有人工沉淀的规则？')) return;
    await set(K.RULES_LEARNED, []);
    await loadAndClassify({ backup: false });
    toast('已清空规则');
  });
  $('btnClearManual').addEventListener('click', async () => {
    if (!confirm('清空所有手动改判？')) return;
    await set(K.MANUAL_ASSIGNMENTS, {});
    await loadAndClassify({ backup: false });
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
  render();
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
