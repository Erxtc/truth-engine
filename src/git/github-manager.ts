import simpleGit, { type SimpleGit } from "simple-git";
import { Octokit } from "@octokit/rest";
import * as fs from "fs/promises";
import * as path from "path";

export class GitHubManager {
	private octokit: Octokit;
	private owner: string;
	private repoPrefix: string;
	private workspaceRoot: string;

	constructor(workspaceRoot: string = "./workspaces") {
		const token = process.env.GITHUB_TOKEN;
		this.owner = process.env.GITHUB_OWNER || "truth-engine";
		this.repoPrefix = process.env.GITHUB_REPO_PREFIX || "problem-";
		if (!token) {
			throw new Error(
				"GITHUB_TOKEN environment variable is required for GitHub integration"
			);
		}
		this.octokit = new Octokit({ auth: token });
		this.workspaceRoot = workspaceRoot;
	}

	/** Ensure repository exists, return its name */
	async ensureRepository(problemId: string): Promise<string> {
		const repoName = `${this.repoPrefix}${problemId}`;
		try {
			await this.octokit.repos.get({ owner: this.owner, repo: repoName });
			console.log(`[GitHub] Repository ${repoName} already exists`);
		} catch {
			console.log(`[GitHub] Creating repository ${repoName}`);
			await this.octokit.repos.createForAuthenticatedUser({
				name: repoName,
				private: true,
				auto_init: true,
				description: `Truth Engine problem: ${problemId}`,
			});
			console.log(`[GitHub] Repository created`);
		}
		return repoName;
	}

	/** Clone repository locally if not already present */
	async cloneIfNeeded(problemId: string): Promise<string> {
		const repoName = await this.ensureRepository(problemId);
		const localPath = path.join(this.workspaceRoot, problemId);
		const git: SimpleGit = simpleGit();

		try {
			await git.cwd(localPath).status();
			console.log(`[Git] Repository already cloned at ${localPath}`);
		} catch {
			const url = `https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/${this.owner}/${repoName}.git`;
			console.log(`[Git] Cloning ${repoName} to ${localPath}`);
			await simpleGit().clone(url, localPath, ["--depth", "1"]);
			console.log(`[Git] Clone complete`);
		}
		return localPath;
	}

	/** 
	 * Create a branch for an artifact, write files, commit, and push.
	 * Returns the commit SHA.
	 */
	async createArtifactBranch(
		problemId: string,
		artifactId: string,
		files: Record<string, string>,
		hypothesisText: string
	): Promise<{ branchName: string; commitSha: string }> {
		const localPath = await this.cloneIfNeeded(problemId);
		const git: SimpleGit = simpleGit(localPath);
		const branchName = `artifact-${artifactId}`;

		// Ensure we're on main and pull latest
		await git.checkout("main");
		await git.pull("origin", "main");

		// Create and switch to new branch
		console.log(`[Git] Creating branch ${branchName}`);
		await git.checkoutLocalBranch(branchName);

		// Clean directory (remove all files except .git)
		const entries = await fs.readdir(localPath);
		for (const entry of entries) {
			if (entry !== ".git") {
				await fs.rm(path.join(localPath, entry), { recursive: true, force: true });
			}
		}

		// Write all files from the proposal
		for (const [filePath, content] of Object.entries(files)) {
			const safePath = path.normalize(filePath).replace(/^(\.\.(\/|\\|$))+/, "");
			const fullPath = path.join(localPath, safePath);
			await fs.mkdir(path.dirname(fullPath), { recursive: true });
			await fs.writeFile(fullPath, content, "utf-8");
			console.log(`[Git] Written: ${filePath}`);
		}

		// Stage all files
		await git.add(".");

		// Commit
		const commitMessage = `[Truth Engine] Proposal ${artifactId}\n\n${hypothesisText}`;
		const commitResult = await git.commit(commitMessage);
		const commitSha = commitResult.commit || "";

		// Push to origin
		console.log(`[Git] Pushing branch ${branchName}`);
		await git.push("origin", branchName, ["--set-upstream"]);

		return { branchName, commitSha };
	}

	/** 
	 * Merge a proven branch into main.
	 */
	async mergeToMain(problemId: string, branchName: string): Promise<void> {
		const repoName = `${this.repoPrefix}${problemId}`;
		console.log(`[GitHub] Merging ${branchName} into main`);

		try {
			await this.octokit.repos.merge({
				owner: this.owner,
				repo: repoName,
				base: "main",
				head: branchName,
				commit_message: `[Truth Engine] Merge verified artifact ${branchName}`,
			});
			console.log(`[GitHub] Merge successful`);

			// Update local
			const localPath = path.join(this.workspaceRoot, problemId);
			const git: SimpleGit = simpleGit(localPath);
			await git.checkout("main");
			await git.pull("origin", "main");
		} catch (err: any) {
			console.error(`[GitHub] Merge failed: ${err.message}`);
			throw err;
		}
	}

