/**
 * Agent Dashboard Server — manage develop-session agents via a web UI.
 *
 * Usage:  bun run src/ui/agent-server.ts
 *         Then open http://localhost:3100
 *
 * Features:
 *   - Lists all agents (develop sessions + pipeline runs)
 *   - Spawn new agents with prompts from prompts.json
 *   - Live status via polling (3s auto-refresh)
 *   - View agent logs inline
 */

import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join, basename } from "path";
import { spawn } from "child_process";
import type { Server } from "bun";

const PORT = parseInt(process.env.PORT || "3100");
const ROOT = import.meta.dir.replace("/src/ui", "");
const LOGDIR = join(ROOT, "logs");
const DEV_LOGDIR = join(ROOT, "logs", "develop");
const PROMPTS_FILE = join(ROOT, "prompts.json");
const SCRIPTS_DIR = join(ROOT, "scripts");

// ── Types ──────────────────────────────────────────────────────────────────

interface Agent {
  id: string;
  type: "develop" | "pipeline";
  name: string;
  status: "running" | "completed" | "failed" | "crashed";
  startedAt: string;
  durationSec: number | null;
  calls: number | null;
  tokens: number | null;
  prompt?: string;
  sessionId?: string;
  logFile: string;
  logSize: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function loadPrompts(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(PROMPTS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function parseMeta(metaPath: string): Partial<Agent> | null {
  try {
    const m = JSON.parse(readFileSync(metaPath, "utf-8"));
    return {
      calls: m.calls ?? null,
      tokens: m.totalTokens ?? null,
      durationSec: m.durationSeconds ?? null,
      status: m.result === "PASS" ? "completed" : "failed",
    };
  } catch {
    return null;
  }
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m ago`;
}

// ── Agent discovery ────────────────────────────────────────────────────────

function scanDevelopAgents(): Agent[] {
  const agents: Agent[] = [];
  if (!existsSync(DEV_LOGDIR)) return agents;

  for (const f of readdirSync(DEV_LOGDIR)) {
    if (!f.endsWith(".log")) continue;
    const logPath = join(DEV_LOGDIR, f);
    const donePath = logPath.replace(".log", ".done");
    const stat = statSync(logPath);
    const name = f.replace(/^\d{8}-\d{6}-/, "").replace(".log", "");

    let status: Agent["status"] = "running";
    let durationSec: number | null = null;
    if (existsSync(donePath)) {
      const done = readFileSync(donePath, "utf-8");
      const exitMatch = done.match(/EXIT:(\d+)/);
      const elapsedMatch = done.match(/ELAPSED:(\d+)s/);
      status = exitMatch && exitMatch[1] === "0" ? "completed" : "failed";
      durationSec = elapsedMatch ? parseInt(elapsedMatch[1]) : null;
    } else {
      // Check if still running by looking at modification time
      const ageSec = (Date.now() - stat.mtimeMs) / 1000;
      if (ageSec > 300) status = "crashed"; // No update in 5 min = crashed
    }

    // Try to extract prompt from first lines of log
    let prompt: string | undefined;
    try {
      const head = readFileSync(logPath, "utf-8").slice(0, 2000);
      const taskMatch = head.match(/→ Task: (.+)/);
      if (taskMatch) prompt = taskMatch[1].slice(0, 200);
    } catch {}

    // Try to extract session ID
    let sessionId: string | undefined;
    try {
      const head = readFileSync(logPath, "utf-8").slice(0, 500);
      const sessMatch = head.match(/→ Session: ([a-f0-9-]+)/);
      if (sessMatch) sessionId = sessMatch[1];
    } catch {}

    agents.push({
      id: f.replace(".log", ""),
      type: "develop",
      name,
      status,
      startedAt: stat.birthtime.toISOString(),
      durationSec,
      calls: null,
      tokens: null,
      prompt,
      sessionId,
      logFile: logPath,
      logSize: stat.size,
    });
  }

  // Sort by start time, newest first
  agents.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return agents;
}

function scanPipelineAgents(): Agent[] {
  const agents: Agent[] = [];
  if (!existsSync(LOGDIR)) return agents;

  for (const f of readdirSync(LOGDIR)) {
    if (!f.endsWith(".log") || f.includes("develop/")) continue;
    const logPath = join(LOGDIR, f);
    const metaPath = logPath.replace(".log", ".meta.json");
    const stat = statSync(logPath);

    // Parse log header for problem description
    let prompt: string | undefined;
    try {
      const head = readFileSync(logPath, "utf-8").slice(0, 1000);
      const lines = head.split("\n");
      // Pipeline logs have "PROBLEM: ..." or domain info
      for (const line of lines.slice(0, 20)) {
        if (line.includes("PROBLEM:") || line.includes("Domain:")) {
          prompt = line.trim().slice(0, 200);
          break;
        }
      }
      if (!prompt && lines.length > 3) prompt = lines[3]?.slice(0, 200);
    } catch {}

    const meta = parseMeta(metaPath);
    const name = f.replace(/^truth-engine-/, "").replace(/\.log$/, "");

    agents.push({
      id: f.replace(".log", ""),
      type: "pipeline",
      name,
      status: meta?.status ?? "completed",
      startedAt: stat.birthtime.toISOString(),
      durationSec: meta?.durationSec ?? null,
      calls: meta?.calls ?? null,
      tokens: meta?.tokens ?? null,
      prompt,
      logFile: logPath,
      logSize: stat.size,
    });
  }

  agents.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return agents.slice(0, 30); // Most recent 30
}

function getAllAgents(): Agent[] {
  const dev = scanDevelopAgents();
  const pipe = scanPipelineAgents();
  // Combine, sort by time, limit to 50
  return [...dev, ...pipe].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 50);
}

function getSessionState() {
  const stateFile = join(DEV_LOGDIR, "last-session-state.txt");
  const statusFile = join(DEV_LOGDIR, "last-session-status.txt");
  let sessionId: string | null = null;
  let sessionStatus: string | null = null;
  try { sessionId = readFileSync(stateFile, "utf-8").trim(); } catch {}
  try { sessionStatus = readFileSync(statusFile, "utf-8").trim(); } catch {}
  return { sessionId, sessionStatus };
}

// ── Spawn agent ────────────────────────────────────────────────────────────

function spawnAgent(prompt: string, background: boolean = true): { ok: boolean; msg: string } {
  const script = join(SCRIPTS_DIR, "develop.sh");
  if (!existsSync(script)) {
    return { ok: false, msg: `Script not found: ${script}` };
  }

  try {
    const args = [script];
    if (background) args.push("--bg");
    args.push(prompt);

    const proc = spawn("bash", args, {
      cwd: ROOT,
      detached: true,
      stdio: "ignore",
    });
    proc.unref();
    return { ok: true, msg: `Spawned agent with prompt: "${prompt.slice(0, 80)}..."` };
  } catch (err: any) {
    return { ok: false, msg: `Failed to spawn: ${err.message}` };
  }
}

// ── Server ─────────────────────────────────────────────────────────────────

function json(res: Response, data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}

function html(res: Response, body: string) {
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // ── API routes ──────────────────────────────────────────────────────

    if (path === "/api/agents") {
      return json(null as any, getAllAgents());
    }

    if (path === "/api/prompts") {
      return json(null as any, loadPrompts());
    }

    if (path === "/api/state") {
      return json(null as any, getSessionState());
    }

    if (path === "/api/spawn" && req.method === "POST") {
      let body: any;
      try { body = await req.json(); } catch { body = {}; }
      const prompt = body.prompt || body.name || "";
      if (!prompt) return json(null as any, { ok: false, msg: "Missing prompt" }, 400);
      const bg = body.bg !== false;
      const result = spawnAgent(prompt, bg);
      return json(null as any, result, result.ok ? 200 : 500);
    }

    if (path === "/api/agent-log") {
      const logPath = url.searchParams.get("path");
      if (!logPath) return json(null as any, { error: "Missing path" }, 400);
      const lines = url.searchParams.get("lines") || "100";
      try {
        const content = readFileSync(logPath, "utf-8");
        const allLines = content.split("\n");
        const tail = allLines.slice(-parseInt(lines)).join("\n");
        return new Response(tail, {
          headers: { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*" },
        });
      } catch {
        return json(null as any, { error: "File not found" }, 404);
      }
    }

    // ── Dashboard HTML ──────────────────────────────────────────────────
    if (path === "/" || path === "/index.html") {
      return html(null as any, DASHBOARD_HTML);
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`\n  Agent Dashboard → http://localhost:${PORT}\n`);

// ── Dashboard HTML (inline — no build step needed) ─────────────────────────

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Agent Dashboard — truth-engine</title>
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --elevated: #1c2129;
    --border: #30363d; --text: #e6edf3; --text2: #8b949e; --text3: #6e7681;
    --accent: #58a6ff; --success: #3fb950; --warning: #d29922; --error: #f85149;
    --purple: #a371f7; --radius: 8px; --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--font); background: var(--bg); color: var(--text); line-height: 1.5; }
  .app { max-width: 1200px; margin: 0 auto; padding: 20px; }

  /* Header */
  .header { display: flex; align-items: center; justify-content: space-between; padding: 16px 0; border-bottom: 1px solid var(--border); margin-bottom: 20px; }
  .header h1 { font-size: 20px; font-weight: 700; }
  .header h1 span { color: var(--accent); }
  .header-stats { display: flex; gap: 16px; font-size: 13px; color: var(--text2); }
  .header-stats strong { color: var(--text); }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; }
  .dot.running { background: var(--success); animation: pulse 1.5s infinite; }
  .dot.failed  { background: var(--error); }
  .dot.done    { background: var(--text3); }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }

  /* Grid */
  .grid { display: grid; grid-template-columns: 1fr 340px; gap: 20px; }
  @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }

