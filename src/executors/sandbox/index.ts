import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PersistentShell } from "./persistent-shell";
import {
  ContainerShell,
  buildBwrapArgs,
  bwrapFunctional,
  type ContainerConfig,
  DEFAULT_CONTAINER_CONFIG,
} from "./container";

import type { SandboxResult } from "./types";
import type { PipelineResult } from "../../core/types";
export type { SandboxResult };

export interface ExecOptions {
  timeoutMs?: number;
  env?: Record<string, string>;
  relCwd?: string;
}

export interface SandboxOptions {
  /** Temp directory prefix (default: "truth-sb-"). Ignored when workspaceDir is set. */
  prefix?: string;
  /** Use a persistent bash process so shell state carries over between exec() calls. */
  persistent?: boolean;
  /** Use this specific directory instead of a temp dir. Persists across runs. */
  workspaceDir?: string;
  /** Enable container isolation (bubblewrap). null/undefined = no isolation. */
  container?: ContainerConfig | null;
}

export class Sandbox {
  readonly dir: string;
  private _shell: PersistentShell | ContainerShell | null = null;
  private _containerCfg: Required<ContainerConfig> | null = null;
  private _ownsDir: boolean;

  constructor(opts?: SandboxOptions | string) {
    // Backward compat: string arg = prefix
    let options: SandboxOptions;
    if (typeof opts === "string") {
      options = { prefix: opts };
    } else if (opts && typeof opts === "object") {
      options = opts;
    } else {
      options = {};
    }

    if (options.workspaceDir) {
      this.dir = path.resolve(options.workspaceDir);
      fs.mkdirSync(this.dir, { recursive: true });
      this._ownsDir = false; // don't delete user-specified workspace dir
    } else {
      this.dir = fs.mkdtempSync(path.join(os.tmpdir(), options.prefix ?? "truth-sb-"));
      this._ownsDir = true;
    }

    // Container isolation (bubblewrap)
    if (options.container !== null && options.container !== undefined) {
      if (bwrapFunctional()) {
        this._containerCfg = { ...DEFAULT_CONTAINER_CONFIG, ...options.container };
      } else {
        console.log("  [sandbox] bwrap not functional — disabling container isolation");
        this._containerCfg = null;
      }
    }

    if (options.persistent) {
      if (this._containerCfg) {
        this._shell = new ContainerShell(this.dir, this._containerCfg);
      } else {
        this._shell = new PersistentShell(this.dir);
      }
    }
  }

  /** Whether container isolation is active. */
  get isolated(): boolean {
    return this._containerCfg !== null;
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

  /** Attach stdout/stderr capture + timeout to an already-spawned process. */
  private _monitor(proc: ChildProcess, timeoutMs: number): Promise<SandboxResult> {
    const start = Date.now();
    return new Promise<SandboxResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;

      proc.stdout!.on("data", (d: Buffer) => { stdout += d; });
      proc.stderr!.on("data", (d: Buffer) => { stderr += d; });

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

	async exec(command: string, opts: ExecOptions = {}): Promise<SandboxResult> {
		// Persistent mode (with or without container): delegate to the shell
		if (this._shell) {
			return this._shell.exec(command, { timeoutMs: opts.timeoutMs });
		}

		// Stateless container mode: wrap with bwrap
		if (this._containerCfg) {
			return this._execBwrapped(command, opts);
		}

		// Legacy stateless mode (backward compat for domain executors)
		const timeoutMs = opts.timeoutMs ?? 30_000;
		const cwd = opts.relCwd ? path.join(this.dir, opts.relCwd) : this.dir;
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
		return this._monitor(proc, timeoutMs);
	}

	/** Execute a command through bwrap in stateless mode. */
	private async _execBwrapped(command: string, opts: ExecOptions): Promise<SandboxResult> {
		const timeoutMs = opts.timeoutMs ?? 30_000;
		const cfg = this._containerCfg!;
		const bwrapArgs = buildBwrapArgs(this.dir, cfg);
		const memKB = cfg.memoryLimitMB * 1024;
		const wrappedCmd = `ulimit -v ${memKB}; ${command}`;

		const proc = spawn("/usr/bin/bwrap", [...bwrapArgs, "--", "bash", "-c", wrappedCmd], {
			cwd: this.dir,
			env: {
				PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		return this._monitor(proc, timeoutMs);
	}

	async gitClone(url: string, dest = "repo", depth = 1): Promise<SandboxResult> {
		return this.exec(
			`git clone --depth=${depth} -- ${JSON.stringify(url)} ${JSON.stringify(dest)}`,
			{ timeoutMs: 120_000 }
		);
	}

	/** Kill the persistent shell (if any) without deleting the workspace directory. */
	killShell(): void {
		if (this._shell) {
			this._shell.cleanup();
			this._shell = null;
		}
	}

	cleanup(): void {
		this.killShell();
		if (this._ownsDir) {
			try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
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
): PipelineResult {
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
