import { KnowledgeGraph } from "./db/knowledge-graph";
import { runProposer, runCritic, runJudge, runFormalizer, runRepair } from "./agents";
import { runExecutor, type ExecutionOutcome } from "./executors/sandbox";
import { DOMAINS } from "./executors/domains";
import { buildWorkingContext } from "./core/context";
import { WorkspaceManager } from "./workspace/manager";
import { runFeedbackAnalyzer } from "./analysis/feedback-manager";
import { db } from "./db/client";
import type { Domain, Proposal, Critique } from "./core/types";
import type { Artifact } from "./db/schema";

// ── Configuration ────────────────────────────────────────────────────────────
const DOMAIN: Domain = (process.env.DOMAIN as Domain) || "sorting";
const ROOT_PROBLEM_DESC = process.env.PROBLEM_DESC || `
  Optimize a JavaScript sort function for large integer arrays (>1M elements).
  Current baseline: Array.prototype.sort() on [1_000_000 random integers].
  Target: measurable throughput improvement with no correctness regression.
`;

const MAX_DEPTH = 6;
const MAX_BRANCHES = 3;
const CRITIC_COUNT = 2;
const SCORE_THRESHOLD = 60;
const MAX_REPAIR_DEPTH = 1;

function computeScore(judgeScore: number, iterations: number, depth: number): number {
	const iterBonus = Math.min(iterations * 5, 20);
	const depthBonus = Math.min(depth * 3, 15);
	return Math.min(Math.round(judgeScore + iterBonus + depthBonus), 100);
}

async function getLivingCount(problemId: string): Promise<number> {
	const result = await db
		.selectFrom("artifacts")
		.select(db.fn.count("id").as("count"))
		.where("problemId", "=", problemId)
		.where("status", "=", "active")
		.executeTakeFirst();
	return Number(result?.count ?? 0);
}

// ── Main entry ───────────────────────────────────────────────────────────────
const kg = new KnowledgeGraph();
const workspace = new WorkspaceManager();

async function main() {
	console.log(`\n[truth-engine] Starting`);
	console.log(`[truth-engine] Domain: ${DOMAIN}`);
	console.log(`[truth-engine] Problem: ${ROOT_PROBLEM_DESC.trim().slice(0, 100)}...\n`);

	if (!DOMAINS[DOMAIN]) {
		console.error(`No kill harness registered for "${DOMAIN}".`);
		process.exit(1);
	}

	const problem = await kg.createProblem(DOMAIN, ROOT_PROBLEM_DESC.trim());
	console.log(`Problem created: ${problem.id}`);

	// Seed CI workflow if GitHub is configured
	if (process.env.GITHUB_TOKEN) {
		await workspace.seedCIWorkflow(problem.id);
	}

	const root = await kg.createArtifact({
		type: "hypothesis",
		problemId: problem.id,
		title: "Root",
		hypothesisText: ROOT_PROBLEM_DESC.trim(),
		depth: 0,
	});

	await evolve(root, 0, 0);

	console.log("\n[truth-engine] Run complete");
	const living = await getLivingCount(problem.id);
	console.log(`Living nodes: ${living}`);
	process.exit(0);
}

