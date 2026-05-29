export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  runtimeMs: number;
  timedOut: boolean;
}

/** Sentinel prefix for persistent shell command output demarcation. */
export const SENTINEL_PREFIX = "__CMD__";

/** Generate a short random nonce string for command sentinels. */
export function randomNonce(): string {
  return Math.random().toString(16).slice(2, 6);
}
