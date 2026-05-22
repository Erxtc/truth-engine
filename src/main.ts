import { KnowledgeGraph } from "./db/knowledge-graph";
import { runProposer, runCritic, runJudge, runFormalizer, runRepair, runPlanner, estimateComplexity, resolveRunParams } from "./agents";
import { runExecutor, type ExecutionOutcome } from "./executors/sandbox-runner";
import { getDomainSpec } from "./executors/domains";
import { runConsensus } from "./consensus/runner";
import { getDomainInvariants } from "./core/context";
import { ContextBuilder } from "./core/context-builder";
import { WorkspaceManager } from "./workspace/manager";
import { runFeedbackAnalyzer, runLegislator } from "./analysis/feedback-manager";
import { db } from "./db/client";
import type { Proposal, Critique, WorkingContext } from "./core/types";
import type { Artifact } from "./db/schema";
import { emit } from "./ui/events";
import { startUiServer } from "./ui/server";
import { loadConfig, printConfig } from "./cli";
import { detectOrGenerateDomain } from "./domains/auto-detect";

// ── Configuration (CLI > env > complexity estimator > safety floor) ──────────
const cfg = loadConfig();
const DOMAIN = cfg.domain;
const ROOT_PROBLEM_DESC = cfg.problem;
const SCORE_THRESHOLD = cfg.scoreThreshold;
const LEGISLATOR_EVERY_N_DEATHS = 5;

// These are set in main() after the complexity estimator runs.
// Safety floors ensure evolve() can never receive nonsense values.
let MAX_DEPTH    = 4;
let MAX_BRANCHES = 2;
let CRITIC_COUNT = 2;

// LLM call budget — set from runParams in main(); evolve() stops escalating when exhausted.
let llmCallsUsed   = 0;
let budgetLlmCalls = 200;

function trackLlmCalls(n: number): void { llmCallsUsed += n; }
function budgetExhausted(): boolean     { return llmCallsUsed >= budgetLlmCalls; }

let deathCount = 0;
async function recordDeath(problemId: string) {
	deathCount++;
	if (deathCount % LEGISLATOR_EVERY_N_DEATHS === 0) {
		console.log(`\n[Legislator] Triggering after ${deathCount} deaths…`);
		await runLegislator(kg, problemId);
	}
}

function confidenceLabel(level: number): string {
	return ["proposed", "critique-verified", "execution-verified", "peer-consensus", "formally-proven"][level] ?? "unknown";
}

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

// ── Module-level singletons ───────────────────────────────────────────────────
const kg = new KnowledgeGraph();
const workspace = new WorkspaceManager();
const contextBuilder = new ContextBuilder(kg);
// Populated in main() before evolve() is called
let domainSpec = getDomainSpec(DOMAIN);

