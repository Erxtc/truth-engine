import type { KnowledgeGraph } from "../db/knowledge-graph";
import type { WorkingContext } from "./types";
import type { Artifact } from "../db/schema";
import { getDomainSpec } from "../executors/domains/registry";

// Fallback invariants for any domain not yet in the registry
const FALLBACK_INVARIANTS: Record<string, string[]> = {
	sorting: [
		"Output array must be sorted in non-decreasing order",
		"Output must be a permutation of input (same multiset of elements)",
		"No mutation of input array",
		"Must handle empty arrays, single elements, duplicates, negative numbers",
	],
	typescript: [
		"Output array must be sorted in non-decreasing order",
		"Output must be a permutation of input",
		"No mutation of input array",
		"Must compile without errors under Bun/TypeScript",
	],
	python: [
		"Output list must be sorted in non-decreasing order",
		"Output must be a permutation of input",
		"No mutation of input list",
		"Must run under Python 3.10+",
	],
	c: [
		"Array must be sorted in-place in non-decreasing order",
		"Must not read/write out of bounds",
		"Must handle n=0",
		"No memory leaks in the sort function itself",
	],
	compression: [
		"decompress(compress(data)) === data",
		"Compression ratio must be > 1 for non-trivial data",
		"No data loss",
	],
	math: [
		"Proof must be constructively valid",
		"All lemmas must be referenced",
		"No circular dependencies",
	],
	ml: [
		"Model must not overfit (validation loss within 10% of training loss)",
		"Inference time < 100ms per sample",
	],
	physics: [
		"Simulation must conserve energy/momentum (within floating error)",
		"Time step must respect Courant condition",
	],
	project: [
		"All tests must pass (testCommand exits 0)",
		"No hardcoded credentials or secrets in source files",
		"Build must succeed before tests run",
	],
};

export function getDomainInvariants(domain: string): string[] {
	// Registry takes precedence; hardcoded list is fallback
	return getDomainSpec(domain)?.invariants
		?? FALLBACK_INVARIANTS[domain]
		?? ["Preserve all domain-specific invariants"];
}

export async function buildWorkingContext(
	kg: KnowledgeGraph,
	node: Artifact
): Promise<WorkingContext> {
	const problem = await kg.getProblem(node.problemId);
	if (!problem) throw new Error(`Problem ${node.problemId} not found`);

	const lemmas = await kg.getProvenLemmas(node.problemId, 10);
	const failedRaw = await kg.getFailedApproaches(node.problemId, 15);
	const failed = failedRaw.map(f => ({ summary: f.hypothesis, reason: f.reason }));
	const ancestorChain = await kg.getAncestorChain(node.id);
	const ancestorProposals = ancestorChain.map(a => ({
		hypothesis: a.hypothesisText ?? "",
		score: a.score,
	}));

	const insights = await kg.getRecentInsights(node.problemId, 5);
	const insightTexts = insights.map(i => i.title).filter(Boolean) as string[];

	const constraints = await kg.getActiveConstraints(node.problemId);
	const constraintTexts = constraints.map(c => c.title).filter(Boolean) as string[];

	const stepInfo = await kg.getStepInfo(node.problemId);
	const step_plan = stepInfo?.plan ?? null;
	const current_step = stepInfo ? (stepInfo.plan.steps[stepInfo.currentStep] ?? null) : null;

	return {
		domain: problem.domain,
		problem: problem.description,
		depth: node.depth,
		proven_lemmas: lemmas.map(l => l.hypothesisText ?? l.title ?? "").filter(Boolean),
		failed_approaches: failed as Array<{ summary: string; reason: string }>,
		ancestor_proposals: ancestorProposals,
		recent_insights: insightTexts,
		active_invariants: getDomainInvariants(problem.domain),
		active_constraints: constraintTexts,
		step_plan,
		current_step,
	};
}

