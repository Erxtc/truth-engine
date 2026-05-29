/**
 * Custom oracle runner — executes a JS oracle `verify(fn)` against a proposed
 * solution (Python or JS), bridging Python solutions via `buildPythonOracleHarness`.
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { normalizeEscapes, transpileToJs } from "../utils/general";
import { validateAndFixPython, validateAndFixJs } from "../utils/code-validator";
import { buildPythonOracleHarness } from "./oracle-hardener";
import type { Proposal } from "../core/types";
import type { Artifact } from "../db/schema";

export function runCustomOracle(
	oracleJs: string,
	proposal: Proposal,
	artifact: Artifact,
	domainName: string
) {
	const { overallPassed, stages, finalMetrics } = (() => {
		const rawSource = artifact.sourceCode ?? (proposal.executable.type === "code" ? proposal.executable.source : null);
		const sourceCode = rawSource
			? normalizeEscapes(rawSource)
			: null;
		if (!sourceCode) {
			return {
				overallPassed: false,
				stages: [{ stageName: "CustomOracle", passed: false, reason: "No source code in artifact", runtimeMs: 0 }],
				finalMetrics: {},
			};
		}

		const lang = proposal.executable.type === "code" ? proposal.executable.lang : "js";
		const isPython = lang === "python";
		const start = Date.now();
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `truth-custom-${domainName}-`));

		try {
			let verifyHarness: string;

			if (isPython) {
				const rawNorm = normalizeEscapes(sourceCode);

				// Run pre-execution validator: auto-fix common 7B model issues
				const validation = validateAndFixPython(rawNorm);
				if (!validation.ok) {
					return {
						overallPassed: false,
						stages: [{ stageName: "CustomOracle", passed: false, reason: validation.error ?? "Syntax error", runtimeMs: Date.now() - start }],
						finalMetrics: {},
					};
				}
				if (validation.autoFixed) {
					console.log(`  [validator] Auto-fixed Python source before execution`);
				}
				const normalizedSource = validation.source;
				const pyFile = path.join(tmpDir, "solution.py");
				const pyWrapper = `import sys, json, math\n${normalizedSource}\n\ndef _auto_int_keys(obj):\n    """JSON serializes integer keys as strings. Convert numeric string keys back to ints\n    so the model's solution (written expecting Python int keys) works correctly."""\n    if isinstance(obj, dict):\n        result = {}\n        for k, v in obj.items():\n            if isinstance(k, str) and (k.isdigit() or (k.startswith('-') and k[1:].isdigit())):\n                k = int(k)\n            result[k] = _auto_int_keys(v)\n        return result\n    if isinstance(obj, list):\n        return [_auto_int_keys(x) for x in obj]\n    return obj\n\ndef _json_safe(v):\n    if isinstance(v, dict):\n        return {k: _json_safe(v) for k, v in v.items()}\n    if isinstance(v, (list, tuple)):\n        return [_json_safe(x) for x in v]\n    if isinstance(v, float) and math.isinf(v):\n        return \"__INF__\" if v > 0 else \"__NEG_INF__\"\n    if isinstance(v, float) and math.isnan(v):\n        return None\n    return v\n\n_args = _auto_int_keys(json.loads(sys.stdin.read() or \"[]\"))\n_result = proposedSolution(*_args)\n# Preserve None as null — functions that legitimately return None (e.g. cycle detection)\n# must not have their return value replaced with a positional argument.\nprint(json.dumps(_json_safe(_result)))`;
				fs.writeFileSync(pyFile, pyWrapper);
				const pyFileSafe = JSON.stringify(pyFile);
				verifyHarness = buildPythonOracleHarness({
					pyFileSafe, oracleJs,
					timeout: 10_000,
					diagnostic: true,
				});
			} else {
				// JS: validate syntax before running
				const jsValidation = validateAndFixJs(transpileToJs(sourceCode));
				if (!jsValidation.ok) {
					return {
						overallPassed: false,
						stages: [{ stageName: "CustomOracle", passed: false, reason: jsValidation.error ?? "JS syntax error", runtimeMs: Date.now() - start }],
						finalMetrics: {},
					};
				}
				// JS: pass the actual function to verify(fn) so oracle can call fn(input)
				verifyHarness = `
${jsValidation.source}

var __fn = typeof proposedSolution !== 'undefined' ? proposedSolution
         : typeof solution !== 'undefined' ? solution
         : typeof main !== 'undefined' ? main
         : null;
if (!__fn) throw new Error('No exported function found');
${oracleJs}
var __result = verify(__fn);
process.stdout.write(JSON.stringify(__result));
`.trim();
			}

			const verifyFile = path.join(tmpDir, "verify.js");
			fs.writeFileSync(verifyFile, verifyHarness);
			const raw = execSync(`node ${verifyFile}`, { timeout: 10_000, stdio: "pipe" }).toString().trim();
			const r = JSON.parse(raw) as { passed: boolean; reason: string; _diag?: { returned: string; input: string } };

			if (r.passed) {
				console.log(`  [oracle] Passed: ${r.reason}`);
			} else {
				const diagInfo = r._diag ? ` (returned: ${r._diag.returned.slice(0, 100)})` : "";
				console.log(`  [oracle] Failed: ${r.reason}${diagInfo}`);
			}

			// Build enriched failures list with diagnostic context
			const failuresList: string[] = r.passed ? [] : [r.reason];
			if (!r.passed && r._diag) {
				failuresList.push(`returned: ${r._diag.returned}`);
				if (r._diag.input) failuresList.push(`input: ${r._diag.input}`);
			}

			return {
				overallPassed: r.passed,
				stages: [{
					stageName: "CustomOracle",
					passed: r.passed,
					reason: r.passed ? undefined : r.reason,
					artifacts: {
						...(r.passed ? { computed_output: r.reason } : {}),
						oracle_full_output: raw,
						failures: failuresList,
						passed_count: r.passed ? 1 : 0,
						failed_count: r.passed ? failuresList.length - (r._diag ? 2 : 0) : 1,
						oracle_source: oracleJs,
					},
					runtimeMs: Date.now() - start,
				}],
				finalMetrics: {},
			};
		} catch (err: any) {
			const errMsg = err.stderr?.toString().slice(0, 600) ?? err.message ?? String(err);
			return {
				overallPassed: false,
				stages: [{ stageName: "CustomOracle", passed: false, reason: `Oracle error: ${errMsg}`, runtimeMs: Date.now() - start }],
				finalMetrics: {},
			};
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	})();

	return { overallPassed, stages, finalMetrics };
}
