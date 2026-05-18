import * as v from "valibot";
import { queryLlm } from "../llm";
import type { WorkingContext, Proposal } from "../core/types";

export const proposalSchema = v.object({
	hypothesis: v.string(),
	expected_benefit: v.string(),
	assumptions: v.array(v.string()),
	possible_failure_modes: v.array(
		v.object({ condition: v.string(), issue: v.string() })
	),
	suggested_tests: v.array(
		v.object({ test_name: v.string(), description: v.string() })
	),
	executable: v.union([
		v.object({
			type: v.literal("code"),
			lang: v.union([v.literal("js"), v.literal("ts"), v.literal("python")]),
			source: v.string(),
		}),
		v.object({
			type: v.literal("proof"),
			system: v.union([v.literal("lean4"), v.literal("coq")]),
			source: v.string(),
		}),
		v.object({
			type: v.literal("sim"),
			engine: v.union([v.literal("qutip"), v.literal("custom")]),
			config: v.record(v.string(), v.unknown()),
		}),
	]),
});

const proposalListSchema = v.object({
	proposals: v.array(proposalSchema),
});


export async function runProposer(ctx: WorkingContext, count: number): Promise<Proposal[]> {
	const prompt = buildPrompt(ctx, count);
	const result = await queryLlm(prompt, proposalListSchema);
	return result.response.proposals;
}


function buildPrompt(ctx: WorkingContext, count: number): string {
	const failedBlock = ctx.failed_approaches.length
		? `\nFailed approaches (do NOT repeat):\n${ctx.failed_approaches
			.map((f) => `  - ${f.summary}\n    reason: ${f.reason}`)
			.join("\n")}`
		: "";

	const provenBlock = ctx.proven_lemmas.length
		? `\nProven so far (you may build on):\n${ctx.proven_lemmas
			.map((l) => `  - ${l}`)
			.join("\n")}`
		: "";

	const ancestorBlock = ctx.ancestor_proposals.length
		? `\nAncestor proposals you are extending:\n${ctx.ancestor_proposals
			.map((a) => `  - [score=${a.score}] ${a.hypothesis}`)
			.join("\n")}`
		: "";

	const insightBlock = ctx.recent_insights.length
		? `\nRecent insights (learn from past failures):\n${ctx.recent_insights.map(i => `  - ${i}`).join("\n")}`
		: "";

	const constraintsBlock = ctx.active_constraints.length
		? `\nActive domain constraints (you must not violate):\n${ctx.active_constraints.map(c => `  - ${c}`).join("\n")}`
		: "";


	const domainRules = getDomainRules(ctx.domain);

	return `
You are a research proposer agent in domain: ${ctx.domain}
Current depth: ${ctx.depth}

Problem:
${ctx.problem}

Domain invariants (ALL proposals must preserve these):
${ctx.active_invariants.map((i) => `  - ${i}`).join("\n")}
${failedBlock}
${provenBlock}
${ancestorBlock}
${insightBlock}

${constraintsBlock}
${domainRules}

Generate exactly ${count} distinct proposals. Each must include an executable field.
Return ONLY valid JSON as described.
`.trim();
}

function getDomainRules(domain: string): string {
	switch (domain) {
		case "sorting":
			return `- Executable MUST be a JavaScript function named \`proposedSort\` that takes an array and returns a sorted array.`;
		case "compression":
			return `- Executable MUST contain \`compress\` and \`decompress\` functions.`;
		case "math":
			return `- Executable MUST be a Lean 4 proof with \`theorem main : ...\`.`;
		default:
			return `- Executable type must match the domain.`;
	}
}