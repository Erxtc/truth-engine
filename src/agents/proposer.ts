import * as v from "valibot";
import { queryReasoning } from "../llm";
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
	const result = await queryReasoning({ userPrompt: prompt, schema: proposalListSchema, temperature: 0.7 });
	const proposals = result.response.proposals;
	// Deduplicate by hypothesis text (model occasionally emits the same proposal twice)
	const seen = new Set<string>();
	return proposals.filter(p => {
		const key = p.hypothesis.trim().toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function buildPrompt(ctx: WorkingContext, count: number): string {
	// Step target — highest priority, always at top
	const stepBlock = ctx.current_step ? `
CURRENT TARGET STEP [${ctx.current_step.index}]:
  Goal: ${ctx.current_step.goal}
  Success criteria: ${ctx.current_step.success_criteria}
  Verification oracle: ${ctx.current_step.oracle_hint}
  Your proposal MUST directly advance this step. Off-target proposals will be killed.` : "";

	const constraintsBlock = ctx.active_constraints.length
		? `\nHARD CONSTRAINTS (violation = automatic kill):\n${ctx.active_constraints.map(c => `  ✗ ${c}`).join("\n")}`
		: "";

	const invariantsBlock = `\nDOMAIN INVARIANTS (all proposals must preserve):\n${ctx.active_invariants.map(i => `  - ${i}`).join("\n")}`;

	const provenBlock = ctx.proven_lemmas.length
		? `\nPROVEN LEMMAS (build on these, cite them):\n${ctx.proven_lemmas.slice(0, 5).map(l => `  ✓ ${l}`).join("\n")}`
		: "";

	// Only last 4 ancestors to stay within token budget
	const ancestorBlock = ctx.ancestor_proposals.length
		? `\nANCESTOR LINEAGE:\n${ctx.ancestor_proposals.slice(-4).map(a => `  [score=${a.score}] ${a.hypothesis}`).join("\n")}`
		: "";

	const insightBlock = ctx.recent_insights.length
		? `\nLEARNED INSIGHTS (apply these):\n${ctx.recent_insights.slice(0, 3).map(i => `  → ${i}`).join("\n")}`
		: "";

	const failedBlock = ctx.failed_approaches.length
		? `\nDEAD APPROACHES (do NOT repeat):\n${ctx.failed_approaches.slice(0, 5).map(f => `  ✗ ${f.summary} — ${f.reason}`).join("\n")}`
		: "";

	const calibrationBlock = ctx.calibration_example
		? `\nCALIBRATION EXAMPLE (a solution that already passed — use as a reference baseline, then improve upon it):
  Score: ${ctx.calibration_example.score}
  Hypothesis: ${ctx.calibration_example.hypothesis.slice(0, 200)}
  Source:
${ctx.calibration_example.source_code.slice(0, 800).split("\n").map(l => `    ${l}`).join("\n")}`
		: "";

	const formatRules = getDomainFormatRules(ctx.domain, ctx.solution_format);

	return `
You are a research proposer in domain: ${ctx.domain} (depth ${ctx.depth})

PROBLEM:
${ctx.problem}
${stepBlock}
${constraintsBlock}
${invariantsBlock}
${provenBlock}
${ancestorBlock}
${insightBlock}
${failedBlock}
${calibrationBlock}

EXECUTABLE FORMAT:
${formatRules}
- The "source" field must contain ONLY the raw function body — no markdown, no comments after the closing brace, no "comment" keys, no extra text.
- If lang is "js": write plain JavaScript. NO TypeScript (no type annotations, no interfaces, no generics like <T>).

QUALITY REQUIREMENTS:
- hypothesis: specific and testable — "use a better algorithm" is rejected
- expected_benefit: quantifiable — "reduces comparisons by ~30%" not "faster"
- assumptions: every precondition your approach requires
- possible_failure_modes: honest assessment of what would break this
- executable: complete and runnable — no stubs, no TODO comments, no placeholders

Generate exactly ${count} DISTINCT proposals exploring genuinely different strategies.

EXAMPLE of correct JSON shape (do not copy the content, only follow the structure):
{
  "proposals": [
    {
      "hypothesis": "Radix sort on 32-bit integers achieves O(n) time with 4 passes",
      "expected_benefit": "Reduces comparisons to zero, ~2x throughput vs TimSort on 1M ints",
      "assumptions": ["integers are 32-bit", "sufficient heap memory for count arrays"],
      "possible_failure_modes": [
        { "condition": "negative integers", "issue": "bit representation differs, must handle sign bit" }
      ],
      "suggested_tests": [
        { "test_name": "negative_numbers", "description": "sort array containing negative integers" }
      ],
      "executable": {
        "type": "code",
        "lang": "js",
        "source": "function proposedSort(arr) { ... }"
      }
    }
  ]
}

Return ONLY valid JSON: { "proposals": [...] }
`.trim();
}

function getDomainFormatRules(domain: string, solutionFormat?: string): string {
	switch (domain) {
		case "sorting":
			return [
				'- executable.type = "code", lang = "js"',
				"- Write plain JavaScript — NO TypeScript type annotations (no `arr: number[]`, no `: number`, no `interface`, no `type`)",
				"- Export a function `proposedSort(arr)` that returns a sorted array",
				"- Must handle: empty array, single element, duplicates, negatives, already-sorted input",
				"- Return a NEW array — do not mutate the input",
				"- Target O(n log n) or better; O(n²) will fail the benchmark",
			].join("\n");
		case "compression":
			return [
				'- executable.type = "code", lang = "js"',
				"- Write plain JavaScript — NO TypeScript type annotations",
				"- Export `compress(data)` and `decompress(data)` functions (data is a Uint8Array)",
				"- decompress(compress(x)) === x for all inputs",
				"- Compression ratio > 1 for non-trivial inputs",
			].join("\n");
		case "math":
			return [
				'- executable.type = "proof", system = "lean4"',
				"- Include `theorem main : <statement> := <proof>`",
				"- All lemmas self-contained or from Mathlib — no sorry, no non-standard axioms",
			].join("\n");
		case "typescript":
			return [
				'- executable.type = "code", lang = "ts"',
				"- Write TypeScript (type annotations allowed and encouraged)",
				"- Export a function `proposedSort(arr: number[]): number[]`",
				"- Must handle: empty array, single element, duplicates, negatives",
				"- Return a NEW array — do not mutate input",
				"- Runs via `bun run` — Bun is the TypeScript runtime",
			].join("\n");
		case "python":
			return [
				'- executable.type = "code", lang = "python"',
				"- Define `def proposed_sort(arr: list) -> list:`",
				"- Return a NEW list — do not mutate input",
				"- Must handle: empty list, single element, duplicates, negatives",
				"- Target O(n log n) or better",
			].join("\n");
		case "c":
			return [
				'- executable.type = "code", lang = "c"',
				"- Define `void proposed_sort(int *arr, int n)` — sorts IN PLACE",
				"- Include only standard headers (<stdlib.h>, <string.h>, etc.)",
				"- Do NOT include a main() function — the harness provides it",
				"- Handle n=0 without crashing",
			].join("\n");
		case "project":
			return [
				'- executable.type = "project"',
				"- files: a Record<string, string> of all source files (path → content)",
				"- testCommand: command that runs tests and exits 0 on success (e.g. 'bun test', 'pytest', 'npm test')",
				"- installCommand: dependency installation command if needed (e.g. 'npm install', 'pip install -r requirements.txt')",
				"- buildCommand: optional build step (e.g. 'bun build src/index.ts')",
				"- gitRepo: optional URL to clone before writing files (for repo-modification proposals)",
				"- Test output should be valid JSON on the last stdout line: { stages: [...], passed: bool }",
				"  OR any test runner that exits 0 = pass, non-zero = fail",
			].join("\n");
		case "physics":
			return [
				'- executable.type = "sim"',
				"- Conserve energy and momentum within floating-point tolerance",
				"- Respect Courant condition for timestep",
				"- Config must specify: timestep, duration, initial_conditions",
			].join("\n");
		case "ml":
			return [
				'- executable.type = "code", lang = "python"',
				"- Include training loop, validation loop, and inference function",
				"- Validation loss within 10% of training loss",
				"- Inference < 100ms per sample",
			].join("\n");
		default:
			if (solutionFormat) {
				return [
					`- Solution format: ${solutionFormat}`,
					'- executable.type = "code", lang = "js"',
					"- Write plain JavaScript (no TypeScript annotations)",
					"- Export a function named `proposedSolution` that returns the answer",
					"- The function must be self-contained (no imports, no require)",
				].join("\n");
			}
			return "- Executable type must match the verification oracle for the current step.";
	}
}
