import { execSync } from "child_process";
import type { VerificationStage, PipelineResult } from "../verification/types";
import { runPipeline } from "../verification/pipeline";
import { consistencyCheck } from "../verification/stages/consistency-check";
import { ciStatusCheck } from "../verification/stages/ci-status";
import type { Proposal, WorkingContext } from "../core/types";
import type { Artifact } from "../db/schema";
import { WorkspaceManager } from "../workspace/manager";

const workspace = new WorkspaceManager();

export async function runProjectPipeline(
	proposal: Proposal,
	ctx: WorkingContext,
	artifact: Artifact
): Promise<PipelineResult> {
	const stages: VerificationStage[] = [
		consistencyCheck,
		{
			name: "Build",
			async run(artifact: Artifact) {
				const files = (artifact.payload as any)?.files;
				if (!files) return { stageName: "Build", passed: true, runtimeMs: 0 };
				const buildCmd = (artifact.payload as any)?.buildCommand;
				if (!buildCmd) return { stageName: "Build", passed: true, runtimeMs: 0 };

				const cwd = await workspace.getArtifactPath(artifact);
				if (!cwd) return { stageName: "Build", passed: false, reason: "No workspace path", runtimeMs: 0 };

				const start = Date.now();
				try {
					execSync(buildCmd, { cwd, timeout: 120_000, stdio: "pipe" });
					return { stageName: "Build", passed: true, runtimeMs: Date.now() - start };
				} catch (err: any) {
					return {
						stageName: "Build",
						passed: false,
						reason: err.stderr?.toString() || err.message,
						runtimeMs: Date.now() - start,
					};
				}
			},
		},
		{
			name: "Tests",
			async run(artifact: Artifact) {
				const files = (artifact.payload as any)?.files;
				if (!files) return { stageName: "Tests", passed: true, runtimeMs: 0 };
				const testCmd = (artifact.payload as any)?.testCommand;
				if (!testCmd) return { stageName: "Tests", passed: true, runtimeMs: 0 };

				const cwd = await workspace.getArtifactPath(artifact);
				if (!cwd) return { stageName: "Tests", passed: false, reason: "No workspace path", runtimeMs: 0 };

				const start = Date.now();
				try {
					execSync(testCmd, { cwd, timeout: 120_000, stdio: "pipe" });
					return { stageName: "Tests", passed: true, runtimeMs: Date.now() - start };
				} catch (err: any) {
					return {
						stageName: "Tests",
						passed: false,
						reason: err.stderr?.toString() || err.message,
						runtimeMs: Date.now() - start,
					};
				}
			},
		},
		ciStatusCheck,
	];

	return runPipeline(stages, artifact, ctx);
}