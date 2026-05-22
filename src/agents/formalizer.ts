import type { WorkingContext, Proposal } from "../core/types";
import * as v from "valibot";
import { queryReasoning } from "../llm";

const formalizerOutputSchema = v.object({
	success: v.boolean(),
	formalCode: v.optional(v.string()),
	error: v.optional(v.string()),
});

export async function runFormalizer(
	ctx: WorkingContext,
	proposal: Proposal
): Promise<Proposal | null> {
	// Only attempt formalization for code-type proposals that are math-related
	if (proposal.executable.type !== "code") {
		console.log("[formalizer] only code proposals can be formalized");
		return null;
	}

	const prompt = `
You are a formal verification expert. Convert the following JavaScript sorting algorithm into a Lean 4 theorem and proof.

Domain: ${ctx.domain}
Problem: ${ctx.problem}
Hypothesis: ${proposal.hypothesis}

Code:
\`\`\`javascript
${proposal.executable.source}
\`\`\`

Generate a Lean 4 theorem that states the correctness property (sortedness and permutation) and provide a proof skeleton. 
Return JSON: { "success": boolean, "formalCode": "lean code", "error": "..." }

If you cannot produce a correct formalization, set success=false and explain why.
`.trim();

	try {
		const result = await queryReasoning({ userPrompt: prompt, schema: formalizerOutputSchema });
		if (!result.response.success || !result.response.formalCode) {
			console.log(`[formalizer] failed: ${result.response.error}`);
			return null;
		}

		// Create a new proposal with proof type
		const formalProposal: Proposal = {
			...proposal,
			executable: {
				type: "proof",
				system: "lean4",
				source: result.response.formalCode,
			},
		};
		return formalProposal;
	} catch (err) {
		console.error("[formalizer] LLM error:", err);
		return null;
	}
}