async function main() {
	startUiServer();
	console.log(`\n[truth-engine] Starting`);
	emit("info", `Starting — domain: ${DOMAIN}`);

	// ── 1. Domain resolution ─────────────────────────────────────────────────
	if (DOMAIN === "auto") {
		console.log("[truth-engine] Auto-detecting domain…");
		const detected = await detectOrGenerateDomain(ROOT_PROBLEM_DESC.trim());
		(cfg as any).domain = detected.domain;
		domainSpec = detected.spec;
		console.log(`[truth-engine] Domain resolved: "${detected.domain}" (generated=${detected.wasGenerated})`);
	} else {
		domainSpec = getDomainSpec(DOMAIN);
		if (!domainSpec) {
			console.error(`No domain spec registered for "${DOMAIN}". Register it via registerDomain() in domains/index.ts.`);
			process.exit(1);
		}
	}

	const resolvedDomain = cfg.domain;

	// ── 2. Complexity estimation ─────────────────────────────────────────────
	console.log("[truth-engine] Estimating problem complexity…");
	const assessment = await estimateComplexity(
		resolvedDomain,
		ROOT_PROBLEM_DESC.trim(),
		domainSpec!.requiredConfidence
	);
	console.log(`[complexity] score=${assessment.score}/10  type=${assessment.type}  sub-problems=${assessment.numSubproblems}`);
	console.log(`[complexity] ${assessment.reasoning}`);
	if (assessment.decompositionHint.length > 0) {
		console.log(`[complexity] Decomposition: ${assessment.decompositionHint.join(" → ")}`);
	}

	// ── 3. Resolve run params (CLI overrides win; estimator fills gaps) ──────
	const runParams = resolveRunParams(
		{
			maxDepth:           cfg.maxDepth,
			maxBranches:        cfg.maxBranches,
			criticCount:        cfg.criticCount,
			requiredConfidence: cfg.requiredConfidence,
			consensus:          cfg.consensus,
		},
		assessment
	);

	// Set module-level run vars that evolve() reads
	MAX_DEPTH    = runParams.maxDepth;
	MAX_BRANCHES = runParams.maxBranches;
	CRITIC_COUNT = runParams.criticCount;

	const effectiveConfidence = runParams.requiredConfidence;

	printConfig(cfg, MAX_DEPTH, MAX_BRANCHES, CRITIC_COUNT);
	emit("info", `Complexity ${assessment.score}/10 — depth=${MAX_DEPTH} branches=${MAX_BRANCHES} critics=${CRITIC_COUNT}`);

	// ── 4. Create problem ────────────────────────────────────────────────────
	const problem = await kg.createProblem(resolvedDomain, ROOT_PROBLEM_DESC.trim(), effectiveConfidence);
	console.log(`Required confidence: ${effectiveConfidence} (${confidenceLabel(effectiveConfidence)})`);
	console.log(`Problem created: ${problem.id}`);

	// Generate step plan before evolution begins
	console.log(`[truth-engine] Generating step plan…`);
	try {
		const stepPlan = await runPlanner(DOMAIN, ROOT_PROBLEM_DESC.trim(), getDomainInvariants(DOMAIN));
		await kg.setStepPlan(problem.id, stepPlan);
		emit("planner:done", `${stepPlan.steps.length}-step plan ready`, { detail: stepPlan });
		console.log(`[truth-engine] Step plan (${stepPlan.steps.length} steps):`);
		stepPlan.steps.forEach(s => console.log(`  Step ${s.index}: ${s.goal}`));
	} catch (err) {
		console.warn(`[truth-engine] Planner failed, continuing without step plan:`, err);
	}

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

	const solvedViaEvolution = await evolve(root, 0);

	// ── Consensus phase ──────────────────────────────────────────────────────
	// Driven by resolved runParams (complexity estimator + CLI overrides).
	// Skip consensus if evolution already reached required confidence
	const runConsensusPhase = runParams.consensus && !solvedViaEvolution;

	if (runConsensusPhase) {
		console.log("\n[truth-engine] Entering consensus phase…");
		const consensusResult = await runConsensus(
			{
				domain: DOMAIN,
				problemDescription: ROOT_PROBLEM_DESC.trim(),
				numChains: cfg.consensusChains,
				maxDepth: Math.min(MAX_DEPTH, 4),
				maxBranches: Math.min(MAX_BRANCHES, 2),
				criticCount: CRITIC_COUNT,
				scoreThreshold: SCORE_THRESHOLD,
			},
			kg,
			workspace
		);

		console.log(`\n[consensus] ${consensusResult.summary}`);
		for (const c of consensusResult.chains) {
			console.log(`  chain ${c.problemId.slice(0, 8)}: survived=${c.survived} score=${c.score}`);
		}

		if (consensusResult.achieved && consensusResult.winner) {
			// Promote the consensus winner into the main problem as a linked lemma
			const winner = await kg.createArtifact({
				type: "lemma",
				problemId: problem.id,
				title: `Consensus winner (confidence=3)`,
				hypothesisText: consensusResult.winner.hypothesisText ?? undefined,
				sourceCode: consensusResult.winner.sourceCode ?? undefined,
				payload: consensusResult.winner.payload,
				provenance: { agent: "consensus", chainProblemId: consensusResult.winner.problemId },
			});
			await kg.setConfidenceLevel(winner.id, 3);
			await kg.updateArtifact(winner.id, { score: consensusResult.winner.score, status: "lemma" });
			emit("problem:solved", `consensus achieved — confidence=3`, {
				artifactId: winner.id,
				detail: { hypothesis: consensusResult.winner.hypothesisText, summary: consensusResult.summary },
			});
			console.log(`\n✓ PROBLEM SOLVED at confidence=3 (peer-consensus)`);
			console.log(`  Artifact: ${winner.id}`);
			console.log(`  Hypothesis: ${consensusResult.winner.hypothesisText?.slice(0, 120)}`);
		} else {
			console.log(`\n[consensus] Consensus not achieved — best survivors are at confidence=2`);
		}
	}

	console.log("\n[truth-engine] Run complete");
	const living = await getLivingCount(problem.id);
	console.log(`Living nodes: ${living}`);
	process.exit(0);
}

