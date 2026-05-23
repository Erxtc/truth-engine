import * as v from "valibot";
import { queryReasoning } from "../llm";
import type { WorkingContext, Proposal, Critique, Verdict } from "../core/types";

const verdictSchema = v.object({
	decision: v.union([
		v.literal("execute"),
		v.literal("formalize"),
		v.literal("kill"),
	]),
	score: v.pipe(v.number(), v.minValue(0), v.maxValue(100)),
	reason: v.string(),
	repairs: v.optional(v.array(v.string())),
	advances_step: v.optional(v.boolean()),
	step_assessment: v.optional(v.string()),
});

export async function runJudge(ctx: WorkingContext, proposal: Proposal, critiques: Critique[]): Promise<Verdict> {
	const prompt = buildPrompt(ctx, proposal, critiques);
	const result = await queryReasoning({ userPrompt: prompt, schema: verdictSchema, temperature: 0.1, _role: 'judge' });
	return result.response;
}

function buildPrompt(ctx: WorkingContext, proposal: Proposal, critiques: Critique[]): string {
	const stepBlock = ctx.current_step ? `
CURRENT STEP [${ctx.current_step.index}]: ${ctx.current_step.goal}
  Success criteria: ${ctx.current_step.success_criteria}` : "";

	const critiqueBlock = critiques.length > 0
		? critiques.map((c, i) =>
			`  [${i + 1}] ${c.severity.toUpperCase()} | ${c.attack_type}: ${c.description}` +
			(c.counterexample ? `\n       counterexample: ${c.counterexample}` : "")
		).join("\n")
		: "  (no critiques)";

	return `
You are a gatekeeper. Your ONLY job: catch obviously broken code before execution.

Domain: ${ctx.domain}
${stepBlock}

PROBLEM: ${ctx.problem.slice(0, 300)}

PROPOSAL: ${proposal.hypothesis}

CRITIQUES (${critiques.length} total):
${critiqueBlock}

SCORING:
  Base: 80.
  The EXECUTION SANDBOX is the real verifier — it will run the code and check the answer.
  You only catch OBVIOUS problems:
    - TODO/stub/placeholder in code → score 0, KILL
    - Syntax error / obviously crashes → score 10
    - Returns completely wrong type → score 30
    - Otherwise → execute (score 70-95)
  Do NOT try to verify mathematical correctness. That is the sandbox's job.
  Critiques about "the answer is wrong" without proof → ignore. Let execution decide.

DECISION:
  kill      → score < 20, OR code has TODO/stub/placeholder text
  execute   → score >= 20 (DEFAULT — let almost everything through)
  formalize → math/proof domain only

advances_step: true if this likely satisfies the step goal.

Return ONLY valid JSON:
{ "decision": "execute", "score": 85, "reason": "Code is runnable, let execution verify.", "advances_step": true, "step_assessment": "Will verify" }
`.trim();
}
