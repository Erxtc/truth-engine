import { db } from "./client";
import { type Artifact, type Relation, type Execution, type Problem, } from "./schema";
import { randomUUIDv7 } from "bun";
import type { PipelineResult } from "../verification/types";
import type { StepPlan } from "../core/types";

export class KnowledgeGraph {
	async createProblem(domain: string, description: string, requiredConfidence = 2): Promise<Problem> {
		const id = Bun.randomUUIDv7();

		const p = await db
			.insertInto("problems")
			.values({ id, domain, description, status: "open", currentStep: 0, requiredConfidence } as any)
			.returningAll()
			.executeTakeFirstOrThrow();

		return p as unknown as Problem;
	}

	async getProblem(id: string): Promise<Problem | undefined> {
		const row = await db
			.selectFrom("problems")
			.selectAll()
			.where("id", "=", id)
			.executeTakeFirst();
		return row as unknown as Problem | undefined;
	}

	async createArtifact(input: {
		type: Artifact["type"];
		problemId: string;
		parentId?: string | null;
		depth?: number;
		title?: string;
		hypothesisText?: string;
		formalStatement?: string;
		sourceCode?: string;
		payload?: any;
		provenance?: any;
	}): Promise<Artifact> {
		const id = Bun.randomUUIDv7();

		const row = {
			id,
			status: "active",
			score: 0,
			depth: input.depth ?? 0,
			parentId: input.parentId ?? null,
			...input,
			payload: input.payload != null ? JSON.stringify(input.payload) : null,
			provenance: input.provenance != null ? JSON.stringify(input.provenance) : null,
		};

		const artifact = await db
			.insertInto("artifacts")
			.values(row as any)
			.returningAll()
			.executeTakeFirstOrThrow();

		return artifact as unknown as Artifact;
	}

	async getArtifact(id: string): Promise<Artifact | undefined> {
		const row = await db
			.selectFrom("artifacts")
			.selectAll()
			.where("id", "=", id)
			.executeTakeFirst();
		return row as unknown as Artifact | undefined;
	}

	async updateArtifact(
		id: string,
		updates: Partial<
			Pick<
				Artifact,
				| "status"
				| "score"
				| "latestExecutionId"
				| "title"
				| "sourceCode"
				| "formalStatement"
				| "payload"
			>
		>
	) {
		const serialized: any = { ...updates };
		if (serialized.payload !== undefined && serialized.payload !== null && typeof serialized.payload === "object") {
			serialized.payload = JSON.stringify(serialized.payload);
		}
		await db
			.updateTable("artifacts")
			.set(serialized)
			.where("id", "=", id)
			.execute();
	}

	async setConfidenceLevel(artifactId: string, level: number): Promise<void> {
		await db
			.updateTable("artifacts")
			.set({ confidenceLevel: level } as any)
			.where("id", "=", artifactId)
			.execute();
	}

	async killArtifact(id: string, reason: string) {
		const artifact = await this.getArtifact(id);
		if (!artifact) return;

		const failure = await this.createArtifact({
			type: "failure_report",
			problemId: artifact.problemId,
			title: reason,
		});

		await this.addRelation(id, failure.id, "contradicts", { reason });

		await db
			.updateTable("artifacts")
			.set({ status: "dead" })
			.where("id", "=", id)
			.execute();
	}

	// ── Relations ───────────────────────────────────────────────────────────

	async addRelation(
		sourceId: string,
		targetId: string,
		type: Relation["relationType"],
		props?: any
	) {
		const id = Bun.randomUUIDv7();

		await db
			.insertInto("relations")
			.values({ id, sourceId, targetId, relationType: type, properties: props != null ? JSON.stringify(props) : null } as any)
			.execute();
	}

	// ── Queries ─────────────────────────────────────────────────────────────

	async getProvenLemmas(problemId: string, limit = 10): Promise<Artifact[]> {
		const rows = await db
			.selectFrom("artifacts")
			.selectAll()
			.where("problemId", "=", problemId)
			.where("type", "=", "lemma")
			.where("status", "=", "active")
			.orderBy("score", "desc")
			.limit(limit)
			.execute();
		return rows as unknown as Artifact[];
	}

