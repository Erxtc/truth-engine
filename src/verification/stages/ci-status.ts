import type { VerificationStage, StageResult } from "../types";
import type { Artifact } from "../../db/schema";
import { WorkspaceManager } from "../../workspace/manager";

const workspace = new WorkspaceManager();

export const ciStatusCheck: VerificationStage = {
	name: "CIStatus",
	async run(artifact: Artifact): Promise<StageResult> {
		if (!process.env.GITHUB_TOKEN) {
			return { stageName: this.name, passed: true, reason: "No GitHub integration", runtimeMs: 0 };
		}

		const gitBranch = (artifact.payload as any)?.gitBranch;
		if (!gitBranch) {
			return { stageName: this.name, passed: true, reason: "Not a Git-managed artifact", runtimeMs: 0 };
		}

		const start = Date.now();

		// Poll up to 10 minutes
		for (let i = 0; i < 60; i++) {
			const ciStatus = await workspace.getCIStatus(artifact.problemId, gitBranch);

			if (ciStatus.status === "completed") {
				const passed = ciStatus.failedChecks === 0;
				return {
					stageName: this.name,
					passed,
					reason: passed
						? `CI passed: ${ciStatus.passedChecks}/${ciStatus.totalChecks} checks`
						: `CI failed: ${ciStatus.failedChecks}/${ciStatus.totalChecks} checks`,
					metrics: {
						totalChecks: ciStatus.totalChecks,
						passedChecks: ciStatus.passedChecks,
						failedChecks: ciStatus.failedChecks,
					},
					runtimeMs: Date.now() - start,
				};
			}

			if (ciStatus.status === "failed") {
				return {
					stageName: this.name,
					passed: false,
					reason: `CI failed: ${ciStatus.failedChecks}/${ciStatus.totalChecks} checks`,
					runtimeMs: Date.now() - start,
				};
			}

			// Wait 10 seconds before next poll
			await new Promise((r) => setTimeout(r, 10_000));
		}

		return {
			stageName: this.name,
			passed: false,
			reason: "CI check timed out",
			runtimeMs: Date.now() - start,
		};
	},
};	