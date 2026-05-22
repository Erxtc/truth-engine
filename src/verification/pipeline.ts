import type { VerificationStage, PipelineResult } from "./types";
import type { Artifact } from "../db/schema";
import type { WorkingContext } from "../core/types";
import { transpileToJs } from "../utils/general";

export async function runPipeline(
	stages: VerificationStage[],
	artifact: Artifact,
	context: WorkingContext
): Promise<PipelineResult> {
	// Strip TypeScript annotations so node-based stages receive plain JS
	if (artifact.sourceCode) {
		artifact = { ...artifact, sourceCode: transpileToJs(artifact.sourceCode) };
	}
	const stageResults = [];
	let overallPassed = true;
	const finalMetrics: Record<string, number> = {};

	for (const stage of stages) {
		console.log(`    [Pipeline] Running stage: ${stage.name}`);
		const result = await stage.run(artifact, context);
		stageResults.push(result);
		if (result.metrics) {
			Object.assign(finalMetrics, result.metrics);
		}
		if (!result.passed) {
			overallPassed = false;
			break; // short-circuit on first failure
		}
	}

	return { overallPassed, stages: stageResults, finalMetrics };
}