  /* Agent cards */
  .agent-list { display: flex; flex-direction: column; gap: 10px; }
  .agent-card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 14px 16px;
    transition: border-color .15s;
  }
  .agent-card:hover { border-color: var(--accent); }
  .agent-card.running { border-left: 3px solid var(--success); }
  .agent-card.failed  { border-left: 3px solid var(--error); }
  .agent-card.crashed { border-left: 3px solid var(--warning); }
  .agent-card.completed { border-left: 3px solid var(--text3); }
  .card-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
  .card-name { font-weight: 600; font-size: 14px; }
  .card-type {
    font-size: 10px; font-weight: 600; text-transform: uppercase;
    padding: 2px 8px; border-radius: 12px; letter-spacing: .4px;
  }
  .card-type.develop { background: rgba(88,166,255,.15); color: var(--accent); }
  .card-type.pipeline { background: rgba(163,113,247,.15); color: var(--purple); }
  .card-status {
    font-size: 10px; font-weight: 600; text-transform: uppercase;
    padding: 3px 10px; border-radius: 12px;
  }
  .card-status.running   { background: rgba(63,185,80,.15); color: var(--success); }
  .card-status.completed { background: rgba(139,148,158,.15); color: var(--text2); }
  .card-status.failed    { background: rgba(248,81,73,.15); color: var(--error); }
  .card-status.crashed   { background: rgba(210,153,34,.15); color: var(--warning); }
  .card-meta { font-size: 11px; color: var(--text2); margin-top: 4px; display: flex; gap: 12px; flex-wrap: wrap; }
  .card-prompt { font-size: 11px; color: var(--text3); margin-top: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 500px; }
  .card-actions { margin-top: 8px; display: flex; gap: 8px; }
  .card-actions button {
    font-size: 10px; padding: 4px 12px; border-radius: 4px; border: 1px solid var(--border);
    background: var(--elevated); color: var(--text2); cursor: pointer; font-family: var(--font);
    transition: all .15s;
  }
  .card-actions button:hover { border-color: var(--accent); color: var(--accent); }

  /* Log viewer modal */
  .log-viewer {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 10px;
    margin-top: 8px; display: none;
  }
  .log-viewer.open { display: block; }
  .log-viewer pre {
    font-size: 11px; font-family: 'SF Mono', 'Cascadia Code', monospace;
    max-height: 300px; overflow-y: auto; white-space: pre-wrap;
    color: var(--text2); background: var(--bg); padding: 10px; border-radius: 4px;
  }

  /* Sidebar */
  .sidebar { display: flex; flex-direction: column; gap: 16px; }
  .panel {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 16px;
  }
  .panel h3 { font-size: 13px; font-weight: 600; margin-bottom: 12px; color: var(--text); }
  .prompt-btn {
    display: block; width: 100%; text-align: left; padding: 8px 12px;
    background: var(--elevated); border: 1px solid var(--border);
    border-radius: 6px; color: var(--text2); font-size: 12px; cursor: pointer;
    font-family: var(--font); margin-bottom: 6px; transition: all .15s;
  }
  .prompt-btn:hover { border-color: var(--accent); color: var(--text); }
  .prompt-btn .desc { font-size: 10px; color: var(--text3); display: block; margin-top: 2px; }
  .custom-input {
    width: 100%; padding: 8px 10px; background: var(--bg); border: 1px solid var(--border);
    border-radius: 6px; color: var(--text); font-size: 12px; font-family: var(--font);
    margin-bottom: 8px; resize: vertical;
  }
  .spawn-btn {
    width: 100%; padding: 10px; background: var(--accent); color: #fff;
    border: none; border-radius: 6px; font-size: 13px; font-weight: 600;
    cursor: pointer; font-family: var(--font); transition: opacity .15s;
  }
  .spawn-btn:hover { opacity: .85; }
  .spawn-btn:disabled { opacity: .4; cursor: not-allowed; }

  /* Stats */
  .stat-row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 12px; }
  .stat-label { color: var(--text2); }
  .stat-value { font-weight: 600; }
  .stat-value.good { color: var(--success); }
  .refresh-bar { font-size: 10px; color: var(--text3); text-align: center; margin-top: 8px; }

  .empty { text-align: center; padding: 40px; color: var(--text3); font-size: 13px; }
