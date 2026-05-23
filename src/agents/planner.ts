import * as v from "valibot";
import { queryReasoning } from "../llm";
import type { StepPlan, OracleHint } from "../core/types";

const ALL_ORACLES: OracleHint[] = [
	"unit_tests",
	"property_fuzz",
	"benchmark",
	"lean4_proof",
	"qutip_sim",
	"custom_sim",
	"adversarial",
	"code_review",
];

const DOMAIN_ORACLES: Record<string, OracleHint[]> = {
	sorting:     ["unit_tests", "property_fuzz", "benchmark", "adversarial"],
	compression: ["unit_tests", "property_fuzz", "benchmark"],
	math:        ["lean4_proof", "code_review"],
	ml:          ["benchmark", "unit_tests", "code_review"],
	physics:     ["qutip_sim", "custom_sim", "benchmark"],
	project:     ["unit_tests", "benchmark", "code_review"],
	typescript:  ["unit_tests", "property_fuzz", "benchmark"],
	python:      ["unit_tests", "property_fuzz", "benchmark"],
	c:           ["unit_tests", "property_fuzz", "benchmark"],
};

// For domains not in DOMAIN_ORACLES (e.g. auto-generated custom domains),
// only suggest oracles that make sense for a code-verification pipeline.
// Never suggest lean4_proof or qutip_sim for non-math/non-physics domains.
const CODE_ORACLES: OracleHint[] = ["unit_tests", "code_review"];

const planStepSchema = v.object({
	index: v.pipe(v.number(), v.integer(), v.minValue(0)),
	goal: v.string(),
	success_criteria: v.string(),
	oracle_hint: v.picklist(ALL_ORACLES),
	depends_on: v.array(v.number()),
});

const stepPlanSchema = v.object({
	steps: v.pipe(v.array(planStepSchema), v.minLength(1), v.maxLength(7)),
	rationale: v.string(),
});

export async function runPlanner(
	domain: string,
	problem: string,
	invariants: string[],
	complexityScore?: number,
): Promise<StepPlan> {
	const prompt = buildPrompt(domain, problem, invariants, complexityScore);
	const result = await queryReasoning({ userPrompt: prompt, schema: stepPlanSchema, temperature: 0.1, _role: 'planner' });
	return result.response;
}

function buildPrompt(domain: string, problem: string, invariants: string[], complexityScore?: number): string {
	const available = (DOMAIN_ORACLES[domain] ?? CODE_ORACLES).join(", ");

	const invariantBlock = invariants.length
		? `Domain invariants (every step must preserve these):\n${invariants.map(i => `  - ${i}`).join("\n")}`
		: "";

	const scaleGuide = complexityScore !== undefined
		? `Problem complexity: ${complexityScore}/10.\n${complexityScore <= 2 ? "This is a TRIVIAL problem. Use 1 step, maybe 2. A single function returning the answer IS the complete solution." : complexityScore <= 5 ? "This is a MODERATE problem. Use 2-4 steps." : "This is a COMPLEX problem. Use 4-7 steps with genuine dependencies."}`
		: "";

	return `
You are a step planner. Break the problem into the MINIMUM number of verifiable steps needed.

Domain: ${domain}
Available oracles: ${available}

Problem:
${problem}

${invariantBlock}
${scaleGuide}

CRITICAL RULES:
- Use the FEWEST steps that actually make sense. More steps ≠ better plan.
- For trivial problems (simple computation, direct answer), 1 step is correct: "implement and verify".
- ONLY add steps when there is a GENUINE dependency — step B truly cannot start before step A finishes.
- Do NOT generate busywork steps (benchmark, review, formal proof) unless the problem explicitly demands them.
- oracle_hint must be one of: ${available}
- depends_on lists indices of prerequisite steps.

Return ONLY valid JSON:
{
  "steps": [
    {
      "index": 0,
      "goal": "...",
      "success_criteria": "...",
      "oracle_hint": "...",
      "depends_on": []
    }
  ],
  "rationale": "Brief."
}
`.trim();
}
