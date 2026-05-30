/**
 * Prompt Version Tracker — tracks system prompt versions, usage counts,
 * and per-problem performance across prompt changes.
 *
 * Enables:
 *   - Knowing which prompt version was used for each benchmark run
 *   - Detecting whether pass/fail changes are due to prompt changes vs. LLM non-determinism
 *   - Auto-cache decisions: when same (problem, promptHash) combo seen >2 times, use cache
 *   - Cross-prompt comparison: "prompt v3 passes 90%, v2 passed 85% → improvement!"
 *
 * Stores data in: src/analysis/.prompt-versions.json
 */

import { createHash } from "crypto";
import { JsonFileStore } from "../utils/json-file-store";

const STORE_PATH = import.meta.dir + "/.prompt-versions.json";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface PromptRun {
  /** When this prompt was used */
  timestamp: string;
  /** Problem name (e.g. "fibonacci", "dijkstra-shortest-path") */
  problem: string;
  /** SHA256 hash of the system prompt (16 hex chars) */
  systemPromptHash: string;
  /** First 300 chars of the system prompt — enough to distinguish versions without storing full text */
  systemPromptPreview: string;
  /** The user prompt/problem description */
  userPrompt: string;
  /** Complexity tier */
  complexity?: string;
  /** Result: pass/fail */
  passed: boolean;
  /** Number of LLM calls used */
  calls: number;
  /** Total tokens used */
  tokens: number;
  /** Who solved it (1-shot, task-agent, repair, etc.) */
  solvedBy?: string;
  /** Git commit at time of run */
  commit?: string;
}

export interface PromptVersionSummary {
  /** The SHA256 hash of (systemPrompt + userPrompt) — truncated to 16 chars for readability */
  hash: string;
  /** When first seen */
  firstSeen: string;
  /** When last used */
  lastSeen: string;
  /** Total usage count across all problems */
  totalUses: number;
  /** Number of unique problems this prompt was used for */
  uniqueProblems: number;
  /** Per-problem performance */
  problemResults: Record<string, {
    passes: number;
    failures: number;
    totalCalls: number;
    totalTokens: number;
    lastPassed: boolean;
  }>;
  /** Overall pass rate */
  passRate: number;
}

export interface PromptVersionState {
  /** All runs, keyed by hash */
  runs: Record<string, PromptRun[]>;
  /** Summaries for fast lookup */
  summaries: Record<string, PromptVersionSummary>;
  /** Current active prompt hash (from the latest buildSystemPrompt) */
  currentHash: string | null;
  /** When the state was last updated */
  updatedAt: string;
}

// ── Store ───────────────────────────────────────────────────────────────────────

function emptyState(): PromptVersionState {
  return {
    runs: {},
    summaries: {},
    currentHash: null,
    updatedAt: new Date().toISOString(),
  };
}

const store = new JsonFileStore<PromptVersionState>(STORE_PATH, emptyState);

// ── Public API ──────────────────────────────────────────────────────────────────

/** Compute a deterministic hash for a prompt pair.
 *  Same system prompt + same user prompt = same hash.
 *  Returns a 16-char hex string. */
