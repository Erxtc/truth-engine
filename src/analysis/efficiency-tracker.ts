/**
 * Efficiency Tracker — logs per-problem LLM call counts across benchmark runs
 * so the system knows whether it's getting more efficient or less efficient.
 */

import { execSync } from "child_process";
import { JsonFileStore } from "../utils/json-file-store";
import { formatTokens, formatCost } from "../utils/format";

const STATE_PATH = import.meta.dir + "/.efficiency-state.json";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ProblemEfficiency {
  name: string;
  complexity?: string;
  pipelineCalls: number;
  pipelineTokens: number;
  pipelineCost?: number;
  baselineCalls: number;
  llmAloneCalls: number;
  passed: boolean;
}

export interface EfficiencySnapshot {
  timestamp: string;
  commit?: string;
  problems: ProblemEfficiency[];
  totalProblems: number;
  totalPipelineCalls: number;
  avgPipelineCalls: number;
  totalPipelineTokens: number;
  avgPipelineTokens: number;
  totalPipelineCost: number;
  avgPipelineCost: number;
  passRate: number;
}

export interface EfficiencyState {
  previous: EfficiencySnapshot | null;
  history: EfficiencySnapshot[];
  updatedAt: string;
}

export interface EfficiencyDiff {
  problemDiffs: Record<string, {
    name: string;
    prevCalls: number;
    currCalls: number;
    delta: number;
    prevTokens: number;
    currTokens: number;
    tokenDelta: number;
    prevPassed: boolean;
    currPassed: boolean;
  }>;
  avgDelta: number;
  totalDelta: number;
  avgTokenDelta: number;
  totalTokenDelta: number;
  avgCostDelta: number;
  totalCostDelta: number;
  improved: string[];
  regressed: string[];
  unchanged: string[];
  newProblems: string[];
  isFirstRun: boolean;
}

const store = new JsonFileStore<EfficiencyState>(STATE_PATH, () => ({
  previous: null,
  history: [],
  updatedAt: new Date().toISOString(),
}));

// ── Git helper ─────────────────────────────────────────────────────────────────

