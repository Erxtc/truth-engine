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
 */

import { PROBLEMS, type TestProblem } from "./benchmark-problems";
import { execSync } from "child_process";
import { recordEfficiency, printEfficiencyReport } from "../analysis/efficiency-tracker";
import type { ProblemEfficiency } from "../analysis/efficiency-tracker";
import { formatMs, formatTokens, formatCost } from "../utils/format";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";

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

function runPipeline(problem: TestProblem): { passed: boolean; calls: number; tokens: number; cost: number; durationMs: number } {
  const domain = problem.domain || "auto";
  const projectTestsJson = problem.projectTests ? JSON.stringify(problem.projectTests) : "";
  const langEnv = problem.language ? `PROBLEM_LANGUAGE=${problem.language}` : "";
  try {
    const t0 = Date.now();
    const output = execSync(
      `${langEnv} PROBLEM_COMPLEXITY=${problem.complexity} DOMAIN=${domain} PROBLEM_DESC="${problem.description.replace(/"/g, '\\"')}" NO_UI=1 bun run ${ROOT}/src/main.ts`,
      { cwd: ROOT, timeout: 300_000, encoding: "utf-8", env: { ...process.env, DOMAIN: domain, PROBLEM_DESC: problem.description, PROBLEM_COMPLEXITY: problem.complexity, NO_UI: "1", PROJECT_TESTS: projectTestsJson, PROBLEM_LANGUAGE: problem.language || "" } }
    );
    const duration = Date.now() - t0;

    // Parse structured result from output (preferred) or fall back to regex
    let passed = false;
    const resultMatch = output.match(/\{"result":\{[^}]+\}\}/);
    if (resultMatch) {
      try {
        const parsed = JSON.parse(resultMatch[0]);
        passed = parsed.result?.solved === true;
      } catch { /* fall through to regex */ }
    }
    if (!passed && !resultMatch) {
      passed = /✓ SOLVED|PROBLEM SOLVED|FINAL ANSWER/i.test(output);
    }

    const log = lastLogPath();
    const calls = log ? countCalls(log) : 0;
    const tokens = log ? totalTokens(log) : 0;
    const cost = log ? totalCost(log) : 0;

    return { passed, calls, tokens, cost, durationMs: duration };
  } catch (err: any) {
    const log = lastLogPath();
    const calls = log ? countCalls(log) : 0;
    const tokens = log ? totalTokens(log) : 0;
    const cost = log ? totalCost(log) : 0;
    return { passed: false, calls, tokens, cost, durationMs: 0 };
  }
}

// ── Filter logic ──────────────────────────────────────────────────────────────

let isConsistency = false;

function getProblems(args: string[]): { problems: TestProblem[]; label: string } {
  let mode: "all" | "failing" | "tier" | "named" = "named";
  let tierFilter: string | null = null;
  const names: string[] = [];

  for (const arg of args) {
    if (arg === "--all") mode = "all";
    else if (arg === "--failing") mode = "failing";
    else if (arg === "--consistency") { isConsistency = true; }
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
      const pl = runPipeline(p);
      const icon = pl.passed ? "PASS" : "FAIL";
      console.log(`${icon} (${pl.calls}c ${formatTokens(pl.tokens)} ${formatMs(pl.durationMs)})`);
      runs.push({ passed: pl.passed, calls: pl.calls, tokens: pl.tokens, durationMs: pl.durationMs });
    }

    const allPassed = runs.every(r => r.passed);
    const allFailed = runs.every(r => !r.passed);
    const stable = allPassed || allFailed;
    const verdict = allPassed ? "stable-pass" : allFailed ? "stable-fail" : "flaky";

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
  console.log(`  Total time: ${formatMs(elapsed)}`);
  console.log(`═══════════════════════════════════════════════════════════════\n`);
}

// ── Benchmark ─────────────────────────────────────────────────────────────────

async function runBenchmark(problems: TestProblem[], label: string): Promise<void> {
  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log(`  BENCHMARK — ${problems.length} problem(s) (${label})`);
  console.log(`═══════════════════════════════════════════════════════════════\n`);

  const results: ProblemEfficiency[] = [];
  let totalPipelineCalls = 0;
  let totalPipelineTokens = 0;
  let totalPipelineCost = 0;
  let totalPipelineMs = 0;
  let passed = 0;

  const startTime = Date.now();

  for (let i = 0; i < problems.length; i++) {
    const p = problems[i]!;
    const progress = `[${i + 1}/${problems.length}]`;
    console.log(`${progress} ${p.name} (${p.complexity})…`);

    const pl = runPipeline(p);
    const costStr = pl.cost > 0 ? `  ${formatCost(pl.cost)}` : '';
    console.log(`  ${pl.passed ? "PASS" : "FAIL"} in ${pl.calls} calls, ${formatTokens(pl.tokens)}${costStr}, ${formatMs(pl.durationMs)}`);

    if (pl.passed) passed++;

    results.push({
      name: p.name,
      complexity: p.complexity,
      pipelineCalls: pl.calls,
      pipelineTokens: pl.tokens,
      pipelineCost: pl.cost,
      baselineCalls: 1,
      llmAloneCalls: 1,
      passed: pl.passed,
    });

    totalPipelineCalls += pl.calls;
    totalPipelineTokens += pl.tokens;
    totalPipelineCost += pl.cost;
    totalPipelineMs += pl.durationMs;
  }

  const elapsed = Date.now() - startTime;

  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log(`  SUMMARY`);
  console.log(`═══════════════════════════════════════════════════════════════`);
  console.log(`  Problems:       ${problems.length}`);
  console.log(`  Passed:         ${passed}/${problems.length} (${(passed / problems.length * 100).toFixed(0)}%)`);
  console.log(`  Total calls:    ${totalPipelineCalls}`);
  console.log(`  Avg calls:      ${(totalPipelineCalls / problems.length).toFixed(1)} per problem`);
  console.log(`  Total tokens:   ${formatTokens(totalPipelineTokens)}`);
  console.log(`  Avg tokens:     ${formatTokens(totalPipelineTokens / problems.length)} per problem`);
  if (totalPipelineCost > 0) {
    console.log(`  Total cost:     ${formatCost(totalPipelineCost)}`);
    console.log(`  Avg cost:       ${formatCost(totalPipelineCost / problems.length)} per problem`);
  }
  console.log(`  Total time:     ${formatMs(elapsed)}`);

  console.log(`\n  Per-problem:`);
  for (const r of results) {
    const icon = r.passed ? "✓" : "✗";
    const costLine = r.pipelineCost ? `  ${formatCost(r.pipelineCost)}` : '';
    console.log(`    ${icon} ${r.name.padEnd(22)} ${String(r.pipelineCalls).padStart(2)} calls  ${formatTokens(r.pipelineTokens).padStart(8)}${costLine}`);
  }

  try {
    const diff = recordEfficiency(results);
    printEfficiencyReport(diff);
  } catch (err) {
    console.log(`  [efficiency] Failed to record: ${(err as Error).message}`);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const { problems, label } = getProblems(args);

  if (problems.length === 0) {
    console.log("No problems to run.");
    return;
  }

  if (isConsistency) {
    const runCount = parseInt(process.env.CONSISTENCY_RUNS || "2", 10);
    await runConsistencyCheck(problems, Math.max(2, Math.min(runCount, 5)));
  } else {
    await runBenchmark(problems, label);
  }
}

main().catch(err => {
  console.error("Benchmark fatal:", err);
  process.exit(1);
});
