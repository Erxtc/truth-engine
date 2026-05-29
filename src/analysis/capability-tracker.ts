/**
 * Capability Tracker — records what each model tier can and cannot solve,
 * persisted across runs so the pipeline learns from past failures.
 */

import { JsonFileStore } from "../utils/json-file-store";

// ── Types ──────────────────────────────────────────────────────────────────────

export type FailureClass =
  | "parse_error"
  | "syntax_error"
  | "type_error"
  | "wrong_output"
  | "wrong_approach"
  | "capability_gap";

const STATE_PATH = import.meta.dir + "/.capability-state.json";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface CapabilityRecord {
  /** Problem domain (e.g. "sorting", "graph-theory", "linear-algebra") */
  domain: string;
  /** Short problem description (truncated to 120 chars) */
  description: string;
  /** Number of subproblems */
  numSubproblems: number;
  /** Model tier that attempted this (1=7B, 2=DeepSeek, 3=Claude) */
  modelTier: number;
  /** Did the pipeline solve it? */
  solved: boolean;
  /** If unsolved, the failure classification */
  failureClass?: FailureClass;
  /** How many LLM calls did this problem consume */
  llmCallsUsed: number;
  /** Which agent solved it (1-shot, task-agent, repair, evolution) */
  solvedBy?: string;
  timestamp: string;
}

interface CapabilityState {
  records: CapabilityRecord[];
  updatedAt: string;
}

const store = new JsonFileStore<CapabilityState>(STATE_PATH, () => ({
  records: [],
  updatedAt: new Date().toISOString(),
}));

// ── Public API ─────────────────────────────────────────────────────────────────

/** Record a problem attempt (solved or not). Call after each problem completes. */
export function recordAttempt(record: CapabilityRecord): void {
  const state = store.load();
  state.records.push(record);
  store.markDirty();

  const emoji = record.solved ? "✓" : "✗";
  console.log(`[capability] ${emoji} ${record.domain} (tier ${record.modelTier}) — ${record.solved ? `SOLVED by ${record.solvedBy}` : record.failureClass} in ${record.llmCallsUsed} calls`);
}

/** Query historical pass rate and recent attempts for a domain, optionally filtered by tier.
 *  Returns null if no records exist for the domain/tier combination. */
export function getDomainCapability(domain: string, modelTier?: number): {
  passRate: number;
  avgCalls: number;
  attempts: number;
  lastSolved: string | null;
  recentFailures: string[];
} | null {
  const state = store.load();
  const records = modelTier != null
    ? state.records.filter(r => r.domain === domain && r.modelTier === modelTier)
    : state.records.filter(r => r.domain === domain);
  if (records.length === 0) return null;

  const solved = records.filter(r => r.solved);
  const passRate = solved.length / records.length;
  const avgCalls = records.reduce((s, r) => s + r.llmCallsUsed, 0) / records.length;
  const lastSolved = solved.length > 0 ? solved[solved.length - 1]!.timestamp : null;
  const recentFailures = records.filter(r => !r.solved).slice(-3).map(r => r.failureClass ?? "unknown");

  return { passRate, avgCalls, attempts: records.length, lastSolved, recentFailures };
}

// Auto-save on exit
process.on("exit", () => { store.save(); });
