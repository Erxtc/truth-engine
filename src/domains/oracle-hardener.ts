/**
 * Oracle hardening — deterministic verification that generated oracles reject
 * broken stubs (return-none, return-zero, return-empty, etc.).
 *
 * Zero LLM cost. Called during oracle generation to catch weak oracles before
 * they silently accept wrong answers.
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { RESTORE_INF_JS, pythonRunnerSource } from "../utils/general";

// ── Seeded PRNG (mulberry32) — deterministic fuzz phase ─────────────────────

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const fuzzRand = mulberry32(42);

// ── Shared JS harness builder (Python bridge) ──────────────────────────────

/** Build a Node.js harness that bridges a Python solution to a JS oracle.
 *  The harness spawns `python3` via execFileSync, pipes JSON args on stdin,
 *  and passes the restored result to `verify(__fn)`.
 *
 *  Used by oracle hardening (simple) and custom oracle execution (diagnostic mode). */
export function buildPythonOracleHarness(opts: {
  pyFileSafe: string;
  oracleJs: string;
  timeout?: number;
  /** Capture Python errors + result for augmented failure diagnostics. */
  diagnostic?: boolean;
  /** Also test with single-argument wrapper (for fuzz hardening). */
  singleArgVariant?: boolean;
  /** Extra require() lines (e.g. "var fs = require('fs');"). */
  extraRequires?: string;
}): string {
  const timeout = opts.timeout ?? 5000;
  const extra = opts.extraRequires ? opts.extraRequires + "\n" : "";

  const fnBody = opts.diagnostic
    ? `var _args = Array.prototype.slice.call(arguments);
  var _raw;
  try {
    _raw = execFileSync('python3', [${opts.pyFileSafe}], { input: JSON.stringify(_args), timeout: ${timeout} }).toString().trim();
  } catch (_e) {
    __lastPyError = (_e.stderr ? _e.stderr.toString() : _e.message || 'crash').split('\\n').filter(function(l){return l.trim();}).slice(-3).join(' | ');
    throw new Error('py-crash: ' + __lastPyError);
  }
  if (!_raw) { __lastPyError = 'empty output from python'; throw new Error('py-empty'); }
  var _result;
  try { _result = _restore_inf(JSON.parse(_raw)); } catch(_e2) { __lastPyError = 'bad json: ' + _raw.slice(0,80); throw new Error('py-json'); }
  __lastPyResult = _result;
  __lastPyArgs = _args.slice();`
    : `var _args = Array.prototype.slice.call(arguments);
  var _raw = execFileSync('python3', [${opts.pyFileSafe}], { input: JSON.stringify(_args), timeout: ${timeout} }).toString().trim();
  if (!_raw) throw new Error('empty');
  return _restore_inf(JSON.parse(_raw));`;

  const mutationMirror = opts.diagnostic
    ? `
  // Mirror Python in-place mutations back to the JS caller's array/object.
  if (_result !== null && typeof _result === 'object' && _args.length > 0 && typeof _args[0] === 'object') {
    var _a0 = _args[0];
    if (Array.isArray(_result) && Array.isArray(_a0)) {
      for (var _i = 0; _i < _result.length; _i++) {
        if (Array.isArray(_result[_i]) && Array.isArray(_a0[_i])) {
          for (var _j = 0; _j < _result[_i].length; _j++) { _a0[_i][_j] = _result[_i][_j]; }
        } else { _a0[_i] = _result[_i]; }
      }
    }
  }
  return _result;`
    : "";

  const diagVars = opts.diagnostic
    ? `var __lastPyError = null;
var __lastPyResult = null;
var __lastPyArgs = null;
`
    : "";

  const verifyCatch = opts.diagnostic
    ? `try {
  __result = verify(__fn);
} catch (_verifyErr) {
  __result = { passed: false, reason: __lastPyError ? __lastPyError.slice(0, 200) : (_verifyErr.message || 'verify-threw').slice(0, 200) };
}`
    : `try { __result = verify(__fn); } catch(_e) { __result = { passed: false, reason: _e.message || 'crash' }; }`;

  const singleArgBlock = opts.singleArgVariant
    ? `
// Also run with single-arg style (wrap in list)
try {
  var __result2 = verify(function(x) { return __fn(x); });
} catch(_e2) { /* optional */ }`
    : "";

  const diagAugment = opts.diagnostic
    ? `
// Augment failure with Python diagnostic: what was actually returned vs what was expected
if (__result && !__result.passed && __lastPyResult !== null) {
  __result._diag = {
    returned: typeof __lastPyResult === 'string' ? __lastPyResult.slice(0, 400) : JSON.stringify(__lastPyResult).slice(0, 400),
    input: __lastPyArgs ? JSON.stringify(__lastPyArgs).slice(0, 200) : null
  };
}`
    : "";

  return `var { execFileSync } = require('child_process');
${extra}${RESTORE_INF_JS}
${diagVars}var __fn = function() {
  ${fnBody}${mutationMirror}
};
${opts.oracleJs}
var __result;
${verifyCatch}${singleArgBlock}${diagAugment}
process.stdout.write(JSON.stringify(__result));`;
}