	async getFailedApproaches(
		problemId: string,
		limit = 15
	): Promise<Array<{ hypothesis: string; reason: string }>> {
		const rows = await db
			.selectFrom("artifacts")
			.selectAll()
			.where("problemId", "=", problemId)
			.where("status", "=", "dead")
			.where("type", "!=", "failure_report")
			.limit(limit)
			.execute();

		const result: Array<{ hypothesis: string; reason: string }> = [];

		for (const a of rows) {
			const rel = await db
				.selectFrom("relations")
				.selectAll()
				.where("sourceId", "=", a.id)
				.where("relationType", "=", "contradicts")
				.executeTakeFirst();

			const failReport = rel
				? await this.getArtifact(rel.targetId)
				: null;

			result.push({
				hypothesis: a.hypothesisText ?? a.title ?? "unknown",
				reason: failReport?.title ?? "no reason recorded",
			});
		}

		return result;
	}

	async getAncestorChain(artifactId: string): Promise<Artifact[]> {
		const chain: Artifact[] = [];

		let current = await this.getArtifact(artifactId);

		while (current?.parentId) {
			current = await this.getArtifact(current.parentId);
			if (current) chain.unshift(current);
		}

		return chain;
	}

	async recordExecution(
		artifactId: string,
		exec: Omit<Execution, "id" | "createdAt" | "artifactId">
	) {
		const id = randomUUIDv7();

		await db
			.insertInto("executions")
			.values({
				id,
				artifactId,
				...exec,
				metrics: exec.metrics != null ? JSON.stringify(exec.metrics) : null,
				testResults: exec.testResults != null ? JSON.stringify(exec.testResults) : null,
			} as any)
			.execute();

		await db
			.updateTable("artifacts")
			.set({ latestExecutionId: id } as any)
			.where("id", "=", artifactId)
			.execute();
	}

	async logAgentAction(input: {
		artifactId?: string;
		agentRole: string;
		inputContext?: string;
		response: any;
		cost?: number;
	}) {
		const id = Bun.randomUUIDv7();

		await db
			.insertInto("agent_logs")
			.values({
				id,
				artifactId: input.artifactId ?? null,
				agentRole: input.agentRole,
				inputContext: input.inputContext,
				response: input.response,
				cost: input.cost,
			} as any)
			.execute();
	}

	async recordPipelineExecution(
		artifactId: string,
		pipelineResult: PipelineResult
	) {
		for (const stage of pipelineResult.stages) {
			await this.recordExecution(artifactId, {
				executionType: `stage_${stage.stageName}`,
				passed: stage.passed,
				metrics: stage.metrics || {},
				errorLog: stage.reason ?? null,
				runtimeMs: stage.runtimeMs,
				testResults: stage.testResults || [],
			});
		}

		await this.recordExecution(artifactId, {
			executionType: "pipeline_summary",
			passed: pipelineResult.overallPassed,
			metrics: pipelineResult.finalMetrics,
			errorLog: null,
			testResults: [],
			runtimeMs: pipelineResult.stages.reduce((sum, s) => sum + s.runtimeMs, 0),
		});
	}

	// Create an insight linked to the problem
	async createInsight(input: {
		problemId: string;
		title: string;
		relatedArtifactIds?: string[];
		payload?: any;
	}) {
		const artifact = await this.createArtifact({
			type: "insight",
			problemId: input.problemId,
			title: input.title,
			payload: input.payload,
		});
		// Link to related artifacts (failed proposals)
		if (input.relatedArtifactIds) {
			for (const relatedId of input.relatedArtifactIds) {
				await this.addRelation(relatedId, artifact.id, "cites");
			}
		}
		return artifact;
	}

	// Get recent insights for a problem (ordered by recency)
	async getRecentInsights(problemId: string, limit = 5): Promise<Artifact[]> {
		const rows = await db
			.selectFrom("artifacts")
			.selectAll()
			.where("problemId", "=", problemId)
			.where("type", "=", "insight")
			.where("status", "=", "active")
			.orderBy("createdAt", "desc")
			.limit(limit)
			.execute();
		return rows as unknown as Artifact[];
	}

	// Get all active constraints for a problem
	async getActiveConstraints(problemId: string): Promise<Artifact[]> {
		const rows = await db
			.selectFrom("artifacts")
			.selectAll()
			.where("problemId", "=", problemId)
			.where("type", "=", "constraint")
			.where("status", "=", "active")
			.orderBy("score", "desc")
			.execute();
		return rows as unknown as Artifact[];
	}

