import * as v from "valibot";
import type { WorkingContext, Proposal, Critique } from "../core/types";
import { queryCritic } from "../llm";

const critiqueSchema = v.object({
	attack_type: v.fallback(
		v.union([
			v.literal("logic"),
			v.literal("assumption"),
			v.literal("edge_case"),
			v.literal("counterexample"),
			v.literal("complexity"),
		]),
		"logic"
	),
	description: v.string(),
	severity: v.fallback(
		v.union([v.literal("fatal"), v.literal("major"), v.literal("minor")]),
		"major"
	),
	counterexample: v.optional(v.string()),
	repairable: v.fallback(v.boolean(), true),
});

const critiqueListSchema = v.object({
	critiques: v.array(critiqueSchema),
});

export async function runCritic(ctx: WorkingContext, proposal: Proposal): Promise<Critique[]> {
	const prompt = buildPrompt(ctx, proposal);
	try {
		const result = await queryCritic({ userPrompt: prompt, schema: critiqueListSchema, temperature: 0.3 });
		return result.response.critiques;
	} catch (err) {
		console.warn(`  [critic] parse failed, treating as no critiques:`, (err as Error).message?.slice(0, 120));
		return [];
	}
}

function buildPrompt(ctx: WorkingContext, proposal: Proposal): string {
	const stepBlock = ctx.current_step
		? `\nSTEP BEING TARGETED: ${ctx.current_step.goal}\nSuccess criteria: ${ctx.current_step.success_criteria}`
		: "";

	const constraintsBlock = ctx.active_constraints.length
		? `\nACTIVE CONSTRAINTS (check for violations):\n${ctx.active_constraints.map(c => `  - ${c}`).join("\n")}`
		: "";

	const insightBlock = ctx.recent_insights.length
		? `\nPAST FAILURE PATTERNS (look for these recurring mistakes):\n${ctx.recent_insights.slice(0, 3).map(i => `  - ${i}`).join("\n")}`
		: "";

	const exe = proposal.executable;
	const executableSummary = exe.type === "code"
		? `\nCODE:\n\`\`\`${exe.lang}\n${exe.source}\n\`\`\``
		: exe.type === "proof"
			? `\nPROOF (${exe.system}):\n${exe.source}`
			: exe.type === "sim"
				? `\nSIMULATION CONFIG:\n${JSON.stringify(exe.config, null, 2)}`
				: `\nPROJECT FILES: ${Object.keys(exe.files).join(", ")}`;

	return `
You are an adversarial critic. Your job is to find real flaws that would cause this proposal to fail in practice.
Domain: ${ctx.domain}
${stepBlock}

DOMAIN INVARIANTS (violations are always fatal):
${ctx.active_invariants.map(i => `  - ${i}`).join("\n")}
${constraintsBlock}
${insightBlock}

PROPOSAL TO ATTACK:
  hypothesis: ${proposal.hypothesis}
  expected_benefit: ${proposal.expected_benefit}
  assumptions: ${proposal.assumptions.join("; ")}
  claimed failure modes: ${proposal.possible_failure_modes.map(f => `${f.condition}: ${f.issue}`).join("; ")}
${executableSummary}

ATTACK ANGLES — check each of these systematically:

1. LOGIC (attack_type: "logic")
   - Is the core algorithm or proof strategy correct?
   - Does the expected_benefit actually follow from the approach?
   - Are there logical gaps between the hypothesis and the implementation?

2. ASSUMPTIONS (attack_type: "assumption")
   - Which assumptions are unjustified or will not hold in practice?
   - What happens when assumptions are violated?
   - Does the code/proof silently depend on inputs being pre-sorted, non-null, etc.?

3. EDGE CASES (attack_type: "edge_case")
   - Empty input, single element, all identical elements, max/min values
   - Off-by-one errors, boundary conditions
   - Inputs the author probably didn't test

4. COUNTEREXAMPLES (attack_type: "counterexample")
   - Construct a specific input that causes wrong output, crash, or invariant violation
   - For proofs: find a case where the theorem statement could be false

5. COMPLEXITY (attack_type: "complexity")
   - Worst-case time/space complexity — is it acceptable for the domain?
   - Hidden O(n²) inner loops, excessive allocations, stack overflow on large inputs

SEVERITY CALIBRATION:
  fatal   → the proposal fundamentally cannot work as stated, or violates an invariant/constraint.
            Use for: incorrect algorithm, violated domain invariant, proven counterexample, non-termination.
            Mark repairable=false if the entire approach is wrong.
            Mark repairable=true if a targeted fix (not a rewrite) would solve it.
  major   → serious flaw that would cause failures on realistic inputs, but the core idea survives.
  minor   → cosmetic, rare edge case, or low-impact inefficiency.

RULES:
- If you find no real flaws, return an empty critiques array — do NOT invent issues.
- Be specific: "this fails when arr=[1,1,1]" is better than "may fail on duplicates".
- Each critique must be a distinct, independent flaw — no duplicates.
- Maximum 5 critiques total.

EXAMPLE of correct JSON shape (follow the field names exactly):
{
  "critiques": [
    {
      "attack_type": "edge_case",
      "description": "Fails on empty array — the while loop accesses arr[0] before checking length",
      "severity": "fatal",
      "counterexample": "proposedSort([]) throws TypeError",
      "repairable": true
    },
    {
      "attack_type": "complexity",
      "description": "Inner loop is O(n²) for partially-sorted inputs due to insertion fallback",
      "severity": "major",
      "repairable": true
    }
  ]
}

Return ONLY valid JSON: { "critiques": [...] }
`.trim();
}