	/** 
	 * Close a dead branch (delete remote) and create an issue documenting why.
	 */
	async closeBranch(problemId: string, branchName: string, reason: string): Promise<void> {
		const repoName = `${this.repoPrefix}${problemId}`;
		console.log(`[GitHub] Closing branch ${branchName}: ${reason}`);

		// Delete remote branch
		try {
			await this.octokit.git.deleteRef({
				owner: this.owner,
				repo: repoName,
				ref: `heads/${branchName}`,
			});
		} catch (err: any) {
			console.warn(`[GitHub] Could not delete branch: ${err.message}`);
		}

		// Create an issue documenting the failure
		try {
			await this.octokit.issues.create({
				owner: this.owner,
				repo: repoName,
				title: `Killed: ${branchName}`,
				body: `**Artifact**: \`${branchName}\`\n\n**Kill Reason**: ${reason}\n\nThis branch was automatically closed by the Truth Engine because it failed verification.`,
				labels: ["dead", "auto-closed"],
			});
		} catch (err: any) {
			console.warn(`[GitHub] Could not create issue: ${err.message}`);
		}

		// Clean local branch
		const localPath = path.join(this.workspaceRoot, problemId);
		const git: SimpleGit = simpleGit(localPath);
		try {
			await git.checkout("main");
			await git.deleteLocalBranch(branchName, true);
		} catch { }
	}

	/** 
	 * Get CI check status for a branch reference.
	 */
	async getCIStatus(
		problemId: string,
		branchName: string
	): Promise<{
		totalChecks: number;
		completedChecks: number;
		passedChecks: number;
		failedChecks: number;
		status: "pending" | "completed" | "failed";
		details: Array<{ name: string; status: string; conclusion: string | null }>;
	}> {
		const repoName = `${this.repoPrefix}${problemId}`;
		try {
			const checks = await this.octokit.checks.listForRef({
				owner: this.owner,
				repo: repoName,
				ref: branchName,
				per_page: 100,
			});

			const checkRuns = checks.data.check_runs;
			const totalChecks = checkRuns.length;
			const completedChecks = checkRuns.filter(c => c.status === "completed").length;
			const passedChecks = checkRuns.filter(c => c.conclusion === "success").length;
			const failedChecks = checkRuns.filter(c => c.conclusion === "failure" || c.conclusion === "timed_out").length;

			let status: "pending" | "completed" | "failed" = "pending";
			if (totalChecks > 0 && completedChecks === totalChecks) {
				status = failedChecks > 0 ? "failed" : "completed";
			}

			return {
				totalChecks,
				completedChecks,
				passedChecks,
				failedChecks,
				status,
				details: checkRuns.map(c => ({
					name: c.name,
					status: c.status,
					conclusion: c.conclusion,
				})),
			};
		} catch {
			return { totalChecks: 0, completedChecks: 0, passedChecks: 0, failedChecks: 0, status: "pending", details: [] };
		}
	}

	/**
	 * Seed a GitHub Actions workflow file in the repository.
	 */
	async seedCIWorkflow(problemId: string): Promise<void> {
		const localPath = await this.cloneIfNeeded(problemId);
		const git: SimpleGit = simpleGit(localPath);

		await git.checkout("main");
		await git.pull("origin", "main");

		const workflowsDir = path.join(localPath, ".github", "workflows");
		await fs.mkdir(workflowsDir, { recursive: true });

		const workflowContent = `name: Truth Engine Verification
on:
  push:
    branches: [ artifact-* ]
  pull_request:
    branches: [ main ]

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          
      - name: Install dependencies (Node)
        if: hashFiles('package.json') != ''
        run: npm install
        
      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'
          
      - name: Install dependencies (Python)
        if: hashFiles('requirements.txt') != ''
        run: pip install -r requirements.txt
        
      - name: Build project
        if: hashFiles('Makefile', 'package.json', 'pyproject.toml') != ''
        run: |
          if [ -f Makefile ]; then make build; fi
          if [ -f package.json ]; then npm run build; fi
          
      - name: Run tests
        run: |
          if [ -f Makefile ]; then make test; fi
          if [ -f package.json ]; then npm test; fi
          if [ -f requirements.txt ]; then python -m pytest tests/; fi
          
      - name: Lint code
        continue-on-error: true
        run: |
          if [ -f package.json ]; then npx eslint . || true; fi
          if [ -f requirements.txt ]; then pip install pylint && pylint *.py || true; fi
`;

		await fs.writeFile(path.join(workflowsDir, "verify.yml"), workflowContent, "utf-8");
		await git.add(".github/workflows/verify.yml");
		await git.commit("[Truth Engine] Add CI workflow");
		await git.push("origin", "main");
		console.log(`[GitHub] CI workflow seeded`);
	}
}