	// Promote an insight or failure pattern into a constraint proposal
	async createConstraintProposal(input: {
		problemId: string;
		title: string;
		description: string;
		derivedFromInsightIds: string[];
	}): Promise<Artifact> {
		const artifact = await this.createArtifact({
			type: "constraint",
			problemId: input.problemId,
			title: input.title,
			hypothesisText: input.description,
			provenance: { agent: "legislator" },
		});

		// Link to insights it generalizes
		for (const insightId of input.derivedFromInsightIds) {
			await this.addRelation(insightId, artifact.id, "generalizes");
		}
		return artifact;
	}

	async createProjectArtifact(
		input: {
			problemId: string;
			parentId?: string | null;
			depth?: number;
			title?: string;
			hypothesisText?: string;
			files?: Record<string, string>;
			provenance?: any;
		}
	): Promise<Artifact> {
		const artifact = await this.createArtifact({
			type: "project",
			...input,
			payload: input.files ? { files: input.files } : undefined,
		});

		if (input.files) {
			const workspacePath = `artifacts/${artifact.id}`;
			await db
				.updateTable("artifacts")
				.set({ workspacePath })
				.where("id", "=", artifact.id)
				.execute();
			artifact.workspacePath = workspacePath;
		}

		return artifact;
	}

	// ── Step Plan ───────────────────────────────────────────────────────────

	async setStepPlan(problemId: string, plan: StepPlan): Promise<void> {
		await db
			.updateTable("problems")
			.set({ stepPlan: JSON.stringify(plan), currentStep: 0 } as any)
			.where("id", "=", problemId)
			.execute();
	}

	async getStepInfo(problemId: string): Promise<{ plan: StepPlan; currentStep: number } | null> {
		const problem = await this.getProblem(problemId);
		if (!problem?.stepPlan) return null;
		const plan: StepPlan = typeof problem.stepPlan === "string"
			? JSON.parse(problem.stepPlan)
			: problem.stepPlan as unknown as StepPlan;
		return { plan, currentStep: (problem as any).currentStep ?? 0 };
	}

	async advanceStep(problemId: string): Promise<void> {
		const info = await this.getStepInfo(problemId);
		if (!info) return;
		const next = info.currentStep + 1;
		if (next >= info.plan.steps.length) {
			await db.updateTable("problems").set({ status: "solved" } as any).where("id", "=", problemId).execute();
			console.log(`[KG] Problem ${problemId} solved — all steps complete`);
			return;
		}
		await db.updateTable("problems").set({ currentStep: next } as any).where("id", "=", problemId).execute();
		console.log(`[KG] Step advanced → ${next}: ${info.plan.steps[next]?.goal}`);
	}

	/** Get the highest-scoring surviving artifact for a problem */
	async getBestSurvivor(problemId: string): Promise<Artifact | undefined> {
		const row = await db
			.selectFrom("artifacts")
			.selectAll()
			.where("problemId", "=", problemId)
			.where("status", "=", "lemma")
			.where("confidenceLevel", ">=", 2 as any)
			.orderBy("score", "desc")
			.limit(1)
			.executeTakeFirst();
		return row as unknown as Artifact | undefined;
	}

	/** Get all surviving artifacts at or above a given confidence level */
	async getSurvivors(problemId: string, minConfidence = 2): Promise<Artifact[]> {
		const rows = await db
			.selectFrom("artifacts")
			.selectAll()
			.where("problemId", "=", problemId)
			.where("status", "=", "lemma")
			.where("confidenceLevel", ">=", minConfidence as any)
			.orderBy("score", "desc")
			.execute();
		return rows as unknown as Artifact[];
	}

	/** Get the most recent N hypothesis/project attempts (both alive and dead) for health tracking */
	async getRecentAttempts(
		problemId: string,
		limit = 8
	): Promise<Array<{ id: string; score: number; status: string; hypothesisText: string | null }>> {
		const rows = await db
			.selectFrom("artifacts")
			.select(["id", "score", "status", "hypothesisText"])
			.where("problemId", "=", problemId)
			.where("type", "in", ["hypothesis", "project"])
			.orderBy("createdAt", "desc")
			.limit(limit)
			.execute();
		return rows as unknown as Array<{ id: string; score: number; status: string; hypothesisText: string | null }>;
	}

}