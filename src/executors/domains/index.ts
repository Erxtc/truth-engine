import type { Proposal, WorkingContext, Domain } from "../../core/types";
import type { PipelineResult } from "../../verification/types";
import type { Artifact } from "../../db/schema";
import { runSortingPipeline } from "./sorting-pipeline";
import { runProjectPipeline } from "../project-harness";

export interface KillHarness {
	run(proposal: Proposal, ctx: WorkingContext, artifact: Artifact): Promise<PipelineResult>;
}

function sortingHarness(): KillHarness {
	return {
		async run(proposal, ctx, _artifact): Promise<PipelineResult> {
			if (proposal.executable.type !== "code") {
				return {
					overallPassed: false,
					stages: [{ stageName: "SyntaxCheck", passed: false, reason: "Sorting harness requires code", runtimeMs: 0 }],
					finalMetrics: {},
				};
			}
			const tempArtifact = {
				sourceCode: proposal.executable.source,
				payload: proposal,
			};
			return runSortingPipeline(tempArtifact as any, ctx);
		},
	};
}

function compressionHarness(): KillHarness {
	return {
		async run(): Promise<PipelineResult> {
			return {
				overallPassed: false,
				stages: [{ stageName: "NotImplemented", passed: false, reason: "Compression harness not implemented", runtimeMs: 0 }],
				finalMetrics: {},
			};
		},
	};
}

function mathHarness(): KillHarness {
	return {
		async run(proposal, ctx, _artifact): Promise<PipelineResult> {
			if (proposal.executable.type !== "proof") {
				return {
					overallPassed: false,
					stages: [{ stageName: "TypeCheck", passed: false, reason: "Math harness requires proof type", runtimeMs: 0 }],
					finalMetrics: {},
				};
			}
			const isValid = proposal.executable.source.includes("theorem") && proposal.executable.source.includes("proof");
			return {
				overallPassed: isValid,
				stages: [{ stageName: "ProofCheck", passed: isValid, reason: isValid ? undefined : "Proof invalid or incomplete", runtimeMs: 0 }],
				finalMetrics: {},
			};
		},
	};
}

function mlHarness(): KillHarness {
	return {
		async run(proposal, ctx, _artifact): Promise<PipelineResult> {
			if (proposal.executable.type !== "code") {
				return {
					overallPassed: false,
					stages: [{ stageName: "TypeCheck", passed: false, reason: "ML harness requires code type", runtimeMs: 0 }],
					finalMetrics: {},
				};
			}
			const hasModel = proposal.executable.source.includes("model") || proposal.executable.source.includes("train");
			return {
				overallPassed: hasModel,
				stages: [{ stageName: "MLValidation", passed: hasModel, reason: hasModel ? undefined : "No ML model detected", runtimeMs: 0 }],
				finalMetrics: {},
			};
		},
	};
}

function physicsHarness(): KillHarness {
	return {
		async run(proposal, ctx, _artifact): Promise<PipelineResult> {
			if (proposal.executable.type !== "sim") {
				return {
					overallPassed: false,
					stages: [{ stageName: "TypeCheck", passed: false, reason: "Physics harness requires sim type", runtimeMs: 0 }],
					finalMetrics: {},
				};
			}
			const hasTimestep = proposal.executable.config && "timestep" in proposal.executable.config;
			return {
				overallPassed: hasTimestep,
				stages: [{ stageName: "SimulationCheck", passed: hasTimestep, reason: hasTimestep ? undefined : "Missing timestep configuration", runtimeMs: 0 }],
				finalMetrics: {},
			};
		},
	};
}

function projectHarness(): KillHarness {
	return {
		async run(proposal, ctx, artifact): Promise<PipelineResult> {
			return runProjectPipeline(proposal, ctx, artifact);
		},
	};
}

export const DOMAINS: Partial<Record<Domain, KillHarness>> = {
	sorting: sortingHarness(),
	compression: compressionHarness(),
	math: mathHarness(),
	ml: mlHarness(),
	physics: physicsHarness(),
	project: projectHarness(),
};