function getGitCommit(): string | undefined {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return undefined;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/** Record a benchmark run and compare against the previous run. */
export function recordEfficiency(problems: ProblemEfficiency[]): EfficiencyDiff {
  const state = store.load();
  const passed = problems.filter(p => p.passed).length;

  const totalCalls = problems.reduce((s, p) => s + p.pipelineCalls, 0);
  const totalTokens = problems.reduce((s, p) => s + (p.pipelineTokens || 0), 0);
  const totalCost = problems.reduce((s, p) => s + (p.pipelineCost || 0), 0);

  const snapshot: EfficiencySnapshot = {
    timestamp: new Date().toISOString(),
    commit: getGitCommit(),
    problems,
    totalProblems: problems.length,
    totalPipelineCalls: totalCalls,
    avgPipelineCalls: problems.length > 0 ? totalCalls / problems.length : 0,
    totalPipelineTokens: totalTokens,
    avgPipelineTokens: problems.length > 0 ? totalTokens / problems.length : 0,
    totalPipelineCost: totalCost,
    avgPipelineCost: problems.length > 0 ? totalCost / problems.length : 0,
    passRate: problems.length > 0 ? passed / problems.length : 0,
  };

  const diff = computeDiff(state.previous, snapshot);

  state.previous = snapshot;
  state.history.push(snapshot);
  if (state.history.length > 20) {
    state.history = state.history.slice(-20);
  }
  store.markDirty();
  store.save();

  return diff;
}

function computeDiff(prev: EfficiencySnapshot | null, curr: EfficiencySnapshot): EfficiencyDiff {
  if (!prev) {
    return {
      problemDiffs: {},
      avgDelta: 0, totalDelta: 0, avgTokenDelta: 0, totalTokenDelta: 0,
      avgCostDelta: 0, totalCostDelta: 0,
      improved: [], regressed: [], unchanged: [],
      newProblems: curr.problems.map(p => p.name),
      isFirstRun: true,
    };
  }

  const prevMap = new Map(prev.problems.map(p => [p.name, p]));
  const problemDiffs: EfficiencyDiff["problemDiffs"] = {};
  const improved: string[] = [];
  const regressed: string[] = [];
  const unchanged: string[] = [];
  const newProblems: string[] = [];

  for (const currP of curr.problems) {
    const prevP = prevMap.get(currP.name);
    if (!prevP) {
      newProblems.push(currP.name);
      continue;
    }
    const prevTokens = prevP.pipelineTokens ?? 0;
    const currTokens = currP.pipelineTokens ?? 0;
    const delta = currP.pipelineCalls - prevP.pipelineCalls;
    const tokenDelta = currTokens - prevTokens;
    problemDiffs[currP.name] = {
      name: currP.name,
      prevCalls: prevP.pipelineCalls, currCalls: currP.pipelineCalls,
      delta, prevTokens, currTokens, tokenDelta,
      prevPassed: prevP.passed, currPassed: currP.passed,
    };
    const efficiencySignal = tokenDelta !== 0 ? tokenDelta : delta;
    if (efficiencySignal < 0) improved.push(currP.name);
    else if (efficiencySignal > 0) regressed.push(currP.name);
    else unchanged.push(currP.name);
  }

  return {
    problemDiffs,
    avgDelta: curr.avgPipelineCalls - prev.avgPipelineCalls,
    totalDelta: curr.totalPipelineCalls - prev.totalPipelineCalls,
    avgTokenDelta: (curr.avgPipelineTokens || 0) - (prev.avgPipelineTokens || 0),
    totalTokenDelta: (curr.totalPipelineTokens || 0) - (prev.totalPipelineTokens || 0),
    avgCostDelta: (curr.avgPipelineCost || 0) - (prev.avgPipelineCost || 0),
    totalCostDelta: (curr.totalPipelineCost || 0) - (prev.totalPipelineCost || 0),
    improved, regressed, unchanged, newProblems,
    isFirstRun: false,
  };
}

/** Print a human-readable efficiency comparison. */
export function printEfficiencyReport(diff: EfficiencyDiff): void {
  const bar = "──────────────────────────────────────────────────────────────────";

  if (diff.isFirstRun) {
    console.log(`\n${bar}`);
    console.log("Efficiency — first run (baseline established)");
    console.log(`${bar}`);
    console.log(`  New problems tracked: ${diff.newProblems.length}`);
    console.log("  Future runs will compare against this baseline.");
    console.log(`${bar}\n`);
    return;
  }

  console.log(`\n${bar}`);
  console.log("Efficiency — vs previous run");
  console.log(`${bar}`);

  const callIcon = diff.avgDelta < 0 ? "↓ faster" : diff.avgDelta > 0 ? "↑ slower" : "→ same";
  const callMark = diff.avgDelta < 0 ? "✓" : diff.avgDelta > 0 ? "⚠" : "─";
  console.log(`  ${callMark} Calls/problem: ${diff.avgDelta > 0 ? "+" : ""}${diff.avgDelta.toFixed(1)} ${callIcon}`);

  if (diff.totalTokenDelta !== 0) {
    const tokenIcon = diff.avgTokenDelta < 0 ? "↓ cheaper" : "↑ costlier";
    const tokenMark = diff.avgTokenDelta < 0 ? "✓" : "⚠";
    console.log(`  ${tokenMark} Tokens/problem: ${diff.avgTokenDelta > 0 ? "+" : ""}${formatTokens(diff.avgTokenDelta)} ${tokenIcon}`);
    console.log(`    Total: ${formatTokens(diff.totalTokenDelta > 0 ? diff.totalTokenDelta : -diff.totalTokenDelta)} tokens ${diff.totalTokenDelta < 0 ? "saved" : "extra"}`);
  }

  if (diff.totalCostDelta !== 0) {
    const costIcon = diff.avgCostDelta < 0 ? "↓ cheaper" : "↑ costlier";
    const costMark = diff.avgCostDelta < 0 ? "✓" : "⚠";
    console.log(`  ${costMark} Cost/problem: ${diff.avgCostDelta > 0 ? "+" : ""}${formatCost(Math.abs(diff.avgCostDelta))} ${costIcon}`);
    console.log(`    Total: ${formatCost(Math.abs(diff.totalCostDelta))} ${diff.totalCostDelta < 0 ? "saved" : "extra"}`);
  }

  if (diff.improved.length > 0) {
    console.log(`\n  ↓ More efficient (${diff.improved.length} problems):`);
    for (const name of diff.improved) {
      const d = diff.problemDiffs[name]!;
      const tokenStr = d.tokenDelta !== 0 ? ` (${formatTokens(Math.abs(d.tokenDelta))} tokens saved)` : "";
      console.log(`    ${name}: ${d.prevCalls} → ${d.currCalls} calls${tokenStr}`);
    }
  }

  if (diff.regressed.length > 0) {
    console.log(`\n  ↑ Less efficient (${diff.regressed.length} problems) — INVESTIGATE:`);
    for (const name of diff.regressed) {
      const d = diff.problemDiffs[name]!;
      const extra = d.currPassed && !d.prevPassed ? " (but now passes!)" : "";
      const tokenStr = d.tokenDelta !== 0 ? ` (+${formatTokens(d.tokenDelta)} tokens)` : "";
      console.log(`    ${name}: ${d.prevCalls} → ${d.currCalls} calls${tokenStr}${extra}`);
    }
  }

  // ── Pass/fail changes (separate from efficiency) ──
  const newlyPassing: string[] = [];
  const newlyFailing: string[] = [];
  for (const [name, d] of Object.entries(diff.problemDiffs)) {
    if (d.currPassed && !d.prevPassed) newlyPassing.push(name);
    else if (!d.currPassed && d.prevPassed) newlyFailing.push(name);
  }

  if (newlyPassing.length > 0) {
    console.log(`\n  ✓ FIXED (${newlyPassing.length} problems — now passing!):`);
    for (const name of newlyPassing) console.log(`    ${name}: FAIL → PASS`);
  }

  if (newlyFailing.length > 0) {
    console.log(`\n  ✗ REGRESSION (${newlyFailing.length} problems — were passing, now failing!):`);
    for (const name of newlyFailing) {
      const d = diff.problemDiffs[name]!;
      const callStr = ` (${d.prevCalls} → ${d.currCalls} calls)`;
      console.log(`    ${name}: PASS → FAIL${callStr}`);
    }
  }

  if (diff.unchanged.length > 0) {
    console.log(`\n  → Unchanged: ${diff.unchanged.length} problems`);
  }

  if (diff.newProblems.length > 0) {
    console.log(`\n  + New: ${diff.newProblems.length} problems (no history to compare)`);
  }

  console.log(`${bar}\n`);
}

