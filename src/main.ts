/**
 * truth-engine — Entry point.
 *
 * Full pipeline: domain detection → oracle generation → 1-shot baseline
 * → repair (if needed) → task-agent (if needed) → supervisor evolve loop.
 *
 * Usage:
 *   DOMAIN=auto PROBLEM_DESC="..." bun run src/main.ts
 */

import { RESTORE_INF_JS, pythonRunnerSource } from "./utils/general";
import { logEvent } from "./utils/prompt-logger";
import { loadConfig } from "./cli";
import { detectOrGenerateDomain } from "./domains/auto-detect";
import { getDomainSpec } from "./executors/domains/registry";
import { runBaseline } from "./agents/baseline";
import { runRepair } from "./agents/repair";
import { runTaskAgent } from "./llm/task-agent";
import { isSelfTerminated } from "./llm/stuck-loop-detector";
import { runSupervisor } from "./agents/supervisor";
import { getPreset } from "./llm/workflow-presets";
import { VERIFY_SCRIPT, VERIFY_CLI_SCRIPT } from "./executors/domains/project-verify";
import { recordAttempt } from "./analysis/capability-tracker";
import { getModelTier } from "./llm";
import type { WorkingContext, Proposal, ExecutionResult, RunParams, ConfidenceLevel } from "./core/types";
import type { SupervisorDecision } from "./agents/supervisor";
import { HealthMonitor } from "./core/health-monitor";

// Ensure domain executors are loaded
import "./executors/domains/index";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Scale turn budget by problem complexity. Simple problems get fewer turns
 *  (they should solve quickly); hard problems get more (research + iteration). */
function getTurnBudget(complexity: string | undefined): number {
  switch (complexity) {
    case "trivial":  return 5;
    case "simple":   return 5;
    case "medium":   return 8;
    case "hard":     return 12;
    case "very-hard": return 15;
    default:         return 5;
  }
}

function proposalFromCode(code: string, lang: string): Proposal {
  return {
    hypothesis: `${lang} solution`,
    expected_benefit: "solve the problem",
    assumptions: [],
    possible_failure_modes: [],
    suggested_tests: [],
    executable: { type: "code", lang: lang as "python" | "js", source: code },
  };
}

/** Wrap a raw oracle JS verify(fn) function into a standalone Node.js script
 *  that the task-agent can run via `node oracle.js [solution_file]`.
 *  The __fn helper writes a temp runner.py combining the solution with a
 *  JSON-safe wrapper, then execs it via `python3 runner.py < args.json`. */
function wrapOracleJs(oracleJs: string): string {
  // Python wrapper — base64-encoded to avoid JSON/JS string escaping bugs
  const PY_RUNNER = pythonRunnerSource("");
  const B64_RUNNER = Buffer.from(PY_RUNNER).toString("base64");

  return [
    `// Oracle verifier — tests a Python solution by calling verify(__fn).`,
    `// Usage: node oracle.js [solution_file]  (default: solution.py)`,
    `var { execSync } = require('child_process');`,
    `var fs = require('fs');`,
    `var path = require('path');`,
    `var solutionFile = process.argv[2] || 'solution.py';`,
    ``,
    `if (!fs.existsSync(solutionFile)) {`,
    `  process.stdout.write(JSON.stringify({ passed: false, reason: 'missing-solution: ' + solutionFile }));`,
    `  process.exit(0);`,
    `}`,
    ``,
    `var _solutionSrc = fs.readFileSync(solutionFile, 'utf8');`,
    ``,
    `// Python runner (decoded from base64 — safe from escaping bugs)`,
    `var _runnerPy = _solutionSrc + "\\n" + Buffer.from("${B64_RUNNER}", "base64").toString("utf8");`,
    ``,
    `var __fn = function() {`,
    `  var _args = Array.prototype.slice.call(arguments);`,
    `  var _input = JSON.stringify(_args);`,
    `  // Write runner to a temp file for this call (args may differ)`,
    `  var _tmp = path.join(path.dirname(solutionFile), '__runner' + Date.now() + '.py');`,
    `  fs.writeFileSync(_tmp, _runnerPy);`,
    `  var _raw;`,
    `  try {`,
    `    _raw = execSync('python3 ' + _tmp, { input: _input, timeout: 10000, maxBuffer: 1024*1024 }).toString().trim();`,
    `  } catch (_e) {`,
    `    var _stderr = (_e.stderr ? _e.stderr.toString() : _e.message || 'crash');`,
    `    var _lines = _stderr.split('\\n').filter(function(l) { return l.trim(); }).slice(-3);`,
    `    throw new Error('py-crash: ' + _lines.join(' | '));`,
    `  } finally {`,
    `    try { fs.unlinkSync(_tmp); } catch(_ignored) {}`,
    `  }`,
    `  if (!_raw) throw new Error('empty-output');`,
    `  try { return _restore_inf(JSON.parse(_raw)); } catch (_e2) { throw new Error('py-json: ' + _raw.slice(0, 200)); }`,
    `};`,
    ``,
    RESTORE_INF_JS,
    ``,
    oracleJs,
    ``,
    `try {`,
    `  var __result = verify(__fn);`,
    `  process.stdout.write(JSON.stringify(__result));`,
    `} catch(_e) {`,
    `  process.stdout.write(JSON.stringify({ passed: false, reason: _e.message || 'crash' }));`,
    `}`,
  ].join("\n");
}

