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
	const result = await queryReasoning({ userPrompt: prompt, schema: verdictSchema, temperature: 0.1 });
	return result.response;
}

function buildPrompt(ctx: WorkingContext, proposal: Proposal, critiques: Critique[]): string {
	const fatalCritiques = critiques.filter(c => c.severity === "fatal");
	const majorCritiques = critiques.filter(c => c.severity === "major");
	const minorCritiques = critiques.filter(c => c.severity === "minor");
	const nonRepairableFatals = fatalCritiques.filter(c => !c.repairable);

	const stepBlock = ctx.current_step ? `
CURRENT STEP [${ctx.current_step.index}]: ${ctx.current_step.goal}
  Success criteria: ${ctx.current_step.success_criteria}
  Oracle: ${ctx.current_step.oracle_hint}` : "";

	const constraintsBlock = ctx.active_constraints.length
		? `\nACTIVE CONSTRAINTS:\n${ctx.active_constraints.map(c => `  - ${c}`).join("\n")}`
		: "";

	const critiqueBlock = critiques.map((c, i) =>
		`  [${i + 1}] ${c.severity.toUpperCase()} | ${c.attack_type}: ${c.description}` +
		(c.counterexample ? `\n       counterexample: ${c.counterexample}` : "") +
		`\n       repairable: ${c.repairable}`
	).join("\n");

	return `
You are a judge agent. Domain: ${ctx.domain}
${stepBlock}
${constraintsBlock}

PROPOSAL:
  hypothesis: ${proposal.hypothesis}
  expected_benefit: ${proposal.expected_benefit}
  assumptions: ${proposal.assumptions.join("; ")}

CRITIQUES (${critiques.length} total — ${fatalCritiques.length} fatal / ${majorCritiques.length} major / ${minorCritiques.length} minor):
${critiqueBlock}

SCORING — start at 100, apply ALL that apply:
  Deductions:
    -35  non-repairable fatal critique
    -20  repairable fatal critique
    -10  major critique
    -3   minor critique
  Bonuses:
    +15  proposal directly advances current step success_criteria
    +10  builds on and cites proven lemmas
    +8   executable is complete with no stubs or placeholders
    +5   failure modes are thorough and honest

  HARD KILL (set score=0, decision=kill immediately, no further scoring):
    - Any non-repairable fatal critique
    - Proposal violates an active constraint
    - Executable contains TODO, stub, or placeholder
    - Hypothesis is non-specific or non-testable ("use a better algorithm")

ROUTING:
  kill      → hard kill condition OR score < 45
  formalize → score ≥ 45, no fatal, math/proof domain needs formal verification
  execute   → score ≥ 45, no non-repairable fatals

advances_step: true ONLY if this proposal would satisfy the current step's success_criteria verbatim.

Hard kill triggered: ${nonRepairableFatals.length > 0 ? `YES (${nonRepairableFatals.length} non-repairable fatal) → score=0, decision=kill` : "no"}

Return ONLY valid JSON:
{
  "decision": "execute|formalize|kill",
  "score": 0-100,
  "reason": "concise explanation",
  "repairs": ["specific fix if repairable issues exist"],
  "advances_step": true/false,
  "step_assessment": "how this addresses the step goal"
}
`.trim();
}
