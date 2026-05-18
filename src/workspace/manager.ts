import { GitHubManager } from "../git/github-manager";
import * as fs from "fs/promises";
import * as path from "path";
import type { Artifact } from "../db/schema";

export class WorkspaceManager {
	private root: string;
	private git: GitHubManager | null;

	constructor(root: string = "./workspaces") {
		this.root = root;
		this.git = process.env.GITHUB_TOKEN ? new GitHubManager(root) : null;
	}

	/** Ensure the problem workspace exists (clone if Git, mkdir otherwise) */
	async ensureProblemDir(problemId: string): Promise<string> {
		if (this.git) {
			return this.git.cloneIfNeeded(problemId);
		}
		const dir = path.join(this.root, problemId);
		await fs.mkdir(dir, { recursive: true });
		return dir;
	}

	/** 
	 * Create artifact files.
	 * In Git mode: create branch, commit files, push, return commit info.
	 * In local mode: write files to disk.
	 */
	async createArtifactDir(
		artifact: Artifact,
		files: Record<string, string>,
		hypothesisText: string = ""
	): Promise<{
		artifactPath: string;
		gitBranch?: string;
		gitCommit?: string;
	}> {
		if (this.git) {
			const { branchName, commitSha } = await this.git.createArtifactBranch(
				artifact.problemId,
				artifact.id,
				files,
				hypothesisText
			);
			const localPath = await this.git.cloneIfNeeded(artifact.problemId);
			return {
				artifactPath: localPath,
				gitBranch: branchName,
				gitCommit: commitSha,
			};
		} else {
			// Local fallback
			const problemDir = await this.ensureProblemDir(artifact.problemId);
			const artifactDir = path.join(problemDir, "artifacts", artifact.id);
			await fs.mkdir(artifactDir, { recursive: true });
			for (const [filePath, content] of Object.entries(files)) {
				const safePath = path.normalize(filePath).replace(/^(\.\.(\/|\\|$))+/, "");
				const fullPath = path.join(artifactDir, safePath);
				await fs.mkdir(path.dirname(fullPath), { recursive: true });
				await fs.writeFile(fullPath, content, "utf-8");
			}
			return { artifactPath: artifactDir };
		}
	}

	/** Get the working directory for an artifact */
	async getArtifactPath(artifact: Artifact): Promise<string | null> {
		const problemDir = await this.ensureProblemDir(artifact.problemId);
		if (artifact.workspacePath) {
			return path.join(problemDir, artifact.workspacePath);
		}
		return problemDir;
	}

	/** Clean up dead artifact */
	async removeArtifactDir(artifact: Artifact, reason: string = ""): Promise<void> {
		if (this.git && artifact.payload?.gitBranch) {
			await this.git.closeBranch(artifact.problemId, artifact.payload.gitBranch, reason);
		} else {
			const problemDir = await this.ensureProblemDir(artifact.problemId);
			const artifactPath = path.join(problemDir, "artifacts", artifact.id);
			try {
				await fs.rm(artifactPath, { recursive: true, force: true });
			} catch { }
		}
	}

	/** Promote verified artifact to shared/main */
	async promoteToShared(artifact: Artifact): Promise<void> {
		if (this.git && artifact.payload?.gitBranch) {
			await this.git.mergeToMain(artifact.problemId, artifact.payload.gitBranch);
		} else {
			// Local: copy files to shared/
			const artifactPath = await this.getArtifactPath(artifact);
			if (!artifactPath) return;
			const problemDir = await this.ensureProblemDir(artifact.problemId);
			const sharedDir = path.join(problemDir, "shared", artifact.id);
			await fs.cp(artifactPath, sharedDir, { recursive: true });
		}
	}

	/** Seed CI workflow for a problem (Git mode only) */
	async seedCIWorkflow(problemId: string): Promise<void> {
		if (this.git) {
			await this.git.seedCIWorkflow(problemId);
		}
	}

	/** Check CI status (Git mode only) */
	async getCIStatus(problemId: string, branchName: string) {
		if (this.git) {
			return this.git.getCIStatus(problemId, branchName);
		}
		return { totalChecks: 0, completedChecks: 0, passedChecks: 0, failedChecks: 0, status: "completed" as const, details: [] };
	}
}