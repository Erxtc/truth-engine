import { DOMAINS, type KillHarness } from "./domains";
import type { PipelineResult } from "../verification/types";
import type { ExecutionResult, Domain, Proposal, WorkingContext } from "../core/types";
import type { Artifact } from "../db/schema";

export interface ExecutionOutcome {
	executionResult: ExecutionResult;
	pipelineResult: PipelineResult;
}

export async function runExecutor(
	domain: Domain,
	proposal: Proposal,
	ctx: WorkingContext,
	artifact: Artifact
): Promise<ExecutionOutcome> {
	const harness: KillHarness | undefined = DOMAINS[domain];

	if (!harness) {
		const pipeline: PipelineResult = {
			overallPassed: false,
			stages: [{ stageName: "NoHarness", passed: false, reason: `No harness registered for "${domain}"`, runtimeMs: 0 }],
			finalMetrics: {},
		};
		return {
			executionResult: {
				passed: false,
				reason: `No harness for domain "${domain}"`,
				iterations: 0,
			},
			pipelineResult: pipeline,
		};
	}

	if (!proposal.executable) {
		const pipeline: PipelineResult = {
			overallPassed: false,
			stages: [{ stageName: "NoExecutable", passed: false, reason: "Proposal has no executable payload", runtimeMs: 0 }],
			finalMetrics: {},
		};
		return {
			executionResult: {
				passed: false,
				reason: "No executable payload",
				iterations: 0,
			},
			pipelineResult: pipeline,
		};
	}

	try {
		const pipelineResult = await harness.run(proposal, ctx, artifact);
		const executionResult: ExecutionResult = {
			passed: pipelineResult.overallPassed,
			reason: pipelineResult.overallPassed
				? `Pipeline passed: ${pipelineResult.stages.map(s => s.stageName).join(", ")}`
				: pipelineResult.stages.find(s => !s.passed)?.reason || "Unknown failure",
			iterations: pipelineResult.stages.length,
			metrics: pipelineResult.finalMetrics,
		};
		return { executionResult, pipelineResult };
	} catch (err) {
		const pipeline: PipelineResult = {
			overallPassed: false,
			stages: [{ stageName: "ExecutorError", passed: false, reason: `Executor threw: ${err instanceof Error ? err.message : String(err)}`, runtimeMs: 0 }],
			finalMetrics: {},
		};
		return {
			executionResult: {
				passed: false,
				reason: `Executor error: ${err}`,
				iterations: 0,
			},
			pipelineResult: pipeline,
		};
	}
}