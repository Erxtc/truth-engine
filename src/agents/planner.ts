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

const planStepSchema = v.object({
	index: v.pipe(v.number(), v.integer(), v.minValue(0)),
	goal: v.string(),
	success_criteria: v.string(),
	oracle_hint: v.picklist(ALL_ORACLES),
	depends_on: v.array(v.number()),
});

const stepPlanSchema = v.object({
	steps: v.pipe(v.array(planStepSchema), v.minLength(2), v.maxLength(7)),
	rationale: v.string(),
});

export async function runPlanner(
	domain: string,
	problem: string,
	invariants: string[]
): Promise<StepPlan> {
	const prompt = buildPrompt(domain, problem, invariants);
	const result = await queryReasoning({ userPrompt: prompt, schema: stepPlanSchema, temperature: 0.1 });
	return result.response;
}

function buildPrompt(domain: string, problem: string, invariants: string[]): string {
	const available = (DOMAIN_ORACLES[domain] ?? ALL_ORACLES).join(", ");

	const invariantBlock = invariants.length
		? `Domain invariants (every step must preserve these):\n${invariants.map(i => `  - ${i}`).join("\n")}`
		: "";

	return `
You are a research planning agent. Decompose the following problem into a concrete, ordered sequence of verifiable steps.

Domain: ${domain}
Available verification oracles: ${available}

Problem:
${problem}

${invariantBlock}

Rules:
- Generate between 2 and 7 steps, ordered by dependency.
- Each step must have a CONCRETE success_criteria that the oracle can objectively verify.
- oracle_hint must be one of: ${available}
- depends_on lists indices of steps that must complete before this one starts.
- Steps must build on each other — each step creates foundations the next step requires.
- Do not generate a step whose success cannot be verified by the available oracles.
- Steps should progress from "establish foundations" → "build solution" → "validate and harden".

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
  "rationale": "Brief explanation of why this decomposition makes sense for the problem."
}
`.trim();
}
