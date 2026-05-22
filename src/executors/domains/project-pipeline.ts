import { Sandbox, parseSandboxOutput } from "../sandbox";
import type { PipelineResult } from "../../verification/types";
import type { Proposal, WorkingContext } from "../../core/types";

/**
 * Pipeline for multi-file project proposals.
 * Writes all files to a sandbox, optionally clones a git repo first,
 * runs install → build → test, and returns structured results.
 */
export async function runProjectPipeline(
	proposal: Proposal,
	_ctx: WorkingContext
): Promise<PipelineResult> {
	if (proposal.executable.type !== "project") {
		return fail("Project pipeline requires a project executable");
	}

	const exe = proposal.executable;
	const sb = new Sandbox("truth-proj-");
	const stages: import("../../verification/types").StageResult[] = [];

	try {
		// 1. Clone git repo if specified
		if (exe.gitRepo) {
			console.log(`    [project] cloning ${exe.gitRepo}`);
			const cloneResult = await sb.gitClone(exe.gitRepo, "repo");
			stages.push({
				stageName: "GitClone",
				passed: cloneResult.exitCode === 0,
				reason: cloneResult.exitCode !== 0 ? cloneResult.stderr.slice(0, 300) : undefined,
				runtimeMs: cloneResult.runtimeMs,
			});
			if (cloneResult.exitCode !== 0) {
				return { overallPassed: false, stages, finalMetrics: {} };
			}
		}

		// 2. Write project files
		const fileRoot = exe.gitRepo ? "repo" : ".";
		for (const [relPath, content] of Object.entries(exe.files ?? {})) {
			const safePath = relPath.replace(/^(\.\.(\/|\\|$))+/, "");
			sb.write(`${fileRoot}/${safePath}`, content);
		}

		const cwd = exe.gitRepo ? "repo" : undefined;

		// 3. Install dependencies
		if (exe.installCommand) {
			const r = await sb.exec(exe.installCommand, { relCwd: cwd, timeoutMs: 180_000 });
			stages.push({
				stageName: "Install",
				passed: r.exitCode === 0,
				reason: r.exitCode !== 0 ? r.stderr.slice(0, 500) : undefined,
				runtimeMs: r.runtimeMs,
			});
			if (r.exitCode !== 0) return { overallPassed: false, stages, finalMetrics: {} };
		}

		// 4. Build
		if (exe.buildCommand) {
			const r = await sb.exec(exe.buildCommand, { relCwd: cwd, timeoutMs: 120_000 });
			stages.push({
				stageName: "Build",
				passed: r.exitCode === 0,
				reason: r.exitCode !== 0 ? (r.stderr || r.stdout).slice(0, 500) : undefined,
				runtimeMs: r.runtimeMs,
			});
			if (r.exitCode !== 0) return { overallPassed: false, stages, finalMetrics: {} };
		}

		// 5. Run tests
		if (!exe.testCommand) {
			stages.push({ stageName: "Tests", passed: true, reason: "No test command specified", runtimeMs: 0 });
			return { overallPassed: true, stages, finalMetrics: {} };
		}

		const testResult = await sb.exec(exe.testCommand, { relCwd: cwd, timeoutMs: 300_000 });

		// Try to parse structured output; fall back to exit code
		const pipeResult = parseSandboxOutput(testResult, "Tests");
		stages.push(...pipeResult.stages);

		return {
			overallPassed: pipeResult.overallPassed,
			stages,
			finalMetrics: pipeResult.finalMetrics,
		};
	} finally {
		sb.cleanup();
	}
}

function fail(reason: string): PipelineResult {
	return {
		overallPassed: false,
		stages: [{ stageName: "Validation", passed: false, reason, runtimeMs: 0 }],
		finalMetrics: {},
	};
}