// ── Recursive evolution ──────────────────────────────────────────────────────
async function evolve(
	parent: Artifact,
	depth: number,
	repairDepth: number = 0
): Promise<void> {
	if (depth >= MAX_DEPTH) {
		console.log(`[depth ${depth}] max depth reached on ${parent.id}`);
		return;
	}

	const context = await buildWorkingContext(kg, parent);

	// 1. Propose
	console.log(`\n[depth ${depth}] Proposing from ${parent.id}…`);
	let proposals: Proposal[];
	try {
		proposals = await runProposer(context, MAX_BRANCHES);
	} catch (err) {
		console.error("Proposer failed:", err);
		return;
	}

	const survivors: Artifact[] = [];

	for (let proposal of proposals) {
		// Create child artifact
		const child = await kg.createArtifact({
			type: proposal.executable.type === "project" ? "project" : "hypothesis",
			problemId: parent.problemId,
			parentId: parent.id,
			depth: parent.depth + 1,
			hypothesisText: proposal.hypothesis,
			sourceCode: proposal.executable.type === "code" ? proposal.executable.source : undefined,
			payload: proposal,
			provenance: { agent: "proposer", model: process.env.OLLAMA_MODEL },
		});

		// Handle project files (write to workspace/Git)
		if (proposal.executable.type === "project" && "files" in proposal.executable) {
			const { gitBranch, gitCommit } = await workspace.createArtifactDir(
				child,
				proposal.executable.files,
				proposal.hypothesis
			);
			// Update the child's payload with git info
			child.payload = { ...proposal, files: proposal.executable.files, gitBranch, gitCommit };
			await kg.updateArtifact(child.id, {
				payload: child.payload,
			});
		}

		// 2. Critics (parallel)
		console.log(`  [${child.id}] Running ${CRITIC_COUNT} critics…`);
		let critiqueArrays: Critique[][];
		try {
			critiqueArrays = await Promise.all(
				Array.from({ length: CRITIC_COUNT }, () => runCritic(context, proposal))
			);
		} catch (err) {
			console.error(`Critics failed for ${child.id}:`, err);
			await workspace.removeArtifactDir(child, "Critic agent error");
			await kg.killArtifact(child.id, "Critic agent error");
			continue;
		}

		const allCritiques = critiqueArrays.flat();
		for (const critique of allCritiques) {
			const critNode = await kg.createArtifact({
				type: "failure_report",
				problemId: parent.problemId,
				title: critique.description,
				payload: critique,
				provenance: { agent: "critic" },
			});
			await kg.addRelation(child.id, critNode.id, "contradicts", {
				severity: critique.severity,
			});
		}

		// 3. Judge
		console.log(`  [${child.id}] Judging…`);
		let verdict;
		try {
			verdict = await runJudge(context, proposal, allCritiques);
		} catch (err) {
			console.error(`Judge failed for ${child.id}:`, err);
			await workspace.removeArtifactDir(child, "Judge agent error");
			await kg.killArtifact(child.id, "Judge agent error");
			await runFeedbackAnalyzer(kg, child.id);
			continue;
		}

		if (verdict.decision === "kill" || verdict.score < SCORE_THRESHOLD) {
			const killReason = `judge: ${verdict.reason} (score ${verdict.score})`;
			await workspace.removeArtifactDir(child, killReason);
			await kg.killArtifact(child.id, killReason);
			console.log(`  [${child.id}] ✗ killed by judge`);
			await runFeedbackAnalyzer(kg, child.id);
			continue;
		}

		// 4. Handle formalize routing
		if (verdict.decision === "formalize") {
			console.log(`  [${child.id}] Routing to formalizer…`);
			const formalProposal = await runFormalizer(context, proposal);
			if (!formalProposal) {
				await workspace.removeArtifactDir(child, "Formalization failed");
				await kg.killArtifact(child.id, "Formalization failed");
				console.log(`  [${child.id}] ✗ formalization failed`);
				await runFeedbackAnalyzer(kg, child.id);
				continue;
			}
			await kg.updateArtifact(child.id, {
				formalStatement:
					formalProposal.executable.type === "proof" ? formalProposal.executable.source : undefined,
				sourceCode: undefined,
			});
			proposal = formalProposal;
		}

		// 5. Execute (reality gate)
		console.log(`  [${child.id}] Executing…`);
		let outcome: ExecutionOutcome;
		try {
			outcome = await runExecutor(DOMAIN, proposal, context, child);
		} catch (err) {
			outcome = {
				executionResult: {
					passed: false,
					reason: `Executor threw: ${err}`,
					iterations: 0,
				},
				pipelineResult: {
					overallPassed: false,
					stages: [{ stageName: "FatalError", passed: false, reason: String(err), runtimeMs: 0 }],
					finalMetrics: {},
				},
			};
		}

		await kg.recordPipelineExecution(child.id, outcome.pipelineResult);
		const { executionResult } = outcome;

		if (!executionResult.passed) {
			// Attempt repair if allowed
			if (repairDepth < MAX_REPAIR_DEPTH) {
				console.log(`  [${child.id}] Attempting repair (depth ${repairDepth})…`);
				const repairedProposal = await runRepair(context, proposal, executionResult);
				if (repairedProposal) {
					const repairedChild = await kg.createArtifact({
						type: "hypothesis",
						problemId: parent.problemId,
						parentId: parent.id,
						depth: parent.depth + 1,
						hypothesisText: repairedProposal.hypothesis,
						sourceCode:
							repairedProposal.executable.type === "code" ? repairedProposal.executable.source : undefined,
						payload: repairedProposal,
						provenance: { agent: "repair" },
					});

					const repairOutcome = await runExecutor(DOMAIN, repairedProposal, context, repairedChild);
					await kg.recordExecution(repairedChild.id, {
						executionType: "code_run",
						passed: repairOutcome.executionResult.passed,
						metrics: repairOutcome.executionResult.metrics ?? {},
						errorLog: repairOutcome.executionResult.passed ? undefined : repairOutcome.executionResult.reason,
					});

					if (repairOutcome.executionResult.passed) {
						const finalScore = computeScore(
							verdict.score,
							repairOutcome.executionResult.iterations,
							repairedChild.depth
						);
						await kg.updateArtifact(repairedChild.id, { score: finalScore, status: "lemma" });
						await workspace.promoteToShared(repairedChild);
						survivors.push(repairedChild);
						console.log(`  [${repairedChild.id}] ✓ repair survived, score=${finalScore}`);
					} else {
						await workspace.removeArtifactDir(repairedChild, repairOutcome.executionResult.reason);
						await kg.killArtifact(repairedChild.id, repairOutcome.executionResult.reason);
						console.log(`  [${repairedChild.id}] ✗ repair failed`);
						await runFeedbackAnalyzer(kg, repairedChild.id);
					}
				}
			}

			await workspace.removeArtifactDir(child, executionResult.reason);
			await kg.killArtifact(child.id, executionResult.reason);
			await runFeedbackAnalyzer(kg, child.id);
			console.log(`  [${child.id}] ✗ killed by reality — ${executionResult.reason}`);
			continue;
		}

		// 6. Survival – promote
		const finalScore = computeScore(verdict.score, executionResult.iterations, child.depth);
		await kg.updateArtifact(child.id, { score: finalScore, status: "lemma" });
		await workspace.promoteToShared(child);
		survivors.push(child);
		console.log(`  [${child.id}] ✓ survived, score=${finalScore}, depth=${child.depth}`);
	}

	// 7. Recurse on survivors (best-first)
	survivors.sort((a, b) => b.score - a.score);
	for (const node of survivors) {
		await evolve(node, depth + 1, 0);
	}
}

main().catch((err) => {
	console.error("[truth-engine] Fatal:", err);
	process.exit(1);
});