export function hashPrompt(systemPromptHash: string, userPrompt: string): string {
  const normalized = JSON.stringify({ s: systemPromptHash, u: userPrompt });
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/** Compute a hash for just the system prompt (for version tracking). */
export function hashSystemPrompt(systemPrompt: string): string {
  return createHash("sha256").update(systemPrompt).digest("hex").slice(0, 16);
}

/** Record a prompt run. Called after each problem execution. */
export function recordPromptRun(run: PromptRun): void {
  const state = store.load();
  const hash = hashPrompt(run.systemPromptHash, run.userPrompt);

  if (!state.runs[hash]) {
    state.runs[hash] = [];
  }
  state.runs[hash]!.push(run);

  // Update summary
  if (!state.summaries[hash]) {
    state.summaries[hash] = {
      hash,
      firstSeen: run.timestamp,
      lastSeen: run.timestamp,
      totalUses: 0,
      uniqueProblems: 0,
      problemResults: {},
      passRate: 0,
    };
  }

  const summary = state.summaries[hash]!;
  summary.lastSeen = run.timestamp;
  summary.totalUses++;

  if (!summary.problemResults[run.problem]) {
    summary.problemResults[run.problem] = {
      passes: 0,
      failures: 0,
      totalCalls: 0,
      totalTokens: 0,
      lastPassed: run.passed,
    };
    summary.uniqueProblems++;
  }

  const pr = summary.problemResults[run.problem]!;
  if (run.passed) pr.passes++;
  else pr.failures++;
  pr.totalCalls += run.calls;
  pr.totalTokens += run.tokens;
  pr.lastPassed = run.passed;

  // Recompute pass rate
  const totalRuns = Object.values(summary.problemResults).reduce(
    (s, r) => s + r.passes + r.failures, 0
  );
  const totalPasses = Object.values(summary.problemResults).reduce(
    (s, r) => s + r.passes, 0
  );
  summary.passRate = totalRuns > 0 ? totalPasses / totalRuns : 0;

  state.updatedAt = new Date().toISOString();
  store.markDirty();
  store.save();
}

/** Set the current active system prompt hash (from the latest code). */
export function setCurrentPromptHash(hash: string): void {
  const state = store.load();
  state.currentHash = hash;
  state.updatedAt = new Date().toISOString();
  store.markDirty();
  store.save();
}

/** Get the current active prompt hash. */
export function getCurrentPromptHash(): string | null {
  return store.load().currentHash;
}

/** Check if a (promptHash, problem) combo has been seen more than `threshold` times.
 *  Used for auto-cache decisions. */
export function shouldAutoCache(
  systemPromptHash: string,
  userPrompt: string,
  threshold: number = 2
): boolean {
  const hash = hashPrompt(systemPromptHash, userPrompt);
  const state = store.load();
  const runs = state.runs[hash];
  return runs ? runs.length > threshold : false;
}

/** Get usage count for a specific (promptHash, userPrompt) combo. */
export function getPromptUsageCount(systemPromptHash: string, userPrompt: string): number {
  const hash = hashPrompt(systemPromptHash, userPrompt);
  const state = store.load();
  return state.runs[hash]?.length ?? 0;
}

/** Get all distinct system prompt hashes (versions) that have been used. */
export function getPromptVersions(): PromptVersionSummary[] {
  const state = store.load();
  return Object.values(state.summaries);
}

/** Get the most recent prompt runs for a given problem, across all prompt versions. */
export function getProblemPromptHistory(problem: string): Array<{
  hash: string;
  timestamp: string;
  passed: boolean;
  calls: number;
  tokens: number;
}> {
  const state = store.load();
  const results: Array<{
    hash: string;
    timestamp: string;
    passed: boolean;
    calls: number;
    tokens: number;
  }> = [];

  for (const [hash, runs] of Object.entries(state.runs)) {
    for (const run of runs) {
      if (run.problem === problem) {
        results.push({
          hash,
          timestamp: run.timestamp,
          passed: run.passed,
          calls: run.calls,
          tokens: run.tokens,
        });
      }
    }
  }

  return results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/** Detect if current prompt version is different from the one used in
 *  the most recent benchmark run. Returns the changed hash or null. */
export function detectPromptChange(): {
  changed: boolean;
  currentHash: string | null;
  previousHash: string | null;
  previousSummary: PromptVersionSummary | null;
} {
  const state = store.load();
  const versions = getPromptVersions();

  if (!state.currentHash) {
    return { changed: false, currentHash: null, previousHash: null, previousSummary: null };
  }

  // Find the most recent non-current hash that was used
  const others = versions
    .filter(v => v.hash !== state.currentHash)
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));

  const previousHash = others.length > 0 ? others[0]!.hash : null;
  const previousSummary = others.length > 0 ? others[0]! : null;
  const changed = previousHash !== null && previousHash !== state.currentHash;

  return { changed, currentHash: state.currentHash, previousHash, previousSummary };
}

