/**
 * Benchmark harness — compares pipeline vs baseline across problem sets.
 *
 * Usage:
 *   bun run src/test/benchmark.ts --all                 # full benchmark
 *   bun run src/test/benchmark.ts --failing              # only previously failed
 *   bun run src/test/benchmark.ts --tier=hard            # all in one tier
 *   PROBLEM_FILTER="dijkstra|nash" bun run src/test/benchmark.ts
 *   bun run src/test/benchmark.ts fibonacci dijkstra     # specific problems
 *   bun run src/test/benchmark.ts --consistency          # run each problem 2x, flag flaky
 *   CONSISTENCY_RUNS=3 bun run src/test/benchmark.ts --consistency --all
 *   bun run src/test/benchmark.ts --prompt-report        # show prompt version history
 *   bun run src/test/benchmark.ts --cross-prompt         # per-problem comparison across prompt versions
 *   bun run src/test/benchmark.ts --cross-prompt fibonacci  # cross-prompt for specific problem
 *   bun run src/test/benchmark.ts --force                # re-run even trusted problems
 *   bun run src/test/benchmark.ts --fresh                 # bypass LLM response cache (passes nonce)
 *   bun run src/test/benchmark.ts --no-prompt-cache       # disable trusted-problem skipping
 *   bun run src/test/benchmark.ts --consistency-report     # show persisted consistency verdicts
 */

import { PROBLEMS, type TestProblem } from "./benchmark-problems";
import { execSync } from "child_process";
import { recordEfficiency, printEfficiencyReport } from "../analysis/efficiency-tracker";
import type { ProblemEfficiency } from "../analysis/efficiency-tracker";
import { formatMs, formatTokens, formatCost } from "../utils/format";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import {
  recordPromptRun,
  recordConsistencyVerdict,
  getConsistencyVerdicts,
  getConsistencyReport,
  formatConsistencyReport,
  generatePromptReport,
  generateCrossPromptComparison,
  formatCrossPromptReport,
  getTrustedProblems,
  getTrustedThreshold,
  getLastTrustedRun,
  getCurrentPromptHash,
} from "../analysis/prompt-version-tracker";
import { getCacheStats } from "../llm/cache";

const ROOT = resolve(dirname(import.meta.filename!), "..", "..");

// ── Helpers ──────────────────────────────────────────────────────────────────

function lastLogPath(): string | null {
  const latest = resolve(ROOT, "latest.log");
  try {
    readFileSync(latest, "utf-8");
    return latest;
  } catch {
    return null;
  }
}

