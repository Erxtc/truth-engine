import type { KnowledgeGraph } from "../db/knowledge-graph";
import type { WorkingContext } from "./types";
import type { Artifact } from "../db/schema";
import { getDomainInvariants } from "./context";

// ── Token budget helpers ──────────────────────────────────────────────────────

function estimateTokens(s: string): number {
	return Math.ceil(s.length / 4);
}

function estimateContextTokens(ctx: Partial<WorkingContext>): number {
	let total = 0;
	if (ctx.problem)            total += estimateTokens(ctx.problem);
	if (ctx.active_invariants)  total += estimateTokens(ctx.active_invariants.join(" "));
	if (ctx.active_constraints) total += estimateTokens(ctx.active_constraints.join(" "));
	if (ctx.proven_lemmas)      total += estimateTokens(ctx.proven_lemmas.join(" "));
	if (ctx.recent_insights)    total += estimateTokens(ctx.recent_insights.join(" "));
	if (ctx.ancestor_proposals) total += estimateTokens(ctx.ancestor_proposals.map(a => a.hypothesis).join(" "));
	if (ctx.failed_approaches)  total += estimateTokens(ctx.failed_approaches.map(f => f.summary + f.reason).join(" "));
	if (ctx.calibration_example) {
		total += estimateTokens(ctx.calibration_example.hypothesis);
		total += estimateTokens(ctx.calibration_example.source_code);
	}
	return total;
}

// ── Semantic relevance scoring ────────────────────────────────────────────────
// Jaccard-like overlap on stemmed words > 3 chars. No external deps — runs fast.

function tokenize(text: string): Set<string> {
	return new Set(
		text.toLowerCase()
			.split(/\W+/)
			.filter(w => w.length > 3)
	);
}

function relevanceScore(text: string, query: string): number {
	const textWords  = tokenize(text);
	const queryWords = tokenize(query);
	if (queryWords.size === 0) return 0;
	let overlap = 0;
	for (const w of queryWords) {
		if (textWords.has(w)) overlap++;
	}
	return overlap / queryWords.size;
}

function rerankByRelevance<T>(
	items: T[],
	getText: (item: T) => string,
	query: string
): T[] {
	return [...items].sort(
		(a, b) => relevanceScore(getText(b), query) - relevanceScore(getText(a), query)
	);
}

// ── Failure synthesis ─────────────────────────────────────────────────────────
// Greedy clustering: if a new failure shares > 50% keyword overlap with an
// already-selected failure, merge them (increment count rather than duplicate).

interface SynthesizedFailure {
	summary: string;
	reason: string;
	count: number;
}

function synthesizeFailures(
	failures: Array<{ summary: string; reason: string }>,
	maxOutput: number
): Array<{ summary: string; reason: string }> {
	if (failures.length <= maxOutput) return failures;

	const clusters: SynthesizedFailure[] = [];

	for (const f of failures) {
		let merged = false;
		for (const c of clusters) {
			if (relevanceScore(f.summary, c.summary) > 0.5) {
				c.count++;
				merged = true;
				break;
			}
		}
		if (!merged) {
			clusters.push({ ...f, count: 1 });
		}
	}

	// Most-common patterns first (they carry more signal)
	clusters.sort((a, b) => b.count - a.count);

	return clusters.slice(0, maxOutput).map(c => ({
		summary: c.count > 1 ? `[×${c.count} similar] ${c.summary}` : c.summary,
		reason:  c.reason,
	}));
}

// ── Build options ─────────────────────────────────────────────────────────────

export interface ContextBuildOptions {
	/** Soft token cap; lower-priority sections are trimmed when exceeded. Default: 3000 */
	tokenBudget: number;
	/** Max proven lemmas to include. Default: 8 */
	maxLemmas: number;
	/** Max failed approaches to include (after synthesis). Default: 8 */
	maxFailures: number;
	/** Max recent insights. Default: 5 */
	maxInsights: number;
	/** Rank lemmas/insights/failures by relevance to the problem. Default: true */
	semanticRerank: boolean;
	/** Collapse near-duplicate failures into one entry with a count prefix. Default: true */
	synthesizeErrors: boolean;
	/** Include the best-known working solution as a calibration example. Default: true */
	includeCalibration: boolean;
}

const DEFAULT_OPTIONS: ContextBuildOptions = {
	tokenBudget:        3000,
	maxLemmas:          8,
	maxFailures:        8,
	maxInsights:        5,
	semanticRerank:     true,
	synthesizeErrors:   true,
	includeCalibration: true,
};

// ── ContextBuilder ────────────────────────────────────────────────────────────

export class ContextBuilder {
	constructor(private kg: KnowledgeGraph) {}