/** Generate a human-readable prompt version report. */
export function generatePromptReport(): string {
  const state = store.load();
  const versions = getPromptVersions();

  if (versions.length === 0) {
    return "No prompt versions recorded yet.";
  }

  const lines: string[] = [];
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("  PROMPT VERSION REPORT");
  lines.push("═══════════════════════════════════════════════════════════════");

  if (state.currentHash) {
    const current = versions.find(v => v.hash === state.currentHash);
    lines.push(`\n  Current prompt: ${state.currentHash}${current ? ` (pass rate: ${(current.passRate * 100).toFixed(0)}%)` : ""}`);
  }

  lines.push(`\n  Total versions: ${versions.length}`);
  lines.push(`  Total runs: ${versions.reduce((s, v) => s + v.totalUses, 0)}`);

  // Show each version
  for (const v of versions.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))) {
    const isCurrent = v.hash === state.currentHash;
    const marker = isCurrent ? " ← CURRENT" : "";
    lines.push(`\n  ${v.hash}${marker}`);
    lines.push(`    Used: ${v.totalUses}x across ${v.uniqueProblems} problems`);
    lines.push(`    Pass rate: ${(v.passRate * 100).toFixed(0)}% (${Math.round(v.passRate * v.totalUses)}/${v.totalUses})`);
    lines.push(`    First seen: ${v.firstSeen.slice(0, 19)}`);
    lines.push(`    Last used:  ${v.lastSeen.slice(0, 19)}`);

    // Show the prompt preview (first stored run's preview)
    const firstRun = state.runs[v.hash]?.[0];
    if (firstRun?.systemPromptPreview) {
      lines.push(`    Preview: ${firstRun.systemPromptPreview.slice(0, 120)}...`);
    }

    // Show per-problem breakdown
    if (v.uniqueProblems > 0) {
      const probs = Object.entries(v.problemResults)
        .sort(([, a], [, b]) => (b.passes + b.failures) - (a.passes + a.failures));
      for (const [name, pr] of probs.slice(0, 10)) {
        const icon = pr.lastPassed ? "✓" : "✗";
        const total = pr.passes + pr.failures;
        const avgCalls = total > 0 ? (pr.totalCalls / total).toFixed(1) : "-";
        lines.push(`      ${icon} ${name.padEnd(25)} ${pr.passes}/${total} pass  avg ${avgCalls} calls`);
      }
      if (probs.length > 10) {
        lines.push(`      ... and ${probs.length - 10} more problems`);
      }
    }
  }

  // Cross-version comparison
  if (versions.length >= 2) {
    const sorted = versions.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
    const current = sorted[0]!;
    const previous = sorted[1]!;

    lines.push(`\n  ── Cross-version comparison ──`);
    lines.push(`  Current (${current.hash}): ${(current.passRate * 100).toFixed(0)}% pass rate`);
    lines.push(`  Previous (${previous.hash}): ${(previous.passRate * 100).toFixed(0)}% pass rate`);
    const delta = current.passRate - previous.passRate;
    if (delta > 0) lines.push(`  → Improvement: +${(delta * 100).toFixed(0)}%`);
    else if (delta < 0) lines.push(`  → Regression: ${(delta * 100).toFixed(0)}%`);
    else lines.push(`  → No change`);

    // Common problems
    const currentProbs = new Set(Object.keys(current.problemResults));
    const previousProbs = new Set(Object.keys(previous.problemResults));
    const common = [...currentProbs].filter(p => previousProbs.has(p));

    if (common.length > 0) {
      const newlyPassing: string[] = [];
      const newlyFailing: string[] = [];
      for (const prob of common) {
        const cp = current.problemResults[prob]!;
        const pp = previous.problemResults[prob]!;
        if (cp.lastPassed && !pp.lastPassed) newlyPassing.push(prob);
        if (!cp.lastPassed && pp.lastPassed) newlyFailing.push(prob);
      }

      if (newlyPassing.length > 0) {
        lines.push(`\n    ✓ Newly passing (${newlyPassing.length}):`);
        for (const p of newlyPassing) lines.push(`      ${p}`);
      }
      if (newlyFailing.length > 0) {
        lines.push(`\n    ✗ Newly failing (${newlyFailing.length}):`);
        for (const p of newlyFailing) lines.push(`      ${p}`);
      }
    }
  }

  lines.push("\n═══════════════════════════════════════════════════════════════");
  return lines.join("\n");
}

