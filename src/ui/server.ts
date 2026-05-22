import { subscribe, history, runParamsState, type UIEvent } from "./events";
import { db } from "../db/client";

const PORT = Number(process.env.UI_PORT ?? 4242);

const DASHBOARD_HTML = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>truth-engine</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg: #0d1117; --bg2: #161b22; --bg3: #21262d; --bg4: #2d333b;
  --border: #30363d; --text: #e6edf3; --text2: #8b949e; --text3: #6e7681;
  --green: #3fb950; --red: #f85149; --yellow: #d29922;
  --blue: #58a6ff; --purple: #bc8cff; --orange: #ffa657;
  --cyan: #39d353; --pink: #ff7b72;
  font-size: 13px;
}
body { background: var(--bg); color: var(--text); font-family: 'Segoe UI', system-ui, sans-serif; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }

/* ── Header ─────────────────────────────────────────────────────────── */
header { display: flex; align-items: center; gap: 8px; padding: 7px 14px; background: var(--bg2); border-bottom: 1px solid var(--border); flex-shrink: 0; min-height: 0; }
.logo { font-size: 14px; font-weight: 700; color: var(--blue); white-space: nowrap; letter-spacing: .3px; }
.problem-pill { flex: 1; background: var(--bg3); border: 1px solid var(--border); border-radius: 5px; padding: 3px 10px; font-size: 11px; color: var(--text2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; transition: border-color .15s; }
.problem-pill:hover { color: var(--text); border-color: var(--blue); }
.badge { font-size: 11px; padding: 2px 8px; border-radius: 10px; background: var(--bg3); border: 1px solid var(--border); color: var(--text2); white-space: nowrap; }
.badge.live { border-color: var(--green); color: var(--green); }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.35} }
.badge.live::before { content: '●'; margin-right: 5px; animation: pulse 2s infinite; }

/* ── Agent banner ────────────────────────────────────────────────────── */
.agent-bar { padding: 4px 14px; background: var(--bg3); border-bottom: 1px solid var(--border); font-size: 11px; display: flex; align-items: center; gap: 8px; flex-shrink: 0; min-height: 26px; }
.agent-label { color: var(--text3); text-transform: uppercase; letter-spacing: .5px; }
.agent-name { font-weight: 600; }
@keyframes spin { to { transform: rotate(360deg); } }
.spinner { width: 10px; height: 10px; border: 1.5px solid var(--border); border-top-color: var(--blue); border-radius: 50%; animation: spin .7s linear infinite; flex-shrink: 0; }
.spinner.off { display: none; }

/* ── Main grid ───────────────────────────────────────────────────────── */
.main-grid { display: grid; grid-template-columns: 234px 1fr 370px; flex: 1; min-height: 0; overflow: hidden; }

/* ── Shared panel pieces ─────────────────────────────────────────────── */
.panel { display: flex; flex-direction: column; border-right: 1px solid var(--border); min-height: 0; }
.panel:last-child { border-right: none; }
.panel-head { padding: 6px 12px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .8px; color: var(--text2); border-bottom: 1px solid var(--border); background: var(--bg2); flex-shrink: 0; display: flex; align-items: center; gap: 6px; }
.panel-body { flex: 1; overflow-y: auto; padding: 8px; min-height: 0; }
.panel-body::-webkit-scrollbar { width: 4px; }
.panel-body::-webkit-scrollbar-track { background: transparent; }
.panel-body::-webkit-scrollbar-thumb { background: var(--bg4); border-radius: 2px; }
.section-head { font-size: 10px; text-transform: uppercase; letter-spacing: .6px; color: var(--text3); padding: 8px 2px 4px; }

