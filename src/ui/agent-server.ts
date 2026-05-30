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

// ── Session index ──────────────────────────────────────────────────────────

function getSessions(): any[] {
  const sessionFile = join(DEV_LOGDIR, "sessions.jsonl");
  try {
    const lines = readFileSync(sessionFile, "utf-8").trim().split("\n").filter(Boolean);
    return lines.map(l => JSON.parse(l)).reverse();
  } catch {
    return [];
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

    if (path === "/api/sessions") {
      return json(null as any, getSessions());
    }

    if (path === "/api/resume" && req.method === "POST") {
      let body: any;
      try { body = await req.json(); } catch { body = {}; }
      const idx = body.index || "1";
      const script = join(SCRIPTS_DIR, "develop.sh");
      try {
        const proc = spawn("bash", [script, "--resume", String(idx)], {
          cwd: ROOT,
          detached: true,
          stdio: "ignore",
        });
        proc.unref();
        return json(null as any, { ok: true, msg: `Resuming session ${idx}...` });
      } catch (err: any) {
        return json(null as any, { ok: false, msg: err.message }, 500);
      }
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
      try {
        const html = readFileSync(join(import.meta.dir, "agent-dashboard.html"), "utf-8");
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
      } catch {
        return new Response("Dashboard not found", { status: 500 });
      }
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`\n  Agent Dashboard → http://localhost:${PORT}\n`);

// ── Dashboard HTML (inline — no build step needed) ─────────────────────────
