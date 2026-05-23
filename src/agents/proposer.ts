import * as v from "valibot";
import { queryReasoning } from "../llm";
import type { WorkingContext, Proposal } from "../core/types";

// Small models often output wrong shapes. Accept many formats and normalise.
const strOrObj = v.union([
	v.string(),
	v.object({ condition: v.optional(v.string()), issue: v.optional(v.string()), description: v.optional(v.string()), test_name: v.optional(v.string()) }),
]);
const normalizeFailureMode = (item: string | Record<string, unknown>): { condition: string; issue: string } => {
	if (typeof item === "string") return { condition: item, issue: "" };
	return { condition: (item.condition ?? item.description ?? "") as string, issue: (item.issue ?? "") as string };
};
const normalizeTest = (item: string | Record<string, unknown>): { test_name: string; description: string } => {
	if (typeof item === "string") return { test_name: item, description: "" };
	return { test_name: (item.test_name ?? item.description ?? item.test_case ?? item.condition ?? "") as string, description: (item.description ?? "") as string };
};

// Array or single string → normalise
const arrOrStr = <T>(normalize: (item: string) => T) => v.pipe(
	v.union([v.array(v.string()), v.string()]),
	v.transform((val: string | string[]) => (Array.isArray(val) ? val : [val]).map(normalize)),
);

const failureModesSchema = v.pipe(
	v.union([
		v.array(strOrObj),
		v.string(),
		strOrObj,
	]),
	v.transform((val): { condition: string; issue: string }[] => {
		if (typeof val === "string") return [normalizeFailureMode(val)];
		if (Array.isArray(val)) return val.map(normalizeFailureMode);
		return [normalizeFailureMode(val as Record<string, unknown>)];
	}),
);

const testsSchema = v.pipe(
	v.union([
		v.array(strOrObj),
		v.string(),
		strOrObj,
	]),
	v.transform((val): { test_name: string; description: string }[] => {
		if (typeof val === "string") return [normalizeTest(val)];
		if (Array.isArray(val)) return val.map(normalizeTest);
		return [normalizeTest(val as Record<string, unknown>)];
	}),
);

