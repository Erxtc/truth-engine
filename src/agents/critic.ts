import * as v from "valibot";
import type { WorkingContext, Proposal, Critique } from "../core/types";
import { queryCritic } from "../llm";

const critiqueSchema = v.object({
	attack_type: v.union([
		v.literal("logic"),
		v.literal("assumption"),
		v.literal("edge_case"),
		v.literal("counterexample"),
		v.literal("complexity"),
	]),
	description: v.string(),
	severity: v.union([
		v.literal("fatal"),
		v.literal("major"),
		v.literal("minor"),
	]),
	counterexample: v.optional(v.string()),
	repairable: v.boolean(),
});

const critiqueListSchema = v.object({
	critiques: v.array(critiqueSchema),
});

export async function runCritic(ctx: WorkingContext, proposal: Proposal): Promise<Critique[]> {
	const prompt = buildPrompt(ctx, proposal);
	const result = await queryCritic({ userPrompt: prompt, schema: critiqueListSchema });
	return result.response.critiques;
}

function buildPrompt(ctx: WorkingContext, proposal: Proposal): string {
	const insightBlock = ctx.recent_insights.length
		? `\nRecent insights (learn from past failures):\n${ctx.recent_insights.map(i => `  - ${i}`).join("\n")}`
		: "";

	const constraintsBlock = ctx.active_constraints.length
		? `\nActive domain constraints (you must not violate):\n${ctx.active_constraints.map(c => `  - ${c}`).join("\n")}`
		: "";

	return `
You are an adversarial critic agent. Domain: ${ctx.domain}
Domain invariants (violations are fatal):
${ctx.active_invariants.map((i) => `  - ${i}`).join("\n")}

Proposal:
  hypothesis: ${proposal.hypothesis}
  expected_benefit: ${proposal.expected_benefit}
  assumptions:
${proposal.assumptions.map((a) => `    - ${a}`).join("\n")}
  executable: ${JSON.stringify(proposal.executable, null, 2)}
  claimed failure modes:
${proposal.possible_failure_modes.map((f) => `    - ${f.condition}: ${f.issue}`).join("\n")}
${insightBlock}
${constraintsBlock}

Attack the logic, assumptions, edge cases, and code. Give concrete counterexamples if possible.
Mark severity: fatal, major, minor.
Return ONLY valid JSON:
{
  "critiques": [
    {
      "attack_type": "...",
      "description": "...",
      "severity": "...",
      "counterexample": "...",
      "repairable": true/false
    }
  ]
}
`.trim();
}