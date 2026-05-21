import { db } from "../db/client";
import { KnowledgeGraph } from "../db/knowledge-graph";
import { queryLlm } from "../llm";
import * as v from "valibot";

function ruleBasedInsight(stageName: string, errorLog: string): string | null {
	const lower = errorLog?.toLowerCase() ?? "";

	if (stageName === "SyntaxCheck" && lower.includes("unexpected token")) {
		return "Syntax errors: ensure the generated code is valid JavaScript.";
	}
	if (stageName === "UnitTests") {
		if (lower.includes("empty")) return "Handle empty input arrays correctly.";
		if (lower.includes("duplicate") || lower.includes("stable"))
			return "Sorting must be stable when elements are equal.";
		return "Verify that your sort function works on all edge cases (empty, single, duplicates).";
	}
	if (stageName === "PropertyFuzz") {
		if (lower.includes("not sorted")) return "Ensure the output array is fully sorted.";
		if (lower.includes("elements changed")) return "Ensure the sort does not lose or duplicate elements.";
		return "The function failed random property‑based testing. Re‑examine invariants.";
	}
	if (stageName === "Performance") {
		if (lower.includes("regression")) return "The proposed sort is slower than the baseline. Look for O(n log n) algorithms.";
		return "Performance regression – avoid recursion or excessive allocations.";
	}
	if (stageName === "Adversarial") {
		return "A maliciously crafted input broke the function. Strengthen edge‑case handling.";
	}
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

Generate a concise, actionable insight that will help future proposals avoid this failure.
Return only a JSON object: { "insight": "..." }
  `.trim();
	try {
		const result = await queryLlm(prompt, insightSchema);
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

	const stageName = failingStage.execution_type?.replace("stage_", "") ?? "Unknown";
	const errorLog = failingStage.error_log ?? "";
	const proposalText = artifact.hypothesisText ?? artifact.title ?? "";

	let insightText = ruleBasedInsight(stageName, errorLog);

	if (!insightText) {
		insightText =
			(await llmBasedInsight(stageName, errorLog, proposalText)) ??
			`Generic: avoid failures at ${stageName} stage.`;
	}

	await kg.createInsight({
		problemId: artifact.problemId,
		title: insightText,
		relatedArtifactIds: [failedArtifactId],
		payload: { stage: stageName, errorLog },
	});

	console.log(`  [FeedbackAnalyzer] Generated insight: "${insightText}"`);
}

async function runLegislator(kg: KnowledgeGraph, problemId: string) {
	// Fetch recent insights (last 20 dead artifacts)
	const deadArtifacts = await db
		.selectFrom("artifacts")
		.selectAll()
		.where("problemId", "=", problemId)
		.where("status", "=", "dead")
		.orderBy("createdAt", "desc")
		.limit(20)
		.execute();

	const insightCounts = new Map<string, number>();
	for (const dead of deadArtifacts) {
		const insightRels = await db
			.selectFrom("relations")
			.innerJoin("artifacts", "targetId", "artifacts.id")
			.select("artifacts.title")
			.where("sourceId", "=", dead.id)
			.where("relationType", "=", "cites")  // or "generalizes"? TODO: Build how insights will be linked properly
			.execute();

		for (const rel of insightRels) {
			const title = rel.title ?? "unknown";
			insightCounts.set(title, (insightCounts.get(title) ?? 0) + 1);
		}
	}

	// Threshold: if any insight appears >= 3 times, legislate it
	for (const [title, count] of insightCounts) {
		if (count >= 3) {
			// Check if already a constraint with similar title
			const existing = await db
				.selectFrom("artifacts")
				.selectAll()
				.where("problemId", "=", problemId)
				.where("type", "=", "constraint")
				.where("title", "=", title)
				.executeTakeFirst();

			if (!existing) {
				// Generate a formal constraint statement using LLM (optional)
				const description = `Automatically legislated from repeated failures: ${title}`;
				await kg.createConstraintProposal({
					problemId,
					title,
					description,
					derivedFromInsightIds: [], // could populate
				});
				console.log(`[Legislator] Promoted insight to constraint: "${title}"`);
			}
		}
	}
}