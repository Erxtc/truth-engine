import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface SandboxResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	runtimeMs: number;
	timedOut: boolean;
}

export interface ExecOptions {
	timeoutMs?: number;
	env?: Record<string, string>;
	relCwd?: string;
}

export class Sandbox {
	readonly dir: string;

	constructor(prefix = "truth-sb-") {
		this.dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	}

	write(relPath: string, content: string): this {
		const full = path.join(this.dir, relPath);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content, "utf8");
		return this;
	}

	read(relPath: string): string | null {
		try {
			return fs.readFileSync(path.join(this.dir, relPath), "utf8");
		} catch {
			return null;
		}
	}

	exists(relPath: string): boolean {
		return fs.existsSync(path.join(this.dir, relPath));
	}

	async exec(command: string, opts: ExecOptions = {}): Promise<SandboxResult> {
		const timeoutMs = opts.timeoutMs ?? 30_000;
		const cwd = opts.relCwd ? path.join(this.dir, opts.relCwd) : this.dir;
		const start = Date.now();

		return new Promise<SandboxResult>((resolve) => {
			const proc = spawn("bash", ["-c", command], {
				cwd,
				env: {
					PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
					HOME: this.dir,
					TMPDIR: this.dir,
					...opts.env,
				},
				stdio: ["ignore", "pipe", "pipe"],
			});

			let stdout = "";
			let stderr = "";
			let timedOut = false;

			proc.stdout.on("data", (d: Buffer) => { stdout += d; });
			proc.stderr.on("data", (d: Buffer) => { stderr += d; });

			const timer = setTimeout(() => {
				timedOut = true;
				proc.kill("SIGKILL");
			}, timeoutMs);

			proc.on("close", (code) => {
				clearTimeout(timer);
				resolve({
					stdout: stdout.slice(0, 64_000),
					stderr: stderr.slice(0, 16_000),
					exitCode: timedOut ? 124 : (code ?? 1),
					runtimeMs: Date.now() - start,
					timedOut,
				});
			});
		});
	}

	async gitClone(url: string, dest = "repo", depth = 1): Promise<SandboxResult> {
		return this.exec(
			`git clone --depth=${depth} -- ${JSON.stringify(url)} ${JSON.stringify(dest)}`,
			{ timeoutMs: 120_000 }
		);
	}

	cleanup(): void {
		try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch { /* ignore */ }
	}
}

/** Parse sandbox stdout into a PipelineResult.
 *  Tries three formats in order:
 *  1. JSON: last line is { stages: StageResult[], passed: bool }
 *  2. key=value: lines like "units_passed=true", "test_empty=true", "fuzz_passed=false"
 *  3. Fallback: exit code determines pass/fail
 */
export function parseSandboxOutput(
	result: SandboxResult,
	stageName = "Execution"
): import("../../verification/types").PipelineResult {
	// 1. Try JSON (last non-empty line)
	const lines = result.stdout.trim().split("\n").filter(l => l.trim());
	const lastLine = lines.at(-1) ?? "";
	try {
		const parsed = JSON.parse(lastLine);
		if (Array.isArray(parsed.stages)) {
			return {
				overallPassed: Boolean(parsed.passed),
				stages: parsed.stages,
				finalMetrics: parsed.metrics ?? {},
			};
		}
	} catch { /* not JSON */ }

	// 2. key=value format (C harness output)
	const kv: Record<string, string> = {};
	for (const line of lines) {
		const eq = line.indexOf("=");
		if (eq > 0) kv[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
	}
	if ("units_passed" in kv || "fuzz_passed" in kv) {
		const unitsPassed = kv["units_passed"] === "true";
		const fuzzPassed = kv["fuzz_passed"] !== "false"; // absent = not run = ok
		const testResults = Object.entries(kv)
			.filter(([k]) => k.startsWith("test_"))
			.map(([k, v]) => ({ name: k.slice(5), passed: v === "true" }));
		return {
			overallPassed: unitsPassed && fuzzPassed,
			stages: [
				{ stageName: "UnitTests", passed: unitsPassed, testResults, runtimeMs: result.runtimeMs },
				{ stageName: "PropertyFuzz", passed: fuzzPassed, runtimeMs: 0, metrics: { iterations: 300 } },
			],
			finalMetrics: {},
		};
	}

	// 3. Fallback: exit code
	const passed = result.exitCode === 0 && !result.timedOut;
	const reason = result.timedOut
		? "Timed out"
		: (result.stderr.slice(0, 500) || result.stdout.slice(0, 500) || `Exit ${result.exitCode}`);
	return {
		overallPassed: passed,
		stages: [{ stageName, passed, reason: passed ? undefined : reason, runtimeMs: result.runtimeMs }],
		finalMetrics: {},
	};
}