/* ── Left panel ──────────────────────────────────────────────────────── */
.cfg-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; margin-bottom: 6px; }
.cfg-cell { background: var(--bg2); border: 1px solid var(--border); border-radius: 4px; padding: 5px 8px; }
.cfg-lbl { font-size: 9px; text-transform: uppercase; letter-spacing: .5px; color: var(--text3); }
.cfg-val { font-size: 16px; font-weight: 700; color: var(--blue); font-variant-numeric: tabular-nums; }
.budget-wrap { margin: 2px 0 10px; }
.budget-labels { display: flex; justify-content: space-between; font-size: 10px; color: var(--text2); margin-bottom: 3px; }
.budget-track { height: 4px; background: var(--bg3); border-radius: 2px; overflow: hidden; }
.budget-fill { height: 100%; background: var(--blue); border-radius: 2px; transition: width .5s, background .5s; }
.stat-row { display: flex; justify-content: space-between; align-items: center; padding: 3px 2px; }
.stat-lbl { color: var(--text2); font-size: 11px; }
.stat-val { font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; }
.stat-val.g { color: var(--green); } .stat-val.r { color: var(--red); } .stat-val.o { color: var(--orange); } .stat-val.b { color: var(--blue); }
.step-item { padding: 6px 8px; border-radius: 4px; margin-bottom: 4px; border: 1px solid var(--border); background: var(--bg2); }
.step-item.cur { border-color: var(--blue); background: #0d1f33; }
.step-item.done { border-color: var(--green); opacity: .7; }
.step-num { font-size: 9px; color: var(--text3); margin-bottom: 2px; }
.step-goal { font-size: 11px; font-weight: 500; line-height: 1.4; }
.step-oracle { font-size: 10px; color: var(--purple); margin-top: 2px; font-style: italic; }

/* ── Center panel ────────────────────────────────────────────────────── */
#event-list { display: flex; flex-direction: column; gap: 3px; }

/* LLM call block */
.call-block { border: 1px solid var(--bg4); border-radius: 6px; background: var(--bg2); overflow: hidden; }
.call-block.running { border-color: var(--blue); }
.call-head { display: flex; align-items: center; gap: 7px; padding: 5px 10px; background: var(--bg3); border-bottom: 1px solid var(--border); }
.call-role { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; }
.call-role.reasoning { color: var(--blue); }
.call-role.critic { color: var(--orange); }
.call-role.llm { color: var(--purple); }
.call-model { font-size: 9px; color: var(--text3); }
.call-art { font-size: 10px; color: var(--text3); font-family: monospace; }
.call-timing { margin-left: auto; font-size: 10px; color: var(--text2); display: flex; align-items: center; gap: 5px; font-variant-numeric: tabular-nums; }
.call-timing .done-ts { color: var(--text3); font-size: 9px; }

/* Thinking section */
.think-section { border-bottom: 1px solid var(--border); }
.think-section summary { list-style: none; cursor: pointer; padding: 4px 10px; font-size: 10px; color: var(--yellow); display: flex; align-items: center; gap: 5px; user-select: none; }
.think-section summary:hover { background: var(--bg3); }
.think-section summary::before { content: '▶'; font-size: 8px; margin-right: 3px; transition: transform .15s; }
.think-section[open] summary::before { content: '▼'; }
.think-text { padding: 8px 12px; font-family: 'Consolas', 'Fira Code', monospace; font-size: 11px; line-height: 1.65; color: var(--text2); white-space: pre-wrap; word-break: break-word; max-height: 280px; overflow-y: auto; background: var(--bg); font-style: italic; }
.think-text::-webkit-scrollbar { width: 3px; }
.think-text::-webkit-scrollbar-thumb { background: var(--bg4); }

/* Event rows */
.ev { display: flex; align-items: center; gap: 7px; padding: 5px 8px; border-radius: 4px; border-left: 3px solid var(--border); background: var(--bg2); cursor: pointer; position: relative; }
.ev:hover { background: var(--bg3); }
.ev-icon { font-size: 12px; flex-shrink: 0; width: 16px; text-align: center; }
.ev-type { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .4px; width: 76px; flex-shrink: 0; }
.ev-msg { flex: 1; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.score-pill { font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 8px; flex-shrink: 0; }
.ev-ts { font-size: 10px; color: var(--text3); flex-shrink: 0; font-variant-numeric: tabular-nums; }
.ev-detail { display: none; padding: 6px 10px; font-size: 11px; font-family: 'Consolas', monospace; color: var(--text2); background: var(--bg); white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow-y: auto; border-top: 1px solid var(--border); }
.ev.open .ev-detail { display: block; }

/* Event border colors */
.ev[data-k="artifact:survived"] { border-left-color: var(--green); }
.ev[data-k="artifact:killed"]   { border-left-color: var(--red); }
.ev[data-k="verdict"]            { border-left-color: var(--yellow); }
.ev[data-k="step:advanced"]      { border-left-color: var(--purple); }
.ev[data-k="repair:start"], .ev[data-k="repair:done"] { border-left-color: var(--orange); }
.ev[data-k="planner:done"]       { border-left-color: var(--purple); }
.ev[data-k="insight"]            { border-left-color: var(--cyan); }

/* Supervisor card */
.sup-card { border-radius: 6px; background: var(--bg2); border: 1px solid var(--border); overflow: hidden; }
.sup-card[data-act="escalate"] { border-color: var(--orange); }
.sup-card[data-act="pivot"]    { border-color: var(--purple); }
.sup-card[data-act="abort"]    { border-color: var(--red); }
.sup-head { padding: 5px 10px; background: var(--bg3); display: flex; align-items: center; gap: 8px; }
.sup-action { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; }
.sup-card[data-act="escalate"] .sup-action { color: var(--orange); }
.sup-card[data-act="pivot"]    .sup-action { color: var(--purple); }
.sup-card[data-act="abort"]    .sup-action { color: var(--red); }
.sup-ts { font-size: 10px; color: var(--text3); margin-left: auto; }
.sup-reason { padding: 5px 10px; font-size: 11px; color: var(--text2); line-height: 1.5; }

/* Solved banner */
.solved-banner { border-radius: 6px; background: #0a1f12; border: 1px solid var(--green); padding: 12px 16px; text-align: center; }
.solved-title { font-size: 15px; font-weight: 700; color: var(--green); margin-bottom: 4px; }
.solved-msg { font-size: 11px; color: var(--text2); }

/* ── Right panel ─────────────────────────────────────────────────────── */
.right-panel { display: flex; flex-direction: column; overflow: hidden; }
.art-section { flex: 1; min-height: 0; display: flex; flex-direction: column; border-bottom: 1px solid var(--border); }
.inspect-section { height: 230px; flex-shrink: 0; display: flex; flex-direction: column; }

/* Artifact tree */
.art-node { padding: 3px 6px; border-radius: 4px; margin-bottom: 2px; cursor: pointer; border: 1px solid transparent; }
.art-node:hover { background: var(--bg3); border-color: var(--border); }
.art-node.sel { background: var(--bg3); border-color: var(--blue); }
.art-row { display: flex; align-items: center; gap: 4px; }
.art-prefix { font-family: monospace; font-size: 11px; color: var(--text3); white-space: pre; flex-shrink: 0; }
.art-badge { font-size: 9px; padding: 1px 5px; border-radius: 3px; font-weight: 700; flex-shrink: 0; }
.art-badge.active { background: #0d1f33; color: var(--blue);  border: 1px solid #1b3a6b; }
.art-badge.lemma  { background: #0a1f12; color: var(--green); border: 1px solid #1b4026; }
.art-badge.dead   { background: var(--bg3); color: var(--text3); border: 1px solid var(--border); }
.art-type { font-size: 9px; color: var(--text3); }
.art-score { font-size: 9px; margin-left: auto; font-variant-numeric: tabular-nums; }
.art-score.hi { color: var(--green); font-weight: 700; }
.art-score.mid { color: var(--blue); }
.art-score.lo { color: var(--text3); }
.art-snippet { font-size: 10px; color: var(--text3); line-height: 1.4; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; padding-left: 14px; margin-top: 1px; }

/* Inspect panel */
.insp-empty { color: var(--text3); font-size: 11px; padding: 4px 2px; }
.insp-row { margin-bottom: 7px; }
.insp-key { font-size: 9px; text-transform: uppercase; letter-spacing: .5px; color: var(--text3); margin-bottom: 2px; }
.insp-val { font-size: 11px; color: var(--text); line-height: 1.5; }
.insp-val.mono { font-family: monospace; color: var(--text3); }
.insp-code { font-family: 'Consolas', monospace; font-size: 10px; color: var(--cyan); background: var(--bg); padding: 6px 8px; border-radius: 4px; max-height: 90px; overflow-y: auto; white-space: pre-wrap; word-break: break-word; margin-top: 2px; }
.conf-dots { display: flex; gap: 3px; margin-top: 2px; }
.conf-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--bg3); border: 1px solid var(--border); }
.conf-dot.on { background: var(--blue); border-color: var(--blue); }
.conf-dot.on.hi { background: var(--green); border-color: var(--green); }

/* ── Misc ────────────────────────────────────────────────────────────── */
#scroll-btn { position: fixed; bottom: 14px; left: 50%; transform: translateX(-50%); background: var(--bg3); border: 1px solid var(--border); color: var(--text2); font-size: 11px; padding: 5px 14px; border-radius: 12px; cursor: pointer; display: none; z-index: 50; }
#scroll-btn:hover { border-color: var(--blue); color: var(--blue); }
.modal-bg { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.7); z-index: 100; align-items: center; justify-content: center; }
.modal-bg.open { display: flex; }
.modal { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; max-width: 640px; width: 90vw; padding: 20px; max-height: 80vh; overflow-y: auto; }
.modal-title { font-size: 13px; font-weight: 700; color: var(--blue); margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; }
.modal-close { background: none; border: none; color: var(--text2); font-size: 16px; cursor: pointer; }
.modal-text { font-size: 12px; line-height: 1.75; color: var(--text); white-space: pre-wrap; }
</style>
</head>
<body>

<header>
  <span class="logo">⚙ truth-engine</span>
  <div class="problem-pill" id="problem-pill" onclick="openModal()" title="Click for full text">Loading…</div>
  <span class="badge" id="domain-badge">—</span>
  <span class="badge" id="elapsed-badge">0:00</span>
  <span class="badge live" id="conn-badge">connecting…</span>
</header>

<div class="agent-bar">
  <div class="spinner off" id="spinner"></div>
  <span class="agent-label">agent:</span>
  <span class="agent-name" id="agent-name" style="color:var(--text3)">idle</span>
  <span class="badge" id="budget-badge" style="margin-left:auto;display:none"></span>
</div>

<div class="main-grid">

  <!-- LEFT: config + stats + plan -->
  <div class="panel">
    <div class="panel-head">Config &amp; Plan</div>
    <div class="panel-body">
      <div class="section-head">Run Params</div>
      <div class="cfg-grid">
        <div class="cfg-cell"><div class="cfg-lbl">Depth</div><div class="cfg-val" id="cfg-depth">—</div></div>
        <div class="cfg-cell"><div class="cfg-lbl">Branches</div><div class="cfg-val" id="cfg-branches">—</div></div>
        <div class="cfg-cell"><div class="cfg-lbl">Critics</div><div class="cfg-val" id="cfg-critics">—</div></div>
        <div class="cfg-cell"><div class="cfg-lbl">Confidence</div><div class="cfg-val" id="cfg-conf">—</div></div>
      </div>
      <div class="budget-wrap">
        <div class="budget-labels"><span>LLM budget</span><span id="budget-lbl">—</span></div>
        <div class="budget-track"><div class="budget-fill" id="budget-fill" style="width:0%"></div></div>
      </div>

      <div class="section-head">Stats</div>
      <div class="stat-row"><span class="stat-lbl">✓ Survived</span><span class="stat-val g" id="s-surv">0</span></div>
      <div class="stat-row"><span class="stat-lbl">✗ Killed</span><span class="stat-val r" id="s-kill">0</span></div>
      <div class="stat-row"><span class="stat-lbl">🔧 Repairs</span><span class="stat-val o" id="s-rep">0</span></div>
      <div class="stat-row"><span class="stat-lbl">⏱ LLM calls</span><span class="stat-val b" id="s-llm">0</span></div>
      <div class="stat-row"><span class="stat-lbl">⌀ Avg time</span><span class="stat-val b" id="s-avg">—</span></div>

      <div class="section-head" style="margin-top:4px">Step Plan</div>
      <div id="step-list"><span style="color:var(--text3);font-size:11px">Waiting for planner…</span></div>
    </div>
  </div>

  <!-- CENTER: event stream -->
  <div class="panel">
    <div class="panel-head">
      Live Activity
      <span style="color:var(--text3);font-weight:400;text-transform:none;font-size:10px" id="ev-count">0 events</span>
    </div>
    <div class="panel-body" id="center-scroll">
      <div id="event-list"></div>
    </div>
  </div>

  <!-- RIGHT: artifact tree + inspect -->
  <div class="panel right-panel">
    <div class="art-section">
      <div class="panel-head">
        Artifact Tree
        <span style="color:var(--text3);font-weight:400;text-transform:none;font-size:10px" id="art-count">0 nodes</span>
      </div>
      <div class="panel-body" id="art-list"></div>
    </div>
    <div class="inspect-section">
      <div class="panel-head">Inspect</div>
      <div class="panel-body" id="inspect-body">
        <span class="insp-empty">Click an artifact to inspect</span>
      </div>
    </div>
  </div>

</div>

<button id="scroll-btn" onclick="resumeScroll()">▼ Resume scroll</button>

<div class="modal-bg" id="modal" onclick="if(event.target===this)closeModal()">
  <div class="modal">
    <div class="modal-title">
      Problem Description
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-text" id="modal-text">—</div>
  </div>
</div>

<script>
// ── utils ───────────────────────────────────────────────────────────────
const el = id => document.getElementById(id);
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmtMs(ms) {
  if (!ms) return '';
  return ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's';
}
function ts(t) { return new Date(t).toISOString().slice(11, 19); }
function kindColor(k) {
  const m = { 'artifact:survived':'var(--green)', 'artifact:killed':'var(--red)', 'verdict':'var(--yellow)',
    'step:advanced':'var(--purple)', 'planner:done':'var(--purple)', 'repair:start':'var(--orange)',
    'repair:done':'var(--orange)', 'insight':'var(--cyan)', 'artifact:born':'var(--blue)',
    'agent:run':'var(--text3)', 'problem:solved':'var(--green)' };
  return m[k] ?? 'var(--text2)';
}
const ICONS = {
  'artifact:survived':'✓', 'artifact:killed':'✗', 'verdict':'⚖',
  'step:advanced':'▶', 'repair:start':'🔧', 'repair:done':'✓',
  'planner:done':'📋', 'insight':'💡', 'artifact:born':'◎',
  'problem:solved':'★', 'agent:run':'→', 'info':'·'
};
const TYPE_LABEL = {
  'artifact:survived':'survived', 'artifact:killed':'killed', 'verdict':'verdict',
  'step:advanced':'step', 'repair:start':'repair', 'repair:done':'repaired',
  'planner:done':'planner', 'insight':'insight', 'artifact:born':'born',
  'agent:run':'agent', 'problem:solved':'solved', 'info':'info'
};

// ── state ───────────────────────────────────────────────────────────────
let evCount = 0, survived = 0, killed = 0, repairs = 0, llmCalls = 0, llmTotalMs = 0;
let budgetTotal = 0;
let autoScroll = true;
let problemText = '';
const centerScroll = el('center-scroll');
let startTime = Date.now();

// Open LLM call blocks stack (supports up to 2 concurrent calls via semaphore)
const openCallStack = []; // { blockEl, startId }

// ── elapsed timer ───────────────────────────────────────────────────────
setInterval(() => {
  const s = Math.floor((Date.now() - startTime) / 1000);
  el('elapsed-badge').textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}, 1000);

// ── scroll ──────────────────────────────────────────────────────────────
centerScroll.addEventListener('scroll', () => {
  const near = centerScroll.scrollHeight - centerScroll.scrollTop - centerScroll.clientHeight < 60;
  autoScroll = near;
  el('scroll-btn').style.display = autoScroll ? 'none' : 'block';
});
function resumeScroll() {
  autoScroll = true;
  el('scroll-btn').style.display = 'none';
  centerScroll.scrollTop = centerScroll.scrollHeight;
}
function scroll() { if (autoScroll) centerScroll.scrollTop = centerScroll.scrollHeight; }

// ── modal ───────────────────────────────────────────────────────────────
function openModal() { el('modal-text').textContent = problemText || '—'; el('modal').classList.add('open'); }
function closeModal() { el('modal').classList.remove('open'); }

// ── agent banner ────────────────────────────────────────────────────────
function setAgent(name, running) {
  el('agent-name').textContent = name;
  el('agent-name').style.color = running ? 'var(--cyan)' : 'var(--text3)';
  el('spinner').classList.toggle('off', !running);
}

// ── budget ──────────────────────────────────────────────────────────────
function updateBudget() {
  if (!budgetTotal) return;
  const pct = Math.min(100, Math.round(llmCalls / budgetTotal * 100));
  el('budget-fill').style.width = pct + '%';
  el('budget-fill').style.background = pct > 80 ? 'var(--red)' : pct > 55 ? 'var(--orange)' : 'var(--blue)';
  el('budget-lbl').textContent = llmCalls + ' / ' + budgetTotal;
  const bb = el('budget-badge');
  bb.textContent = pct + '% used';
  bb.style.display = '';
  bb.style.borderColor = pct > 80 ? 'var(--red)' : pct > 55 ? 'var(--orange)' : 'var(--border)';
  bb.style.color = pct > 80 ? 'var(--red)' : pct > 55 ? 'var(--orange)' : 'var(--text2)';
}

// ── event handler ────────────────────────────────────────────────────────
function addEvent(e) {
  evCount++;
  el('ev-count').textContent = evCount + ' events';

  if (e.kind === 'artifact:survived') { survived++; el('s-surv').textContent = survived; }
  if (e.kind === 'artifact:killed')   { killed++;   el('s-kill').textContent = killed; }
  if (e.kind === 'repair:start')      { repairs++;  el('s-rep').textContent  = repairs; }
  if (e.kind === 'llm:start') {
    llmCalls++;
    el('s-llm').textContent = llmCalls;
    updateBudget();
    setAgent((e.detail?.role ?? 'llm').toUpperCase(), true);
  }
  if (e.kind === 'llm:end' && e.ms) {
    llmTotalMs += e.ms;
    el('s-avg').textContent = fmtMs(Math.round(llmTotalMs / llmCalls));
  }
  if (e.kind === 'agent:run') setAgent(e.msg, true);
  if (e.kind === 'problem:solved') setAgent('SOLVED ✓', false);

  const list = el('event-list');

  // ── LLM call block grouping ──
  if (e.kind === 'llm:start') {
    const block = buildCallBlock(e);
    openCallStack.push({ blockEl: block, startId: e.id });
    list.appendChild(block);
    scroll();
    return;
  }
  if (e.kind === 'llm:thinking') {
    const top = openCallStack[openCallStack.length - 1];
    if (top) appendThinking(top.blockEl, e);
    scroll();
    return;
  }
  if (e.kind === 'llm:end') {
    const top = openCallStack.pop();
    if (top) finaliseBlock(top.blockEl, e);
    if (openCallStack.length === 0) setAgent('idle', false);
    scroll();
    return;
  }

  // ── Supervisor decisions (emitted as info events) ──
  const supMatch = e.kind === 'info' && e.msg.match(/^supervisor: (escalate|pivot|abort) — (.*)/);
  if (supMatch) {
    list.appendChild(buildSupCard(supMatch[1], supMatch[2], e.ts));
    scroll();
    return;
  }

  // ── Solved banner ──
  if (e.kind === 'problem:solved') {
    list.appendChild(buildSolvedBanner(e));
    scroll();
    return;
  }

  // ── Default row ──
  list.appendChild(buildEvRow(e));
  scroll();
}

// ── call block ──────────────────────────────────────────────────────────
function buildCallBlock(startEv) {
  const role  = startEv.detail?.role  ?? 'llm';
  const model = startEv.detail?.model ?? '';
  const artId = startEv.artifactId;
  const div = document.createElement('div');
  div.className = 'call-block running';
  div.innerHTML = \`
    <div class="call-head">
      <span class="call-role \${esc(role)}">\${esc(role.toUpperCase())}</span>
      \${model ? \`<span class="call-model">\${esc(model.slice(0,28))}</span>\` : ''}
      \${artId  ? \`<span class="call-art">\${esc(artId.slice(0,8))}</span>\` : ''}
      <span class="call-timing" id="ctiming-\${startEv.id}">
        <span class="spinner" style="width:8px;height:8px;border-width:1.5px"></span>
        running…
      </span>
    </div>
    <div id="cbody-\${startEv.id}"></div>
  \`;
  return div;
}

function appendThinking(blockEl, thinkEv) {
  const body = blockEl.querySelector('[id^="cbody-"]');
  if (!body) return;
  const thinking = thinkEv.detail?.thinking ?? thinkEv.msg;
  const words = thinking.split(/\\s+/).length;
  const det = document.createElement('details');
  det.className = 'think-section';
  det.innerHTML = \`
    <summary>💭 Thinking <span style="color:var(--text3);margin-left:4px">\${words} words</span></summary>
    <pre class="think-text">\${esc(thinking)}</pre>
  \`;
  body.appendChild(det);
}

function finaliseBlock(blockEl, endEv) {
  blockEl.classList.remove('running');
  const timingEl = blockEl.querySelector('[id^="ctiming-"]');
  if (timingEl) {
    timingEl.innerHTML = \`\${fmtMs(endEv.ms)} <span class="done-ts">\${ts(endEv.ts)}</span>\`;
  }
}

// ── supervisor card ──────────────────────────────────────────────────────
function buildSupCard(action, reason, t) {
  const icons = { escalate: '⬆ ESCALATE', pivot: '↻ PIVOT', abort: '✕ ABORT' };
  const div = document.createElement('div');
  div.className = 'sup-card';
  div.dataset.act = action;
  div.innerHTML = \`
    <div class="sup-head">
      <span class="sup-action">\${icons[action] ?? action.toUpperCase()}</span>
      <span class="sup-ts">\${ts(t)}</span>
    </div>
    <div class="sup-reason">\${esc(reason)}</div>
  \`;
  return div;
}

// ── solved banner ────────────────────────────────────────────────────────
function buildSolvedBanner(e) {
  const div = document.createElement('div');
  div.className = 'solved-banner';
  div.innerHTML = \`<div class="solved-title">★ PROBLEM SOLVED</div><div class="solved-msg">\${esc(e.msg)}</div>\`;
  return div;
}

// ── generic event row ────────────────────────────────────────────────────
function buildEvRow(e) {
  const div = document.createElement('div');
  div.className = 'ev';
  div.dataset.k = e.kind;

  let scorePill = '';
  if (e.kind === 'verdict') {
    const m = e.msg.match(/score=(\\d+)/);
    const s = m ? Number(m[1]) : 0;
    const bg = s >= 80 ? '#0a1f12' : s >= 60 ? '#1f1a0a' : '#1f0a0a';
    const fg = s >= 80 ? 'var(--green)' : s >= 60 ? 'var(--yellow)' : 'var(--red)';
    scorePill = \`<span class="score-pill" style="background:\${bg};color:\${fg};border:1px solid \${fg}">\${s}</span>\`;
  }

  const detail = e.detail ? JSON.stringify(e.detail, null, 2) : '';
  div.innerHTML = \`
    <span class="ev-icon">\${ICONS[e.kind] ?? '·'}</span>
    <span class="ev-type" style="color:\${kindColor(e.kind)}">\${esc(TYPE_LABEL[e.kind] ?? e.kind)}</span>
    \${scorePill}
    <span class="ev-msg">\${esc(e.msg)}</span>
    <span class="ev-ts">\${ts(e.ts)}</span>
    \${detail ? \`<div class="ev-detail"><pre>\${esc(detail)}</pre></div>\` : ''}
  \`;
  if (detail) div.addEventListener('click', () => div.classList.toggle('open'));
  return div;
}

// ── SSE ──────────────────────────────────────────────────────────────────
function connect() {
  const es = new EventSource('/events');
  es.onopen = () => { el('conn-badge').textContent = 'live'; el('conn-badge').className = 'badge live'; };
  es.onmessage = ev => { try { addEvent(JSON.parse(ev.data)); } catch {} };
  es.onerror = () => {
    el('conn-badge').textContent = 'reconnecting…'; el('conn-badge').className = 'badge';
    es.close(); setTimeout(connect, 2000);
  };
}
connect();

// ── state polling ────────────────────────────────────────────────────────
async function pollState() {
  try {
    const r = await fetch('/api/state');
    if (!r.ok) return;
    const s = await r.json();
    if (s.problem) {
      el('domain-badge').textContent = s.problem.domain ?? '—';
      if (s.problem.description) {
        problemText = s.problem.description;
        el('problem-pill').textContent = problemText.length > 110
          ? problemText.slice(0, 110) + '…' : problemText;
      }
    }
    if (s.runParams) {
      el('cfg-depth').textContent    = s.runParams.maxDepth    ?? '—';
      el('cfg-branches').textContent = s.runParams.maxBranches ?? '—';
      el('cfg-critics').textContent  = s.runParams.criticCount ?? '—';
      el('cfg-conf').textContent     = s.runParams.requiredConfidence ?? '—';
      if (s.runParams.budgetLlmCalls) { budgetTotal = s.runParams.budgetLlmCalls; updateBudget(); }
    }
    if (s.stepPlan) renderStepPlan(s.stepPlan, s.currentStep ?? 0);
  } catch {}
}

function renderStepPlan(plan, current) {
  const list = el('step-list');
  list.innerHTML = '';
  for (const step of plan.steps) {
    const done = step.index < current, cur = step.index === current;
    const d = document.createElement('div');
    d.className = 'step-item' + (cur ? ' cur' : done ? ' done' : '');
    d.innerHTML = \`
      <div class="step-num">\${done ? '✓' : cur ? '▶' : '○'} Step \${step.index}</div>
      <div class="step-goal">\${esc(step.goal)}</div>
      \${step.oracle_hint ? \`<div class="step-oracle">\${esc(step.oracle_hint)}</div>\` : ''}
    \`;
    list.appendChild(d);
  }
  if (plan.rationale) {
    const r = document.createElement('div');
    r.style.cssText = 'font-size:10px;color:var(--text3);padding:8px 4px;font-style:italic;line-height:1.55';
    r.textContent = plan.rationale;
    list.appendChild(r);
  }
}

// ── artifact tree ────────────────────────────────────────────────────────
let artifacts = [];
let selArtId = null;

async function pollArtifacts() {
  try {
    const r = await fetch('/api/artifacts');
    if (!r.ok) return;
    artifacts = await r.json();
    renderTree();
  } catch {}
}

function renderTree() {
  const list = el('art-list');
  el('art-count').textContent = artifacts.length + ' nodes';

  const kids = {};
  const roots = [];
  for (const a of artifacts) {
    if (!a.parentId) roots.push(a);
    else { (kids[a.parentId] ??= []).push(a); }
  }

  list.innerHTML = '';

  function node(a, prefix, isLast) {
    const connector = prefix ? (isLast ? '└─ ' : '├─ ') : '';
    const childPfx  = prefix + (isLast ? '   ' : '│  ');

    const div = document.createElement('div');
    div.className = 'art-node' + (a.id === selArtId ? ' sel' : '');
    div.dataset.id = a.id;

    const st = a.status === 'lemma' ? 'lemma' : a.status === 'active' ? 'active' : 'dead';
    const sc = a.score ?? 0;
    const scClass = sc >= 80 ? 'hi' : sc >= 60 ? 'mid' : 'lo';

    div.innerHTML = \`
      <div class="art-row">
        <span class="art-prefix">\${esc(prefix + connector)}</span>
        <span class="art-badge \${st}">\${st}</span>
        <span class="art-type">\${esc(a.type)}</span>
        \${sc ? \`<span class="art-score \${scClass}">\${sc}</span>\` : ''}
      </div>
      <div class="art-snippet">\${esc((a.hypothesisText ?? a.title ?? '').slice(0, 72))}</div>
    \`;

    div.addEventListener('click', () => { selArtId = a.id; renderTree(); showInspect(a); });
    list.appendChild(div);

    const children = (kids[a.id] ?? []).slice().sort((x, y) => (x.score ?? 0) - (y.score ?? 0));
    children.forEach((c, i) => node(c, childPfx, i === children.length - 1));
  }

  roots.forEach((r, i) => node(r, '', i === roots.length - 1));
}

function showInspect(a) {
  const body = el('inspect-body');
  const dots = Array.from({ length: 4 }, (_, i) =>
    \`<div class="conf-dot \${i < (a.confidenceLevel ?? 0) ? 'on' + (i >= 2 ? ' hi' : '') : ''}"></div>\`
  ).join('');

  body.innerHTML = \`
    <div class="insp-row"><div class="insp-key">ID</div><div class="insp-val mono">\${esc(a.id.slice(0, 16))}…</div></div>
    <div class="insp-row"><div class="insp-key">Type · Status</div><div class="insp-val">\${esc(a.type)} · \${esc(a.status)}\${a.score ? ' · score ' + a.score : ''}</div></div>
    <div class="insp-row"><div class="insp-key">Confidence</div><div class="conf-dots">\${dots}</div></div>
    \${a.hypothesisText ? \`
    <div class="insp-row">
      <div class="insp-key">Hypothesis</div>
      <div class="insp-val">\${esc(a.hypothesisText.slice(0, 260))}\${a.hypothesisText.length > 260 ? '…' : ''}</div>
    </div>\` : ''}
    \${a.sourceCode ? \`
    <div class="insp-row">
      <div class="insp-key">Source</div>
      <div class="insp-code">\${esc(a.sourceCode.slice(0, 600))}</div>
    </div>\` : ''}
  \`;
}

// ── kick off polling ─────────────────────────────────────────────────────
pollState();
pollArtifacts();
setInterval(pollState, 5000);
setInterval(pollArtifacts, 3000);
</script>
</body>
</html>`;

export function startUiServer(): void {
  const server = Bun.serve({
    port: PORT,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/") {
        return new Response(DASHBOARD_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      if (url.pathname === "/events") {
        let unsub: (() => void) | null = null;
        const stream = new ReadableStream({
          start(ctrl) {
            const enc = new TextEncoder();
            for (const e of history.slice(-300)) {
              ctrl.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
            }
            unsub = subscribe((e: UIEvent) => {
              try { ctrl.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)); } catch { unsub?.(); }
            });
          },
          cancel() { unsub?.(); },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
          },
        });
      }

      if (url.pathname === "/api/state")     return handleState();
      if (url.pathname === "/api/artifacts") return handleArtifacts();

      return new Response("Not found", { status: 404 });
    },
  });

  console.log(`[ui] Dashboard → http://localhost:${server.port}`);
}

