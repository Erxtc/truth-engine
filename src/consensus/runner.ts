/**
 * Consensus runner — confidence level 3.
 *
 * Spawns N independent evolutionary chains on the same problem.
 * Chains are completely isolated: separate problem rows, separate artifact trees,
 * no shared memory. When each chain produces a survivor, their outputs are
 * cross-validated via the domain's crossValidate() function.
 *
 * Agreement (≥ AGREEMENT_THRESHOLD fraction of test cases matching) elevates
 * the winning artifact to confidence level 3.
 */

import { KnowledgeGraph } from "../db/knowledge-graph";
import { WorkspaceManager } from "../workspace/manager";
import { runProposer, runCritic, runJudge, runFormalizer, runRepair } from "../agents";
import { runExecutor } from "../executors/sandbox-runner";
import { getDomainSpec } from "../executors/domains";
import { buildWorkingContext, getDomainInvariants } from "../core/context";
import { runFeedbackAnalyzer } from "../analysis/feedback-manager";
import { runPlanner } from "../agents";
import { emit } from "../ui/events";
import type { Proposal, Critique } from "../core/types";
import type { Artifact } from "../db/schema";

const AGREEMENT_THRESHOLD = 0.99;

export interface ChainResult {
	problemId: string;
	bestArtifact: Artifact;
	bestProposal: Proposal;
}

export interface ConsensusResult {
	achieved: boolean;
	confidenceLevel: 2 | 3;
	/** The winning artifact (from the highest-scoring chain) */
	winner: Artifact | null;
	/** Short explanation of the consensus outcome */
	summary: string;
	chains: Array<{ problemId: string; survived: boolean; score: number }>;
}

// ── Chain evolution (self-contained, no shared state with other chains) ──────