// ── Oracle hardening ──────────────────────────────────────────────────────────

/** Run the oracle against broken Python stubs and verify each returns passed=false.
 *  Catches oracles that are too lenient and would silently accept wrong answers.
 *  Deterministic, zero LLM cost. */
export function hardenOracle(oracleJs: string): { ok: boolean; error?: string } {
	const BROKEN_STUBS = [
		{ name: "return-none", source: "def proposedSolution(*args):\n    return None\n" },
		{ name: "return-zero", source: "def proposedSolution(*args):\n    return 0\n" },
		{ name: "return-empty", source: "def proposedSolution(*args):\n    return []\n" },
		// More sophisticated wrong answers — catch oracles that only check surface-level output
		{ name: "return-first-arg", source: "def proposedSolution(*args):\n    return args[0] if args else None\n" },
		{ name: "return-negated", source: "def proposedSolution(*args):\n    x = args[0] if args else 0; return -x if isinstance(x, (int, float)) else x\n" },
		{ name: "return-wrong-type", source: "def proposedSolution(*args):\n    return str(args)\n" },
		// Near-miss: returns a value 1% off the first arg — catches loose floating-point tolerances
		{ name: "return-near-miss", source: "def proposedSolution(*args):\n    x = args[0] if args else 0; return x * 1.01 if isinstance(x, (int, float)) else x\n" },
	];

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "truth-harden-"));

	function runOracle(stubSource: string): { passed: boolean; reason: string } | null {
		const pyWrapper = pythonRunnerSource(stubSource);
		fs.writeFileSync(path.join(tmpDir, "solution.py"), pyWrapper);

		const pyFileSafe = JSON.stringify(path.join(tmpDir, "solution.py"));
		const harness = buildPythonOracleHarness({ pyFileSafe, oracleJs });
		fs.writeFileSync(path.join(tmpDir, "verify.js"), harness);

		try {
			const raw = execSync("node verify.js", {
				cwd: tmpDir,
				timeout: 10_000,
				stdio: "pipe",
			}).toString().trim();
			return JSON.parse(raw) as { passed: boolean; reason: string };
		} catch (err: any) {
			const msg = (err.stderr?.toString() ?? err.message ?? String(err)).toLowerCase();
			if (msg.includes('"passed":true') || msg.includes('"passed": true')) {
				return { passed: true, reason: "crash-but-passed" };
			}
			// Crash = rejected = acceptable
			return null;
		}
	}

	try {
		for (const stub of BROKEN_STUBS) {
			const r = runOracle(stub.source);
			if (r?.passed) {
				return { ok: false, error: `Oracle passed broken "${stub.name}" stub — oracle too weak` };
			}
		}

		// ── Fuzz phase: run oracle with random inputs against a trivial function ──
		// This catches oracles that crash or produce malformed output when given
		// varied input sizes/types — they pass broken stubs but can't handle real data.
		const fuzzResults: Array<{ passed: boolean }> = [];
		for (let i = 0; i < 10; i++) {
			// Random inputs: different array sizes and value ranges
			const len = 1 + Math.floor(fuzzRand() * 20);
			const arr = Array.from({ length: len }, () => Math.floor(fuzzRand() * 1000) - 500);
			const stubWithInput = `def proposedSolution(*args):\n    return sum(args) if args else 0\n`;
			const pyWrapper = pythonRunnerSource(stubWithInput);
			fs.writeFileSync(path.join(tmpDir, "solution.py"), pyWrapper);
			fs.writeFileSync(path.join(tmpDir, "input.json"), JSON.stringify(arr));

			const pyFileSafe = JSON.stringify(path.join(tmpDir, "solution.py"));
			const harness = buildPythonOracleHarness({
				pyFileSafe, oracleJs,
				extraRequires: "var fs = require('fs');",
				singleArgVariant: true,
			});
			fs.writeFileSync(path.join(tmpDir, "verify.js"), harness);

			try {
				const raw = execSync("node verify.js", {
					cwd: tmpDir,
					timeout: 10_000,
					stdio: "pipe",
				}).toString().trim();
				const r = JSON.parse(raw) as { passed: boolean; reason: string };
				fuzzResults.push(r);
			} catch (err: any) {
				// Oracle crashed on a valid function with real inputs — it's buggy
				return { ok: false, error: `Oracle crashed during fuzz phase with valid inputs — likely a bug in the oracle that would crash during normal use. Error: ${(err.stderr?.toString() ?? err.message ?? String(err)).slice(0, 120)}` };
			}
		}

		return { ok: true };
	} catch (err: any) {
		return { ok: false, error: `Hardening error: ${err.message?.slice(0, 100)}` };
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}
