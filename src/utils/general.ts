import * as v from "valibot";
import type { PipelineResult } from "../core/types";

// ── Shared code/text extraction ───────────────────────────────────────────

const THINK_TAG_RE = /<think>[\s\S]*?<\/think>/gi;

/** Strip <｜end▁of▁thinking｜>think… response tags from LLM output */
export function stripThinkTags(text: string): string {
  return text.replace(THINK_TAG_RE, '').trim();
}

/** Extract code from raw LLM output: strip think tags, remove markdown fences */
export function extractCode(raw: string): string {
  let code = raw.trim();
  code = code.replace(THINK_TAG_RE, "").trim();
  code = code.replace(/^```(?:python|py|javascript|js|typescript|ts)?\s*\n?/i, "");
  code = code.replace(/\n?```\s*$/, "");
  return code.trim();
}

// ── Shared JS harness snippets ────────────────────────────────────────────

/** JS code for restoring Python Infinity sentinels in JSON output.
 *  Embedded in verification harnesses that bridge Python and Node.js. */
export const RESTORE_INF_JS = `\
function _restore_inf(obj) {
  if (obj === "__INF__") return Infinity;
  if (obj === "__NEG_INF__") return -Infinity;
  if (Array.isArray(obj)) return obj.map(_restore_inf);
  if (obj !== null && typeof obj === 'object') {
    var _out = {};
    for (var _k in obj) _out[_k] = _restore_inf(obj[_k]);
    return _out;
  }
  return obj;
}`;

// ── Shared domain helpers ───────────────────────────────────────────────────

/** Standard failed PipelineResult — used by domain harnesses. */
export function failPipeline(reason: string): PipelineResult {
	return {
		overallPassed: false,
		stages: [{ stageName: "Validation", passed: false, reason, runtimeMs: 0 }],
		finalMetrics: {},
	};
}

// ── Shared oracle output parsing ─────────────────────────────────────────────

/** A single parsed line from oracle test output. */
export interface ParsedOracleLine {
  passed: boolean;
  reason?: string;
}

/** Structured result from parsing oracle test output. */
export interface ParsedOracleOutput {
  /** Passing test results with reasons */
  passing: ParsedOracleLine[];
  /** Failing test results with reasons */
  failing: ParsedOracleLine[];
  /** Debug lines (FAIL input=... expected=... got=... — non-JSON failure details) */
  debugLines: string[];
  /** Total pass count */
  passCount: number;
  /** Total fail count */
  failCount: number;
}

/**
 * Parse oracle test output lines into structured pass/fail/debug data.
 * Used by task-agent (for guidance) and inspector (for repair context).
 *
 * Oracle format:
 *   {"passed": true, "reason": "fibonacci(10) = 55"}
 *   {"passed": false, "reason": "fibonacci(0) = 1, expected 0"}
 *   FAIL test_edge: input=... expected=... got=...      (non-JSON debug line)
 */
export function parseOracleOutput(output: string): ParsedOracleOutput {
  const passing: ParsedOracleLine[] = [];
  const failing: ParsedOracleLine[] = [];
  const debugLines: string[] = [];

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Non-JSON failure debug lines (printed before or alongside JSON failures)
    if (trimmed.startsWith("FAIL ") && trimmed.includes("input=")) {
      debugLines.push(trimmed);
      continue;
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.passed === true) {
        passing.push({ passed: true, reason: parsed.reason });
      } else if (parsed.passed === false) {
        failing.push({ passed: false, reason: parsed.reason || "unknown" });
      }
    } catch { /* skip non-JSON lines */ }
  }

  return {
    passing,
    failing,
    debugLines,
    passCount: passing.length,
    failCount: failing.length + debugLines.length,
  };
}

// ── Shared Python runner template ──────────────────────────────────────────

/**
 * Wrap Python source code (a stub or solution defining proposedSolution) in a
 * full runner script that reads JSON args from stdin and prints the JSON-safe
 * result to stdout. Used by oracle harnesses in main.ts and auto-detect.ts.
 */
export function pythonRunnerSource(stubOrSolution: string): string {
  return [
    `import sys, json, math`,
    stubOrSolution,
    ``,
    `def _json_safe(v):`,
    `    if isinstance(v, dict): return {k: _json_safe(x) for k,x in v.items()}`,
    `    if isinstance(v, (list, tuple)): return [_json_safe(x) for x in v]`,
    `    if isinstance(v, float) and math.isinf(v): return "__INF__" if v > 0 else "__NEG_INF__"`,
    `    if isinstance(v, float) and math.isnan(v): return None`,
    `    return v`,
    `_args = json.loads(sys.stdin.read() or "[]")`,
    `_result = proposedSolution(*_args)`,
    `print(json.dumps(_json_safe(_result)))`,
  ].join("\n");
}

// ── JSON escape normalization ──────────────────────────────────────────────

/**
 * Normalize literal escape sequences that jsonrepair/LLM may introduce
 * in JSON string values. Converts literal \n → actual newline, etc.
 */
export function normalizeEscapes(s: string): string {
  return s.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\'/g, "'");
}

// ── Semaphore ─────────────────────────────────────────────────────────────

export class ThrottledSemaphore {
	private concurrency: number;
	private running = 0;
	private queue: Array<() => void> = [];

	constructor(concurrency: number) {
		this.concurrency = concurrency;
	}

	async acquire(): Promise<void> {
		if (this.running < this.concurrency) {
			this.running++;
			return;
		}
		await new Promise<void>((resolve) => this.queue.push(resolve));
		this.running++;
	}

	release(): void {
		this.running--;
		const next = this.queue.shift();
		if (next) next();
	}
}

/**
 * Strip TypeScript type annotations using Bun's built-in transpiler.
 * Falls back to the original source if transpilation fails (plain JS passes through unchanged).
 */
export function transpileToJs(source: string): string {
	try {
		const transpiler = new Bun.Transpiler({ loader: "ts" });
		return transpiler.transformSync(source);
	} catch {
		return source;
	}
}

export function valibotParse<T extends v.GenericSchema>(schema: T, input: unknown): v.InferOutput<T> {
	const result = v.safeParse(schema, input);
	if (result.success) return result.output;

	// Clean, readable error — valibot issues blobs are huge
	const issues = result.issues.map((issue: any) => {
		const path = issue.path?.map((p: any) => p.key ?? p.item ?? p).join(".") || "<root>";
		const msg = issue.message ?? "unknown error";
		const expected = issue.expected ?? issue.type ?? "?";
		const received = typeof issue.received === "string" ? issue.received.slice(0, 40) : typeof issue.received;
		return `  ${path}: ${msg} (expected ${expected}, got ${String(received)})`;
	});
	throw new Error(`Valibot (${result.issues.length} issue${result.issues.length > 1 ? "s" : ""}):\n${issues.join("\n")}`);
}