async function handleState(): Promise<Response> {
  try {
    const problem = await db
      .selectFrom("problems")
      .selectAll()
      .orderBy("createdAt" as any, "desc")
      .limit(1)
      .executeTakeFirst();

    if (!problem) return Response.json({ problem: null });

    const stepPlan = (problem as any).stepPlan
      ? JSON.parse((problem as any).stepPlan)
      : null;

    return Response.json({
      problem: {
        id: problem.id,
        domain: problem.domain,
        status: problem.status,
        description: problem.description,
      },
      stepPlan,
      currentStep: (problem as any).currentStep ?? 0,
      runParams: runParamsState,
    });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}

async function handleArtifacts(): Promise<Response> {
  try {
    const problem = await db
      .selectFrom("problems")
      .select("id")
      .orderBy("createdAt" as any, "desc")
      .limit(1)
      .executeTakeFirst();

    if (!problem) return Response.json([]);

    const rows = await db
      .selectFrom("artifacts")
      .select([
        "id", "type", "status", "score", "depth", "parentId",
        "hypothesisText", "title", "sourceCode", "confidenceLevel",
      ])
      .where("problemId", "=", problem.id)
      .where("type", "!=", "failure_report")
      .orderBy("createdAt" as any, "asc")
      .limit(200)
      .execute();

    return Response.json(rows);
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
