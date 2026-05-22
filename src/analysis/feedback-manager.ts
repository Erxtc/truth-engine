import { db } from "../db/client";
import { KnowledgeGraph } from "../db/knowledge-graph";
import { queryReasoning } from "../llm";
import * as v from "valibot";

function ruleBasedInsight(stageName: string, errorLog: string): string | null {
	const lower = errorLog?.toLowerCase() ?? "";

	if (stageName === "SyntaxCheck" && lower.includes("unexpected token"))
		return "Syntax errors: ensure the generated code is valid JavaScript.";
	if (stageName === "UnitTests") {
		if (lower.includes("empty")) return "Handle empty input arrays correctly.";
		if (lower.includes("duplicate") || lower.includes("stable"))
			return "Sorting must be stable when elements are equal.";
		return "Verify your sort function works on all edge cases (empty, single, duplicates).";
	}
	if (stageName === "PropertyFuzz") {
		if (lower.includes("not sorted")) return "Ensure the output array is fully sorted.";
		if (lower.includes("elements changed")) return "Ensure the sort does not lose or duplicate elements.";
		return "Failed random property-based testing — re-examine invariants.";
	}
	if (stageName === "Performance")
		return lower.includes("regression")
			? "The proposed sort is slower than baseline. Target O(n log n)."
			: "Performance regression — avoid recursion or excessive allocations.";
	if (stageName === "Adversarial")
		return "A crafted input broke the function. Strengthen edge-case handling.";
	return null;
}

const insightSchema = v.object({ insight: v.string() });

async function llmBasedInsight(
	stageName: string,
	errorLog: string,
	proposalSummary: string
): Promise<string | null> {
	const prompt = `
A proposal failed at the "${stageName}" stage.
Error: ${errorLog}
Proposal summary: ${proposalSummary}

Write one concise, actionable insight that will help future proposals avoid this exact failure.
Return JSON: { "insight": "..." }
`.trim();
	try {
		const result = await queryReasoning({ userPrompt: prompt, schema: insightSchema });
		return result.response.insight;
	} catch {
		return null;
	}
}

export async function runFeedbackAnalyzer(kg: KnowledgeGraph, failedArtifactId: string) {
	const artifact = await kg.getArtifact(failedArtifactId);
	if (!artifact || artifact.status !== "dead") return;

	const execRows = await db
		.selectFrom("executions")
		.selectAll()
		.where("artifactId", "=", failedArtifactId)
		.execute();

	const failingStage = execRows.find((ex) => !ex.passed);
	if (!failingStage) return;

	const stageName = failingStage.executionType?.replace("stage_", "") ?? "Unknown";
	const errorLog = failingStage.errorLog ?? "";
	const proposalText = artifact.hypothesisText ?? artifact.title ?? "";

	const insightText =
		ruleBasedInsight(stageName, errorLog) ??
		(await llmBasedInsight(stageName, errorLog, proposalText)) ??
		`Avoid failures at ${stageName} stage.`;

	await kg.createInsight({
		problemId: artifact.problemId,
		title: insightText,
		relatedArtifactIds: [failedArtifactId],
		payload: { stage: stageName, errorLog },
	});

	console.log(`  [FeedbackAnalyzer] insight: "${insightText}"`);
}

export async function runLegislator(kg: KnowledgeGraph, problemId: string) {
	const deadArtifacts = await db
		.selectFrom("artifacts")
		.selectAll()
		.where("problemId", "=", problemId)
		.where("status", "=", "dead")
		.orderBy("createdAt", "desc")
		.limit(30)
		.execute();

	// Count how often each insight title appears across failed artifacts
	const insightCounts = new Map<string, { count: number; ids: string[] }>();
	for (const dead of deadArtifacts) {
		const cited = await db
			.selectFrom("relations")
			.innerJoin("artifacts", "relations.targetId", "artifacts.id")
			.select(["artifacts.title", "artifacts.id"])
			.where("relations.sourceId", "=", dead.id)
			.where("relations.relationType", "=", "cites")
			.execute();

		for (const row of cited) {
			const title = row.title ?? "unknown";
			const entry = insightCounts.get(title) ?? { count: 0, ids: [] };
			entry.count++;
			entry.ids.push(row.id);
			insightCounts.set(title, entry);
		}
	}

	// Promote recurring insights to hard constraints
	for (const [title, { count, ids }] of insightCounts) {
		if (count < 3) continue;

		const existing = await db
			.selectFrom("artifacts")
			.select("id")
			.where("problemId", "=", problemId)
			.where("type", "=", "constraint")
			.where("title", "=", title)
			.executeTakeFirst();

		if (!existing) {
			await kg.createConstraintProposal({
				problemId,
				title,
				description: `Legislated from ${count} repeated failures: ${title}`,
				derivedFromInsightIds: ids,
			});
			console.log(`  [Legislator] constraint promoted (${count}×): "${title}"`);
		}
	}
}
