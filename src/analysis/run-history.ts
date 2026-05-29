/**
 * Run History — JSONL-based storage of every benchmark run.
 *
 * Each line is a self-contained JSON record. Append-only. No corruption risk.
 * Easy to grep, analyze with jq, or query programmatically.
 *
 * Replaces the thin efficiency/capability tracking with rich historical data:
 *   - Full input (problem, oracle hash) and output (solution code, answer values)
 *   - Pipeline path tracking (which stages were used)
 *   - Cross-run output comparison
 *   - Golden output validation results
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { execSync } from "child_process";

const ROOT = resolve(dirname(import.meta.filename!), "..", "..");
const HISTORY_PATH = resolve(ROOT, ".run-history.jsonl");

// ── Types ──────────────────────────────────────────────────────────────────────

export type PipelinePath =
  | "1-shot"
  | "repair"
  | "task-agent"
  | "supervisor-retry"
  | "failed-all"
  | "no-domain-spec"
  | "fatal-error";

export interface OutputComparison {
  /** Hash of the solution code (for detecting identical outputs across runs) */
  codeHash: string;
  /** Key output values extracted from oracle execution */
  outputValues: Record<string, unknown>;
  /** How these outputs compare to golden expected outputs */
  goldenValidation?: GoldenValidation;
}

export interface GoldenValidation {
  /** Number of golden test cases checked */
  total: number;
  /** Number that matched expected output */
  matched: number;
  /** Details for mismatches */
  mismatches: GoldenMismatch[];
}

export interface GoldenMismatch {
  input: string;
  expected: string;
  got: string;
}

export interface RunRecord {
  /** ISO timestamp */
  timestamp: string;
  /** Git commit hash (short) */
  commit: string;
  /** Problem name (from benchmark-problems.ts) */
  problem: string;
  /** Problem complexity tier */
  complexity: string;
  /** Domain used (detected or explicit) */
  domain: string;
  /** SHA256 hash of the oracle JS source */
  oracleHash: string;
  /** Which pipeline path solved it (or failed) */
  path: PipelinePath;
  /** Did it pass? */
  passed: boolean;
  /** Total LLM API calls consumed */
  totalCalls: number;
  /** Total tokens (prompt + completion) */
  totalTokens: number;
  /** Total cost in USD */
  totalCost: number;
  /** Duration in ms */
  durationMs: number;
  /** Model tier used */
  modelTier: number;
  /** Run number for this problem (1, 2, 3, ...) within the current benchmark session */
  runIndex: number;
  /** Session ID — shared across all problems in one benchmark invocation */
  sessionId: string;
  /** Output comparison data (optional — may not be available for failures) */
  output?: OutputComparison;
  /** Any error or failure reason */
  failureReason?: string;
}

// ── Session ID ─────────────────────────────────────────────────────────────────

let sessionId: string | null = null;

export function getSessionId(): string {
  if (!sessionId) {
    sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
  return sessionId;
}

// ── Write ──────────────────────────────────────────────────────────────────────

/** Append a run record to the JSONL history file. */
export function recordRun(record: RunRecord): void {
  const dir = dirname(HISTORY_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(HISTORY_PATH, JSON.stringify(record) + "\n", "utf-8");
}

/** Record multiple runs at once. */
export function recordRuns(records: RunRecord[]): void {
  if (records.length === 0) return;
  const dir = dirname(HISTORY_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const lines = records.map(r => JSON.stringify(r)).join("\n") + "\n";
  appendFileSync(HISTORY_PATH, lines, "utf-8");
}

// ── Read / Query ───────────────────────────────────────────────────────────────

/** Load all run records from the history file. */
export function loadHistory(): RunRecord[] {
  if (!existsSync(HISTORY_PATH)) return [];
  const raw = readFileSync(HISTORY_PATH, "utf-8").trim();
  if (!raw) return [];
  return raw.split("\n").map(line => JSON.parse(line) as RunRecord);
}

/** Get all runs for a specific problem, ordered by timestamp. */
export function getProblemHistory(problemName: string): RunRecord[] {
  return loadHistory().filter(r => r.problem === problemName);
}

/** Get the most recent run for each problem. */
export function getLatestPerProblem(): Map<string, RunRecord> {
  const map = new Map<string, RunRecord>();
  for (const r of loadHistory()) {
    const existing = map.get(r.problem);
    if (!existing || r.timestamp > existing.timestamp) {
      map.set(r.problem, r);
    }
  }
  return map;
}

/** Get all runs from the most recent session. */
export function getLatestSession(): RunRecord[] {
  const history = loadHistory();
  if (history.length === 0) return [];
  const latestSession = history[history.length - 1]!.sessionId;
  return history.filter(r => r.sessionId === latestSession);
}

/** Compute per-problem path distribution across all history. */
export function getPathDistribution(problemName?: string): Record<string, { passed: number; failed: number }> {
  const runs = problemName ? getProblemHistory(problemName) : loadHistory();
  const dist: Record<string, { passed: number; failed: number }> = {};
  for (const r of runs) {
    if (!dist[r.path]) dist[r.path] = { passed: 0, failed: 0 };
    if (r.passed) dist[r.path]!.passed++;
    else dist[r.path]!.failed++;
  }
  return dist;
}

/** Find problems that are flaky: pass sometimes but not always. */
export function findFlakyProblems(): { name: string; passRate: number; totalRuns: number }[] {
  const byProblem = new Map<string, RunRecord[]>();
  for (const r of loadHistory()) {
    const arr = byProblem.get(r.problem) || [];
    arr.push(r);
    byProblem.set(r.problem, arr);
  }
  const flaky: { name: string; passRate: number; totalRuns: number }[] = [];
  for (const [name, runs] of byProblem) {
    if (runs.length < 3) continue;
    const passed = runs.filter(r => r.passed).length;
    const rate = passed / runs.length;
    if (rate > 0 && rate < 1) {
      flaky.push({ name, passRate: rate, totalRuns: runs.length });
    }
  }
  flaky.sort((a, b) => a.passRate - b.passRate);
  return flaky;
}

/** Compare output values across runs of the same problem — detect divergence. */
export function findOutputDivergence(problemName: string): { codeHashes: string[]; runs: RunRecord[] } | null {
  const runs = getProblemHistory(problemName).filter(r => r.output?.codeHash);
  if (runs.length < 2) return null;
  const hashes = new Set(runs.map(r => r.output!.codeHash));
  if (hashes.size > 1) {
    return { codeHashes: [...hashes], runs };
  }
  return null;
}

// ── Git helper ─────────────────────────────────────────────────────────────────

export function getGitCommit(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf-8", cwd: ROOT }).trim();
  } catch {
    return "unknown";
  }
}

// ── SHA256 helper (for oracle hashing) ─────────────────────────────────────────

import { createHash } from "crypto";

export function hashSource(source: string): string {
  return createHash("sha256").update(source).digest("hex").slice(0, 16);
}
