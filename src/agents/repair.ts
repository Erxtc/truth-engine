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
		console.log("[repair] only code proposals can be repaired");
		return null;
	}

	const exe = failedProposal.executable;
	const langHint = exe.lang === "python" ? "python" : "js";

	const prompt = `
You are a code repair agent. A proposal failed execution. Fix the code.

Domain: ${ctx.domain}
Failure reason: ${executionResult.reason}
${executionResult.metrics ? `Metrics: ${JSON.stringify(executionResult.metrics)}` : ""}

Failed code:
\`\`\`${langHint}
${exe.source}
\`\`\`

RULES:
- Write plain ${langHint === "js" ? "JavaScript" : "Python"} — NO TypeScript type annotations (no \`arr: number[]\`, no \`: number\`, no interface/type keywords)
- Keep the same hypothesis and expected_benefit
- Return ONLY valid JSON — no markdown, no fences, no extra text

EXAMPLE JSON shape (copy field names exactly, fill in your repaired values):
{
  "repairedProposal": {
    "hypothesis": "${failedProposal.hypothesis.replace(/"/g, '\\"')}",
    "expected_benefit": "${failedProposal.expected_benefit.replace(/"/g, '\\"')}",
    "assumptions": ${JSON.stringify(failedProposal.assumptions)},
    "possible_failure_modes": [{ "condition": "example", "issue": "description" }],
    "suggested_tests": [{ "test_name": "example", "description": "description" }],
    "executable": {
      "type": "code",
      "lang": "${exe.lang}",
      "source": "function proposedSort(arr) { /* your repaired function here */ }"
    }
  },
  "explanation": "what you changed and why"
}
`.trim();

	try {
		const result = await queryReasoning({ userPrompt: prompt, schema: repairSchema });
		return result.response.repairedProposal
	} catch (err) {
		console.error("[repair] LLM error:", err);
		return null;
	}
}