// ── Cross-prompt per-problem comparison ─────────────────────────────────────────

export interface CrossPromptResult {
  problem: string;
  /** Per-prompt-version results, sorted by most recent first */
  versions: Array<{
    hash: string;
    passed: boolean;
    calls: number;
    tokens: number;
    lastUsed: string;
    preview: string;
  }>;
  /** Number of distinct prompt versions used for this problem */
  versionCount: number;
  /** Is the result consistent across prompt versions? */
  consistent: boolean;
  /** Stability: fraction of runs that passed (across all versions) */
  stability: number;
}

/** Generate per-problem cross-prompt comparison. Shows how each problem
 *  performed under different system prompt versions. */
export function generateCrossPromptComparison(problemNames?: string[]): CrossPromptResult[] {
  const state = store.load();
  const results: CrossPromptResult[] = [];

  // Collect all problems seen in any run
  const allProblems = new Set<string>();
  for (const runs of Object.values(state.runs)) {
    for (const run of runs) {
      allProblems.add(run.problem);
    }
  }

  const problems = problemNames
    ? [...allProblems].filter(p => problemNames.some(n => p === n || p.includes(n)))
    : [...allProblems].sort();

  for (const problem of problems) {
    const versions: CrossPromptResult["versions"] = [];

    for (const [hash, runs] of Object.entries(state.runs)) {
      const problemRuns = runs.filter(r => r.problem === problem);
      if (problemRuns.length === 0) continue;

      const latest = problemRuns.reduce((a, b) =>
        a.timestamp > b.timestamp ? a : b
      );

      versions.push({
        hash,
        passed: latest.passed,
        calls: latest.calls,
        tokens: latest.tokens,
        lastUsed: latest.timestamp,
        preview: latest.systemPromptPreview?.slice(0, 80) ?? "",
      });
    }

    if (versions.length === 0) continue;

    versions.sort((a, b) => b.lastUsed.localeCompare(a.lastUsed));

    const totalRuns = versions.length;
    const totalPasses = versions.filter(v => v.passed).length;
    const allSameResult = versions.every(v => v.passed === versions[0]?.passed);

    results.push({
      problem,
      versions,
      versionCount: versions.length,
      consistent: allSameResult,
      stability: totalRuns > 0 ? totalPasses / totalRuns : 0,
    });
  }

  return results;
}