function countCalls(logPath: string): number {
  try {
    const content = readFileSync(logPath, "utf-8");
    return (content.match(/^\[.+\] CALL #\d+/gm) || []).length;
  } catch {
    return 0;
  }
}

function totalTokens(logPath: string): number {
  try {
    const content = readFileSync(logPath, "utf-8");
    const matches = content.matchAll(/tokens:\s*\d+p\s*\+\s*\d+c\s*=\s*(\d+)/g);
    let total = 0;
    for (const m of matches) total += parseInt(m[1]!, 10);
    return total;
  } catch {
    return 0;
  }
}

function totalCost(logPath: string): number {
  try {
    const content = readFileSync(logPath, "utf-8");
    const matches = content.matchAll(/cost:\s*\$([\d.]+)/g);
    let total = 0;
    for (const m of matches) total += parseFloat(m[1]!);
    return total;
  } catch {
    return 0;
  }
}

function runPipeline(problem: TestProblem, nonce?: string): { passed: boolean; calls: number; tokens: number; cost: number; durationMs: number; solvedBy: string; systemPromptHash: string } {
  const domain = problem.domain || "auto";
  const projectTestsJson = problem.projectTests ? JSON.stringify(problem.projectTests) : "";
  const langEnv = problem.language ? `PROBLEM_LANGUAGE=${problem.language}` : "";
  try {
    const t0 = Date.now();
    // Shell-escape special characters for the command string.
    // All values are also passed via the env object (safe, no shell interpretation),
    // but the shell command string needs escaping for $, `, \, and ".
    const shellEscape = (s: string) => s.replace(/[\\"$`!]/g, '\\$&').replace(/\n/g, ' ');
    const descEscaped = shellEscape(problem.description);
    // Fresh mode: pass a nonce to bypass LLM response cache (forces fresh API calls)
    const nonceEnv = nonce ? `LLM_NONCE=${nonce}` : "";
    // Fresh mode: bypass LLM response cache for the subprocess
    const cacheMode = nonce ? { CACHE_MODE: "off" } : {};
    const nonceEnvVar = nonce ? { LLM_NONCE: nonce } : {};
    const output = execSync(
      `${nonceEnv} ${langEnv} PROBLEM_COMPLEXITY=${problem.complexity} DOMAIN=${domain} PROBLEM_DESC="${descEscaped}" NO_UI=1 bun run ${ROOT}/src/main.ts`,
      { cwd: ROOT, timeout: 300_000, encoding: "utf-8", env: { ...process.env, DOMAIN: domain, PROBLEM_DESC: problem.description, PROBLEM_COMPLEXITY: problem.complexity, NO_UI: "1", PROJECT_TESTS: projectTestsJson, PROBLEM_LANGUAGE: problem.language || "", ...nonceEnvVar, ...cacheMode } }
    );
    const duration = Date.now() - t0;

    // Parse structured result from stdout (most reliable — doesn't depend on log files)
    let passed = false;
    let jsonCalls = 0;
    let solvedBy = "unknown";
    let systemPromptHash = "";
    const resultLine = output.split("\n").find(l => l.includes('"result"'));
    if (resultLine) {
      try {
        const parsed = JSON.parse(resultLine.trim());
        passed = parsed.result?.solved === true;
        jsonCalls = parsed.result?.totalCalls ?? 0;
        solvedBy = parsed.result?.solvedBy ?? "unknown";
        systemPromptHash = parsed.result?.systemPromptHash ?? "";
      } catch { /* fall through */ }
    }
    if (!resultLine) {
      passed = /✓ SOLVED|PROBLEM SOLVED|FINAL ANSWER/i.test(output);
    }

    const log = lastLogPath();
    // Prefer JSON-reported call count (accurate, not affected by log rotation)
    const calls = jsonCalls > 0 ? jsonCalls : (log ? countCalls(log) : 0);
    const tokens = log ? totalTokens(log) : 0;
    const cost = log ? totalCost(log) : 0;

    return { passed, calls, tokens, cost, durationMs: duration, solvedBy, systemPromptHash };
  } catch (err: any) {
    const log = lastLogPath();
    const calls = log ? countCalls(log) : 0;
    const tokens = log ? totalTokens(log) : 0;
    const cost = log ? totalCost(log) : 0;
    return { passed: false, calls, tokens, cost, durationMs: 0, solvedBy: "crash", systemPromptHash: "" };
  }
}

// ── Filter logic ──────────────────────────────────────────────────────────────

let isConsistency = false;
let isCrossPrompt = false;
let skipTrusted = true; // default: skip problems with >2 consistent passes
let showPromptReport = false;
let isFresh = false;            // bypass LLM response cache
let isEvaluateStrategies = false; // run each problem with each prompt strategy
let showConsistencyReport = false;
let showWhatIf = false;
let showTrends = false;

function getProblems(args: string[]): { problems: TestProblem[]; label: string } {
  let mode: "all" | "failing" | "tier" | "named" = "named";
  let tierFilter: string | null = null;
  const names: string[] = [];

  for (const arg of args) {
    if (arg === "--all") mode = "all";
    else if (arg === "--failing") mode = "failing";
    else if (arg === "--consistency") { isConsistency = true; }
    else if (arg === "--cross-prompt") { isCrossPrompt = true; }
    else if (arg === "--force") { skipTrusted = false; }
    else if (arg === "--fresh") { isFresh = true; }
    else if (arg === "--no-prompt-cache") { skipTrusted = false; }
    else if (arg === "--prompt-report") { showPromptReport = true; }
    else if (arg === "--consistency-report") { showConsistencyReport = true; }
    else if (arg === "--what-if") { showWhatIf = true; }
    else if (arg === "--trends") { showTrends = true; }
    else if (arg === "--evaluate-strategies") { isEvaluateStrategies = true; }
    else if (arg.startsWith("--tier=")) { mode = "tier"; tierFilter = arg.slice(7); }
    else if (arg.startsWith("--")) continue;
    else names.push(arg);
  }

  const envFilter = process.env.PROBLEM_FILTER;
  let problems = PROBLEMS;

  if (mode === "named" && names.length > 0) {
    problems = PROBLEMS.filter(p => names.some(n => p.name === n || p.name.includes(n)));
  } else if (mode === "failing") {
    try {
      const statePath = resolve(ROOT, "src/analysis/.efficiency-state.json");
      const state = JSON.parse(readFileSync(statePath, "utf-8"));
      const failingNames: string[] = [];
      if (state.previous?.problems) {
        for (const p of state.previous.problems) {
          if (!p.passed) failingNames.push(p.name);
        }
      }
      if (failingNames.length > 0) {
        problems = PROBLEMS.filter(p => failingNames.includes(p.name));
      }
    } catch {
      console.log("  No previous efficiency data — running all problems");
    }
  } else if (mode === "tier" && tierFilter) {
    problems = PROBLEMS.filter(p => p.complexity === tierFilter);
  }

  if (envFilter) {
    const re = new RegExp(envFilter, "i");
    problems = problems.filter(p => re.test(p.name));
  }

  return { problems, label: mode === "failing" ? "failing" : mode === "tier" ? `tier=${tierFilter}` : mode === "all" ? "all" : names.join(",") };
}

// ── Consistency check ────────────────────────────────────────────────────────

interface ConsistencyResult {
  name: string;
  complexity: string;
  runs: { passed: boolean; calls: number; tokens: number; durationMs: number }[];
  stable: boolean;
  verdict: "stable-pass" | "stable-fail" | "flaky";
}

async function runConsistencyCheck(problems: TestProblem[], runCount: number): Promise<void> {
  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log(`  CONSISTENCY CHECK — ${problems.length} problem(s) × ${runCount} runs each`);
  console.log(`  Flaky = different results across runs (pass vs fail)`);
  console.log(`═══════════════════════════════════════════════════════════════\n`);

  const results: ConsistencyResult[] = [];
  const startTime = Date.now();

  for (let i = 0; i < problems.length; i++) {
    const p = problems[i]!;
    const progress = `[${i + 1}/${problems.length}]`;
    const runs: ConsistencyResult["runs"] = [];

    for (let r = 0; r < runCount; r++) {
      process.stdout.write(`${progress} ${p.name} run ${r + 1}/${runCount}… `);
      const nonce = isFresh ? `consistency-${i}-${r}-${Date.now()}` : undefined;
      const pl = runPipeline(p, nonce);
      const icon = pl.passed ? "PASS" : "FAIL";
      console.log(`${icon} (${pl.calls}c ${formatTokens(pl.tokens)} ${formatMs(pl.durationMs)})`);
      runs.push({ passed: pl.passed, calls: pl.calls, tokens: pl.tokens, durationMs: pl.durationMs });
    }

    const allPassed = runs.every(r => r.passed);
    const allFailed = runs.every(r => !r.passed);
    const stable = allPassed || allFailed;
    const verdict = allPassed ? "stable-pass" as const : allFailed ? "stable-fail" as const : "flaky" as const;

    // Persist consistency verdict for cross-session flakiness detection
    const passCount = runs.filter(r => r.passed).length;
    const failCount = runs.filter(r => !r.passed).length;
    recordConsistencyVerdict(p.name, verdict, runs.length, passCount, failCount);

    results.push({ name: p.name, complexity: p.complexity, runs, stable, verdict });
  }

  const elapsed = Date.now() - startTime;

  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log(`  CONSISTENCY REPORT`);
  console.log(`═══════════════════════════════════════════════════════════════`);

  const stablePass = results.filter(r => r.verdict === "stable-pass");
  const stableFail = results.filter(r => r.verdict === "stable-fail");
  const flaky = results.filter(r => r.verdict === "flaky");

  if (stablePass.length > 0) {
    console.log(`\n  ✓ Stable-pass (${stablePass.length} problems) — always passes:`);
    for (const r of stablePass) {
      const calls = r.runs.map(run => run.calls).join(",");
      console.log(`    ${r.name.padEnd(24)} ${r.runs.length}x PASS  calls=[${calls}]`);
    }
  }

  if (stableFail.length > 0) {
    console.log(`\n  ✗ Stable-fail (${stableFail.length} problems) — consistently failing:`);
    for (const r of stableFail) {
      const calls = r.runs.map(run => run.calls).join(",");
      console.log(`    ${r.name.padEnd(24)} ${r.runs.length}x FAIL  calls=[${calls}]`);
    }
  }

  if (flaky.length > 0) {
    console.log(`\n  ⚡ FLAKY (${flaky.length} problems) — NON-DETERMINISTIC RESULTS:`);
    for (const r of flaky) {
      const pattern = r.runs.map(run => run.passed ? "PASS" : "FAIL").join(" → ");
      console.log(`    ${r.name.padEnd(24)} ${pattern}`);
    }
    console.log(`\n  These problems sometimes pass and sometimes fail WITHOUT code changes.`);
    console.log(`  Root causes to investigate:`);
    console.log(`    - LLM-generated oracle with ambiguous acceptance criteria`);
    console.log(`    - Stochastic problem without proper seeding`);
    console.log(`    - Race conditions or timeout variance`);
    console.log(`    - LLM non-determinism (temperature > 0)`);
  }

  if (flaky.length === 0) {
    console.log(`\n  ✓ No flaky problems detected — benchmark is consistent.`);
  }

  console.log(`\n  Stable: ${stablePass.length + stableFail.length}/${results.length}  Flaky: ${flaky.length}/${results.length}`);

  // ── Persist consistency verdicts ──────────────────────────────────────────
  console.log(`\n  Persisting consistency verdicts...`);
  for (const r of results) {
    const passes = r.runs.filter(run => run.passed).length;
    const failures = r.runs.filter(run => !run.passed).length;
    try {
      recordConsistencyVerdict(r.name, r.verdict, r.runs.length, passes, failures);
    } catch (err) {
      console.log(`    ⚠ Failed to persist ${r.name}: ${(err as Error).message}`);
    }
  }
  console.log(`  ✓ Saved ${results.length} verdict(s) to .prompt-versions.json`);

  // ── Also persist individual runs for prompt-version tracking ──────────────
  const currentHash = getCurrentPromptHash();
  if (currentHash) {
    for (const r of results) {
      const problem = problems.find(p => p.name === r.name);
      if (problem) {
        for (const run of r.runs) {
          try {
            recordPromptRun({
              timestamp: new Date().toISOString(),
              problem: r.name,
              systemPromptHash: currentHash,
              systemPromptPreview: `[consistency-check] ${r.name}`,
              userPrompt: problem.description,
              complexity: r.complexity,
              passed: run.passed,
              calls: run.calls,
              tokens: run.tokens,
              solvedBy: "consistency-check",
            });
          } catch { /* best-effort */ }
        }
      }
    }
  }

  console.log(`  Total time: ${formatMs(elapsed)}`);
  console.log(`═══════════════════════════════════════════════════════════════\n`);
}

// ── Benchmark ─────────────────────────────────────────────────────────────────

async function runBenchmark(problems: TestProblem[], label: string, skipTrusted: boolean): Promise<void> {
  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log(`  BENCHMARK — ${problems.length} problem(s) (${label})`);
  console.log(`═══════════════════════════════════════════════════════════════\n`);

  // Determine which problems to skip (trusted = >2 runs, all passing with current prompt)
  const skippedProblems: string[] = [];
  const activeProblems: TestProblem[] = [];

  const currentHash = getCurrentPromptHash();
  if (skipTrusted && currentHash) {
    const trustedNames = new Set(getTrustedProblems());
    for (const p of problems) {
      if (trustedNames.has(p.name)) {
        skippedProblems.push(p.name);
      } else {
        activeProblems.push(p);
      }
    }
    if (skippedProblems.length > 0) {
      const threshold = getTrustedThreshold();
      console.log(`  ⏭  Skipping ${skippedProblems.length} trusted problem(s) (≥${threshold} consistent passes with current prompt):`);
      for (const name of skippedProblems) {
        const lastRun = getLastTrustedRun(name, currentHash);
        if (lastRun) {
          const date = lastRun.timestamp.slice(0, 19);
          const callsStr = `${lastRun.calls}c`;
          const tokensStr = lastRun.tokens > 0 ? ` ${formatTokens(lastRun.tokens)}` : "";
          console.log(`     ✓ ${name.padEnd(24)} last: ${date} | ${lastRun.passed ? "PASS" : "FAIL"} | ${callsStr}${tokensStr}`);
        } else {
          console.log(`     ✓ ${name}`);
        }
      }
      console.log(`  Use --force to re-run all problems.\n`);
    }
  } else {
    activeProblems.push(...problems);
  }

  const results: ProblemEfficiency[] = [];
  let totalPipelineCalls = 0;
  let totalPipelineTokens = 0;
  let totalPipelineCost = 0;
  let totalPipelineMs = 0;
  let passed = 0;

  const startTime = Date.now();

  for (let i = 0; i < activeProblems.length; i++) {
    const p = activeProblems[i]!;
    const progress = `[${i + 1}/${activeProblems.length}]`;
    console.log(`${progress} ${p.name} (${p.complexity})…`);

    // Fresh mode: use a per-run nonce to bypass LLM response cache
    const nonce = isFresh ? `bench-${i}-${Date.now()}` : undefined;
    const pl = runPipeline(p, nonce);
    const costStr = pl.cost > 0 ? `  ${formatCost(pl.cost)}` : '';
    const byStr = pl.solvedBy !== "unknown" ? ` [${pl.solvedBy}]` : '';
    const hashStr = pl.systemPromptHash ? ` prompt=${pl.systemPromptHash}` : '';
    console.log(`  ${pl.passed ? "PASS" : "FAIL"} in ${pl.calls} calls, ${formatTokens(pl.tokens)}${costStr}, ${formatMs(pl.durationMs)}${byStr}${hashStr}`);

    if (pl.passed) passed++;

    // Record prompt run for version tracking
    if (pl.systemPromptHash) {
      recordPromptRun({
        timestamp: new Date().toISOString(),
        problem: p.name,
        systemPromptHash: pl.systemPromptHash,
        systemPromptPreview: `[hash: ${pl.systemPromptHash}]`,
        userPrompt: p.description,
        complexity: p.complexity,
        passed: pl.passed,
        calls: pl.calls,
        tokens: pl.tokens,
        solvedBy: pl.solvedBy,
      });
    }

    results.push({
      name: p.name,
      complexity: p.complexity,
      pipelineCalls: pl.calls,
      pipelineTokens: pl.tokens,
      pipelineCost: pl.cost,
      baselineCalls: 1,
      llmAloneCalls: 1,
      passed: pl.passed,
      solvedBy: pl.solvedBy,
      promptHash: pl.systemPromptHash,
    });

    totalPipelineCalls += pl.calls;
    totalPipelineTokens += pl.tokens;
    totalPipelineCost += pl.cost;
    totalPipelineMs += pl.durationMs;
  }

  const elapsed = Date.now() - startTime;

  // ── Summary ───────────────────────────────────────────────────────────
  const totalProblems = problems.length;
  const totalActive = activeProblems.length;
  const totalSkipped = skippedProblems.length;

  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log(`  SUMMARY`);
  console.log(`═══════════════════════════════════════════════════════════════`);
  console.log(`  Problems:       ${totalProblems} (${totalActive} run, ${totalSkipped} skipped)`);
  console.log(`  Passed:         ${passed}/${totalActive} (${totalActive > 0 ? (passed / totalActive * 100).toFixed(0) : 0}%)`);
  console.log(`  Total calls:    ${totalPipelineCalls}`);
  if (totalActive > 0) {
    console.log(`  Avg calls:      ${(totalPipelineCalls / totalActive).toFixed(1)} per problem`);
    console.log(`  Total tokens:   ${formatTokens(totalPipelineTokens)}`);
    console.log(`  Avg tokens:     ${formatTokens(totalPipelineTokens / totalActive)} per problem`);
  }
  if (totalPipelineCost > 0) {
    console.log(`  Total cost:     ${formatCost(totalPipelineCost)}`);
    if (totalActive > 0) {
      console.log(`  Avg cost:       ${formatCost(totalPipelineCost / totalActive)} per problem`);
    }
  }
  console.log(`  Total time:     ${formatMs(elapsed)}`);

  console.log(`\n  Per-problem:`);
  for (const r of results) {
    const icon = r.passed ? "✓" : "✗";
    const costLine = r.pipelineCost ? `  ${formatCost(r.pipelineCost)}` : '';
    console.log(`    ${icon} ${r.name.padEnd(22)} ${String(r.pipelineCalls).padStart(2)} calls  ${formatTokens(r.pipelineTokens).padStart(8)}${costLine}`);
  }
  for (const name of skippedProblems) {
    console.log(`    ✓ ${name.padEnd(22)}  SKIPPED (trusted — >2 consistent passes)`);
  }

  try {
    const diff = recordEfficiency(results);
    printEfficiencyReport(diff);
  } catch (err) {
    console.log(`  [efficiency] Failed to record: ${(err as Error).message}`);
  }

  // ── Cross-prompt analysis (always shown after benchmarks with multi-version data) ──
  const crossPrompt = generateCrossPromptComparison();
  if (crossPrompt.length > 0) {
    const multiVersion = crossPrompt.filter(r => r.versionCount > 1);
    if (multiVersion.length > 0) {
      console.log(formatCrossPromptReport(crossPrompt));
    }
  }

  // ── Cache stats ────────────────────────────────────────────────────────
  try {
    const stats = getCacheStats();
    const hitPct = stats.lookups > 0 ? (stats.hitRate * 100).toFixed(0) : "--";
    console.log("\n" + "─".repeat(66));
    console.log(`  LLM Cache: ${stats.hits} hits / ${stats.lookups} lookups (${hitPct}% hit rate)  |  ${stats.sets} new entries`);
    console.log(`  Mode: ${stats.enabled ? "enabled" : "off"}`);
    console.log("─".repeat(66));
  } catch { /* non-critical */ }

  // ── What-if analysis ───────────────────────────────────────────────────
  try {
    const whatIfResults = generateWhatIfAnalysis(activeProblems.map(p => p.name));
    const multiWif = whatIfResults.filter(r => r.otherVersions.length > 0);
    if (multiWif.length > 0) {
      const regs = multiWif.filter(r => r.regressionFrom !== null);
      const imps = multiWif.filter(r => r.currentResult?.passed && !r.otherVersions.some(v => v.passed));
      if (regs.length > 0 || imps.length > 0) {
        console.log(formatWhatIfReport(whatIfResults));
      }
    }
  } catch { /* non-critical */ }

  // ── Improvement trends ──────────────────────────────────────────────────
  try {
    const tp = [...activeProblems.map(p => p.name), ...skippedProblems];
    const trends = getImprovementTrends(tp);
    if (trends.length > 0) console.log(formatImprovementTrends(trends));
  } catch { /* non-critical */ }}

// ── What-if analysis ─────────────────────────────────────────────────────────────
// Answers: "If we'd used prompt version X instead of the current one, what would
// the result be?" Shows regressions and improvements across prompt versions.

interface WhatIfResult {
  problem: string;
  /** Current prompt's result (null if not run yet) */
  currentResult: { passed: boolean; calls: number; tokens: number } | null;
  /** Results from other prompt versions */
  otherVersions: Array<{
    hash: string;
    passed: boolean;
    calls: number;
    lastUsed: string;
    preview: string;
  }>;
  /** Which prompt version this regressed FROM (was passing, now failing) */
  regressionFrom: string | null;
  /** Was this problem never tested with the current prompt? */
  untested: boolean;
}

/** Generate per-problem "what-if" comparison: what would happen with different
 *  prompt versions? */
function generateWhatIfAnalysis(problemNames?: string[]): WhatIfResult[] {
  const state = (() => {
    // Access prompt version state via the cross-prompt data
    const cross = generateCrossPromptComparison(problemNames);
    const currentHash = getCurrentPromptHash();
    return { cross, currentHash };
  })();

  const results: WhatIfResult[] = [];
  for (const cp of state.cross) {
    const currentVersion = state.currentHash
      ? cp.versions.find(v => v.hash === state.currentHash)
      : undefined;
    const otherVersions = cp.versions.filter(v => v.hash !== state.currentHash);

    // Find regression: current FAILS but a previous version PASSED
    let regressionFrom: string | null = null;
    if (currentVersion && !currentVersion.passed) {
      const prevPassing = otherVersions.find(v => v.passed);
      if (prevPassing) regressionFrom = prevPassing.hash;
    }

    results.push({
      problem: cp.problem,
      currentResult: currentVersion
        ? { passed: currentVersion.passed, calls: currentVersion.calls, tokens: currentVersion.tokens }
        : null,
      otherVersions,
      regressionFrom,
      untested: !currentVersion,
    });
  }

  return results.sort((a, b) => {
    // Regressions first, then untested, then improvements, then stable
    const score = (r: WhatIfResult) => {
      if (r.regressionFrom) return 0;
      if (r.untested) return 1;
      if (r.currentResult?.passed && r.otherVersions.some(v => !v.passed)) return 2;
      return 3;
    };
    return score(a) - score(b) || a.problem.localeCompare(b.problem);
  });
}

/** Format what-if analysis as human-readable text. */
function formatWhatIfReport(results: WhatIfResult[]): string {
  if (results.length === 0) return "No what-if data available.";

  const lines: string[] = [];
  lines.push("═".repeat(70));
  lines.push("  WHAT-IF ANALYSIS — across prompt versions");
  lines.push("═".repeat(70));

  const regressions = results.filter(r => r.regressionFrom);
  const improvements = results.filter(r => r.currentResult?.passed && r.otherVersions.some(v => !v.passed));
  const stables = results.filter(r => !r.regressionFrom && !r.untested && !improvements.includes(r));
  const untested = results.filter(r => r.untested);

  lines.push(`\n  ${regressions.length} regressions  |  ${improvements.length} improvements  |  ${stables.length} stable  |  ${untested.length} untested`);

  if (regressions.length > 0) {
    lines.push(`\n  ⚠  REGRESSIONS — was passing, now failing with current prompt:`);
    for (const r of regressions) {
      const prev = r.otherVersions.find(v => v.hash === r.regressionFrom);
      const prevTag = prev ? ` (was ${prev.passed ? 'PASS' : 'FAIL'} with ${prev.hash})` : '';
      const currTag = r.currentResult ? ` ${r.currentResult.calls}c` : ' untested';
      lines.push(`    ✗ ${r.problem.padEnd(30)} current: FAIL${currTag}${prevTag}`);
    }
  }

  if (improvements.length > 0) {
    lines.push(`\n  ✓ IMPROVEMENTS — now passing, previously failed:`);
    for (const r of improvements) {
      const prevs = r.otherVersions.filter(v => !v.passed);
      const prevTag = prevs.length > 0 ? ` (was FAIL with ${prevs.map(v => v.hash).join(', ')})` : '';
      lines.push(`    ✓ ${r.problem.padEnd(30)} now PASS${prevTag}`);
    }
  }

  if (untested.length > 0 && untested.length < 5) {
    lines.push(`\n  ? UNTESTED — no data with current prompt:`);
    for (const r of untested) {
      const best = r.otherVersions.sort((a, b) => (b.passed ? 1 : 0) - (a.passed ? 1 : 0))[0];
      const bestTag = best ? ` (best: ${best.passed ? 'PASS' : 'FAIL'} with ${best.hash})` : '';
      lines.push(`    ? ${r.problem.padEnd(30)}${bestTag}`);
    }
  }

  lines.push("\n" + "═".repeat(70));
  return lines.join("\n");
}

// ── Improvement trends ───────────────────────────────────────────────────────────

interface ImprovementTrend {
  problem: string;
  runs: number;
  /** Pass rate over time */
  passRate: number;
  /** Average calls over time */
  avgCalls: number;
  /** Direction: "improving" | "regressing" | "stable" | "flaky" */
  direction: "improving" | "regressing" | "stable" | "flaky";
  /** Recent performance (last 5 runs) */
  recentRuns: Array<{ passed: boolean; calls: number }>;
}

/** Get per-problem improvement trends from cross-prompt data. */
function getImprovementTrends(problemNames?: string[]): ImprovementTrend[] {
  const cross = generateCrossPromptComparison(problemNames);
  if (cross.length === 0) return [];

  const trends: ImprovementTrend[] = [];

  for (const cp of cross) {
    const allRuns = cp.versions.sort((a, b) => b.lastUsed.localeCompare(a.lastUsed));
    if (allRuns.length < 2) continue; // need at least 2 runs to detect trend

    const recentRuns = allRuns.slice(0, Math.min(5, allRuns.length)).map(v => ({
      passed: v.passed,
      calls: v.calls,
    }));

    const totalPasses = allRuns.filter(v => v.passed).length;
    const passRate = allRuns.length > 0 ? totalPasses / allRuns.length : 0;
    const totalCalls = allRuns.reduce((s, v) => s + v.calls, 0);
    const avgCalls = allRuns.length > 0 ? totalCalls / allRuns.length : 0;

    // Determine direction: compare first half vs second half
    const mid = Math.ceil(allRuns.length / 2);
    const firstHalf = allRuns.slice(mid);
    const secondHalf = allRuns.slice(0, mid);
    const firstPassRate = firstHalf.filter(v => v.passed).length / (firstHalf.length || 1);
    const secondPassRate = secondHalf.filter(v => v.passed).length / (secondHalf.length || 1);

    let direction: ImprovementTrend["direction"];
    if (firstPassRate === secondPassRate) {
      direction = "stable";
    } else if (secondPassRate > firstPassRate) {
      direction = "improving";
    } else {
      // Check if results are mixed (pass and fail) — could be flaky
      const hasBoth = allRuns.some(v => v.passed) && allRuns.some(v => !v.passed);
      direction = hasBoth ? "flaky" : "regressing";
    }

    trends.push({
      problem: cp.problem,
      runs: allRuns.length,
      passRate,
      avgCalls,
      direction,
      recentRuns,
    });
  }

  return trends.sort((a, b) => {
    const priority: Record<string, number> = { regressing: 0, flaky: 1, improving: 2, stable: 3 };
    return (priority[a.direction] ?? 3) - (priority[b.direction] ?? 3);
  });
}

/** Format improvement trends as human-readable text. */
function formatImprovementTrends(trends: ImprovementTrend[]): string {
  if (trends.length === 0) return "No trend data available (need at least 2 runs per problem).";

  const lines: string[] = [];
  lines.push("═".repeat(70));
  lines.push("  IMPROVEMENT TRENDS — per-problem direction over time");
  lines.push("═".repeat(70));

  const byDir = {
    improving: trends.filter(t => t.direction === "improving"),
    regressing: trends.filter(t => t.direction === "regressing"),
    flaky: trends.filter(t => t.direction === "flaky"),
    stable: trends.filter(t => t.direction === "stable"),
  };

  if (byDir.regressing.length > 0) {
    lines.push(`\n  ⚠  REGRESSING (${byDir.regressing.length} problems) — getting worse:`);
    for (const t of byDir.regressing) {
      const recent = t.recentRuns.map(r => r.passed ? "✓" : "✗").join("");
      lines.push(`    ${t.problem.padEnd(30)} ${(t.passRate * 100).toFixed(0)}% pass  ${t.runs}runs  avg ${t.avgCalls.toFixed(1)}c  [${recent}]`);
    }
  }

  if (byDir.flaky.length > 0) {
    lines.push(`\n  ⚡ FLAKY (${byDir.flaky.length} problems) — inconsistent:`);
    for (const t of byDir.flaky) {
      const recent = t.recentRuns.map(r => r.passed ? "✓" : "✗").join("");
      lines.push(`    ${t.problem.padEnd(30)} ${(t.passRate * 100).toFixed(0)}% pass  ${t.runs}runs  avg ${t.avgCalls.toFixed(1)}c  [${recent}]`);
    }
  }

  if (byDir.improving.length > 0) {
    lines.push(`\n  ✓ IMPROVING (${byDir.improving.length} problems):`);
    for (const t of byDir.improving) {
      const recent = t.recentRuns.map(r => r.passed ? "✓" : "✗").join("");
      lines.push(`    ${t.problem.padEnd(30)} ${(t.passRate * 100).toFixed(0)}% pass  ${t.runs}runs  avg ${t.avgCalls.toFixed(1)}c  [${recent}]`);
    }
  }

  if (byDir.stable.length > 0 && byDir.stable.length < 10) {
    lines.push(`\n  → STABLE (${byDir.stable.length} problems):`);
    for (const t of byDir.stable) {
      lines.push(`    ${t.problem.padEnd(30)} ${(t.passRate * 100).toFixed(0)}% pass  ${t.runs}runs`);
    }
  }

  lines.push("\n" + "═".repeat(70));
  return lines.join("\n");
}

// ── Strategy evaluation ───────────────────────────────────────────────────────

interface StrategyResult {
  strategy: string;
  problem: string;
  passed: boolean;
  calls: number;
  tokens: number;
  durationMs: number;
  solvedBy: string;
}

async function runStrategyEvaluation(problems: TestProblem[]): Promise<void> {
  const promptsPath = resolve(ROOT, "prompts.json");
  let strategyCatalog: Record<string, string>;
  try {
    strategyCatalog = JSON.parse(readFileSync(promptsPath, "utf-8"));
  } catch {
    console.log("  Cannot load prompts.json — skipping strategy evaluation.");
    return;
  }

  const strategies = Object.entries(strategyCatalog);
  if (strategies.length === 0) return;

  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log(`  STRATEGY EVALUATION — ${problems.length} problem(s) × ${strategies.length} strategies`);
  console.log(`  Testing which prompt strategy works best for each problem`);
  console.log(`═══════════════════════════════════════════════════════════════\n`);

  const results: StrategyResult[] = [];
  const startTime = Date.now();

  for (let i = 0; i < problems.length; i++) {
    const p = problems[i]!;
    for (let j = 0; j < strategies.length; j++) {
      const [stratName, stratPrompt] = strategies[j]!;
      const progress = `[${i + 1}/${problems.length}][${j + 1}/${strategies.length}]`;
      process.stdout.write(`${progress} ${p.name} × ${stratName}… `);

      try {
        // Run pipeline with strategy injected as SYSTEM_PROMPT_STRATEGY
        const t0 = Date.now();
        const domain = p.domain || "auto";
        const projectTestsJson = p.projectTests ? JSON.stringify(p.projectTests) : "";
        const descEscaped = p.description.replace(/[\\"$`!]/g, '\\$&').replace(/\n/g, ' ');
        const output = execSync(
          `SYSTEM_PROMPT_STRATEGY_NAME="${stratName}" SYSTEM_PROMPT_STRATEGY="${stratPrompt.replace(/"/g, '\\"')}" PROBLEM_COMPLEXITY=${p.complexity} DOMAIN=${domain} PROBLEM_DESC="${descEscaped}" NO_UI=1 bun run ${ROOT}/src/main.ts`,
          { cwd: ROOT, timeout: 300_000, encoding: "utf-8", env: { ...process.env, DOMAIN: domain, PROBLEM_DESC: p.description, PROBLEM_COMPLEXITY: p.complexity, NO_UI: "1", PROJECT_TESTS: projectTestsJson, PROBLEM_LANGUAGE: p.language || "", SYSTEM_PROMPT_STRATEGY: stratPrompt, SYSTEM_PROMPT_STRATEGY_NAME: stratName } }
        );
        const duration = Date.now() - t0;

        let passed = false;
        let calls = 0;
        let solvedBy = "unknown";
        const resultLine = output.split("\n").find(l => l.includes('"result"'));
        if (resultLine) {
          try {
            const parsed = JSON.parse(resultLine.trim());
            passed = parsed.result?.solved === true;
            calls = parsed.result?.totalCalls ?? 0;
            solvedBy = parsed.result?.solvedBy ?? "unknown";
          } catch { /* fall through */ }
        }

        const log = lastLogPath();
        const tokens = log ? totalTokens(log) : 0;

        const icon = passed ? "PASS" : "FAIL";
        console.log(`${icon} (${calls}c ${formatMs(duration)})`);
        results.push({ strategy: stratName, problem: p.name, passed, calls, tokens, durationMs: duration, solvedBy });
      } catch (err: any) {
        console.log(`ERROR (${err?.message?.slice(0, 60) || "unknown"})`);
        results.push({ strategy: stratName, problem: p.name, passed: false, calls: 0, tokens: 0, durationMs: 0, solvedBy: "crash" });
      }
    }
  }

  // ── Strategy matrix output ─────────────────────────────────────────────
  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log(`  STRATEGY MATRIX — problem × strategy → pass/fail`);
  console.log(`═══════════════════════════════════════════════════════════════\n`);

  // Per-strategy summary
  const stratSummary = new Map<string, { passes: number; fails: number; totalCalls: number }>();
  for (const r of results) {
    const s = stratSummary.get(r.strategy) || { passes: 0, fails: 0, totalCalls: 0 };
    if (r.passed) s.passes++; else s.fails++;
    s.totalCalls += r.calls;
    stratSummary.set(r.strategy, s);
  }

  console.log(`  Strategy effectiveness (sorted best→worst):`);
  const ranked = [...stratSummary.entries()]
    .sort(([, a], [, b]) => b.passes - a.passes || a.totalCalls - b.totalCalls);
  for (const [name, s] of ranked) {
    // Pass rate = passes / (passes + failures)
    const rate = s.passes + s.fails > 0 ? (s.passes / (s.passes + s.fails) * 100).toFixed(0) : "--";
    console.log(`    ${rate}% pass  ${name.padEnd(20)} ${s.passes}P/${s.fails}F  avg ${(s.totalCalls / (s.passes + s.fails || 1)).toFixed(1)}c`);
  }

  // Per-problem matrix
  console.log(`\n  Problem × Strategy matrix (✓=pass, ✗=fail, -=not run):`);
  // Header row
  const stratNames = strategies.map(([n]) => n);
  const maxProbLen = Math.max(...problems.map(p => p.name.length), 8);
  let header = "  " + "".padEnd(maxProbLen) + " │";
  for (const sn of stratNames) {
    header += ` ${sn.slice(0, 8).padEnd(9)}│`;
  }
  console.log(header);
  console.log("  " + "─".repeat(maxProbLen) + "─┼" + "─".repeat(stratNames.length * 10) + "┤");

  for (const p of problems) {
    let row = "  " + p.name.padEnd(maxProbLen) + " │";
    for (const sn of stratNames) {
      const r = results.find(x => x.problem === p.name && x.strategy === sn);
      const cell = r ? (r.passed ? "✓" : "✗") + ` ${r.calls}c` : "  -";
      row += ` ${cell.padEnd(9)}│`;
    }
    console.log(row);
  }

  const elapsed = Date.now() - startTime;
  console.log(`\n  Total time: ${formatMs(elapsed)}`);
  console.log(`═══════════════════════════════════════════════════════════════\n`);
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const { problems, label } = getProblems(args);

  // ── Standalone cross-prompt analysis ──────────────────────────────────
  if (isCrossPrompt && !isConsistency) {
    const problemNames = problems.length > 0 ? problems.map(p => p.name) : undefined;
    console.log(formatCrossPromptReport(generateCrossPromptComparison(problemNames)));

    // If we have trusted problems for current prompt, show them
    const currentHash = getCurrentPromptHash();
    if (currentHash) {
      const trusted = getTrustedProblems();
      if (trusted.length > 0) {
        console.log(`\nTrusted problems (current prompt, >2 consistent passes):`);
        for (const name of trusted) console.log(`  ✓ ${name}`);
        console.log(`These will be skipped in benchmarks unless --force is used.\n`);
      }
    }
    return;
  }

  // ── Standalone prompt report (no problems to run) ─────────────────────
  if (showPromptReport && problems.length === 0) {
    console.log(generatePromptReport());
    return;
  }

  if (showPromptReport && !isConsistency && !isCrossPrompt) {
    // Show prompt report BEFORE running benchmarks (so user sees state before changes)
    console.log(generatePromptReport());
  }


  // ── Standalone consistency report ───────────────────────────────────────
  if (showConsistencyReport) {
    const verdicts = getConsistencyVerdicts();
    if (Object.keys(verdicts).length === 0) {
      console.log("No consistency verdicts recorded yet. Run --consistency first.");
    } else {
      console.log(formatConsistencyReport(getConsistencyReport()));
    }
    return;
  }

  // ── Standalone what-if analysis ─────────────────────────────────────────
  if (showWhatIf) {
    console.log(formatWhatIfReport(generateWhatIfAnalysis()));
    return;
  }

  // ── Standalone trends report ────────────────────────────────────────────
  if (showTrends) {
    console.log(formatImprovementTrends(getImprovementTrends()));
    return;
  }
  if (problems.length === 0) {
    console.log("No problems to run.");
    return;
  }

  if (isEvaluateStrategies) {
    await runStrategyEvaluation(problems);
  } else if (isConsistency) {
    const runCount = parseInt(process.env.CONSISTENCY_RUNS || "2", 10);
    await runConsistencyCheck(problems, Math.max(2, Math.min(runCount, 5)));
  } else {
    await runBenchmark(problems, label, skipTrusted);
  }

  // Show prompt report after benchmark if requested
  if (showPromptReport && !isConsistency && !isCrossPrompt) {
    console.log("\n" + generatePromptReport());
  }
}

main().catch(err => {
  console.error("Benchmark fatal:", err);
  process.exit(1);
});
