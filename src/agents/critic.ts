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
		console.warn(`  [critic] parse failed:`, (err as Error).message?.slice(0, 120));
		return [];
	}
}

function buildPrompt(ctx: WorkingContext, proposal: Proposal): string {
	const exe = proposal.executable;
	const executableBlock = exe.type === "code"
		? `\nCODE:\n\`\`\`${exe.lang}\n${exe.source}\n\`\`\``
		: exe.type === "proof"
			? `\nPROOF (${exe.system}):\n${exe.source}`
			: exe.type === "sim"
				? `\nSIM CONFIG:\n${JSON.stringify(exe.config)}`
				: `\nPROJECT FILES: ${Object.keys(exe.files).join(", ")}`;

	const invariantsBlock = ctx.active_invariants.length
		? `\nINVARIANTS (violation = fatal):\n${ctx.active_invariants.map(i => `  - ${i}`).join("\n")}`
		: "";

	return `
You are a code reviewer. Your ONLY job: determine if this code produces the correct answer for the stated problem.

Domain: ${ctx.domain}
Problem: ${ctx.problem.slice(0, 400)}${invariantsBlock}

PROPOSAL: ${proposal.hypothesis}${executableBlock}

STEP 1 — Is the code CORRECT for this exact problem?
  - Does it produce the right output?
  - For a function with NO INPUTS: returning the correct answer IS the solution.
    You do NOT need a general solver. A hardcoded correct answer = correct function.
  - If the answer is correct → return { "critiques": [] } and STOP. You are DONE.

STEP 2 — Only if you found a REAL bug, not a style complaint:
  REAL issues: wrong answer, infinite loop, crashes on valid input, violates a stated invariant.
  NOT issues (ignore completely):
	    - Missing comments, documentation, or JSDoc
	    - No error handling (for functions that can't error)
	    - No input validation (when there are no inputs, or for trivial functions)
	    - "Not extensible" or "not reusable" or "no tests"
	    - Any complaint about code STYLE rather than code CORRECTNESS

	If the code is correct, critiques MUST be empty. A function that returns 15*17=255 for "what is 15 times 17" is CORRECT — no critiques needed.

	OUTPUT EXAMPLES:

	For CORRECT code: { "critiques": [] }

	For BUGGY code: { "critiques": [{"attack_type": "logic", "description": "Returns 16*17 instead of 15*17", "severity": "fatal", "repairable": true}] }

	Return ONLY: { "critiques": [...] }`.trim();
}
