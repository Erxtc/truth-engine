import type { Insertable } from "kysely";

import { db } from "./client";
import { type Artifact, type Relation, type Execution, type Problem, } from "./schema";

import type { DB } from "./types";
import { randomUUIDv7 } from "bun";
import type { PipelineResult } from "../verification/types";

export class KnowledgeGraph {
	async createProblem(domain: string, description: string): Promise<Problem> {
		const id = Bun.randomUUIDv7();

		const problem: Insertable<DB["problems"]> = {
			id,
			domain,
			description,
			status: "open",
		};

		const p = await db
			.insertInto("problems")
			.values(problem)
			.returningAll()
			.executeTakeFirstOrThrow();

		return p;
	}

	async getProblem(id: string): Promise<Problem | undefined> {
		return db
			.selectFrom("problems")
			.selectAll()
			.where("id", "=", id)
			.executeTakeFirst();
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

		const row: Insertable<DB["artifacts"]> = {
			id,
			status: "active",
			score: 0,
			depth: input.depth ?? 0,
			parent_id: input.parentId ?? null,
			...input,
		};

		const artifact = await db
			.insertInto("artifacts")
			.values(row)
			.returningAll()
			.executeTakeFirstOrThrow();

		return artifact;
	}

	async getArtifact(id: string): Promise<Artifact | undefined> {
		return db
			.selectFrom("artifacts")
			.selectAll()
			.where("id", "=", id)
			.executeTakeFirst();
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
			>
		>
	) {
		await db
			.updateTable("artifacts")
			.set(updates)
			.where("id", "=", id)
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
			.values({
				id,
				sourceId,
				targetId,
				relationType: type,
				properties: props,
			})
			.execute();
	}

	// ── Queries ─────────────────────────────────────────────────────────────

	async getProvenLemmas(problemId: string, limit = 10): Promise<Artifact[]> {
		return db
			.selectFrom("artifacts")
			.selectAll()
			.where("problemId", "=", problemId)
			.where("type", "=", "lemma")
			.where("status", "=", "active")
			.orderBy("score", "desc")
			.limit(limit)
			.execute();
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
		exec: Omit<Execution, "id" | "createdAt">
	) {
		const id = randomUUIDv7();

		await db
			.insertInto("executions")
			.values({
				id,
				artifactId,
				...exec,
			})
			.execute();

		await db
			.updateTable("artifacts")
			.set({ latest_execution_id: id })
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
				artifact_id: input.artifactId ?? null,
				agentRole: input.agentRole,
				inputContext: input.inputContext,
				response: input.response,
				cost: input.cost,
			})
			.execute();
	}

	async recordPipelineExecution(
		artifactId: string,
		pipelineResult: PipelineResult
	) {
		// Record each stage
		for (const stage of pipelineResult.stages) {
			await this.recordExecution(artifactId, {
				executionType: `stage_${stage.stageName}`,
				passed: stage.passed,
				metrics: stage.metrics || {},
				errorLog: stage.reason || undefined,
				runtimeMs: stage.runtimeMs,
				testResults: stage.testResults || [],
			});
		}

		// Record a summary row
		await this.recordExecution(artifactId, {
			executionType: "pipeline_summary",
			passed: pipelineResult.overallPassed,
			metrics: pipelineResult.finalMetrics,
			runtimeMs: pipelineResult.stages.reduce((sum, s) => sum + s.runtimeMs, 0),
		}); // Type '{ executionType: string; passed: boolean; metrics: Record<string, number>; runtimeMs: number; }' is missing the following properties from type 'Omit<{ id: string; createdAt: Date; artifactId: string; executionType: string; passed: boolean; metrics: unknown; errorLog: string | null; testResults: unknown; runtimeMs: number | null; }, "id" | "createdAt">': artifactId, errorLog, testResultsts
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
		return db
			.selectFrom('artifacts')
			.selectAll()
			.where('problem_id', '=', problemId)
			.where('type', '=', "insight")
			.where('status', '=', "active")
			.orderBy('created_at', 'desc')
			.limit(limit).execute();
	}

	// Get all active constraints for a problem
	async getActiveConstraints(problemId: string): Promise<Artifact[]> {
		return db
			.selectFrom("artifacts")
			.selectAll()
			.where("problem_id", "=", problemId)
			.where("type", "=", "constraint")
			.where("status", "=", "active")
			.orderBy("score", "desc")
			.execute();
	}

	// Promote an insight or failure pattern into a constraint proposal
	async createConstraintProposal(input: {
		problemId: string;
		title: string;
		description: string;
		derivedFromInsightIds: string[];
	}): Promise<Artifact> {
		const artifact = await this.createArtifact({
			type: "constraint",          // starts as active constraint if we want
			status: "active",            // or "proposed" – we can use "active" for simplicity
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

}