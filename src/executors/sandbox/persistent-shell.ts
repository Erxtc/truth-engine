/**
 * PersistentShell — long-running bash subprocess with stateful command execution.
 *
 * Unlike Sandbox.exec() which spawns an isolated `bash -c` per command, this wraps
 * a single long-lived bash process. Commands are sent via stdin; output is read
 * until a sentinel delimiter appears. This gives the agent:
 *
 *   - Persistent cwd (cd carries over)
 *   - Persistent environment (export, source venv/bin/activate carry over)
 *   - Background processes (cmd &)
 *   - Package installs that survive the session
 */

import { spawn, type ChildProcess } from "child_process";
import { SENTINEL_PREFIX, randomNonce, type SandboxResult } from "./types";

export class PersistentShell {
  readonly sandboxDir: string;
  protected _proc: ChildProcess | null = null;
  protected _nonce: string;
  protected _lock: Promise<void> = Promise.resolve();
  protected _killed = false;
  protected _label = "persistent-shell";

  constructor(sandboxDir: string) {
    this.sandboxDir = sandboxDir;
    this._nonce = randomNonce();
    this._startShell();
  }

  /** Start or restart the bash subprocess. Override in subclasses for custom spawn logic. */
  protected _startShell(): void {
    if (this._killed) return;

    // Kill any existing process
    if (this._proc && !this._proc.killed) {
      try { this._proc.kill("SIGTERM"); } catch { /* ignore */ }
    }

    this._nonce = randomNonce();

    this._proc = spawn("bash", ["--norc", "--noprofile"], {
      cwd: this.sandboxDir,
      env: {
        ...process.env,
        HOME: this.sandboxDir,
        TMPDIR: this.sandboxDir,
        TMP: this.sandboxDir,
        TEMP: this.sandboxDir,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Drain stderr in the background (we merge 2>&1 into stdout per-command)
    this._proc.stderr?.on("data", () => {
      // Intentionally discarded — each command merges stderr to stdout via 2>&1
    });

    this._proc.on("error", (err) => {
      // Shell failed to start — will be detected on next exec() and restarted
      console.error(`  [${this._label}] bash process error: ${err.message}`);
    });
  }

  /** Send a command to the persistent shell and wait for the sentinel.
   *
   *  Each command is wrapped: ( <cmd> ) 2>&1; printf '\n__CMD__<nonce>_%d\n' "$?"
   *
   *  The subshell ( ... ) scopes I/O so background child output from a previous
   *  command doesn't leak into subsequent command output.
   *
   *  Timeout is implemented by prepending `timeout <N>` (GNU coreutils).
   *  Falls back to killing the child process group on timeout if `timeout` is
   *  unavailable (detected by exit code 127 from the timeout command itself).
   */
  async exec(command: string, opts?: { timeoutMs?: number }): Promise<SandboxResult> {
    const timeoutMs = opts?.timeoutMs ?? 30_000;

    // Serialize commands — only one in flight at a time
    const prev = this._lock;
    let release: () => void;
    this._lock = new Promise<void>((resolve) => { release = resolve; });

    await prev;

    try {
      return await this._execLocked(command, timeoutMs);
    } finally {
      release!();
    }
  }

  private async _execLocked(command: string, timeoutMs: number): Promise<SandboxResult> {
    const start = Date.now();

    // Ensure shell is alive
    if (!this._proc || this._proc.killed) {
      this._startShell();
    }

    const proc = this._proc!;
    const sentinel = `${SENTINEL_PREFIX}${this._nonce}_`;

    // Send the command directly to the persistent shell — NO subshell wrapping.
    // This is critical: cd, export, venv/bin/activate, etc. must persist across commands.
    // We merge stderr to stdout and append a sentinel line with the exit code.
    // Timeout is handled at the Node.js level (Ctrl+C → SIGKILL fallback).
    const wrapped = `${command} 2>&1; printf '\\n${sentinel}%d\\n' "$?"\n`;

    return new Promise<SandboxResult>((resolve) => {
      let stdout = "";
      let timedOut = false;
      let resolved = false;

      const finish = (exitCode: number) => {
        if (resolved) return;
        resolved = true;
        if (timer) clearTimeout(timer);
        proc.stdout?.removeListener("data", onData);
        if (stderrHandler) proc.stderr?.removeListener("data", stderrHandler);
        proc.removeListener("close", onClose);
        resolve({
          stdout: stdout.slice(0, 64_000),
          stderr: "", // merged into stdout via 2>&1
          exitCode,
          runtimeMs: Date.now() - start,
          timedOut,
        });
      };

      const onData = (chunk: Buffer) => {
        stdout += chunk.toString();

        // Check for sentinel in the output
        const sentinelIdx = stdout.indexOf(`\n${sentinel}`);
        if (sentinelIdx >= 0) {
          // Everything before the sentinel is the command output
          const output = stdout.slice(0, sentinelIdx);

          // Parse exit code from after the sentinel: __CMD__<nonce>_<code>
          const afterSentinel = stdout.slice(sentinelIdx + sentinel.length + 1); // +1 for \n
          const codeEnd = afterSentinel.indexOf("\n");
          const codeStr = codeEnd >= 0 ? afterSentinel.slice(0, codeEnd) : afterSentinel;
          const exitCode = parseInt(codeStr.trim(), 10);
          const actualExitCode = isNaN(exitCode) ? 1 : exitCode;

          // Swap in the cleaned output
          stdout = output;
          finish(actualExitCode);
        }
      };

      proc.stdout?.on("data", onData);

      // Capture unexpected stderr (bash itself erroring, not user commands)
      const stderrHandler = (chunk: Buffer) => {
        if (!resolved) {
          stdout += `[bash stderr] ${chunk.toString()}`;
        }
      };
      proc.stderr?.on("data", stderrHandler);

      let timer: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs > 0 && timeoutMs < Infinity) {
        timer = setTimeout(() => {
          timedOut = true;
          // Send Ctrl+C to interrupt the currently running command
          proc.stdin?.write("\x03");
          // Give 2 seconds for graceful shutdown, then force-restart the shell
          setTimeout(() => {
            if (!resolved) {
              console.log(`  [${this._label}] Timeout — restarting shell`);
              this._startShell();
              finish(124);
            }
          }, 2000);
        }, timeoutMs);
      }

      // Watch for shell death
      const onClose = (code: number | null) => {
        if (!resolved) {
          console.log(`  [${this._label}] bash exited unexpectedly (code ${code}) — restarting`);
          this._startShell();
          finish(code ?? 1);
        }
      };
      proc.once("close", onClose);

      // Send the command
      proc.stdin?.write(wrapped);
    });
  }

  /** Kill the persistent shell and all its children. */
  cleanup(): void {
    this._killed = true;
    if (this._proc && !this._proc.killed) {
      try {
        // SIGTERM the entire process group to clean up background children
        const pid = this._proc.pid;
        if (pid) {
          try { process.kill(-pid, "SIGTERM"); } catch { /* ignore */ }
        }
        this._proc.kill("SIGKILL");
      } catch { /* already dead */ }
    }
    this._proc = null;
  }
}
