import * as v from "valibot";
import { createHash } from "crypto";
import type { PipelineResult } from "../core/types";

// ── Shared code/text extraction ───────────────────────────────────────────

const THINK_TAG_RE = /<think>[\s\S]*?<\/think>/gi;

/** Strip <｜end▁of▁thinking｜>think… response tags from LLM output */
export function stripThinkTags(text: string): string {
  return text.replace(THINK_TAG_RE, '').trim();
}

/** Content-addressable SHA-256 hex hash. Default 16 chars for compact IDs. */
export function sha256(input: string, len = 16): string {
  return createHash("sha256").update(input).digest("hex").slice(0, len);
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
 *
 * Options:
 *   autoIntKeys — inject _auto_int_keys to convert JSON-stringified int dict
 *                 keys back to Python ints (needed when the model expects int
 *                 keys but JSON serializes them as strings).
 */
export function pythonRunnerSource(stubOrSolution: string, opts?: { autoIntKeys?: boolean }): string {
  const autoIntKeys = opts?.autoIntKeys;

  return [
    `import sys, json, math`,
    stubOrSolution,
    ``,
    autoIntKeys ? [
      `def _auto_int_keys(obj):`,
      `    """JSON serializes integer keys as strings. Convert numeric string keys back to ints."""`,
      `    if isinstance(obj, dict):`,
      `        result = {}`,
      `        for k, v in obj.items():`,
      `            if isinstance(k, str) and (k.isdigit() or (k.startswith('-') and k[1:].isdigit())):`,
      `                k = int(k)`,
      `            result[k] = _auto_int_keys(v)`,
      `        return result`,
      `    if isinstance(obj, list):`,
      `        return [_auto_int_keys(x) for x in obj]`,
      `    return obj`,
      ``,
    ].join("\n") : null,
    `def _json_safe(v):`,
    `    if isinstance(v, dict): return {k: _json_safe(x) for k,x in v.items()}`,
    `    if isinstance(v, (list, tuple)): return [_json_safe(x) for x in v]`,
    `    if isinstance(v, float) and math.isinf(v): return "__INF__" if v > 0 else "__NEG_INF__"`,
    `    if isinstance(v, float) and math.isnan(v): return None`,
    `    if hasattr(v, "__dict__"): return _json_safe(v.__dict__)`,
    `    return v`,
    autoIntKeys
      ? `# Preserve None as null — functions that legitimately return None (e.g. cycle detection)\n# must not have their return value replaced with a positional argument.`
      : null,
    autoIntKeys
      ? `_args = _auto_int_keys(json.loads(sys.stdin.read() or "[]"))`
      : `_args = json.loads(sys.stdin.read() or "[]")`,
    `_result = proposedSolution(*_args)`,
    `_safe = _json_safe(_result)`,
    `try:`,
    `    print(json.dumps(_safe))`,
    `except (TypeError, ValueError) as _je:`,
    `    print(json.dumps({"_type_error": "proposedSolution() returned a non-JSON-serializable value. Return plain data types only: list, dict, int, float, str, bool, None. Got: " + type(_result).__name__, "_raw_repr": repr(_result)[:500]}))`,
  ].filter(x => x !== null).join("\n");
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