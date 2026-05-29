import type { WorkingContext, Proposal, ExecutionResult } from "../core/types";
import * as v from "valibot";
import { proposalSchema } from "./proposal-schema";
import { queryReasoning, queryRawReasoning } from "../llm";
import { validateAndFixPython } from "../utils/code-validator";
import { extractCode } from "../utils/general";

// ═══════════════════════════════════════════════════════════════════════════════
// JSON path: kept for non-Python code (JS, TS, etc. from registered domains)
// ═══════════════════════════════════════════════════════════════════════════════

const repairSchema = v.object({
  repairedProposal: proposalSchema,
  explanation: v.optional(v.string()),
});

async function runRepairJson(
  ctx: WorkingContext,
  failedProposal: Proposal,
  executionResult: ExecutionResult,
  langHint: string
): Promise<Proposal | null> {
  const exe = failedProposal.executable;
  if (exe.type !== "code") return null;

  // ── Build structured failure context ──
  const fd = executionResult.failureDetail;
  let failedTestList = "";
  if (fd && fd.failures.length > 0) {
    const names = fd.failures.map(f => `  ❌ ${f}`).join("\n");
    failedTestList = `\nFAILED TESTS (${fd.failedCount}/${fd.passedCount + fd.failedCount}):\n${names}`;
  } else {
    failedTestList = `\nFailure: ${executionResult.reason}`;
  }

  let oracleOutput = "";
  if (fd?.oracleFullOutput && fd.oracleFullOutput.length > 5) {
    oracleOutput = `\n\nVERIFICATION OUTPUT:\n\`\`\`\n${fd.oracleFullOutput.slice(0, 1500)}\n\`\`\``;
  }

  const prompt = `
You are a code repair agent. A proposal failed execution. Fix the bug.

Domain: ${ctx.domain}
${failedTestList}${oracleOutput}
${executionResult.metrics ? `Metrics: ${JSON.stringify(executionResult.metrics)}` : ""}

The code that failed:
\`\`\`${langHint}
${exe.source}
\`\`\`

Original hypothesis: ${failedProposal.hypothesis}

YOUR JOB:
1. Identify the EXACT bug that caused the failure from the test results above
2. Fix ONLY that bug — do not rewrite the approach unless the approach is fundamentally broken
3. Keep the same function signature and export name
4. Write plain ${langHint === "js" ? "JavaScript (no TypeScript)" : "Python"}

RULES:
- hypothesis and expected_benefit stay the same (just copy them)
- assumptions and possible_failure_modes: update if the fix changes them
- suggested_tests: add a test that catches the specific failure

Return ONLY valid JSON:
{
  "repairedProposal": {
    "hypothesis": "${failedProposal.hypothesis.replace(/"/g, '\\"')}",
    "expected_benefit": "${failedProposal.expected_benefit.replace(/"/g, '\\"')}",
    "assumptions": ${JSON.stringify(failedProposal.assumptions)},
    "possible_failure_modes": [{"condition": "...", "issue": "..."}],
    "suggested_tests": [{"test_name": "...", "description": "..."}],
    "executable": {
      "type": "code",
      "lang": "${exe.lang}",
      "source": "..."
    }
  },
  "explanation": "what you changed and why"
}
`.trim();

  try {
    const result = await queryReasoning({ userPrompt: prompt, schema: repairSchema, _role: 'repair' });
    return result.response.repairedProposal;
  } catch (err) {
    console.error("  [repair] LLM error:", (err as Error).message?.slice(0, 120));
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Prompter path: LLM outputs raw corrected Python code, not JSON-with-embedded-code.
// Metadata is copied from the failed proposal — only the code needs fixing.
// ═══════════════════════════════════════════════════════════════════════════════

function buildRepairCodePrompt(
  ctx: WorkingContext,
  failedProposal: Proposal,
  executionResult: ExecutionResult,
): string {
  const exe = failedProposal.executable;
  if (exe.type !== "code") return "";

  // ── Build structured failure context ──
  const fd = executionResult.failureDetail;

  // Which specific tests failed (by name)
  let failedTestList = "";
  if (fd && fd.failures.length > 0) {
    const names = fd.failures.map(f => `  ❌ ${f}`).join("\n");
    failedTestList = `\nFAILED TESTS (${fd.failedCount}/${fd.passedCount + fd.failedCount}):\n${names}`;
  } else if (executionResult.reason) {
    failedTestList = `\nFAILURE SUMMARY: ${executionResult.reason.slice(0, 300)}`;
  }

  // Full oracle output (stdout/stderr from verification)
  let oracleOutput = "";
  if (fd?.oracleFullOutput && fd.oracleFullOutput.length > 5) {
    oracleOutput = `\n\nVERIFICATION OUTPUT:\n\`\`\`\n${fd.oracleFullOutput.slice(0, 1500)}\n\`\`\``;
  }

  // Oracle source code — the actual verification tests
  let oracleSpecBlock = "";
  const oracleSrc = fd?.oracleSource ?? ctx.oracle_spec;
  if (oracleSrc) {
    const isJs = oracleSrc.includes("function verify") || oracleSrc.startsWith("function");
    const lang = isJs ? "javascript" : "python";
    const truncated = oracleSrc.length > 1200
      ? oracleSrc.slice(0, 1200) + "\n// ... (truncated)"
      : oracleSrc;
    oracleSpecBlock = `\n\nORACLE VERIFICATION CODE:\n\`\`\`${lang}\n${truncated}\n\`\`\``;
  }

  return `
You are a code repair agent. A Python function failed during testing. Fix the bug.

Domain: ${ctx.domain}
${failedTestList}${oracleOutput}${oracleSpecBlock}

THE BROKEN CODE:
\`\`\`python
${exe.source}
\`\`\`

Original hypothesis: ${failedProposal.hypothesis}

YOUR JOB:
1. Identify the EXACT bug from the failed test names and verification output
2. Fix ONLY the bug — do NOT rewrite the approach unless fundamentally broken
3. Keep the SAME function signature: \`def proposedSolution(...)\`
4. Use proper Python: 4-space indentation, newlines after def/if/for/while/else
5. NEVER write compound statements on one line (no semicolons between statements)

Output ONLY the corrected Python code. No markdown fences. No JSON. No explanation.
`.trim();
}


async function runRepairCode(
  ctx: WorkingContext,
  failedProposal: Proposal,
  executionResult: ExecutionResult,
): Promise<Proposal | null> {
  const prompt = buildRepairCodePrompt(ctx, failedProposal, executionResult);
  if (!prompt) return null;

  let raw: string;
  try {
    raw = await queryRawReasoning({ userPrompt: prompt, temperature: 0.2 });
  } catch (err) {
    console.error("  [repair] LLM error:", (err as Error).message?.slice(0, 120));
    return null;
  }

  const correctedCode = extractCode(raw);
  if (!correctedCode || correctedCode.length < 10) {
    console.warn("  [repair] LLM returned empty/short response");
    return null;
  }

  // Pre-validate and auto-fix — free, catches syntax errors the repair agent may introduce
  const validation = validateAndFixPython(correctedCode);
  if (!validation.ok) {
    console.warn(`  [repair] Validation failed: ${validation.error?.slice(0, 100)}`);
    return null;
  }
  const finalCode = validation.source;
  if (validation.autoFixed) {
    console.log("  [repair] Auto-fixed repair output before execution");
  }

  // Keep the same metadata — only the code changed
  return {
    hypothesis: failedProposal.hypothesis,
    expected_benefit: failedProposal.expected_benefit,
    assumptions: failedProposal.assumptions,
    possible_failure_modes: failedProposal.possible_failure_modes,
    suggested_tests: failedProposal.suggested_tests,
    executable: {
      type: "code",
      lang: "python",
      source: finalCode,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════════

export async function runRepair(
  ctx: WorkingContext,
  failedProposal: Proposal,
  executionResult: ExecutionResult,
): Promise<Proposal | null> {
  if (failedProposal.executable.type !== "code") {
    return null;
  }

  const exe = failedProposal.executable;
  const langHint = exe.lang === "python" ? "python" : "js";

  // Domain/format errors — repair won't help
  if (
    executionResult.reason.includes("No domain spec") ||
    executionResult.reason.includes("not registered") ||
    executionResult.reason.includes("requires project executable") ||
    executionResult.reason.includes("requires code executable")
  ) {
    console.log(`  [repair] Skipping — domain/format mismatch, not a code bug`);
    return null;
  }

  // Python: use Prompter path (raw code output, no JSON wrapping)
  if (exe.lang === "python") {
    return runRepairCode(ctx, failedProposal, executionResult);
  }

  // JS/TS/etc.: keep JSON path
  return runRepairJson(ctx, failedProposal, executionResult, langHint);
}