</style>
</head>
<body>
<div class="app">
  <div class="header">
    <div>
      <h1>truth-engine <span>agents</span></h1>
    </div>
    <div class="header-stats" id="headerStats"></div>
  </div>

  <div class="grid">
    <div class="agent-list" id="agentList">
      <div class="empty">Loading agents…</div>
    </div>

    <div class="sidebar">
      <div class="panel">
        <h3>Spawn Agent</h3>
        <div id="promptList"></div>
        <textarea class="custom-input" id="customPrompt" placeholder="Or type a custom prompt…" rows="2"></textarea>
        <button class="spawn-btn" id="spawnBtn" onclick="spawnAgent()">Spawn Agent</button>
        <div id="spawnStatus" style="font-size:11px;margin-top:6px;color:var(--text2)"></div>
      </div>

      <div class="panel">
        <h3>Stats</h3>
        <div id="statsPanel"></div>
        <div class="refresh-bar">Auto-refresh every 3s · <span id="lastRefresh">just now</span></div>
      </div>
    </div>
  </div>
</div>

<script>
const API = '';
let agents = [];

async function fetchJSON(url) {
  const r = await fetch(url);
  return r.json();
}

function statusIcon(s) {
  if (s === 'running') return '<span class="dot running"></span>';
  if (s === 'failed' || s === 'crashed') return '<span class="dot failed"></span>';
  return '<span class="dot done"></span>';
}