/** Format the cross-prompt comparison as a human-readable string. */
export function formatCrossPromptReport(results: CrossPromptResult[]): string {
  if (results.length === 0) {
    return "No cross-prompt data available (need at least 2 runs per problem with different prompts).";
  }

  const lines: string[] = [];
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("  CROSS-PROMPT COMPARISON — per-problem across prompt versions");
  lines.push("═══════════════════════════════════════════════════════════════");

  // Summary stats
  const singleVersion = results.filter(r => r.versionCount === 1).length;
  const multiVersion = results.filter(r => r.versionCount > 1).length;
  const consistentlyPass = results.filter(r => r.consistent && r.versions[0]?.passed).length;
  const consistentlyFail = results.filter(r => r.consistent && r.versions[0] && !r.versions[0].passed).length;
  const flaky = results.filter(r => !r.consistent && r.versionCount > 1).length;

  lines.push(`\n  Problems with 1 version:  ${singleVersion} (no comparison possible)`);
  lines.push(`  Problems with 2+ versions: ${multiVersion}`);
  if (multiVersion > 0) {
    lines.push(`    Consistently passing: ${consistentlyPass}`);
    lines.push(`    Consistently failing: ${consistentlyFail}`);
    lines.push(`    Flaky (varies by prompt): ${flaky}`);
  }

  // Per-problem detail for multi-version problems
  const multi = results.filter(r => r.versionCount > 1);
  if (multi.length > 0) {
    lines.push(`\n  ── Per-problem detail ──`);
    for (const r of multi) {
      const stabilityIcon = r.stability >= 0.8 ? "✓" : r.stability >= 0.5 ? "~" : "✗";
      lines.push(`\n  ${stabilityIcon} ${r.problem} (${r.versionCount} prompt versions, ${(r.stability * 100).toFixed(0)}% stable)`);
      for (const v of r.versions) {
        const icon = v.passed ? "PASS" : "FAIL";
        const preview = v.preview ? ` [${v.preview.slice(0, 60)}]` : "";
        lines.push(`    ${icon}  ${v.hash}  ${v.calls}c  ${v.lastUsed.slice(0, 19)}${preview}`);
      }
    }
  }

  // Best/worst prompt versions
  const allSummaries = Object.values(store.load().summaries)
    .filter(s => s.totalUses >= 3)
    .sort((a, b) => b.passRate - a.passRate);

  if (allSummaries.length >= 2) {
    lines.push(`\n  ── Best prompt versions (≥3 runs) ──`);
    for (const s of allSummaries.slice(0, 3)) {
      const preview = store.load().runs[s.hash]?.[0]?.systemPromptPreview?.slice(0, 60) ?? "";
      lines.push(`  ${(s.passRate * 100).toFixed(0)}%  ${s.hash}  ${s.totalUses}x  ${preview}`);
    }
  }

  lines.push("\n═══════════════════════════════════════════════════════════════");
  return lines.join("\n");
}

// ── Consistency tracking ────────────────────────────────────────────────────────

export interface ProblemConsistency {
  name: string;
  totalRuns: number;
  passes: number;
  failures: number;
  /** "stable-pass" | "stable-fail" | "flaky" | "insufficient-data" */
  verdict: "stable-pass" | "stable-fail" | "flaky" | "insufficient-data";
  /** Timestamps of all runs */
  runDates: string[];
}

/** Check per-problem consistency across all recorded runs.
 *  Stable = same result every time. Flaky = different results. */
export function getConsistencyReport(): ProblemConsistency[] {
  const state = store.load();
  const problemMap = new Map<string, { passes: number; failures: number; dates: string[] }>();

  for (const runs of Object.values(state.runs)) {
    for (const run of runs) {
      const existing = problemMap.get(run.problem);
      if (existing) {
        if (run.passed) existing.passes++;
        else existing.failures++;
        existing.dates.push(run.timestamp);
      } else {
        problemMap.set(run.problem, {
          passes: run.passed ? 1 : 0,
          failures: run.passed ? 0 : 1,
          dates: [run.timestamp],
        });
      }
    }
  }

  const results: ProblemConsistency[] = [];
  for (const [name, data] of problemMap) {
    const totalRuns = data.passes + data.failures;
    let verdict: ProblemConsistency["verdict"];
    if (totalRuns < 2) {
      verdict = "insufficient-data";
    } else if (data.passes === totalRuns) {
      verdict = "stable-pass";
    } else if (data.failures === totalRuns) {
      verdict = "stable-fail";
    } else {
      verdict = "flaky";
    }

    results.push({
      name,
      totalRuns,
      passes: data.passes,
      failures: data.failures,
      verdict,
      runDates: data.dates.sort(),
    });
  }

  return results.sort((a, b) => b.totalRuns - a.totalRuns);
}