// ── Per-proposal pipeline ─────────────────────────────────────────────────────
// Returns the surviving artifact (or null if killed) and whether the problem is
// solved at the required confidence level.
async function tryProposal(
	proposal: Proposal,
	parent: Artifact,
	context: WorkingContext,
	numCritics: number,
): Promise<{ artifact: Artifact | null; solved: boolean }> {
	const nil = { artifact: null, solved: false };
	const requiredConfidence = domainSpec?.requiredConfidence ?? 2;

	// Create child artifact
	emit("artifact:born", proposal.hypothesis.slice(0, 80));
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

	// Handle project files
	if (proposal.executable.type === "project" && "files" in proposal.executable) {
		const { gitBranch, gitCommit } = await workspace.createArtifactDir(
			child, proposal.executable.files, proposal.hypothesis
		);
		child.payload = { ...proposal, files: proposal.executable.files, gitBranch, gitCommit };
		await kg.updateArtifact(child.id, { payload: child.payload });
	}

	// Critics (parallel)
	console.log(`  [${child.id.slice(0, 8)}] ${numCritics} critic(s)…`);
	emit("agent:run", `${numCritics} critics`, { artifactId: child.id });
	let critiqueArrays: Critique[][];
	try {
		trackLlmCalls(numCritics);
		critiqueArrays = await Promise.all(
			Array.from({ length: numCritics }, () => runCritic(context, proposal))
		);
	} catch (err) {
		console.error(`Critics failed for ${child.id}:`, err);
		await workspace.removeArtifactDir(child, "Critic agent error");
		await kg.killArtifact(child.id, "Critic agent error");
		await recordDeath(parent.problemId);
		return nil;
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
		await kg.addRelation(child.id, critNode.id, "contradicts", { severity: critique.severity });
	}

	// Judge
	console.log(`  [${child.id.slice(0, 8)}] Judging…`);
	emit("agent:run", `judge`, { artifactId: child.id });
	let verdict;
	try {
		trackLlmCalls(1);
		verdict = await runJudge(context, proposal, allCritiques);
	} catch (err) {
		console.error(`Judge failed for ${child.id}:`, err);
		await workspace.removeArtifactDir(child, "Judge agent error");
		await kg.killArtifact(child.id, "Judge agent error");
		trackLlmCalls(1); await runFeedbackAnalyzer(kg, child.id);
		await recordDeath(parent.problemId);
		return nil;
	}

	emit("verdict", `score=${verdict.score} decision=${verdict.decision}`, { artifactId: child.id, detail: verdict });

	if (verdict.decision === "kill" || verdict.score < SCORE_THRESHOLD) {
		const killReason = `judge: ${verdict.reason} (score ${verdict.score})`;
		await workspace.removeArtifactDir(child, killReason);
		await kg.killArtifact(child.id, killReason);
		emit("artifact:killed", `${child.id.slice(0, 8)} — ${verdict.reason.slice(0, 60)}`, { artifactId: child.id });
		console.log(`  [${child.id.slice(0, 8)}] ✗ killed by judge (score=${verdict.score})`);
		trackLlmCalls(1); await runFeedbackAnalyzer(kg, child.id);
		await recordDeath(parent.problemId);
		return nil;
	}

	// Confidence gate 1: survived adversarial critique
	await kg.setConfidenceLevel(child.id, 1);

	// Formalize routing
	if (verdict.decision === "formalize") {
		console.log(`  [${child.id.slice(0, 8)}] Formalizing…`);
		trackLlmCalls(1);
		const formalProposal = await runFormalizer(context, proposal);
		if (!formalProposal) {
			await workspace.removeArtifactDir(child, "Formalization failed");
			await kg.killArtifact(child.id, "Formalization failed");
			await recordDeath(parent.problemId);
			return nil;
		}
		await kg.updateArtifact(child.id, {
			formalStatement: formalProposal.executable.type === "proof" ? formalProposal.executable.source : undefined,
			sourceCode: undefined,
		});
		proposal = formalProposal;
	}

	// Execute (reality gate)
	console.log(`  [${child.id.slice(0, 8)}] Executing…`);
	let outcome: ExecutionOutcome;
	try {
		outcome = await runExecutor(DOMAIN, proposal, context, child);
	} catch (err) {
		outcome = {
			executionResult: { passed: false, reason: `Executor threw: ${err}`, iterations: 0 },
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
		emit("artifact:killed", `${child.id.slice(0, 8)} — execution: ${executionResult.reason.slice(0, 60)}`, { artifactId: child.id });

		// Attempt repair
		console.log(`  [${child.id.slice(0, 8)}] Attempting repair…`);
		emit("repair:start", `repairing: ${executionResult.reason.slice(0, 60)}`, { artifactId: child.id });
		trackLlmCalls(1);
		const repairedProposal = await runRepair(context, proposal, executionResult);
		if (repairedProposal) {
			const repairedChild = await kg.createArtifact({
				type: "hypothesis",
				problemId: parent.problemId,
				parentId: parent.id,
				depth: parent.depth + 1,
				hypothesisText: repairedProposal.hypothesis,
				sourceCode: repairedProposal.executable.type === "code" ? repairedProposal.executable.source : undefined,
				payload: repairedProposal,
				provenance: { agent: "repair" },
			});

			const repairOutcome = await runExecutor(DOMAIN, repairedProposal, context, repairedChild);
			await kg.recordExecution(repairedChild.id, {
				executionType: "code_run",
				passed: repairOutcome.executionResult.passed,
				metrics: repairOutcome.executionResult.metrics ?? {},
				errorLog: repairOutcome.executionResult.passed ? null : repairOutcome.executionResult.reason,
				testResults: [],
				runtimeMs: null,
			});

			if (repairOutcome.executionResult.passed) {
				await kg.setConfidenceLevel(repairedChild.id, 2);
				const finalScore = computeScore(verdict.score, repairOutcome.executionResult.iterations, repairedChild.depth);
				await kg.updateArtifact(repairedChild.id, { score: finalScore, status: "lemma" });
				await workspace.promoteToShared(repairedChild);
				emit("repair:done", `repair survived, score=${finalScore}`, { artifactId: repairedChild.id });
				emit("artifact:survived", `${repairedChild.id.slice(0, 8)} score=${finalScore} (repaired)`, { artifactId: repairedChild.id });
				console.log(`  [${repairedChild.id.slice(0, 8)}] ✓ repair survived [confidence=2/${requiredConfidence}], score=${finalScore}`);
				if (verdict.advances_step) {
					await kg.advanceStep(parent.problemId);
					emit("step:advanced", verdict.step_assessment ?? "step complete", { artifactId: repairedChild.id });
				}
				const solved = requiredConfidence <= 2;
				if (solved) {
					emit("problem:solved", `confidence=2 score=${finalScore} (repaired)`, { artifactId: repairedChild.id, detail: { hypothesis: repairedProposal.hypothesis } });
					console.log(`  [${repairedChild.id.slice(0, 8)}] ✓ SOLVED via repair (${confidenceLabel(2)})`);
				}
				return { artifact: repairedChild, solved };
			}

			await workspace.removeArtifactDir(repairedChild, repairOutcome.executionResult.reason);
			await kg.killArtifact(repairedChild.id, repairOutcome.executionResult.reason);
			emit("repair:done", `repair failed: ${repairOutcome.executionResult.reason.slice(0, 60)}`, { artifactId: repairedChild.id });
			console.log(`  [${repairedChild.id.slice(0, 8)}] ✗ repair failed`);
			trackLlmCalls(1); await runFeedbackAnalyzer(kg, repairedChild.id);
			await recordDeath(parent.problemId);
		}

		await workspace.removeArtifactDir(child, executionResult.reason);
		await kg.killArtifact(child.id, executionResult.reason);
		trackLlmCalls(1); await runFeedbackAnalyzer(kg, child.id);
		await recordDeath(parent.problemId);
		console.log(`  [${child.id.slice(0, 8)}] ✗ killed by reality — ${executionResult.reason}`);
		return nil;
	}

	// Survived execution
	await kg.setConfidenceLevel(child.id, 2);
	const finalScore = computeScore(verdict.score, executionResult.iterations, child.depth);
	await kg.updateArtifact(child.id, { score: finalScore, status: "lemma" });
	await workspace.promoteToShared(child);
	emit("artifact:survived", `${child.id.slice(0, 8)} score=${finalScore} depth=${child.depth}`, { artifactId: child.id, detail: { score: finalScore, hypothesis: proposal.hypothesis.slice(0, 100) } });
	console.log(`  [${child.id.slice(0, 8)}] ✓ survived [confidence=2/${requiredConfidence}], score=${finalScore}`);

	if (verdict.advances_step) {
		console.log(`  [${child.id.slice(0, 8)}] ✓ step advanced — ${verdict.step_assessment ?? ""}`);
		emit("step:advanced", verdict.step_assessment ?? "step complete", { artifactId: child.id });
		await kg.advanceStep(parent.problemId);
	}

	const solved = requiredConfidence <= 2;
	if (solved) {
		console.log(`  [${child.id.slice(0, 8)}] ✓ SOLVED (${confidenceLabel(2)}, score=${finalScore})`);
		emit("problem:solved", `confidence=2 score=${finalScore}`, { artifactId: child.id, detail: { hypothesis: proposal.hypothesis } });
	}
	return { artifact: child, solved };
}

// ── Adaptive evolution ────────────────────────────────────────────────────────
// Phase 1 (direct): 1 proposal, 1 critic — cheapest possible attempt.
// Phase 2 (escalate): remaining branches with full critics — only if direct fails
//   and budget allows. Context is rebuilt so failures from phase 1 inform phase 2.
// Recurses on survivors (best-first) until solved or depth/budget limit hit.
// Returns true as soon as required confidence is reached — callers short-circuit.
async function evolve(parent: Artifact, depth: number): Promise<boolean> {
	if (depth >= MAX_DEPTH) {
		console.log(`[depth ${depth}] max depth reached`);
		return false;
	}
	if (budgetExhausted()) {
		console.log(`[depth ${depth}] LLM budget exhausted (${llmCallsUsed}/${budgetLlmCalls} calls)`);
		return false;
	}

	// Direct phase: only on the very first call (depth 0, no calls used yet)
	const isDirect = depth === 0 && llmCallsUsed === 0;
	const branchCount = isDirect ? 1 : MAX_BRANCHES;
	const numCritics  = isDirect ? 1 : CRITIC_COUNT;

	console.log(`\n[depth ${depth}] ${isDirect ? "Direct attempt" : `Exploring ${branchCount} branch(es)`} from ${parent.id.slice(0, 8)}…`);
	emit("agent:run", `proposer @ depth ${depth}${isDirect ? " (direct)" : ""}`, { artifactId: parent.id });

	let proposals: Proposal[];
	try {
		trackLlmCalls(branchCount);
		proposals = await runProposer(await contextBuilder.build(parent), branchCount);
	} catch (err) {
		console.error("Proposer failed:", err);
		return false;
	}

	const survivors: Artifact[] = [];

	for (const proposal of proposals) {
		const { artifact, solved } = await tryProposal(proposal, parent, await contextBuilder.build(parent), numCritics);
		if (artifact) survivors.push(artifact);
		if (solved) return true;
	}

	// Escalate: direct failed → try remaining branches with full critics
	if (isDirect && survivors.length === 0 && !budgetExhausted() && MAX_BRANCHES > 1) {
		const extra = Math.min(MAX_BRANCHES - 1, budgetLlmCalls - llmCallsUsed);
		console.log(`\n[depth 0] Direct failed — escalating (${extra} more branch(es))…`);
		emit("info", `direct attempt failed; escalating to ${extra} more branches`);

		let moreProposals: Proposal[];
		try {
			trackLlmCalls(extra);
			// Rebuild context so the direct-phase failure is visible to the proposer
			moreProposals = await runProposer(await contextBuilder.build(parent), extra);
		} catch (err) {
			console.error("Proposer (escalation) failed:", err);
			moreProposals = [];
		}

		for (const proposal of moreProposals) {
			const { artifact, solved } = await tryProposal(proposal, parent, await contextBuilder.build(parent), CRITIC_COUNT);
			if (artifact) survivors.push(artifact);
			if (solved) return true;
		}
	}

	// Recurse best-first; short-circuit as soon as one branch solves the problem
	survivors.sort((a, b) => b.score - a.score);
	for (const node of survivors) {
		const solved = await evolve(node, depth + 1);
		if (solved) return true;
	}
	return false;
}

main().catch((err) => {
	console.error("[truth-engine] Fatal:", err);
	process.exit(1);
});