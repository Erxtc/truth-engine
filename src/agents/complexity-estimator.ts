import * as v from "valibot";
import { queryReasoning } from "../llm";
import type {
	ComplexityAssessment,
	ComplexityType,
	ConfidenceLevel,
	RunParams,
} from "../core/types";

// ── LLM schema — qualitative only; params are computed deterministically ─────

const assessmentSchema = v.object({
	score: v.pipe(v.number(), v.minValue(1), v.maxValue(10)),
	type: v.fallback(
		v.picklist(["trivial", "algorithmic", "optimization", "systems", "research", "formal_proof"]),
		"algorithmic"
	),
	reasoning: v.string(),
	num_subproblems: v.fallback(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10)), 1),
	decomposition_hint: v.fallback(v.array(v.string()), []),
});

// ── Parameter table — score → RunParams ──────────────────────────────────────
// Indexed by Math.ceil(score / 2) - 1, giving buckets 1-2, 3-4, 5-6, 7-8, 9-10

const PARAM_TABLE: RunParams[] = [
	// score 1–2: trivial
	{ maxDepth: 2, maxBranches: 2, criticCount: 1, requiredConfidence: 2, consensus: false, budgetLlmCalls: 15 },
	// score 3–4: simple
	{ maxDepth: 3, maxBranches: 2, criticCount: 1, requiredConfidence: 2, consensus: false, budgetLlmCalls: 30 },
	// score 5–6: moderate
	{ maxDepth: 5, maxBranches: 3, criticCount: 2, requiredConfidence: 2, consensus: false, budgetLlmCalls: 60 },
	// score 7–8: complex
	{ maxDepth: 6, maxBranches: 3, criticCount: 2, requiredConfidence: 3, consensus: true,  budgetLlmCalls: 120 },
	// score 9–10: research / formal
	{ maxDepth: 8, maxBranches: 4, criticCount: 3, requiredConfidence: 3, consensus: true,  budgetLlmCalls: 200 },
];

function scoreToParams(score: number, domainRequiredConfidence: ConfidenceLevel): RunParams {
	const bucket = Math.min(Math.ceil(score / 2) - 1, 4);
	const base = { ...PARAM_TABLE[bucket]! };
	// Domain's required confidence is a hard lower bound
	if (domainRequiredConfidence > base.requiredConfidence) {
		base.requiredConfidence = domainRequiredConfidence;
		// formal_proof domains always need consensus
		if (domainRequiredConfidence >= 4) base.consensus = true;
	}
	return base;
}

// ── Prompt ────────────────────────────────────────────────────────────────────

function buildPrompt(domain: string, problem: string): string {
	return `
You are a complexity estimator for an automated problem-solving system.

Domain: ${domain}
Problem:
${problem}

Rate this problem's complexity on a scale of 1–10:
  1–2  trivial       One obvious correct approach, well-known algorithm, no ambiguity
  3–4  algorithmic   Standard technique, straightforward implementation
  5–6  optimization  Multiple valid approaches, tradeoffs and benchmarking required
  6–7  systems       Multi-component architecture, integration challenges
  8–9  research      Novel methodology required, no direct known solution
  9–10 formal_proof  Requires formal verification or mathematical proof

Also assess:
- num_subproblems: how many independent sub-problems this decomposes into (1 if atomic)
- decomposition_hint: if num_subproblems > 1, a short label for each sub-problem (e.g. ["parse", "type-check", "codegen"])

SCORING EXAMPLES:
  "Implement max(a, b)"               → score: 1, type: "trivial"
  "Implement quicksort"               → score: 3, type: "algorithmic"
  "Optimize sort for 1M integers"     → score: 5, type: "optimization"
  "Build a REST API with auth"        → score: 6, type: "systems", num_subproblems: 3
  "Find fastest graph coloring algo"  → score: 8, type: "research"
  "Prove correctness of merge sort"   → score: 9, type: "formal_proof"

Return ONLY valid JSON:
{
  "score": 1-10,
  "type": "trivial|algorithmic|optimization|systems|research|formal_proof",
  "reasoning": "one or two sentences",
  "num_subproblems": 1,
  "decomposition_hint": []
}
`.trim();
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function estimateComplexity(
	domain: string,
	problem: string,
	domainRequiredConfidence: ConfidenceLevel = 2
): Promise<ComplexityAssessment> {
	const prompt = buildPrompt(domain, problem);

	try {
		const result = await queryReasoning({ userPrompt: prompt, schema: assessmentSchema, temperature: 0.1 });
		const r = result.response;

		const suggestedParams = scoreToParams(r.score, domainRequiredConfidence);

		return {
			score: r.score,
			type: r.type as ComplexityType,
			reasoning: r.reasoning,
			numSubproblems: r.num_subproblems,
			decompositionHint: r.decomposition_hint,
			suggestedParams,
		};
	} catch (err) {
		// Fail safe: return a moderate-complexity assessment so the run still proceeds
		console.warn("[complexity-estimator] Estimation failed, defaulting to score=5:", (err as Error).message?.slice(0, 80));
		return {
			score: 5,
			type: "optimization",
			reasoning: "Estimation failed — defaulting to moderate complexity",
			numSubproblems: 1,
			decompositionHint: [],
			suggestedParams: scoreToParams(5, domainRequiredConfidence),
		};
	}
}

/**
 * Merge CLI overrides with the estimator's suggested params.
 * Explicit CLI flags always win; null/undefined means "use assessment".
 */
export function resolveRunParams(
	cliOverrides: {
		maxDepth: number | null;
		maxBranches: number | null;
		criticCount: number | null;
		requiredConfidence: number | null;
		consensus: boolean | null;
	},
	assessment: ComplexityAssessment
): RunParams {
	const base = assessment.suggestedParams;
	return {
		maxDepth:           cliOverrides.maxDepth           ?? base.maxDepth,
		maxBranches:        cliOverrides.maxBranches        ?? base.maxBranches,
		criticCount:        cliOverrides.criticCount        ?? base.criticCount,
		requiredConfidence: (cliOverrides.requiredConfidence ?? base.requiredConfidence) as ConfidenceLevel,
		consensus:          cliOverrides.consensus          ?? base.consensus,
		budgetLlmCalls:     base.budgetLlmCalls,
	};
}
