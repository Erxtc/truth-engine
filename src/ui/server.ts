import { subscribe, history, type UIEvent } from "./events";
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
    --bg: #0d1117; --bg2: #161b22; --bg3: #21262d;
    --border: #30363d; --text: #e6edf3; --text2: #8b949e;
    --green: #3fb950; --red: #f85149; --yellow: #d29922;
    --blue: #58a6ff; --purple: #bc8cff; --orange: #ffa657;
    --cyan: #39d353;
    font-size: 13px;
  }
  body { background: var(--bg); color: var(--text); font-family: 'Segoe UI', system-ui, monospace; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
  header { display: flex; align-items: center; gap: 12px; padding: 8px 16px; border-bottom: 1px solid var(--border); background: var(--bg2); flex-shrink: 0; }
  header h1 { font-size: 14px; font-weight: 600; letter-spacing: .5px; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 10px; background: var(--bg3); border: 1px solid var(--border); color: var(--text2); }
  .badge.live { border-color: var(--green); color: var(--green); animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.5} }
  .cols { display: grid; grid-template-columns: 280px 1fr 300px; gap: 0; flex: 1; min-height: 0; }
  .panel { display: flex; flex-direction: column; border-right: 1px solid var(--border); min-height: 0; }
  .panel:last-child { border-right: none; }
  .panel-header { padding: 8px 12px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .8px; color: var(--text2); border-bottom: 1px solid var(--border); flex-shrink: 0; display: flex; align-items: center; gap: 8px; }
  .panel-body { flex: 1; overflow-y: auto; padding: 8px; }
  .panel-body::-webkit-scrollbar { width: 4px; } .panel-body::-webkit-scrollbar-track { background: var(--bg); } .panel-body::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

  /* Left panel — step plan */
  .step-item { padding: 8px 10px; border-radius: 6px; margin-bottom: 6px; border: 1px solid var(--border); background: var(--bg2); }
  .step-item.current { border-color: var(--blue); background: #0d1f33; }
  .step-item.done { border-color: var(--green); background: #0c1f15; opacity: .8; }
  .step-index { font-size: 10px; color: var(--text2); margin-bottom: 2px; }
  .step-goal { font-size: 12px; font-weight: 500; line-height: 1.4; }
  .step-oracle { font-size: 10px; color: var(--purple); margin-top: 3px; }
  .stat-row { display: flex; justify-content: space-between; align-items: center; padding: 5px 10px; border-radius: 4px; margin-bottom: 3px; }
  .stat-label { color: var(--text2); font-size: 11px; }
  .stat-value { font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .stat-value.green { color: var(--green); } .stat-value.red { color: var(--red); } .stat-value.blue { color: var(--blue); } .stat-value.orange { color: var(--orange); }
  .section-title { font-size: 10px; text-transform: uppercase; letter-spacing: .6px; color: var(--text2); padding: 10px 10px 4px; }

  /* Center panel — event stream */
  #event-list { display: flex; flex-direction: column; gap: 2px; }
  .ev { border-radius: 4px; border-left: 3px solid var(--border); padding: 5px 8px; background: var(--bg2); cursor: pointer; transition: background .1s; }
  .ev:hover { background: var(--bg3); }
  .ev-header { display: flex; align-items: center; gap: 8px; }
  .ev-kind { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; width: 110px; flex-shrink: 0; }
  .ev-msg { font-size: 12px; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ev-meta { font-size: 10px; color: var(--text2); flex-shrink: 0; }
  .ev-detail { display: none; margin-top: 6px; font-size: 11px; color: var(--text2); background: var(--bg); border-radius: 4px; padding: 8px; font-family: monospace; white-space: pre-wrap; word-break: break-word; max-height: 300px; overflow-y: auto; }
  .ev.open .ev-detail { display: block; }
  .ev[data-kind="llm:start"] { border-color: var(--blue); }
  .ev[data-kind="llm:end"] { border-color: var(--cyan); }
  .ev[data-kind="artifact:survived"] { border-color: var(--green); }
  .ev[data-kind="artifact:killed"] { border-color: var(--red); }
  .ev[data-kind="step:advanced"] { border-color: var(--purple); }
  .ev[data-kind="repair:start"], .ev[data-kind="repair:done"] { border-color: var(--orange); }
  .ev[data-kind="verdict"] { border-color: var(--yellow); }
  .ev[data-kind="planner:done"] { border-color: var(--purple); }
  .kind-llm\\:start, .kind-llm\\:end { color: var(--blue); }
  .kind-artifact\\:survived { color: var(--green); }
  .kind-artifact\\:killed { color: var(--red); }
  .kind-step\\:advanced, .kind-planner\\:done { color: var(--purple); }
  .kind-repair\\:start, .kind-repair\\:done { color: var(--orange); }
  .kind-verdict { color: var(--yellow); }
  .kind-agent\\:run { color: var(--text2); }
  .kind-info { color: var(--text2); }
  .kind-insight { color: var(--cyan); }

  /* Right panel — artifact tree */
  .art { padding: 5px 8px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg2); margin-bottom: 4px; font-size: 11px; }
  .art-id { font-size: 9px; color: var(--text2); font-family: monospace; }
  .art-text { margin-top: 2px; line-height: 1.4; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .art-score { font-size: 10px; color: var(--blue); margin-top: 2px; }
  .art[data-status="active"] { border-color: var(--blue); }
  .art[data-status="lemma"] { border-color: var(--green); }
  .art[data-status="dead"] { border-color: var(--border); opacity: .5; }
  .depth-indent { display: inline-block; }

  #scroll-pause { position: fixed; bottom: 12px; right: 12px; background: var(--bg3); border: 1px solid var(--border); color: var(--text2); font-size: 11px; padding: 4px 10px; border-radius: 4px; cursor: pointer; display: none; }
</style>
</head>
<body>
<header>
  <h1>⚙ truth-engine</h1>
  <span class="badge live" id="conn-badge">connecting…</span>
  <span class="badge" id="problem-badge">no problem</span>
  <span class="badge" id="domain-badge"></span>
  <span style="flex:1"></span>
  <span class="badge" id="event-count">0 events</span>
</header>
<div class="cols">

  <!-- LEFT: step plan + stats -->
  <div class="panel">
    <div class="panel-header">Plan &amp; Stats</div>
    <div class="panel-body" id="left-panel">
      <div class="section-title">Stats</div>
      <div class="stat-row"><span class="stat-label">Survived</span><span class="stat-value green" id="s-survived">0</span></div>
      <div class="stat-row"><span class="stat-label">Killed</span><span class="stat-value red" id="s-killed">0</span></div>
      <div class="stat-row"><span class="stat-label">Repairs</span><span class="stat-value orange" id="s-repairs">0</span></div>
      <div class="stat-row"><span class="stat-label">LLM calls</span><span class="stat-value blue" id="s-llm">0</span></div>
      <div class="stat-row"><span class="stat-label">Avg LLM ms</span><span class="stat-value blue" id="s-llm-avg">—</span></div>
      <div class="section-title" style="margin-top:8px">Step Plan</div>
      <div id="step-list"><span style="color:var(--text2);font-size:11px">Loading…</span></div>
    </div>
  </div>

  <!-- CENTER: live event stream -->
  <div class="panel">
    <div class="panel-header">
      Events
      <span style="color:var(--text2);font-weight:400;font-size:10px;text-transform:none" id="center-hint">click row to expand</span>
    </div>
    <div class="panel-body" id="center-scroll">
      <div id="event-list"></div>
    </div>
  </div>

  <!-- RIGHT: artifact tree -->
  <div class="panel">
    <div class="panel-header">Artifacts <span style="color:var(--text2);font-weight:400;font-size:10px;text-transform:none" id="art-count"></span></div>
    <div class="panel-body" id="art-list"></div>
  </div>

</div>
<button id="scroll-pause" onclick="resumeScroll()">▼ Resume scroll</button>

<script>
const el = id => document.getElementById(id);
let evCount = 0, survived = 0, killed = 0, repairs = 0, llmCalls = 0, llmTotalMs = 0;
let autoScroll = true;
const centerScroll = el('center-scroll');

centerScroll.addEventListener('scroll', () => {
  const nearBottom = centerScroll.scrollHeight - centerScroll.scrollTop - centerScroll.clientHeight < 60;
  autoScroll = nearBottom;
  el('scroll-pause').style.display = autoScroll ? 'none' : 'block';
});
function resumeScroll() { autoScroll = true; el('scroll-pause').style.display = 'none'; centerScroll.scrollTop = centerScroll.scrollHeight; }

function kindColor(k) {
  if (k === 'llm:start' || k === 'llm:end') return 'var(--blue)';
  if (k === 'artifact:survived') return 'var(--green)';
  if (k === 'artifact:killed') return 'var(--red)';
  if (k === 'step:advanced' || k === 'planner:done') return 'var(--purple)';
  if (k === 'repair:start' || k === 'repair:done') return 'var(--orange)';
  if (k === 'verdict') return 'var(--yellow)';
  if (k === 'insight') return 'var(--cyan)';
  return 'var(--text2)';
}

function fmtMs(ms) {
  if (!ms) return '';
  if (ms < 1000) return ms + 'ms';
  return (ms / 1000).toFixed(1) + 's';
}

function addEvent(e) {
  evCount++;
  el('event-count').textContent = evCount + ' events';
  if (e.kind === 'artifact:survived') survived++, el('s-survived').textContent = survived;
  if (e.kind === 'artifact:killed') killed++, el('s-killed').textContent = killed;
  if (e.kind === 'repair:start') repairs++, el('s-repairs').textContent = repairs;
  if (e.kind === 'llm:start') llmCalls++, el('s-llm').textContent = llmCalls;
  if (e.kind === 'llm:end' && e.ms) {
    llmTotalMs += e.ms;
    el('s-llm-avg').textContent = fmtMs(Math.round(llmTotalMs / llmCalls));
  }

  const div = document.createElement('div');
  div.className = 'ev';
  div.dataset.kind = e.kind;
  const ts = new Date(e.ts).toISOString().slice(11, 23);
  const detail = e.detail ? JSON.stringify(e.detail, null, 2) : '';
  div.innerHTML = \`
    <div class="ev-header">
      <span class="ev-kind" style="color:\${kindColor(e.kind)}">\${e.kind}</span>
      <span class="ev-msg">\${escHtml(e.msg)}</span>
      <span class="ev-meta">\${e.ms ? fmtMs(e.ms) + ' · ' : ''}\${ts}</span>
    </div>
    \${detail ? \`<div class="ev-detail">\${escHtml(detail)}</div>\` : ''}
  \`;
  div.addEventListener('click', () => div.classList.toggle('open'));

  el('event-list').appendChild(div);
  if (autoScroll) centerScroll.scrollTop = centerScroll.scrollHeight;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// SSE connection
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

// State polling (step plan + problem badge)
async function pollState() {
  try {
    const r = await fetch('/api/state');
    if (!r.ok) return;
    const s = await r.json();
    if (s.problem) {
      el('problem-badge').textContent = s.problem.id.slice(0,8);
      el('domain-badge').textContent = s.problem.domain;
    }
    if (s.stepPlan) renderStepPlan(s.stepPlan, s.currentStep ?? 0);
  } catch {}
}

function renderStepPlan(plan, current) {
  const list = el('step-list');
  list.innerHTML = '';
  for (const step of plan.steps) {
    const d = document.createElement('div');
    const done = step.index < current;
    const cur = step.index === current;
    d.className = 'step-item' + (cur ? ' current' : done ? ' done' : '');
    d.innerHTML = \`
      <div class="step-index">\${done ? '✓' : cur ? '▶' : '○'} Step \${step.index}</div>
      <div class="step-goal">\${escHtml(step.goal)}</div>
      <div class="step-oracle">\${step.oracle_hint}</div>
    \`;
    list.appendChild(d);
  }
  if (plan.rationale) {
    const r = document.createElement('div');
    r.style.cssText = 'font-size:10px;color:var(--text2);padding:8px 10px;font-style:italic;line-height:1.5';
    r.textContent = plan.rationale;
    list.appendChild(r);
  }
}

// Artifact polling
async function pollArtifacts() {
  try {
    const r = await fetch('/api/artifacts');
    if (!r.ok) return;
    const arts = await r.json();
    const list = el('art-list');
    el('art-count').textContent = arts.length + ' total';
    list.innerHTML = '';
    for (const a of arts) {
      const d = document.createElement('div');
      d.className = 'art';
      d.dataset.status = a.status;
      const indent = '  '.repeat(Math.min(a.depth ?? 0, 6));
      d.innerHTML = \`
        <div class="art-id">\${indent}\${a.id.slice(0,8)} · \${a.type}</div>
        <div class="art-text">\${escHtml(a.hypothesisText ?? a.title ?? '—')}</div>
        \${a.score ? \`<div class="art-score">score \${a.score}</div>\` : ''}
      \`;
      list.appendChild(d);
    }
  } catch {}
}

pollState(); pollArtifacts();
setInterval(pollState, 4000);
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
            // Send history so reconnects catch up
            const enc = new TextEncoder();
            for (const e of history.slice(-200)) {
              ctrl.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
            }
            unsub = subscribe((e: UIEvent) => {
              try {
                ctrl.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
              } catch {
                unsub?.();
              }
            });
          },
          cancel() {
            unsub?.();
          },
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

      if (url.pathname === "/api/state") {
        return handleState();
      }

      if (url.pathname === "/api/artifacts") {
        return handleArtifacts(url);
      }

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

    if (!problem) {
      return Response.json({ problem: null });
    }

    const stepPlan = (problem as any).stepPlan
      ? JSON.parse((problem as any).stepPlan)
      : null;

    return Response.json({
      problem: { id: problem.id, domain: problem.domain, status: problem.status },
      stepPlan,
      currentStep: (problem as any).currentStep ?? 0,
    });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}

async function handleArtifacts(url: URL): Promise<Response> {
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
      .select(["id", "type", "status", "score", "depth", "parentId", "hypothesisText", "title"])
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