async function evolveChain(
	kg: KnowledgeGraph,
	workspace: WorkspaceManager,
	parent: Artifact,
	domain: string,
	maxDepth: number,
	maxBranches: number,
	criticCount: number,
	scoreThreshold: number,
	repairDepth: number,
	depth: number
): Promise<void> {
	if (depth >= maxDepth) return;

	const context = await buildWorkingContext(kg, parent);
	let proposals: Proposal[];
	try {
		proposals = await runProposer(context, maxBranches);
	} catch {
		return;
	}

	const survivors: Artifact[] = [];

	for (let proposal of proposals) {
		const child = await kg.createArtifact({
			type: proposal.executable.type === "project" ? "project" : "hypothesis",
			problemId: parent.problemId,
			parentId: parent.id,
			depth: parent.depth + 1,
			hypothesisText: proposal.hypothesis,
			sourceCode: proposal.executable.type === "code" ? proposal.executable.source : undefined,
			payload: proposal,
			provenance: { agent: "proposer", chain: true },
		});

		// Critics
		let critiqueArrays: Critique[][];
		try {
			critiqueArrays = await Promise.all(
				Array.from({ length: criticCount }, () => runCritic(context, proposal))
			);
		} catch {
			await kg.killArtifact(child.id, "Critic error in consensus chain");
			continue;
		}

		const allCritiques = critiqueArrays.flat();

		// Judge
		let verdict;
		try {
			verdict = await runJudge(context, proposal, allCritiques);
		} catch {
			await kg.killArtifact(child.id, "Judge error in consensus chain");
			continue;
		}

		if (verdict.decision === "kill" || verdict.score < scoreThreshold) {
			await kg.killArtifact(child.id, `judge: ${verdict.reason} (score ${verdict.score})`);
			continue;
		}

		// Confidence gate 1
		await kg.setConfidenceLevel(child.id, 1);

		// Formalize if needed
		if (verdict.decision === "formalize") {
			const formalProposal = await runFormalizer(context, proposal);
			if (!formalProposal) {
				await kg.killArtifact(child.id, "Formalization failed in consensus chain");
				continue;
			}
			proposal = formalProposal;
		}

		// Execute
		const outcome = await runExecutor(domain, proposal, context, child);
		await kg.recordPipelineExecution(child.id, outcome.pipelineResult);

		if (!outcome.executionResult.passed) {
			if (repairDepth > 0) {
				const repaired = await runRepair(context, proposal, outcome.executionResult);
				if (repaired) {
					const rc = await kg.createArtifact({
						type: "hypothesis",
						problemId: parent.problemId,
						parentId: child.id,
						depth: child.depth + 1,
						hypothesisText: repaired.hypothesis,
						sourceCode: repaired.executable.type === "code" ? repaired.executable.source : undefined,
						payload: repaired,
						provenance: { agent: "repair", chain: true },
					});
					const ro = await runExecutor(domain, repaired, context, rc);
					if (ro.executionResult.passed) {
						await kg.setConfidenceLevel(rc.id, 2);
						await kg.updateArtifact(rc.id, { score: verdict.score, status: "lemma" });
						survivors.push(rc);
						continue;
					} else {
						await kg.killArtifact(rc.id, ro.executionResult.reason);
					}
				}
			}
			await kg.killArtifact(child.id, outcome.executionResult.reason);
			await runFeedbackAnalyzer(kg, child.id);
			continue;
		}

		// Confidence gate 2
		await kg.setConfidenceLevel(child.id, 2);
		await kg.updateArtifact(child.id, { score: verdict.score, status: "lemma" });
		survivors.push(child);
	}

	survivors.sort((a, b) => b.score - a.score);
	for (const node of survivors) {
		await evolveChain(kg, workspace, node, domain, maxDepth, maxBranches, criticCount, scoreThreshold, repairDepth, depth + 1);
	}
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface ConsensusConfig {
	domain: string;
	problemDescription: string;
	numChains?: number;       // default 2
	maxDepth?: number;        // default 4
	maxBranches?: number;     // default 2
	criticCount?: number;     // default 2
	scoreThreshold?: number;  // default 55
}

export async function runConsensus(
	config: ConsensusConfig,
	kg: KnowledgeGraph,
	workspace: WorkspaceManager
): Promise<ConsensusResult> {
	const {
		domain,
		problemDescription,
		numChains = 2,
		maxDepth = 4,
		maxBranches = 2,
		criticCount = 2,
		scoreThreshold = 55,
	} = config;

	const spec = getDomainSpec(domain);
	if (!spec) {
		return { achieved: false, confidenceLevel: 2, winner: null, summary: `No domain spec for "${domain}"`, chains: [] };
	}
	if (!spec.crossValidate) {
		return { achieved: false, confidenceLevel: 2, winner: null, summary: `Domain "${domain}" has no crossValidate — cannot reach consensus`, chains: [] };
	}

	emit("info", `[consensus] Starting ${numChains} independent chains for domain: ${domain}`);
	console.log(`\n[consensus] Spawning ${numChains} independent chains…`);

	const invariants = getDomainInvariants(domain);
	const chainResults: Array<{ problemId: string; survived: boolean; score: number }> = [];

	// Spawn all chains in parallel
	const chainPromises = Array.from({ length: numChains }, async (_, i) => {
		const chainKg = new KnowledgeGraph();
		const chainLabel = `chain-${i + 1}`;

		try {
			// Each chain gets its own isolated problem row
			const chainProblem = await chainKg.createProblem(domain, problemDescription, 2);
			console.log(`[consensus] ${chainLabel} → problem ${chainProblem.id}`);

			// Independent step plan
			try {
				const plan = await runPlanner(domain, problemDescription, invariants);
				await chainKg.setStepPlan(chainProblem.id, plan);
			} catch {
				// Proceed without plan
			}

			const root = await chainKg.createArtifact({
				type: "hypothesis",
				problemId: chainProblem.id,
				title: `Root (${chainLabel})`,
				hypothesisText: problemDescription,
				depth: 0,
			});

			await evolveChain(chainKg, workspace, root, domain, maxDepth, maxBranches, criticCount, scoreThreshold, 1, 0);

			const best = await chainKg.getBestSurvivor(chainProblem.id);
			if (!best) {
				console.log(`[consensus] ${chainLabel} produced no survivors`);
				chainResults.push({ problemId: chainProblem.id, survived: false, score: 0 });
				return null;
			}

			console.log(`[consensus] ${chainLabel} best survivor: score=${best.score}`);
			chainResults.push({ problemId: chainProblem.id, survived: true, score: best.score });
			return { problemId: chainProblem.id, bestArtifact: best, bestProposal: best.payload as Proposal };
		} catch (err) {
			console.error(`[consensus] ${chainLabel} threw:`, err);
			chainResults.push({ problemId: "error", survived: false, score: 0 });
			return null;
		}
	});

	const settled = await Promise.allSettled(chainPromises);
	const survivors = settled
		.map(r => (r.status === "fulfilled" ? r.value : null))
		.filter((r): r is ChainResult => r !== null && r.bestProposal != null);

	if (survivors.length === 0) {
		return { achieved: false, confidenceLevel: 2, winner: null, summary: "No chains produced a survivor", chains: chainResults };
	}
	if (survivors.length === 1) {
		const solo = survivors[0]!;
		return { achieved: false, confidenceLevel: 2, winner: solo.bestArtifact, summary: "Only one chain survived — consensus requires at least 2", chains: chainResults };
	}

	// Cross-validate all pairs; consensus achieved if any pair agrees
	console.log(`[consensus] Cross-validating ${survivors.length} survivors…`);
	emit("info", `[consensus] Cross-validating ${survivors.length} survivors`);

	type BestPair = [ChainResult, ChainResult];
	let bestPair: BestPair | null = null;
	let bestRate = 0;

	for (let i = 0; i < survivors.length; i++) {
		for (let j = i + 1; j < survivors.length; j++) {
			const a = survivors[i];
			const b = survivors[j];
			if (!a || !b) continue;
			const xv = await spec.crossValidate!(a.bestProposal, b.bestProposal);
			console.log(`[consensus] chains ${i + 1}↔${j + 1}: rate=${xv.agreementRate.toFixed(3)} — ${xv.summary}`);
			if (xv.agreementRate > bestRate) {
				bestRate = xv.agreementRate;
				bestPair = [a, b];
			}
		}
	}

	const achieved = bestRate >= AGREEMENT_THRESHOLD;
	const firstSurvivor = survivors[0];

	// Winner = higher-scoring artifact from the best-agreeing pair
	let winner: Artifact | null = firstSurvivor?.bestArtifact ?? null;
	if (bestPair) {
		winner = bestPair[0].bestArtifact.score >= bestPair[1].bestArtifact.score
			? bestPair[0].bestArtifact
			: bestPair[1].bestArtifact;
	}

	const summary = achieved
		? `Consensus achieved — ${(bestRate * 100).toFixed(1)}% agreement across ${survivors.length} independent chains`
		: `Consensus NOT achieved — best agreement was ${(bestRate * 100).toFixed(1)}% (need ${AGREEMENT_THRESHOLD * 100}%)`;

	return { achieved, confidenceLevel: achieved ? 3 : 2, winner, summary, chains: chainResults };
}