/** Format consistency report as human-readable string. */
export function formatConsistencyReport(consistency: ProblemConsistency[]): string {
  if (consistency.length === 0) {
    return "No consistency data available.";
  }

  const lines: string[] = [];
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("  CONSISTENCY REPORT — per-problem pass/fail stability");
  lines.push("═══════════════════════════════════════════════════════════════");

  const stablePass = consistency.filter(c => c.verdict === "stable-pass");
  const stableFail = consistency.filter(c => c.verdict === "stable-fail");
  const flaky = consistency.filter(c => c.verdict === "flaky");
  const insufficient = consistency.filter(c => c.verdict === "insufficient-data");

  lines.push(`\n  Total problems tracked: ${consistency.length}`);
  lines.push(`  Stable-pass: ${stablePass.length}  |  Stable-fail: ${stableFail.length}  |  Flaky: ${flaky.length}  |  Insufficient data: ${insufficient.length}`);

  if (stablePass.length > 0) {
    lines.push(`\n  ✓ STABLE-PASS (${stablePass.length}) — always passes:`);
    for (const c of stablePass) {
      lines.push(`    ${c.name.padEnd(28)} ${c.passes}/${c.totalRuns} runs`);
    }
  }

  if (stableFail.length > 0) {
    lines.push(`\n  ✗ STABLE-FAIL (${stableFail.length}) — consistently failing:`);
    for (const c of stableFail) {
      lines.push(`    ${c.name.padEnd(28)} ${c.failures}/${c.totalRuns} runs`);
    }
  }

  if (flaky.length > 0) {
    lines.push(`\n  ⚡ FLAKY (${flaky.length}) — NON-DETERMINISTIC — investigate:`);
    for (const c of flaky) {
      lines.push(`    ${c.name.padEnd(28)} ${c.passes}P/${c.failures}F across ${c.totalRuns} runs`);
    }
    lines.push(`\n  ⚠  Flaky problems may indicate:`);
    lines.push(`    - LLM-generated oracle with ambiguous acceptance criteria`);
    lines.push(`    - Stochastic problem without proper seeding`);
    lines.push(`    - LLM non-determinism (temperature > 0) or timeout variance`);
  }

  if (insufficient.length > 0 && insufficient.length < consistency.length) {
    lines.push(`\n  ? Insufficient data (${insufficient.length}): run at least 2x to assess stability`);
  }

  lines.push("\n═══════════════════════════════════════════════════════════════");
  return lines.join("\n");
}

// ── Trusted problems (smart cache defaults) ──────────────────────────────────────

/** A problem is "trusted" when it has passed consistently ≥3 times with the
 *  current prompt hash. Trusted problems can be skipped in benchmark runs
 *  (--force overrides). This saves significant LLM cost on stable problems. */
export function isTrusted(problemName: string): boolean {
  const state = store.load();
  const phash = state.currentHash;
  if (!phash) return false;

  const runs = state.runs[phash];
  if (!runs) return false;

  const problemRuns = runs.filter(r => r.problem === problemName);
  if (problemRuns.length < 3) return false;

  return problemRuns.every(r => r.passed);
}

/** Get all problem names that are currently trusted (consistently passing ≥3x
 *  with the current prompt hash). These can be safely skipped with --force.
 *  @param currentHashOverride — optional explicit hash; uses state.currentHash if omitted */
export function getTrustedProblems(currentHashOverride?: string | null): string[] {
  const state = store.load();
  const phash = currentHashOverride ?? state.currentHash;
  if (!phash) return [];

  const runs = state.runs[phash];
  if (!runs) return [];

  const byProblem = new Map<string, boolean>();
  for (const run of runs) {
    if (!byProblem.has(run.problem)) {
      byProblem.set(run.problem, true);
    }
    if (!run.passed) {
      byProblem.set(run.problem, false);
    }
  }

  return [...byProblem.entries()]
    .filter(([, allPassed]) => allPassed)
    .map(([name]) => name)
    .filter(name => {
      const problemRuns = (state.runs[phash] ?? []).filter(r => r.problem === name);
      return problemRuns.length >= 3;
    });
}

// ── Cache invalidation ───────────────────────────────────────────────────────────

/** Clear all prompt run data. Useful for fresh starts or after major prompt changes. */
export function clearPromptCache(): void {
  const state = store.load();
  // Reset all fields
  Object.keys(state.runs).forEach(k => delete state.runs[k]);
  Object.keys(state.summaries).forEach(k => delete state.summaries[k]);
  state.currentHash = null;
  state.updatedAt = new Date().toISOString();
  store.markDirty();
  store.save();
}

// Auto-save on exit
process.on("exit", () => { store.save(); });
