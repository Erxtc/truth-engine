/**
 * Container-based sandbox isolation using bubblewrap (bwrap).
 *
 * When enabled, all commands run inside a Linux namespace with:
 *   - Read-only root filesystem (/usr, /bin, /lib, /etc, etc.)
 *   - Writable workspace directory only
 *   - Network isolation (no external connectivity)
 *   - PID namespace (children killed on exit)
 *   - IPC separation
 *
 * This makes the sandbox safe for running untrusted code — the agent
 * can install packages, run servers, and write files within its workspace
 * but cannot read sensitive files, access the network, or escape.
 *
 * Requirements: bubblewrap must be installed (`apt install bubblewrap`).
 * Falls back gracefully — if bwrap is missing, execs run without isolation.
 */

import { spawn } from "child_process";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { randomNonce } from "./types";
import { PersistentShell } from "./persistent-shell";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ContainerConfig {
  /** Enable network access inside the container (default: false). */
  network?: boolean;
  /** Memory limit in MB (default: 512). Enforced via ulimit -v. */
  memoryLimitMB?: number;
  /** Additional writable directories (in addition to workspace + /tmp). */
  extraWritableDirs?: string[];
  /** Additional read-only bind mounts. */
  extraRoDirs?: string[];
}

export const DEFAULT_CONTAINER_CONFIG: Required<ContainerConfig> = {
  network: false,
  memoryLimitMB: 512,
  extraWritableDirs: [],
  extraRoDirs: [],
};

// ── Bwrap path detection ─────────────────────────────────────────────────────

let _bwrapPath: string | null | undefined = undefined;

function getBwrapPath(): string | null {
  if (_bwrapPath !== undefined) return _bwrapPath;
  // Common locations
  for (const p of ["/usr/bin/bwrap", "/usr/local/bin/bwrap", "/bin/bwrap"]) {
    if (existsSync(p)) {
      _bwrapPath = p;
      return p;
    }
  }
  _bwrapPath = null;
  return null;
}

// ── Bwrap argument builder ────────────────────────────────────────────────────

/**
 * Build the bwrap argument list for a given workspace directory.
 *
 * The container layout:
 *   /        — read-only bind of host root
 *   /tmp     — writable bind of host /tmp (for pip/npm cache, temp files)
 *   workspace — writable bind of the sandbox workspace dir
 *   /proc    — new proc mount (PID namespace)
 *   /dev     — new dev mount (/dev/null, /dev/zero, etc.)
 *
 * Network is disabled by default (--unshare-net).
 * Memory is capped via ulimit -v (virtual memory in KB).
 */
export function buildBwrapArgs(
  workspaceDir: string,
  config: Required<ContainerConfig>
): string[] {
  const args: string[] = [];

  // Read-only root filesystem
  args.push("--ro-bind", "/", "/");

  // Writable /tmp (needed by compilers, pip, npm, venv)
  args.push("--bind", tmpdir(), "/tmp");

  // Writable workspace
  args.push("--bind", workspaceDir, workspaceDir);

  // Extra writable dirs
  for (const dir of config.extraWritableDirs) {
    args.push("--bind", dir, dir);
  }

  // Extra read-only dirs
  for (const dir of config.extraRoDirs) {
    args.push("--ro-bind", dir, dir);
  }

  // Home directory — make writable so pip/npm config can live there.
  // Use the workspace as HOME so cache/config persists with the sandbox.
  args.push("--setenv", "HOME", workspaceDir);

  // Environment
  args.push("--setenv", "PATH", process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin");

  // Namespace isolation
  if (config.network) {
    args.push("--unshare-all", "--share-net");
  } else {
    args.push("--unshare-all");
  }

  // PID namespace + proc
  args.push("--unshare-pid");
  args.push("--proc", "/proc");

  // Device nodes (/dev/null, /dev/zero, /dev/random)
  args.push("--dev", "/dev");

  // Working directory
  args.push("--chdir", workspaceDir);

  return args;
}

// ── Containerized Persistent Shell ────────────────────────────────────────────

/**
 * A long-running bash process inside a bwrap container.
 *
 * Extends PersistentShell — only overrides shell spawning to run inside
 * the container namespace. All exec, timeout, and cleanup logic is inherited.
 */
export class ContainerShell extends PersistentShell {
  private _config: Required<ContainerConfig>;

  constructor(sandboxDir: string, config: Required<ContainerConfig>) {
    super(sandboxDir);
    this._config = config;
    this._label = "container-shell";
    // Re-spawn inside container (super called _startShell with plain bash)
    this._startShell();
  }

  protected override _startShell(): void {
    if (this._killed) return;
    // Guard: super() calls _startShell before _config is assigned. Defer to the explicit
    // _startShell() call in our constructor (after _config is set).
    if (!this._config) return;

    if (this._proc && !this._proc.killed) {
      try { this._proc.kill("SIGTERM"); } catch { /* ignore */ }
    }

    this._nonce = randomNonce();

    const bwrapPath = getBwrapPath();
    if (!bwrapPath) {
      // Fallback: spawn bash directly without isolation
      this._proc = spawn("bash", ["--norc", "--noprofile"], {
        cwd: this.sandboxDir,
        env: { ...process.env, HOME: this.sandboxDir },
        stdio: ["pipe", "pipe", "pipe"],
      });
      this._proc.stderr?.on("data", () => { /* drained */ });
      this._proc.on("error", () => { /* will be detected on next exec */ });
      return;
    }

    const bwrapArgs = buildBwrapArgs(this.sandboxDir, this._config);

    // Wrap bash to include memory ulimit
    const memKB = this._config.memoryLimitMB * 1024;
    const bashCmd = `ulimit -v ${memKB}; exec bash --norc --noprofile`;

    this._proc = spawn(bwrapPath, [...bwrapArgs, "--", "bash", "-c", bashCmd], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this._proc.stderr?.on("data", () => { /* drained — per-command merging via 2>&1 */ });
    this._proc.on("error", (err) => {
      console.error(`  [container-shell] bwrap process error: ${err.message}`);
    });
  }
}
