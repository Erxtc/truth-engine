import type { KnowledgeGraph } from "../db/knowledge-graph";
import type { WorkingContext, Artifact } from "./types";

function getDomainInvariants(domain: string): string[] {
	const invariants: Record<string, string[]> = {
		sorting: [
			"Output array must be sorted in non-decreasing order",
			"Output must be a permutation of input (same multiset of elements)",
			"No mutation of input array",
			"Must handle empty arrays, single elements, duplicates, negative numbers",
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
	};
	return invariants[domain] ?? ["Preserve all domain-specific invariants"];
}

export async function buildWorkingContext(
	kg: KnowledgeGraph,
	node: Artifact
): Promise<WorkingContext> {
	const problem = await kg.getProblem(node.problemId);
	if (!problem) throw new Error(`Problem ${node.problemId} not found`);

	const lemmas = await kg.getProvenLemmas(node.problemId, 10);
	const failed = await kg.getFailedApproaches(node.problemId, 15);
	const ancestorChain = await kg.getAncestorChain(node.id);
	const ancestorProposals = ancestorChain.map(a => ({
		hypothesis: a.hypothesisText ?? "",
		score: a.score,
	}));

	const insights = await kg.getRecentInsights(node.problemId, 5);
	const insightTexts = insights.map(i => i.title).filter(Boolean) as string[];

	const constraints = await kg.getActiveConstraints(node.problemId);
	const constraintTexts = constraints.map(c => c.title).filter(Boolean) as string[];

	return {
		domain: problem.domain,
		problem: problem.description,
		depth: node.depth,
		proven_lemmas: lemmas.map(l => l.hypothesisText ?? l.title ?? "").filter(Boolean),
		failed_approaches: failed,
		ancestor_proposals: ancestorProposals,
		recent_insights: insightTexts,
		active_invariants: getDomainInvariants(problem.domain),
		active_constraints: constraintTexts,
	};
}