import { queryLlm } from "../llm";
import type { WorkingContext, Proposal, ExecutionResult } from "../core/types";
import * as v from "valibot";
import { proposalSchema } from "./proposer";

const repairSchema = v.object({
	repairedProposal: proposalSchema,
	explanation: v.string(),
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

	const prompt = `
You are a code repair agent. The following proposal failed execution.

Domain: ${ctx.domain}
Hypothesis: ${failedProposal.hypothesis}
Expected benefit: ${failedProposal.expected_benefit}
Assumptions: ${failedProposal.assumptions.join(", ")}

Failed code:
\`\`\`javascript
${failedProposal.executable.source}
\`\`\`

Failure reason from execution pipeline:
${executionResult.reason}

Failed test details (if any):
${executionResult.metrics ? JSON.stringify(executionResult.metrics, null, 2) : "No metrics"}

Your task: Repair the code to pass the failing tests. Maintain the same hypothesis and expected benefit.
Return JSON: 
{
  "repairedProposal": { ... same schema as proposal ... },
  "explanation": "brief description of changes"
}
`.trim();

	try {
		const result = await queryLlm(prompt, repairSchema);
		return result.response.repairedProposal
	} catch (err) {
		console.error("[repair] LLM error:", err);
		return null;
	}
}