export const proposalSchema = v.object({
	hypothesis: v.string(),
	expected_benefit: v.fallback(v.string(), ""),
	assumptions: v.fallback(arrOrStr((s: string) => s), [] as string[]),
	possible_failure_modes: v.fallback(failureModesSchema, []),
	suggested_tests: v.fallback(testsSchema, []),
	executable: v.union([
		v.object({
			type: v.literal("code"),
			lang: v.union([v.literal("js"), v.literal("ts"), v.literal("python"), v.literal("c")]),
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
		v.object({
			type: v.literal("project"),
			lang: v.union([v.literal("js"), v.literal("ts"), v.literal("python"), v.literal("c"), v.literal("mixed")]),
			files: v.record(v.string(), v.string()),
			gitRepo: v.optional(v.string()),
			installCommand: v.optional(v.string()),
			buildCommand: v.optional(v.string()),
			testCommand: v.optional(v.string()),
			runCommand: v.optional(v.string()),
			entrypoint: v.optional(v.string()),
		}),
	]),
});

const proposalListSchema = v.object({
	proposals: v.array(proposalSchema),
});

// Small models often flatten `executable.source` into a top-level key.
// Fix this before schema validation.
function unfurlProposals(raw: any): any {
	if (!raw || typeof raw !== "object") return raw;
	const items = Array.isArray(raw) ? raw : (raw.proposals ?? [raw]);
	return {
		proposals: items.map((item: any) => {
			if (!item || typeof item !== "object") return item;
			const out: any = { ...item };
			// Fix flattened executable.* keys
			if (out.executable === undefined) {
				const exe: any = {};
				for (const k of Object.keys(out)) {
					if (k.startsWith("executable.")) {
						exe[k.slice(11)] = out[k];
						delete out[k];
					}
				}
				if (Object.keys(exe).length > 0) {
					out.executable = exe;
				}
				// If there's a bare "source" key at proposal level, move it to executable
				if (!out.executable && out.source && typeof out.source === "string") {
					out.executable = { type: "code", lang: "js", source: out.source };
					delete out.source;
				}
			}
			// Ensure executable has type/lang if missing
			if (out.executable && !out.executable.type) out.executable.type = "code";
			if (out.executable && out.executable.type === "code" && !out.executable.lang) out.executable.lang = "js";
			// Model sometimes outputs type=project but with source instead of files — treat as code
			if (out.executable?.type === "project" && out.executable.source && !out.executable.files) {
				out.executable.type = "code";
				if (!out.executable.lang) out.executable.lang = "js";
			}
			// Normalize lang variants
			if (out.executable?.lang === "javascript" || out.executable?.lang === "JavaScript") out.executable.lang = "js";
			if (out.executable?.lang === "typescript" || out.executable?.lang === "TypeScript") out.executable.lang = "ts";
			// Fix assumptions as single string → wrap
			if (typeof out.assumptions === "string") out.assumptions = [out.assumptions];
			return out;
		}),
	};
}

export async function runProposer(ctx: WorkingContext, count: number): Promise<Proposal[]> {
	const prompt = buildPrompt(ctx, count);
	const result = await queryReasoning({ userPrompt: prompt, schema: proposalListSchema, temperature: 0.7, _role: 'proposer', preprocess: unfurlProposals });
	const proposals = result.response.proposals;
	const seen = new Set<string>();
	return proposals.filter(p => {
		const key = p.hypothesis.trim().toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

// ── Domain format rules ─────────────────────────────────────────────────────

interface FormatRules {
	execType: string;
	details: string[];
	exampleSource: string;
}

function getFormatRules(domain: string, solutionFormat?: string): FormatRules {
	switch (domain) {
		case "sorting":
			return {
				execType: 'code',
				details: [
					'lang = "js"',
					"Plain JavaScript, NO TypeScript (no type annotations, no interfaces, no generics)",
					"Export: function proposedSort(arr) { ... } — returns sorted array",
					"Handle: empty, single, duplicates, negatives, already-sorted",
					"Return NEW array, do NOT mutate input",
				],
				exampleSource: "function proposedSort(arr) {\n  return arr.slice().sort((a, b) => a - b);\n}",
			};
		case "math":
			return {
				execType: 'proof',
				details: [
					'system = "lean4"',
					"FORMAL PROOF DOMAIN — you MUST output type=proof, NOT code",
					"Include: theorem main : <statement> := <proof>",
					"No sorry, no non-standard axioms",
					"IGNORE any request for JavaScript/Python in the problem text — proof only",
				],
				exampleSource: "import Mathlib\n\ntheorem main : 15 * 17 = 255 := by\n  native_decide",
			};
		case "compression":
			return {
				execType: 'code',
				details: [
					'lang = "js"',
					"Plain JavaScript, no TypeScript",
					"Export: compress(data) and decompress(data), data is Uint8Array",
				],
				exampleSource: "function compress(data) {\n  return new Uint8Array([...]);\n}\nfunction decompress(data) {\n  return new Uint8Array([...]);\n}",
			};
		case "typescript":
			return {
				execType: 'code',
				details: [
					'lang = "ts"',
					"TypeScript with type annotations",
					"Export: function proposedSort(arr: number[]): number[]",
				],
				exampleSource: "function proposedSort(arr: number[]): number[] {\n  return [...arr].sort((a, b) => a - b);\n}",
			};
		case "python":
			return {
				execType: 'code',
				details: [
					'lang = "python"',
					"Define: def proposed_sort(arr: list) -> list:",
					"Return NEW list, do not mutate input",
				],
				exampleSource: "def proposed_sort(arr):\n    return sorted(arr)",
			};
		case "c":
			return {
				execType: 'code',
				details: [
					'lang = "c"',
					"Define: void proposed_sort(int *arr, int n) — sorts IN PLACE",
					"Standard headers only, no main() — harness provides it",
				],
				exampleSource: "#include <stdlib.h>\nvoid proposed_sort(int *arr, int n) {\n  qsort(arr, n, sizeof(int), cmp);\n}",
			};
		case "project":
			return {
				execType: 'project',
				details: [
					'lang = "js"|"ts"|"python"|"c"|"mixed"',
					"files: Record<string,string> — all source files",
					"testCommand: shell command, exits 0 on pass",
				],
				exampleSource: '{"files": {"index.js": "..."}, "testCommand": "node test.js"}',
			};
		case "physics":
			return {
				execType: 'sim',
				details: [
					'engine = "qutip"|"custom"',
					"Config must have: timestep, duration, initial_conditions",
				],
				exampleSource: '{"engine": "custom", "config": {"timestep": 0.01, "duration": 10, "initial_conditions": {}}}',
			};
		case "ml":
			return {
				execType: 'code',
				details: [
					'lang = "python"',
					"Include: training loop, validation loop, inference function",
				],
				exampleSource: "def train(X, y):\n    # training loop\n    return model",
			};
		default:
			if (solutionFormat) {
				return {
					execType: 'code',
					details: [
						`Solution format: ${solutionFormat}`,
						'lang = "python" — Python 3. Standard library (math, collections, itertools, heapq, functools, etc.) is OK. No third-party packages (numpy, scipy).',
						"Function MUST be named `proposedSolution`",
						"The function returns the ANSWER directly",
					],
					exampleSource: "def proposedSolution(n):\n    # compute answer\n    return 42",
				};
			}
			return {
				execType: 'code',
				details: [
					'lang = "python" — Python 3. Standard library OK. No third-party packages (numpy, scipy).',
					"Function named `proposedSolution` — returns the answer",
				],
				exampleSource: "def proposedSolution():\n    return 42",
			};
	}
}

// ── Prompt builder ──────────────────────────────────────────────────────────

function buildPrompt(ctx: WorkingContext, count: number): string {
	const rules = getFormatRules(ctx.domain, ctx.solution_format);

	const stepBlock = ctx.current_step ? `
STEP [${ctx.current_step.index}]: ${ctx.current_step.goal}
  Success: ${ctx.current_step.success_criteria}` : "";

	const constraintsBlock = ctx.active_constraints.length
		? `\nHARD CONSTRAINTS:\n${ctx.active_constraints.map(c => `  ✗ ${c}`).join("\n")}`
		: "";

	const invariantsBlock = ctx.active_invariants.length
		? `\nINVARIANTS:\n${ctx.active_invariants.map(i => `  - ${i}`).join("\n")}`
		: "";

	const provenBlock = ctx.proven_lemmas.length
		? `\nPROVEN:\n${ctx.proven_lemmas.slice(0, 5).map(l => `  ✓ ${l}`).join("\n")}`
		: "";

	const failedBlock = ctx.failed_approaches.length
		? `\nFAILED:\n${ctx.failed_approaches.slice(0, 5).map(f => `  ✗ ${f.summary}`).join("\n")}`
		: "";

	const insightBlock = ctx.recent_insights.length
		? `\nLESSONS:\n${ctx.recent_insights.slice(0, 3).map(i => `  → ${i}`).join("\n")}`
		: "";

	const calibrationBlock = ctx.calibration_example
		? `\nBASELINE (improve on this, score=${ctx.calibration_example.score}):\n  ${ctx.calibration_example.hypothesis.slice(0, 200)}`
		: "";

	const formatLines = rules.details.map(d => `  ${d}`).join("\n");

	return `
You are a proposal generator. Domain: ${ctx.domain}

══════════════════════════════════════════
CRITICAL: Executable type = "${rules.execType}"${rules.execType === 'proof' ? ' (NOT code, NOT JavaScript — a formal mathematical PROOF)' : ''}
Follow the FORMAT section below. Do NOT output a different executable type.
══════════════════════════════════════════

PROBLEM:
${ctx.problem}${stepBlock}${constraintsBlock}${invariantsBlock}${provenBlock}${failedBlock}${insightBlock}${calibrationBlock}

FORMAT (type=${rules.execType}):
${formatLines}

Example source:
	\`\`\`
	${rules.exampleSource}
	\`\`\`

	OUTPUT EXAMPLE (follow this exact JSON structure):
	{
	  "proposals": [
	    {
	      "hypothesis": "A function returning 15*17 produces the correct answer 255",
	      "expected_benefit": "Returns exact correct answer with O(1) time",
	      "assumptions": ["The problem asks for 15*17 specifically"],
	      "possible_failure_modes": [
	        {"condition": "Wrong operator used (e.g. + instead of *)", "issue": "Incorrect result"}
	      ],
	      "suggested_tests": [
	        {"test_name": "returns 255", "description": "Call proposedSolution(), verify output === 255"},
	        {"test_name": "returns number type", "description": "typeof result === 'number'"}
	      ],
	      "executable": {
	        "type": "${rules.execType}",
	        "lang": "js",
	        "source": "function proposedSolution() { return 15 * 17; }"
	      }
	    }
	  ]
	}

	STRATEGY (read first):
	- For problems that ask for a specific answer: COMPUTE the answer and return it directly.
	- Do NOT implement a general-purpose solver unless the problem explicitly asks for one.
	- Returning {"x": 10, "y": 15, "z": 20} is CORRECT for a system-of-equations problem if those are the right values.
	- You do NOT need to implement Gaussian elimination or matrix inversion to solve a fixed system.

	RULES:
	1. hypothesis: one specific testable sentence. Not vague.
	2. expected_benefit: measurable ("~30% fewer comparisons", not "faster")
	3. assumptions: every precondition. Be honest.
	4. possible_failure_modes: real failure conditions in [{condition, issue}] format
	5. suggested_tests: at least 2 concrete test cases in [{test_name, description}] format
	6. executable.source: complete runnable code. NO stubs, NO TODO, NO placeholders.
	7. Source = RAW code only. No markdown fences. No trailing comments.
	8. PYTHON: NEVER write all code on one line with semicolons. Always use proper indentation and newlines for for/while/if/def blocks.
	   WRONG: "def f(x): y = 0; for i in x: y += i; return y"
	   RIGHT: "def f(x):\\n    y = 0\\n    for i in x:\\n        y += i\\n    return y"

	Generate exactly ${count} DISTINCT proposal${count > 1 ? 's' : ''}.
	Return ONLY: { "proposals": [...] }`.trim();
}