	async build(node: Artifact, opts: Partial<ContextBuildOptions> = {}): Promise<WorkingContext> {
		const options = { ...DEFAULT_OPTIONS, ...opts };

		const problem = await this.kg.getProblem(node.problemId);
		if (!problem) throw new Error(`Problem ${node.problemId} not found`);

		const query = problem.description;

		// ── Fetch raw data ────────────────────────────────────────────────────
		const [lemmasRaw, failedRaw, ancestorChain, insightsRaw, constraintsRaw, stepInfo] =
			await Promise.all([
				this.kg.getProvenLemmas(node.problemId, options.maxLemmas * 3),
				this.kg.getFailedApproaches(node.problemId, options.maxFailures * 3),
				this.kg.getAncestorChain(node.id),
				this.kg.getRecentInsights(node.problemId, options.maxInsights * 2),
				this.kg.getActiveConstraints(node.problemId),
				this.kg.getStepInfo(node.problemId),
			]);

		// ── Semantic reranking ────────────────────────────────────────────────
		const lemmaTexts = options.semanticRerank
			? rerankByRelevance(lemmasRaw, l => l.hypothesisText ?? l.title ?? "", query)
			: lemmasRaw;

		const insightTexts = options.semanticRerank
			? rerankByRelevance(insightsRaw, i => i.title ?? "", query)
			: insightsRaw;

		// ── Failure synthesis (then rerank by relevance) ──────────────────────
		let failedList = failedRaw.map(f => ({ summary: f.hypothesis, reason: f.reason }));
		if (options.synthesizeErrors) {
			failedList = synthesizeFailures(failedList, options.maxFailures);
		} else {
			failedList = failedList.slice(0, options.maxFailures);
		}
		if (options.semanticRerank) {
			failedList = rerankByRelevance(failedList, f => f.summary + " " + f.reason, query);
		}

		// ── Ancestor chain ────────────────────────────────────────────────────
		const ancestorProposals = ancestorChain.map(a => ({
			hypothesis: a.hypothesisText ?? "",
			score:      a.score,
		}));

		// ── Calibration example ───────────────────────────────────────────────
		let calibration_example: WorkingContext["calibration_example"] | undefined;
		if (options.includeCalibration) {
			const best = await this.kg.getBestSurvivor(node.problemId);
			if (best && best.id !== node.id && (best.sourceCode || best.hypothesisText)) {
				calibration_example = {
					hypothesis:  best.hypothesisText ?? "",
					source_code: best.sourceCode     ?? "",
					score:       best.score,
				};
			}
		}

		// ── Assemble draft context ────────────────────────────────────────────
		const ctx: WorkingContext = {
			domain:             problem.domain,
			problem:            problem.description,
			depth:              node.depth,
			proven_lemmas:      lemmaTexts.slice(0, options.maxLemmas).map(l => l.hypothesisText ?? l.title ?? "").filter(Boolean),
			failed_approaches:  failedList,
			active_invariants:  getDomainInvariants(problem.domain),
			ancestor_proposals: ancestorProposals,
			recent_insights:    insightTexts.slice(0, options.maxInsights).map(i => i.title ?? "").filter(Boolean),
			active_constraints: constraintsRaw.map(c => c.title ?? "").filter(Boolean),
			step_plan:          stepInfo?.plan ?? null,
			current_step:       stepInfo ? (stepInfo.plan.steps[stepInfo.currentStep] ?? null) : null,
			calibration_example,
		};

		// ── Token budget enforcement ──────────────────────────────────────────
		// Trim sections from lowest to highest priority until under budget.
		let used = estimateContextTokens(ctx);
		if (used > options.tokenBudget) {
			// 1. Trim ancestor proposals (keep last 4; already short)
			if (ctx.ancestor_proposals.length > 4) {
				ctx.ancestor_proposals = ctx.ancestor_proposals.slice(-4);
				used = estimateContextTokens(ctx);
			}
		}
		if (used > options.tokenBudget) {
			// 2. Trim failed approaches
			while (ctx.failed_approaches.length > 3 && used > options.tokenBudget) {
				ctx.failed_approaches.pop();
				used = estimateContextTokens(ctx);
			}
		}
		if (used > options.tokenBudget) {
			// 3. Trim insights
			while (ctx.recent_insights.length > 2 && used > options.tokenBudget) {
				ctx.recent_insights.pop();
				used = estimateContextTokens(ctx);
			}
		}
		if (used > options.tokenBudget) {
			// 4. Trim proven lemmas
			while (ctx.proven_lemmas.length > 2 && used > options.tokenBudget) {
				ctx.proven_lemmas.pop();
				used = estimateContextTokens(ctx);
			}
		}
		if (used > options.tokenBudget) {
			// 5. Drop calibration example (nice-to-have)
			ctx.calibration_example = undefined;
			used = estimateContextTokens(ctx);
		}

		ctx.token_budget_used = used;
		return ctx;
	}
}
