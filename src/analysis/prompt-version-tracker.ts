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

import { JsonFileStore } from "../utils/json-file-store";
import { sha256 } from "../utils/general";

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

export interface ConsistencyVerdict {
  /** "stable-pass" | "stable-fail" | "flaky" */
  verdict: "stable-pass" | "stable-fail" | "flaky";
  /** When this consistency check was performed */
  lastChecked: string;
  /** How many runs were performed */
  runsChecked: number;
  /** Pass count in those runs */
  passes: number;
  /** Fail count in those runs */
  failures: number;
}

export interface PromptVersionState {
  /** All runs, keyed by hash */
  runs: Record<string, PromptRun[]>;
  /** Summaries for fast lookup */
  summaries: Record<string, PromptVersionSummary>;
  /** Current active prompt hash (from the latest buildSystemPrompt) */
  currentHash: string | null;
  /** Per-problem consistency verdicts (from --consistency mode) — persists across sessions */
  consistencyVerdicts: Record<string, ConsistencyVerdict>;
  /** Configurable trusted-problem threshold — how many consistent passes needed */
  trustedThreshold: number;
  /** When the state was last updated */
  updatedAt: string;
}

// ── Store ───────────────────────────────────────────────────────────────────────

function emptyState(): PromptVersionState {
  return {
    runs: {},
    summaries: {},
    currentHash: null,
    consistencyVerdicts: {},
    trustedThreshold: 2,
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
  return sha256(normalized);
}

/** Compute a hash for just the system prompt (for version tracking). */
export function hashSystemPrompt(systemPrompt: string): string {
  return sha256(systemPrompt);
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
 *  Used for auto-cache decisions. Iterates runs to handle userPrompt mismatches. */
export function shouldAutoCache(
  systemPromptHash: string,
  userPrompt: string,
  threshold: number = 2
): boolean {
  // Try combined-hash lookup first (fast path — works when userPrompt is consistent)
  const hash = hashPrompt(systemPromptHash, userPrompt);
  const state = store.load();
  const directMatch = state.runs[hash];
  if (directMatch && directMatch.length > threshold) return true;

  // Fallback: iterate all runs (handles userPrompt format differences)
  const problemRuns = getRunsBySystemHash(systemPromptHash);
  return problemRuns.length > threshold;
}

/** Get usage count for runs with the given system prompt hash.
 *  Uses iteration to be robust against userPrompt format variations. */
export function getPromptUsageCount(systemPromptHash: string, userPrompt?: string): number {
  // Try fast hash-based lookup first
  if (userPrompt) {
    const hash = hashPrompt(systemPromptHash, userPrompt);
    const direct = store.load().runs[hash];
    if (direct) return direct.length;
  }
  // Fallback: count all runs with this system prompt hash
  return getRunsBySystemHash(systemPromptHash).length;
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

// ── Internal helpers ─────────────────────────────────────────────────────────────

/** Iterate all runs and collect those matching a given system prompt hash. */
function getRunsBySystemHash(phash: string): PromptRun[] {
  const state = store.load();
  const matches: PromptRun[] = [];
  for (const runs of Object.values(state.runs)) {
    for (const run of runs) {
      if (run.systemPromptHash === phash) {
        matches.push(run);
      }
    }
  }
  return matches;
}

/** Iterate all runs and collect those matching (systemPromptHash, problem). */
function getRunsBySystemAndProblem(phash: string, problem: string): PromptRun[] {
  const state = store.load();
  const matches: PromptRun[] = [];
  for (const runs of Object.values(state.runs)) {
    for (const run of runs) {
      if (run.systemPromptHash === phash && run.problem === problem) {
        matches.push(run);
      }
    }
  }
  return matches;
}

// ── Trusted problems (smart cache defaults) ──────────────────────────────────────

/** A problem is "trusted" when it has passed consistently ≥threshold times
 *  with the current prompt hash. Trusted problems can be skipped in benchmark runs
 *  (--force overrides). Threshold defaults to 2 (user-configured).
 *  Also checks consistency verdicts: if a problem is known-flaky, it's never trusted
 *  regardless of recent passes (flaky = passes sometimes, fails other times). */
export function isTrusted(problemName: string): boolean {
  const state = store.load();
  const phash = state.currentHash;
  if (!phash) return false;

  // Never trust flaky problems — they might fail next time
  const verdict = state.consistencyVerdicts?.[problemName];
  if (verdict?.verdict === "flaky") return false;

  const threshold = state.trustedThreshold ?? 2;
  const problemRuns = getRunsBySystemAndProblem(phash, problemName);
  if (problemRuns.length < threshold) return false;

  return problemRuns.every(r => r.passed);
}

/** Get all problem names that are currently trusted (consistently passing ≥threshold
 *  with the current prompt hash). These can be safely skipped without --force.
 *  @param currentHashOverride — optional explicit hash; uses state.currentHash if omitted
 *  @param thresholdOverride — optional explicit threshold; uses state.trustedThreshold if omitted */
export function getTrustedProblems(currentHashOverride?: string | null, thresholdOverride?: number): string[] {
  const state = store.load();
  const phash = currentHashOverride ?? state.currentHash;
  if (!phash) return [];

  const threshold = thresholdOverride ?? state.trustedThreshold ?? 2;
  const allRuns = getRunsBySystemHash(phash);

  const byProblem = new Map<string, { allPassed: boolean; count: number; lastRun: PromptRun }>();
  for (const run of allRuns) {
    const existing = byProblem.get(run.problem);
    if (existing) {
      existing.count++;
      if (!run.passed) existing.allPassed = false;
      if (run.timestamp > existing.lastRun.timestamp) existing.lastRun = run;
    } else {
      byProblem.set(run.problem, { allPassed: run.passed, count: 1, lastRun: run });
    }
  }

  return [...byProblem.entries()]
    .filter(([, v]) => v.allPassed && v.count >= threshold)
    .filter(([name]) => {
      // Flaky problems are never trusted — even if recent runs all passed
      const verdict = state.consistencyVerdicts?.[name];
      return verdict?.verdict !== "flaky";
    })
    .map(([name]) => name);
}

/** Get last trusted run info for display in benchmark output (when skipping).
 *  Returns the most recent passing run for this (phash, problem) combo, or null. */
export function getLastTrustedRun(problemName: string, phash?: string | null): PromptRun | null {
  const state = store.load();
  const hash = phash ?? state.currentHash;
  if (!hash) return null;

  const problemRuns = getRunsBySystemAndProblem(hash, problemName);
  const passing = problemRuns.filter(r => r.passed);
  if (passing.length === 0) return null;

  return passing.reduce((a, b) => a.timestamp > b.timestamp ? a : b);
}

// ── Consistency verdict persistence ──────────────────────────────────────────────

/** Record a consistency verdict for a problem. Called after --consistency mode runs.
 *  Persisted across sessions so flaky detection survives restarts. */
export function recordConsistencyVerdict(
  problem: string,
  verdict: "stable-pass" | "stable-fail" | "flaky",
  runsChecked: number,
  passes: number,
  failures: number,
): void {
  const state = store.load();
  if (!state.consistencyVerdicts) state.consistencyVerdicts = {};
  state.consistencyVerdicts[problem] = {
    verdict,
    lastChecked: new Date().toISOString(),
    runsChecked,
    passes,
    failures,
  };
  state.updatedAt = new Date().toISOString();
  store.markDirty();
  store.save();
}

/** Get all persisted consistency verdicts. */
export function getConsistencyVerdicts(): Record<string, ConsistencyVerdict> {
  return { ...(store.load().consistencyVerdicts || {}) };
}

/** Get consistency verdict for a single problem. */
export function getConsistencyVerdict(problemName: string): ConsistencyVerdict | null {
  const verdicts = store.load().consistencyVerdicts;
  return verdicts[problemName] ?? null;
}

/** Get the current trusted-problem threshold. */
export function getTrustedThreshold(): number {
  return store.load().trustedThreshold ?? 2;
}

/** Set the trusted-problem threshold. Problems with ≥N consistent passes are trusted. */
export function setTrustedThreshold(n: number): void {
  const state = store.load();
  state.trustedThreshold = Math.max(1, Math.min(n, 10));
  state.updatedAt = new Date().toISOString();
  store.markDirty();
  store.save();
}

// ── Improvement trend tracking ────────────────────────────────────────────────────

export interface ProblemTrend {
  name: string;
  /** Trend direction based on call counts across recent runs */
  trend: "improving" | "regressing" | "stable" | "new";
  /** Pass/fail trend */
  passTrend: "always-pass" | "always-fail" | "improved-to-pass" | "regressed-to-fail" | "flaky" | "new";
  /** Recent run data for this problem */
  recentRuns: Array<{
    timestamp: string;
    passed: boolean;
    calls: number;
    tokens: number;
    promptHash: string;
  }>;
}

/** Compute per-problem improvement trends across recent runs.
 *  Groups runs by problem name and compares recent performance to earlier. */
export function getImprovementTrends(problemNames?: string[]): ProblemTrend[] {
  const state = store.load();
  const problemMap = new Map<string, Array<{
    timestamp: string;
    passed: boolean;
    calls: number;
    tokens: number;
    promptHash: string;
  }>>();

  // Collect all runs for each problem
  for (const [hash, runs] of Object.entries(state.runs)) {
    for (const run of runs) {
      if (problemNames && !problemNames.includes(run.problem)) continue;
      const existing = problemMap.get(run.problem) || [];
      existing.push({
        timestamp: run.timestamp,
        passed: run.passed,
        calls: run.calls,
        tokens: run.tokens,
        promptHash: hash,
      });
      problemMap.set(run.problem, existing);
    }
  }

  const trends: ProblemTrend[] = [];
  for (const [name, runs] of problemMap) {
    const sorted = runs.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    // Split into recent half and older half
    const mid = Math.floor(sorted.length / 2);
    const older = sorted.slice(0, mid);
    const recent = sorted.slice(mid);

    const olderAvgCalls = older.length > 0
      ? older.reduce((s, r) => s + r.calls, 0) / older.length
      : 0;
    const recentAvgCalls = recent.length > 0
      ? recent.reduce((s, r) => s + r.calls, 0) / recent.length
      : 0;

    // Determine call-count trend
    let trend: ProblemTrend["trend"];
    if (sorted.length < 2) {
      trend = "new";
    } else if (recentAvgCalls < olderAvgCalls * 0.85) {
      trend = "improving";
    } else if (recentAvgCalls > olderAvgCalls * 1.15) {
      trend = "regressing";
    } else {
      trend = "stable";
    }

    // Determine pass/fail trend
    const olderPassRate = older.length > 0
      ? older.filter(r => r.passed).length / older.length
      : 0;
    const recentPassRate = recent.length > 0
      ? recent.filter(r => r.passed).length / recent.length
      : 0;

    let passTrend: ProblemTrend["passTrend"];
    if (recentPassRate === 1 && olderPassRate === 1) passTrend = "always-pass";
    else if (recentPassRate === 0 && olderPassRate === 0) passTrend = "always-fail";
    else if (recentPassRate >= 0.8 && olderPassRate < 0.5) passTrend = "improved-to-pass";
    else if (recentPassRate < 0.5 && olderPassRate >= 0.8) passTrend = "regressed-to-fail";
    else if (recentPassRate > 0 && recentPassRate < 1) passTrend = "flaky";
    else passTrend = "always-fail";

    trends.push({
      name,
      trend,
      passTrend,
      recentRuns: sorted.slice(-5),
    });
  }

  // Sort: failing first (need attention), then flaky, then passing
  const priority: Record<string, number> = {
    "always-fail": 0, "regressed-to-fail": 1, "flaky": 2,
    "new": 3, "improving": 4, "stable": 5, "always-pass": 6, "improved-to-pass": 7,
  };
  trends.sort((a, b) => (priority[a.passTrend] ?? 5) - (priority[b.passTrend] ?? 5));

  return trends;
}

/** Format improvement trends as a human-readable string. */
export function formatImprovementTrends(trends: ProblemTrend[]): string {
  if (trends.length === 0) return "No improvement trend data available.";

  const lines: string[] = [];
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("  IMPROVEMENT TRENDS — per-problem trajectory across runs");
  lines.push("═══════════════════════════════════════════════════════════════");

  const byPassTrend = {
    "always-fail": trends.filter(t => t.passTrend === "always-fail"),
    "regressed-to-fail": trends.filter(t => t.passTrend === "regressed-to-fail"),
    "flaky": trends.filter(t => t.passTrend === "flaky"),
    "improved-to-pass": trends.filter(t => t.passTrend === "improved-to-pass"),
    "always-pass": trends.filter(t => t.passTrend === "always-pass"),
    "new": trends.filter(t => t.trend === "new"),
  };

  if (byPassTrend["always-fail"].length > 0) {
    lines.push(`\n  ✗ ALWAYS FAIL (${byPassTrend["always-fail"].length} problems) — highest priority:`);
    for (const t of byPassTrend["always-fail"]) {
      const callTrend = t.trend === "improving" ? "↓" : t.trend === "regressing" ? "↑" : "→";
      lines.push(`    ${t.name.padEnd(28)} ${callTrend} calls ${t.trend}`);
    }
  }

  if (byPassTrend["regressed-to-fail"].length > 0) {
    lines.push(`\n  ⚠ REGRESSED TO FAIL (${byPassTrend["regressed-to-fail"].length}) — was passing, now failing:`);
    for (const t of byPassTrend["regressed-to-fail"]) {
      lines.push(`    ${t.name.padEnd(28)} investigate what changed`);
    }
  }

  if (byPassTrend["flaky"].length > 0) {
    lines.push(`\n  ⚡ FLAKY (${byPassTrend["flaky"].length}) — non-deterministic:`);
    for (const t of byPassTrend["flaky"]) {
      lines.push(`    ${t.name.padEnd(28)} passes sometimes, fails other times — run --consistency`);
    }
  }

  if (byPassTrend["improved-to-pass"].length > 0) {
    lines.push(`\n  ✓ IMPROVED TO PASS (${byPassTrend["improved-to-pass"].length}) — was failing, now passing:`);
    for (const t of byPassTrend["improved-to-pass"]) {
      const callTrend = t.trend === "improving" ? "↓" : t.trend === "regressing" ? "↑" : "→";
      lines.push(`    ${t.name.padEnd(28)} ${callTrend} calls ${t.trend}`);
    }
  }

  if (byPassTrend["always-pass"].length > 0) {
    lines.push(`\n  ✓ ALWAYS PASS (${byPassTrend["always-pass"].length}) — rock solid:`);
    const improving = byPassTrend["always-pass"].filter(t => t.trend === "improving");
    const stable = byPassTrend["always-pass"].filter(t => t.trend === "stable");
    const regressing = byPassTrend["always-pass"].filter(t => t.trend === "regressing");
    if (improving.length > 0) lines.push(`    ${improving.length} getting faster ↓`);
    if (stable.length > 0) lines.push(`    ${stable.length} stable →`);
    if (regressing.length > 0) lines.push(`    ${regressing.length} getting slower ↑ (investigate)`);
  }

  lines.push("\n═══════════════════════════════════════════════════════════════");
  return lines.join("\n");
}

// ── "What if" cross-prompt analysis ───────────────────────────────────────────────

export interface WhatIfResult {
  problem: string;
  /** Most recent result with the current prompt */
  currentResult: { passed: boolean; calls: number; hash: string } | null;
  /** Results under OTHER prompt versions (excluding current) */
  otherVersions: Array<{
    hash: string;
    passed: boolean;
    calls: number;
    lastSeen: string;
    preview: string;
  }>;
  /** Did at least one other prompt version pass? */
  bestHistoricalPassed: boolean;
  /** If current fails but historical passed, which prompt hash? */
  regressionFrom: string | null;
}

/** Generate "what if" analysis: for each problem, show how it performed
 *  under different prompt versions. This answers: "would a different prompt
 *  have solved this problem?" — critical for evaluating prompt improvements. */
export function generateWhatIfAnalysis(problemNames?: string[]): WhatIfResult[] {
  const state = store.load();
  const results: WhatIfResult[] = [];

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
    const otherVersions: WhatIfResult["otherVersions"] = [];
    let currentResult: WhatIfResult["currentResult"] = null;

    for (const [hash, runs] of Object.entries(state.runs)) {
      const problemRuns = runs.filter(r => r.problem === problem);
      if (problemRuns.length === 0) continue;

      const latest = problemRuns.reduce((a, b) =>
        a.timestamp > b.timestamp ? a : b
      );

      const isCurrent = hash === state.currentHash;

      if (isCurrent) {
        currentResult = { passed: latest.passed, calls: latest.calls, hash };
      } else {
        otherVersions.push({
          hash,
          passed: latest.passed,
          calls: latest.calls,
          lastSeen: latest.timestamp,
          preview: latest.systemPromptPreview?.slice(0, 60) ?? "",
        });
      }
    }

    const anyHistoricalPassed = otherVersions.some(v => v.passed);
    let regressionFrom: string | null = null;

    if (currentResult && !currentResult.passed && anyHistoricalPassed) {
      regressionFrom = otherVersions.filter(v => v.passed)
        .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))[0]?.hash ?? null;
    }

    if (currentResult || otherVersions.length > 0) {
      results.push({
        problem,
        currentResult,
        otherVersions: otherVersions.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)),
        bestHistoricalPassed: anyHistoricalPassed,
        regressionFrom,
      });
    }
  }

  return results;
}

