import { syntaxCheck } from "../../verification/stages/syntax";
import { unitTests } from "../../verification/stages/unit-tests";
import { propertyFuzz } from "../../verification/stages/property-fuzz";
// Needs Implementation:
// import { adversarialAttack } from "../../verification/stages/adversarial";
import { runPipeline } from "../../verification/pipeline";
import type { VerificationStage, PipelineResult } from "../../verification/types";

import { consistencyCheck } from "../../verification/stages/consistency-check";

export const sortingStages: VerificationStage[] = [
	syntaxCheck,
	consistencyCheck,
	unitTests,
	propertyFuzz,
	// performanceBenchmark,
	// adversarialAttack,
];

export async function runSortingPipeline(
	artifact: { sourceCode?: string; payload?: any },
	context: any
): Promise<PipelineResult> {
	return runPipeline(sortingStages, artifact as any, context);
}