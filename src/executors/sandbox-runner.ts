import { getDomainSpec } from "./domains";
import type { PipelineResult } from "../verification/types";
import type { ExecutionResult, Proposal, WorkingContext } from "../core/types";
import type { Artifact } from "../db/schema";

export interface ExecutionOutcome {
	executionResult: ExecutionResult;
	pipelineResult: PipelineResult;
}

function failOutcome(reason: string, stageName = "Validation"): ExecutionOutcome {
	const pipeline: PipelineResult = {
		overallPassed: false,
		stages: [{ stageName, passed: false, reason, runtimeMs: 0 }],
		finalMetrics: {},
	};
	return { executionResult: { passed: false, reason, iterations: 0 }, pipelineResult: pipeline };
}

export async function runExecutor(
	domain: string,
	proposal: Proposal,
	ctx: WorkingContext,
	artifact: Artifact
): Promise<ExecutionOutcome> {
	const spec = getDomainSpec(domain);
	if (!spec) return failOutcome(`No domain spec registered for "${domain}"`, "NoDomain");
	if (!proposal.executable) return failOutcome("Proposal has no executable payload", "NoExecutable");

	try {
		const pipelineResult = await spec.run(proposal, ctx, artifact);
		const firstFail = pipelineResult.stages.find(s => !s.passed);
		const executionResult: ExecutionResult = {
			passed: pipelineResult.overallPassed,
			reason: pipelineResult.overallPassed
				? `Passed: ${pipelineResult.stages.map(s => s.stageName).join(", ")}`
				: firstFail?.reason ?? "Unknown failure",
			iterations: pipelineResult.stages.length,
			metrics: pipelineResult.finalMetrics,
		};
		return { executionResult, pipelineResult };
	} catch (err) {
		return failOutcome(`Executor threw: ${err instanceof Error ? err.message : String(err)}`, "ExecutorError");
	}
}