/** Format "what if" analysis as human-readable string. */
export function formatWhatIfReport(results: WhatIfResult[]): string {
  if (results.length === 0) return "No \"what if\" data available (need historical prompt data).";

  const lines: string[] = [];
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("  WHAT-IF ANALYSIS — how would different prompts have done?");
  lines.push("═══════════════════════════════════════════════════════════════");

  const regressions = results.filter(r => r.regressionFrom !== null);
  const newlyPassing = results.filter(r =>
    r.currentResult?.passed && r.otherVersions.length > 0 && !r.otherVersions.some(v => v.passed)
  );
  const alwaysPass = results.filter(r =>
    r.currentResult?.passed && r.otherVersions.length > 0 && r.otherVersions.every(v => v.passed)
  );

  lines.push(`\n  Total problems with history: ${results.length}`);

  if (regressions.length > 0) {
    lines.push(`\n  ⚠ PROMPT REGRESSIONS (${regressions.length}) — current prompt fails, previous succeeded:`);
    for (const r of regressions) {
      const passing = r.otherVersions.find(v => v.hash === r.regressionFrom);
      const callsStr = passing ? ` (${passing.calls}c)` : "";
      lines.push(`    ${r.problem.padEnd(28)} current: FAIL  |  ${r.regressionFrom!.slice(0, 8)}: PASS${callsStr} — revert prompt?`);
    }
  }

  if (newlyPassing.length > 0) {
    lines.push(`\n  ✓ PROMPT IMPROVEMENTS (${newlyPassing.length}) — current prompt succeeds where all previous failed:`);
    for (const r of newlyPassing) {
      lines.push(`    ${r.problem.padEnd(28)} current: PASS (${r.currentResult?.calls ?? 0}c) — prompt got better!`);
    }
  }

  if (alwaysPass.length > 0) {
    lines.push(`\n  ✓ ALWAYS PASS (${alwaysPass.length}) — passes with every prompt version:`);
    for (const r of alwaysPass) {
      lines.push(`    ${r.problem}`);
    }
  }

  const singleVersion = results.filter(r => r.otherVersions.length === 0);
  if (singleVersion.length > 0 && singleVersion.length < results.length) {
    lines.push(`\n  ? SINGLE VERSION (${singleVersion.length}) — no historical data to compare`);
  }

  lines.push("\n═══════════════════════════════════════════════════════════════");
  return lines.join("\n");
}

// ── Cache invalidation ───────────────────────────────────────────────────────────

/** Clear all prompt run data. Useful for fresh starts or after major prompt changes. */
export function clearPromptCache(): void {
  const state = store.load();
  // Reset all fields
  Object.keys(state.runs).forEach(k => delete state.runs[k]);
  Object.keys(state.summaries).forEach(k => delete state.summaries[k]);
  if (state.consistencyVerdicts) Object.keys(state.consistencyVerdicts).forEach(k => delete state.consistencyVerdicts[k]);
  state.currentHash = null;
  state.updatedAt = new Date().toISOString();
  store.markDirty();
  store.save();
}

// Auto-save on exit
process.on("exit", () => { store.save(); });
