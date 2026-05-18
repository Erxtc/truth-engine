import { queryLlm } from "../../llm";
import type { VerificationStage, StageResult } from "../types";
import type { Artifact } from "../../db/schema";
import type { WorkingContext } from "../../core/types";
import * as v from "valibot";

const consistencySchema = v.object({
	consistent: v.boolean(),
	reasoning: v.string(),
	violatedConstraints: v.optional(v.array(v.string())),
});

export const consistencyCheck: VerificationStage = {
	name: "ConsistencyCheck",
	async run(artifact: Artifact, ctx: WorkingContext): Promise<StageResult> {
		const start = Date.now();

		// Only run if there are active constraints
		if (!ctx.active_constraints || ctx.active_constraints.length === 0) {
			return { stageName: this.name, passed: true, runtimeMs: 0 };
		}

		const hypothesis = artifact.hypothesisText ?? artifact.title ?? "";
		const constraintsText = ctx.active_constraints
			.map((c, i) => `${i + 1}. ${c}`)
			.join("\n");

		const prompt = `
You are a rigorous physicist/mathematician checking a hypothesis against established constraints.

Domain: ${ctx.domain}
Established constraints (these are non‑negotiable):
${constraintsText}

Proposed hypothesis:
${hypothesis}

Assumptions listed by proposer:
${ctx.ancestor_proposals.map(a => `- ${a.hypothesis}`).join("\n")}

Does the hypothesis contradict any of the constraints? Answer with JSON only:
{
  "consistent": true/false,
  "reasoning": "detailed explanation",
  "violatedConstraints": ["constraint1", ...]
}
`.trim();

		try {
			const { response } = await queryLlm(prompt, consistencySchema);
			return {
				stageName: this.name,
				passed: response.consistent,
				reason: response.consistent
					? "Consistent with all active constraints"
					: `Violates: ${(response.violatedConstraints ?? []).join(", ")}. ${response.reasoning}`,
				runtimeMs: Date.now() - start,
			};
		} catch (err) {
			return {
				stageName: this.name,
				passed: false,
				reason: `Consistency check failed: ${err}`,
				runtimeMs: Date.now() - start,
			};
		}
	},
};