function renderPromptButtons(prompts) {
  const el = document.getElementById('promptList');
  const keys = Object.keys(prompts);
  el.innerHTML = keys.map(k =>
    \`<button class="prompt-btn" onclick="spawnNamed('\${k}')">
      <strong>\${k}</strong>
      <span class="desc">\${prompts[k].slice(0, 100)}…</span>
    </button>\`
  ).join('');
}

function renderAgent(agent) {
  const typeLabel = agent.type === 'develop' ? 'dev agent' : 'pipeline';
  const meta = [];
  if (agent.calls !== null) meta.push(\`\${agent.calls} calls\`);
  if (agent.tokens !== null) meta.push(\`\${(agent.tokens/1000).toFixed(1)}k tokens\`);
  if (agent.durationSec !== null) meta.push(\`\${agent.durationSec}s\`);
  const ago = timeAgo(agent.startedAt);
  meta.push(\`started \${ago}\`);

  return \`
    <div class="agent-card \${agent.status}" id="card-\${agent.id}">
      <div class="card-top">
        <span class="card-name">\${statusIcon(agent.status)} \${esc(agent.name)}</span>
        <div style="display:flex;gap:6px;align-items:center">
          <span class="card-type \${agent.type}">\${typeLabel}</span>
          <span class="card-status \${agent.status}">\${agent.status}</span>
        </div>
      </div>
      \${agent.prompt ? \`<div class="card-prompt" title="\${esc(agent.prompt)}">\${esc(agent.prompt)}</div>\` : ''}
      <div class="card-meta">\${meta.join(' · ')}</div>
      <div class="card-actions">
        <button onclick="toggleLog('\${agent.id}', '\${esc(agent.logFile)}')">View Log</button>
        \${agent.sessionId ? \`<span style="font-size:10px;color:var(--text3);align-self:center">session: \${agent.sessionId.slice(0,8)}…</span>\` : ''}
      </div>
      <div class="log-viewer" id="log-\${agent.id}">
        <pre id="log-content-\${agent.id}">Loading…</pre>
      </div>
    </div>
  \`;
}

function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return sec + 's ago';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + 'm ago';
  const hr = Math.floor(min / 60);
  return hr + 'h ' + (min % 60) + 'm ago';
}

async function loadAgents() {
  try {
    agents = await fetchJSON(API + '/api/agents');
    render();
  } catch(e) { console.error(e); }
}

async function loadPrompts() {
  try {
    const prompts = await fetchJSON(API + '/api/prompts');
    renderPromptButtons(prompts);
  } catch(e) {}
}

function render() {
  // Agent list
  const el = document.getElementById('agentList');
  if (agents.length === 0) {
    el.innerHTML = '<div class="empty">No agents yet. Spawn one →</div>';
  } else {
    el.innerHTML = agents.map(renderAgent).join('');
  }

  // Stats
  const running = agents.filter(a => a.status === 'running').length;
  const completed = agents.filter(a => a.status === 'completed').length;
  const failed = agents.filter(a => a.status === 'failed' || a.status === 'crashed').length;
  const develop = agents.filter(a => a.type === 'develop').length;
  const pipeline = agents.filter(a => a.type === 'pipeline').length;

  document.getElementById('headerStats').innerHTML =
    \`<span><span class="dot running"></span> <strong>\${running}</strong> running</span>
     <span><span class="dot failed"></span> <strong>\${failed}</strong> failed</span>
     <span><span class="dot done"></span> <strong>\${completed}</strong> done</span>
     <span style="color:var(--text3)">| \${develop} dev · \${pipeline} pipeline</span>\`;

  document.getElementById('statsPanel').innerHTML =
    \`<div class="stat-row"><span class="stat-label">Total agents</span><span class="stat-value">\${agents.length}</span></div>
     <div class="stat-row"><span class="stat-label">Running</span><span class="stat-value good">\${running}</span></div>
     <div class="stat-row"><span class="stat-label">Completed</span><span class="stat-value">\${completed}</span></div>
     <div class="stat-row"><span class="stat-label">Failed/Crashed</span><span class="stat-value" style="color:var(--error)">\${failed}</span></div>
     <div class="stat-row"><span class="stat-label">Dev agents</span><span class="stat-value">\${develop}</span></div>
     <div class="stat-row"><span class="stat-label">Pipeline runs</span><span class="stat-value">\${pipeline}</span></div>\`;

  document.getElementById('lastRefresh').textContent = 'just now';
}

function spawnNamed(name) {
  document.getElementById('customPrompt').value = name;
  spawnAgent();
}

async function spawnAgent() {
  const input = document.getElementById('customPrompt').value.trim();
  const freeText = document.getElementById('customPrompt').value.trim();
  const prompt = freeText || '';
  if (!prompt) return;

  const btn = document.getElementById('spawnBtn');
  const status = document.getElementById('spawnStatus');
  btn.disabled = true;
  btn.textContent = 'Spawning…';
  status.textContent = '';

  try {
    const r = await fetch(API + '/api/spawn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, bg: true }),
    });
    const data = await r.json();
    if (data.ok) {
      status.textContent = '✓ ' + data.msg;
      document.getElementById('customPrompt').value = '';
      setTimeout(loadAgents, 2000);
    } else {
      status.textContent = '✗ ' + data.msg;
    }
  } catch(e) {
    status.textContent = '✗ ' + e.message;
  }
  btn.disabled = false;
  btn.textContent = 'Spawn Agent';
}

async function toggleLog(id, logPath) {
  const viewer = document.getElementById('log-' + id);
  const content = document.getElementById('log-content-' + id);
  if (viewer.classList.contains('open')) {
    viewer.classList.remove('open');
    return;
  }
  viewer.classList.add('open');
  try {
    const r = await fetch(API + '/api/agent-log?path=' + encodeURIComponent(logPath) + '&lines=80');
    content.textContent = await r.text();
  } catch(e) {
    content.textContent = 'Failed to load log';
  }
}

// Init
loadAgents();
loadPrompts();
setInterval(loadAgents, 3000);

// Enter key in custom input spawns agent
document.getElementById('customPrompt').addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    spawnAgent();
  }
});
</script>
</body>
</html>`;