function emptyWorkingContext(domain: string, problem: string, oracleSource: string): WorkingContext {
  return {
    domain,
    problem,
    depth: 0,
    oracle_spec: oracleSource,
  };
}


interface RunOutcome {
  solved: boolean;
  solvedBy: string;
  totalCalls: number;
  domain: string;
  description: string;
}

/** Shared supervisor retry loop — runs up to 2 iterations of supervisor-guided
 *  task-agent attempts. Returns whether solved and how many LLM calls were spent. */
async function runSupervisorLoop(params: {
    domain: string;
    problem: string;
    domainType: string | undefined;
    maxDepth: number | null;
    maxBranches: number | null;
    requiredConfidence: number | null;
    health: HealthMonitor;
    setupFiles: Record<string, string> | undefined;
    enableWebSearch: boolean;
    maxTurns: number;
    label: string;
    handleEscalate?: boolean;
    domainInvariants?: string[];
    oracleContent?: string;
    problemLanguage?: string;
}): Promise<{ solved: boolean; callsSpent: number }> {
    const { domain, problem, domainType, health, setupFiles, enableWebSearch, maxTurns, label, handleEscalate, domainInvariants, oracleContent, problemLanguage } = params;
    let callsSpent = 0;
    let maxDepth = params.maxDepth ?? 3;
    let maxBranches = params.maxBranches ?? 2;
    const runParams: RunParams = {
        maxDepth,
        maxBranches,
        requiredConfidence: (params.requiredConfidence ?? 1) as ConfidenceLevel,
        budgetLlmCalls: 30,
    };

    console.log(`\n── Supervisor evolve loop (${label}) ──`);
    let healthReport = health.getReportWithHistory(domain);
    let prevRetryAnswer = "";
    let prevRetryTurns = 0;
    let activeDirectionHint = "";       // from supervisor pivot → next task-agent
    let previousAttemptSummary = "";    // from failed task-agent → next task-agent
    let lastErrorContext = "";          // from failed task-agent → next supervisor
    let lastTurnSummary = "";           // turn-by-turn actions → next supervisor

    for (let iteration = 0; iteration < 2; iteration++) {
        let decision: SupervisorDecision;
        try {
            decision = await runSupervisor(domain, problem, healthReport, runParams, lastErrorContext, lastTurnSummary);
            callsSpent++;
        } catch {
            console.log(`   Supervisor call failed — aborting`);
            break;
        }
        console.log(`   [${iteration + 1}] ${decision.action}: ${decision.reason.slice(0, 120)}`);

        if (decision.action === "abort") {
            console.log(`\n✗ ABORTED — ${decision.reason}`);
            return { solved: false, callsSpent };
        }

        if (decision.action === "pivot") {
            activeDirectionHint = decision.directionHint;
            console.log(`   ↻ Pivot: ${activeDirectionHint.slice(0, 100)}`);
        }

        if (decision.action === "escalate" && handleEscalate) {
            runParams.maxBranches = decision.newBranches || maxBranches + 1;
            runParams.maxDepth = decision.newDepth || maxDepth + 1;
            maxBranches = runParams.maxBranches;
            maxDepth = runParams.maxDepth;
            console.log(`   Escalated: depth=${maxDepth} branches=${maxBranches}`);
        }

        const retryResult = await runTaskAgent(problem, {
            domain,
            domainType,
            useStrongModel: true,
            maxTurns,
            commandTimeout: 30_000,
            taskTimeout: 300_000,
            enableWebSearch,
            setupFiles,
            healthMonitor: health,
            supervisorHint: activeDirectionHint || undefined,
            previousAttemptSummary: previousAttemptSummary || undefined,
            domainInvariants,
            oracleContent,
            workflow: problemLanguage ? { language: problemLanguage } : undefined,
        });
        callsSpent += retryResult.turns;

        if (retryResult.success) {
            health.record(100, true, "supervisor-retry");
            console.log(`\n✓ SOLVED by supervisor-guided retry (${callsSpent} calls in loop)`);
            logEvent("✓ SOLVED", "supervisor retry loop");
            return { solved: true, callsSpent };
        }

        // Build failure context for next iteration
        lastErrorContext = retryResult.answer.slice(0, 300);
        lastTurnSummary = retryResult.turnSummary;
        previousAttemptSummary = [
            retryResult.turnSummary,
            `Failure reason: ${retryResult.answer.slice(0, 200)}`,
        ].join("\n");

        // Cross-retry stagnation: if this retry's answer is identical to the
        // previous one, the LLM cache is replaying the same responses. Each
        // fresh task-agent starts with a clean detector, so we must catch it here.
        if (prevRetryAnswer && retryResult.answer === prevRetryAnswer && retryResult.turns === prevRetryTurns) {
            console.log(`   ⛔ Cross-retry cache loop: same ${retryResult.turns}-turn failure pattern. Aborting.`);
            logEvent("✗ FAILED", "cross-retry cache loop");
            return { solved: false, callsSpent };
        }
        prevRetryAnswer = retryResult.answer;
        prevRetryTurns = retryResult.turns;

        health.record(0, false, retryResult.answer || decision.reason);
        healthReport = health.getReportWithHistory(domain);
    }

    console.log(`\n✗ FAILED — exhausted supervisor loop`);
    return { solved: false, callsSpent };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const cfg = loadConfig();
  const problem = cfg.problem;
  if (!problem || problem.length < 3) {
    console.error("Usage: DOMAIN=auto PROBLEM_DESC='...' bun run src/main.ts");
    process.exit(1);
  }

  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║  truth-engine pipeline                                   ║`);
  console.log(`╚══════════════════════════════════════════════════════════╝\n`);

  let totalCalls = 0;
  const modelTier = await getModelTier();
  const complexity = cfg.problemComplexity || "medium";
  const health = new HealthMonitor();

  const outcome: RunOutcome = { solved: false, solvedBy: "pipeline", totalCalls: 0, domain: "", description: problem.slice(0, 120) };

  let _outcomeRecorded = false;
  const _recordOutcome = () => {
    if (_outcomeRecorded) return;
    _outcomeRecorded = true;
    if (outcome.domain) {
      recordAttempt({
        domain: outcome.domain,
        description: outcome.description,
        numSubproblems: 1,
        modelTier,
        solved: outcome.solved,
        llmCallsUsed: outcome.totalCalls,
        solvedBy: outcome.solved ? outcome.solvedBy : undefined,
        timestamp: new Date().toISOString(),
      });
    }
  };
  process.on("exit", _recordOutcome);
  process.on("SIGINT", () => { _recordOutcome(); process.exit(0); });

  function solved(by: string): void {
    outcome.solved = true;
    outcome.solvedBy = by;
    outcome.totalCalls = totalCalls;
  }

  function done(): void {
    outcome.totalCalls = totalCalls;
  }

  // ── Step 1: Domain detection + oracle generation ──────────────────────────
  console.log("── Domain detection + oracle generation ──");
  // When the caller explicitly sets a domain (not "auto"), use it directly.
  // Saves 1 LLM call and avoids misclassification for known domain names.
  const explicitDomain = cfg.domain && cfg.domain !== "auto" ? cfg.domain : null;
  const explicitSpec = explicitDomain ? getDomainSpec(explicitDomain) : null;
  let detected: Awaited<ReturnType<typeof detectOrGenerateDomain>>;
  if (explicitSpec && explicitDomain) {
    console.log(`   Domain: ${explicitDomain} (explicit — skipping auto-detect)`);
    detected = { domain: explicitDomain!, spec: explicitSpec, wasGenerated: false };
  } else {
    detected = await detectOrGenerateDomain(problem);
    totalCalls++;
    console.log(`   Domain: ${detected.domain} (${detected.wasGenerated ? "generated" : "matched"})`);
  }
  if (detected.domainType) console.log(`   Type: ${detected.domainType}`);

  const spec = detected.spec;
  const domain = detected.domain;
  const oracleSource = spec?.testSource ?? "";
  outcome.domain = domain;

  if (!spec) {
    console.log(`\n✗ FAILED — domain generation returned no spec`);
    logEvent("✗ FAILED", "no-domain-spec");
    done();
    return;
  }

  try {

  // ── Project domain fast path: skip 1-shot baseline ──────────────────────
  if (detected.domainType === "project" || detected.domainType === "cli-project") {
    const isCli = detected.domainType === "cli-project";
    const domainLabel = isCli ? "cli-project" : "project";
    const verifyScript = isCli ? VERIFY_CLI_SCRIPT : VERIFY_SCRIPT;
    const verifyFileName = isCli ? "verify-cli-project.js" : "verify-project.js";

    console.log(`\n── Task-agent (${domainLabel} domain — skipping 1-shot) ──`);
    const workflow = getPreset(domain);
    const enableWebSearch = workflow?.enableWebSearch ?? false;
    const maxTurns = getTurnBudget(complexity);

    const setupFiles: Record<string, string> = {};
    setupFiles[verifyFileName] = verifyScript;

    // Functional tests for project/CLI problems (passed via PROJECT_TESTS env var)
    const projectTestsJson = process.env.PROJECT_TESTS;
    if (projectTestsJson && projectTestsJson.length > 0) {
      try {
        JSON.parse(projectTestsJson); // validate
        setupFiles["tests.json"] = projectTestsJson;
        console.log(`   Project tests: ${projectTestsJson.length} bytes`);
      } catch {
        console.log(`   Warning: PROJECT_TESTS is not valid JSON — skipping functional tests`);
      }
    }

    const taskResult = await runTaskAgent(problem, {
      domain,
      domainType: detected.domainType,
      useStrongModel: true,
      maxTurns,
      commandTimeout: 30_000,
      taskTimeout: 300_000,
      enableWebSearch,
      complexity,
      setupFiles,
      healthMonitor: health,
      domainInvariants: spec.invariants,
      workflow: cfg.problemLanguage ? { language: cfg.problemLanguage } : undefined,
    });

    totalCalls += taskResult.turns;

    if (taskResult.success) {
      console.log(`\n✓ SOLVED by task-agent (${taskResult.turns} turns, ${totalCalls} total LLM calls)`);
      logEvent("✓ SOLVED", `task-agent (${domainLabel})`);
      solved("task-agent");
      return;
    }

    console.log(`   Task-agent failed after ${taskResult.turns} turns`);

    health.record(0, false, taskResult.answer);

    const supervisorResult = await runSupervisorLoop({
      domain,
      problem,
      domainType: detected.domainType,
      maxDepth: cfg.maxDepth,
      maxBranches: cfg.maxBranches,
      requiredConfidence: cfg.requiredConfidence,
      health,
      setupFiles,
      enableWebSearch,
      maxTurns: 5,
      label: domainLabel,
      domainInvariants: spec.invariants,
      problemLanguage: cfg.problemLanguage,
    });
    totalCalls += supervisorResult.callsSpent;

    if (supervisorResult.solved) {
      console.log(`\n✓ SOLVED by supervisor-guided retry (${totalCalls} total LLM calls)`);
      logEvent("✓ SOLVED", `supervisor-retry (${domainLabel})`);
      solved("supervisor-retry");
    } else {
      console.log(`\n✗ FAILED — exhausted supervisor loop (${totalCalls} total LLM calls)`);
      logEvent("✗ FAILED", `supervisor loop exhausted (${domainLabel})`);
      done();
    }
    return;
  }

  // ── Step 2: 1-shot baseline ───────────────────────────────────────────────
  console.log("\n── 1-shot baseline ──");
  const baselineLang: "python" | "js" = (cfg.problemLanguage === "js" || cfg.problemLanguage === "javascript") ? "js" : "python";
  const baselineResult = await runBaseline(problem, spec, baselineLang, oracleSource || undefined);
  totalCalls++;
  console.log(`   ${baselineResult.passed ? "PASS" : "FAIL"} | ${baselineResult.durationMs}ms | ${baselineResult.reason.slice(0, 120)}`);

  if (baselineResult.passed) {
    console.log(`\n✓ SOLVED by 1-shot baseline (${totalCalls} LLM calls)`);
    logEvent("✓ SOLVED", "1-shot baseline");
    solved("1-shot");
    return;
  }
  health.record(0, false, baselineResult.reason);

  // ── Step 3: Repair (only if 1-shot had partial success — some tests passed) ──
  const allTestsFailed = baselineResult.reason.includes("0/")
    || baselineResult.reason.includes("all failed")
    || baselineResult.reason.includes("all tests failed");
  const ctx = emptyWorkingContext(domain, problem, oracleSource);

  if (!allTestsFailed) {
    console.log("\n── Repair ──");
    const baselineProposal = proposalFromCode(baselineResult.code, baselineLang);
    const baselineExec: ExecutionResult = { passed: false, reason: baselineResult.reason, iterations: 1, failureDetail: baselineResult.failureDetail };

    try {
      const repaired = await runRepair(ctx, baselineProposal, baselineExec);
      totalCalls++;

      if (repaired) {
        const repairedCode = repaired.executable.type === "code" ? repaired.executable.source : "";
        if (repairedCode) {
          const reProposal = proposalFromCode(repairedCode, baselineLang);
          try {
            const reRunResult = await spec.run(reProposal, ctx, {
              id: "repair-check",
              type: "code_module",
              status: "active",
              problemId: "main",
              parentId: null,
              depth: 0,
              score: 0,
              sourceCode: repairedCode,
              confidenceLevel: 0,
              createdAt: new Date(),
              updatedAt: new Date(),
              workspacePath: null,
              title: "repair-check",
              hypothesisText: null,
              formalStatement: null,
              payload: null,
              latestExecutionId: null,
              provenance: null,
            });

            if (reRunResult.overallPassed) {
              console.log(`\n✓ SOLVED by repair (${totalCalls} LLM calls)`);
              logEvent("✓ SOLVED", "repair");
              solved("repair");
              return;
            }
            console.log(`   Repair re-execution FAILED`);
          } catch {
            console.log(`   Repair re-execution threw — falling through`);
          }
        }
        console.log(`   Repair FAILED — falling through to task-agent`);
      } else {
        console.log(`   Repair returned null — falling through to task-agent`);
      }
    } catch (err) {
      console.log(`   Repair threw: ${err} — falling through to task-agent`);
    }
  } else {
    console.log("\n── Repair skipped (all tests failed — wrong approach, repair won't help) ──");
  }

  // ── Step 4: Task-agent (ReAct loop) ──────────────────────────────────────
  console.log("\n── Task-agent (ReAct loop) ──");

  const workflow = getPreset(domain);
  const enableWebSearch = workflow?.enableWebSearch ?? false;

  // Build context from the failed baseline so the task-agent doesn't start blind.
  // Include the baseline code + oracle failures + per-test results.
  const prevLang = baselineLang;
  const fd = baselineResult.failureDetail;
  const testSummary = fd && fd.failures.length > 0
    ? `\n\nFailed tests (${fd.failedCount}/${fd.passedCount + fd.failedCount}):\n${fd.failures.map(f => `  ❌ ${f}`).join("\n")}`
    : `\n\nOracle output: ${baselineResult.reason.slice(0, 300)}`;
  const previousAttemptSummary = allTestsFailed
    ? `The 1-shot baseline returned code that failed ALL tests. Here's what it produced:\n\`\`\`${prevLang}\n${baselineResult.code.slice(0, 500)}\n\`\`\`${testSummary}\n\nThis approach was FUNDAMENTALLY WRONG. Do NOT try the same approach. Read the problem carefully, understand what's actually being asked, and implement the correct algorithm from scratch.`
    : `The 1-shot baseline returned code that passed SOME tests but failed others. Here's what it produced:\n\`\`\`${prevLang}\n${baselineResult.code.slice(0, 500)}\n\`\`\`${testSummary}\n\nStart by understanding WHY these specific tests failed. Fix the bugs in the approach, or if the approach is fundamentally wrong, start fresh.`;

  const taskResult = await runTaskAgent(problem, {
    domain,
    domainType: detected.domainType,
    useStrongModel: true,
    maxTurns: getTurnBudget(complexity),
    commandTimeout: 30_000,
    taskTimeout: 300_000,
    enableWebSearch,
    complexity,
    setupFiles: oracleSource ? { "oracle.js": wrapOracleJs(oracleSource) } : undefined,
    healthMonitor: health,
    previousAttemptSummary,
    domainInvariants: spec.invariants,
    oracleContent: oracleSource || undefined,
    workflow: cfg.problemLanguage ? { language: cfg.problemLanguage } : undefined,
  });

  totalCalls += taskResult.turns;

  if (taskResult.success) {
    console.log(`\n✓ SOLVED by task-agent (${taskResult.turns} turns, ${totalCalls} total LLM calls)`);
    logEvent("✓ SOLVED", "task-agent");
    solved("task-agent");
    return;
  }

  console.log(`   Task-agent failed after ${taskResult.turns} turns`);
  health.record(0, false, taskResult.answer);

  const selfTerminated = isSelfTerminated(taskResult.answer);
  if (selfTerminated) {
    console.log(`   Self-terminated — model cannot make progress. Skipping supervisor loop.`);
    console.log(`\n✗ FAILED — capability limit (${totalCalls} total LLM calls)`);
    logEvent("✗ FAILED", "capability limit");
    done();
    return;
  }

  const supervisorResult = await runSupervisorLoop({
    domain,
    problem,
    domainType: detected.domainType,
    maxDepth: cfg.maxDepth,
    maxBranches: cfg.maxBranches,
    requiredConfidence: cfg.requiredConfidence,
    health,
    setupFiles: oracleSource ? { "oracle.js": wrapOracleJs(oracleSource) } : undefined,
    enableWebSearch,
    maxTurns: Math.min(8, getTurnBudget(complexity)),
    label: "code",
    handleEscalate: true,
    problemLanguage: cfg.problemLanguage,
    domainInvariants: spec.invariants,
    oracleContent: oracleSource || undefined,
  });
  totalCalls += supervisorResult.callsSpent;

  if (supervisorResult.solved) {
    console.log(`\n✓ SOLVED by supervisor-guided retry (${totalCalls} total LLM calls)`);
    logEvent("✓ SOLVED", "supervisor-retry");
    solved("supervisor-retry");
  } else {
    console.log(`\n✗ FAILED — exhausted supervisor loop (${totalCalls} total LLM calls)`);
    logEvent("✗ FAILED", "supervisor loop exhausted");
    done();
  }

  } finally {
    // ── Structured result for programmatic consumers (benchmark, agents) ──────
    console.log(`\n${JSON.stringify({ result: { solved: outcome.solved, solvedBy: outcome.solvedBy, totalCalls: outcome.totalCalls, domain: outcome.domain, description: outcome.description.slice(0, 200), modelTier } })}`);
  }
}

main().catch((err) => {
  console.error("[main] Fatal error:", err);
  logEvent("✗ FAILED", `fatal error: ${(err as Error).message?.slice(0, 80) || "unknown"}`);
  process.exit(1);
});
