import type { WorkingContext, Proposal, ExecutionResult } from "../core/types";
import * as v from "valibot";
import { proposalSchema } from "./proposer";
import { queryReasoning } from "../llm";

const repairSchema = v.object({
	repairedProposal: proposalSchema,
	explanation: v.optional(v.string()),
});

export async function runRepair(
	ctx: WorkingContext,
	failedProposal: Proposal,
	executionResult: ExecutionResult
): Promise<Proposal | null> {
	if (failedProposal.executable.type !== "code") {
		return null;
	}

	const exe = failedProposal.executable;
	const langHint = exe.lang === "python" ? "python" : "js";

	// If the failure is a domain/format error (not a code bug), repair won't help
	if (
		executionResult.reason.includes("requires proof") ||
		executionResult.reason.includes("No domain spec") ||
		executionResult.reason.includes("not registered")
	) {
		console.log(`  [repair] Skipping — domain/format mismatch, not a code bug`);
		return null;
	}

	const prompt = `
You are a code repair agent. A proposal failed execution. Fix the bug.

Domain: ${ctx.domain}
Failure: ${executionResult.reason}
${executionResult.metrics ? `Metrics: ${JSON.stringify(executionResult.metrics)}` : ""}

The code that failed:
\`\`\`${langHint}
${exe.source}
\`\`\`

Original hypothesis: ${failedProposal.hypothesis}

YOUR JOB:
1. Identify the EXACT bug that caused the failure
2. Fix ONLY that bug — do not rewrite the approach unless the approach is fundamentally broken
3. Keep the same function signature and export name
4. Write plain ${langHint === "js" ? "JavaScript (no TypeScript)" : "Python"}
5. PYTHON: NEVER write code as a single line with semicolons. Always use proper indented blocks for for/while/if/def.
   WRONG: "def f(x): y = 0; for i in x: y += i; return y"
   RIGHT: proper multi-line indented code with \\n between lines

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
      "source": "function proposedSort(arr) { ... }"
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
