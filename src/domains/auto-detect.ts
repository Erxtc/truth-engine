/**
 * Auto-domain detector.
 *
 * Given a natural language problem statement, either:
 *   (a) maps to a registered domain if the problem clearly fits one, or
 *   (b) generates a custom DomainSpec with LLM-derived invariants and a
 *       JavaScript oracle function that verifies proposed solutions.
 *
 * The generated oracle is a JS function `verify(output, input)` that returns
 * `{ passed: boolean, reason: string }`. It gets compiled and sandboxed at
 * runtime (same node-based harness as other domains).
 */

import * as v from "valibot";
import { queryReasoning } from "../llm";
import { getDomainSpec, listDomains, registerDomain } from "../executors/domains";
import type { DomainSpec } from "../executors/domains/registry";
import type { Proposal, WorkingContext } from "../core/types";
import type { Artifact } from "../db/schema";
import { transpileToJs } from "../utils/general";
import { validateAndFixPython, validateAndFixJs } from "../utils/code-validator";
import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ── Schema for the LLM's domain classification response ──────────────────────

const classifySchema = v.object({
	matched_domain: v.nullable(v.string()),
	confidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
	reasoning: v.string(),
});

const customDomainSchema = v.object({
	domain_name: v.string(),
	invariants: v.pipe(v.array(v.string()), v.minLength(1), v.maxLength(8)),
	required_confidence: v.pipe(v.number(), v.minValue(1), v.maxValue(4)),
	oracle_js: v.string(),
	solution_format: v.string(),
});

// ── Domain classification ─────────────────────────────────────────────────────

async function classifyDomain(problem: string, _registered: string[]): Promise<{ matched: string | null; confidence: number }> {
	const prompt = `
You are a domain classifier for an automated problem-solving system.

Problem statement:
${problem}

Does this problem clearly fit one of these SPECIFIC domains?
- "sorting": ONLY if the problem literally says "implement merge sort", "implement quicksort", "implement bubble sort", etc. — the word "sort" must describe what to BUILD, not how to solve it.
- "compression": the ONLY goal is lossless data compression/decompression
- "math": a formal mathematical PROOF in Lean4 or Coq — NOT arithmetic, NOT code
- "project": a multi-file software project with build/test commands

ALWAYS RETURN null FOR (no matter how high your confidence):
- "find the kth largest" → null (uses sorting internally, not a sorting problem)
- "topological sort" → null (graph algorithm, not a sorting algorithm)
- "group/count/frequency" → null
- Any function that computes a single answer value
- Any function involving primes, fibonacci, parentheses, arrays, strings, graphs, DP, cycles, paths
- Arithmetic ("what is X*Y") → null
- Any problem that USES sorting as a technique but isn't IMPLEMENTING a sort algorithm
- "detect cycle", "find path", "count islands", "shortest path" → null (graph problems)

Only return a domain if you are HIGHLY confident (>= 0.8) it fits exactly.
If in doubt, return null — a custom domain will be generated.

Return ONLY valid JSON:
{ "matched_domain": "sorting" | "compression" | "math" | "project" | null, "confidence": 0.0-1.0, "reasoning": "brief explanation" }
`.trim();

	try {
		const result = await queryReasoning({ userPrompt: prompt, schema: classifySchema, temperature: 0.1 });
		return { matched: result.response.matched_domain, confidence: result.response.confidence };
	} catch {
		return { matched: null, confidence: 0 };
	}
}

// ── Custom domain generation ──────────────────────────────────────────────────

// Build oracle examples as plain objects so JSON.stringify handles all escaping.
function buildOracleExamples(): string {
	const examples = [
		{
			domain_name: "arithmetic",
			invariants: ["Result must be the mathematical product", "Function must return a number"],
			required_confidence: 2,
			oracle_js: "function verify(fn) { var out = fn(); var exp = 15 * 17; if (out === exp) return { passed: true, reason: \"correct\" }; return { passed: false, reason: \"wrong-answer\" }; }",
			solution_format: "A function proposedSolution() that returns 255 (the product of 15 and 17)",
		},
		{
			domain_name: "prime_check",
			invariants: ["Returns boolean", "True for primes, false otherwise", "Handles edge cases 0 and 1"],
			required_confidence: 2,
			oracle_js: "function verify(fn) { if (fn(17) !== true) return { passed: false, reason: \"17-not-prime\" }; if (fn(15) !== false) return { passed: false, reason: \"15-is-prime\" }; if (fn(1) !== false) return { passed: false, reason: \"1-is-prime\" }; if (fn(2) !== true) return { passed: false, reason: \"2-not-prime\" }; return { passed: true, reason: \"ok\" }; }",
			solution_format: "A function proposedSolution(n) that returns true if n is prime, false otherwise",
		},
		{
			domain_name: "fibonacci",
			invariants: ["Returns number", "Base cases: fib(0)=0, fib(1)=1"],
			required_confidence: 2,
			oracle_js: "function verify(fn) { if (fn(0) !== 0) return { passed: false, reason: \"fib0-fail\" }; if (fn(1) !== 1) return { passed: false, reason: \"fib1-fail\" }; if (fn(10) !== 55) return { passed: false, reason: \"fib10-fail\" }; return { passed: true, reason: \"ok\" }; }",
			solution_format: "A function proposedSolution(n) that returns the nth Fibonacci number",
		},
		{
			domain_name: "generate_parentheses",
			invariants: ["Returns list of strings", "Each string has correct length 2*n", "Each string is balanced", "Count matches Catalan number"],
			required_confidence: 2,
			// For list-return problems: check count, then check each item is valid — never hardcode the full expected list.
			// A valid n-pair parentheses string: length == 2n, balanced (no prefix has more ')' than '(').
			oracle_js: "function verify(fn) { function isValid(s) { var d = 0; for (var i = 0; i < s.length; i++) { d += s[i] === '(' ? 1 : -1; if (d < 0) return false; } return d === 0; } var r1 = fn(1); if (!Array.isArray(r1) || r1.length !== 1) return { passed: false, reason: \"n1-count\" }; if (!isValid(r1[0])) return { passed: false, reason: \"n1-invalid\" }; var r2 = fn(2); if (!Array.isArray(r2) || r2.length !== 2) return { passed: false, reason: \"n2-count\" }; for (var i = 0; i < r2.length; i++) { if (!isValid(r2[i]) || r2[i].length !== 4) return { passed: false, reason: \"n2-invalid\" }; } var r3 = fn(3); if (!Array.isArray(r3) || r3.length !== 5) return { passed: false, reason: \"n3-count\" }; for (var i = 0; i < r3.length; i++) { if (!isValid(r3[i]) || r3[i].length !== 6) return { passed: false, reason: \"n3-invalid\" }; } return { passed: true, reason: \"ok\" }; }",
			solution_format: "A function proposedSolution(n) that returns a list of all valid combinations of n pairs of parentheses",
		},
		{
			domain_name: "prime_factors",
			invariants: ["Returns sorted list of prime factors with repetition", "12 = [2,2,3], 18 = [2,3,3], 7 = [7]"],
			required_confidence: 2,
			// Count each expected factor individually — NEVER use sum or length only.
			// Sort output before comparing so order doesn't matter.
			oracle_js: "function verify(fn) { function check(n, exp) { var got = fn(n).slice().sort(function(a,b){return a-b;}); if (got.length !== exp.length) return \"len-\" + n; for (var i=0;i<exp.length;i++) { if (got[i] !== exp[i]) return \"val-\" + n; } return null; } var e12=check(12,[2,2,3]); if(e12) return {passed:false,reason:e12}; var e18=check(18,[2,3,3]); if(e18) return {passed:false,reason:e18}; var e7=check(7,[7]); if(e7) return {passed:false,reason:e7}; var e1=check(1,[]); if(e1) return {passed:false,reason:e1}; return {passed:true,reason:\"ok\"}; }",
			solution_format: "A function proposedSolution(n) that returns a sorted list of prime factors of n (with repetition)",
		},
		{
			domain_name: "word_frequency",
			invariants: ["Returns dict/object mapping each word to its count", "Case-insensitive", "Punctuation stripped"],
			required_confidence: 2,
			// Check each key individually — NEVER sum totals or aggregate.
			oracle_js: "function verify(fn) { var r = fn(\"the cat sat on the mat\"); if (typeof r !== 'object' || r === null) return {passed:false,reason:\"not-object\"}; if (r[\"the\"] !== 2) return {passed:false,reason:\"the-count\"}; if (r[\"cat\"] !== 1) return {passed:false,reason:\"cat-count\"}; if (r[\"sat\"] !== 1) return {passed:false,reason:\"sat-count\"}; if (r[\"mat\"] !== 1) return {passed:false,reason:\"mat-count\"}; var r2 = fn(\"hello world hello\"); if (r2[\"hello\"] !== 2) return {passed:false,reason:\"hello-count\"}; if (r2[\"world\"] !== 1) return {passed:false,reason:\"world-count\"}; return {passed:true,reason:\"ok\"}; }",
			solution_format: "A function proposedSolution(s) that returns a dict mapping each word to its frequency count",
		},
	];
	return examples.map(e => JSON.stringify(e, null, 2)).join("\n\n");
}

// Replace non-JSON-serializable JS literals so oracle comparisons don't blow up.
// Infinity → 1e308, -Infinity → -1e308, NaN → null (all JSON-safe and distinct enough for oracle checks).
function sanitizeOracleJs(js: string): string {
	return js
		.replace(/\bInfinity\b/g, "1e308")
		.replace(/-1e308/g, "-1e308")  // already fine, leave as is
		.replace(/\bNaN\b/g, "null")
		.replace(/\bundefined\b/g, "null");
}

async function generateCustomDomain(problem: string): Promise<DomainSpec | null> {
	const examples = buildOracleExamples();
	const prompt = `
You are designing a verification system for an automated problem-solving engine.

Problem:
${problem}

Your task: design a domain spec that can verify proposed solutions to this problem.

CRITICAL — oracle design rules:
  1. oracle_js is a JavaScript function verify(fn) where fn is the proposed solution function.
  2. Call fn ONLY with inputs explicitly given in the problem statement. Do NOT invent test inputs.
  3. Copy expected values VERBATIM from the problem statement — NEVER compute or re-derive them yourself.
     If problem says "f(12)=[2,2,3]", write: var exp=[2,2,3]; (3 elements, copied exactly as stated)
  4. For lists that could come in any order: sort both before comparing. Example:
     var got=fn(n).slice().sort(); var exp=[2,2,3]; if(JSON.stringify(got)!==JSON.stringify(exp)) return {passed:false,reason:"fail"};
  5. For dict/object returns: check each expected key individually, no aggregate sum checks.
  6. For equations: verify by substituting into the equations.
  7. reason strings: SHORT HYPHENATED WORDS only, no concatenation. Examples: "wrong", "f12-fail", "ok".
  8. NO sum/total/aggregate checks — they cause false negatives. Only check the values stated in the problem.
  9. PRESERVE input formats EXACTLY as shown in the problem. If the problem says graph[u] = [(v,w), ...] (list of pairs),
     use arrays-of-arrays in JS: {"A": [["B",1],["C",4]], "D": []} — NEVER convert to {v: w} dict-of-dicts.
     The solver will receive the EXACT structure you pass to fn(), so it must match what the problem describes.
 10. For graph/tree inputs: include ALL nodes as keys (with [] or {} for terminal nodes with no outgoing edges).
 11. CRITICAL for in-place mutation: the solution runs in a subprocess — it CANNOT mutate JS variables.
     ALWAYS capture the return value and check it: var r = fn(x); if (r[0][0] !== 7) ...
     NEVER check the original variable after calling fn: fn(m1); if (m1[0][0] ... // WRONG — m1 is unchanged
     The harness returns the first argument when the function returns null/None, so in-place mutations are visible via the return value.

Fields:
  domain_name: short snake_case identifier
  invariants: 2-6 properties every valid solution must satisfy
  required_confidence: 2 (use 3 only if independent agreement is needed)
  oracle_js: JavaScript function verify(fn) → { passed: boolean, reason: string }
  solution_format: one sentence describing expected function signature and return value

EXAMPLES (copy this exact JSON structure):
${examples}

Return ONLY valid JSON matching the structure above.`.trim();

	// Try up to 3 times. On failure, include the error and demand a simpler oracle.
	let lastError: unknown;
	for (let attempt = 0; attempt < 3; attempt++) {
		const retryHint = attempt === 0 ? "" : `

PREVIOUS ATTEMPT FAILED: ${lastError instanceof Error ? lastError.message.slice(0, 200) : String(lastError)}
COMMON CAUSE: unescaped double quotes in oracle_js reason strings, or string concatenation in reasons.
FIX: Use ONLY simple one-word reasons. No "+" concatenation. No variable interpolation.
GOOD: reason: "fail"   BAD: reason: "test-" + i + "-fail"`;

		const fullPrompt = prompt + retryHint;
		try {
			const result = await queryReasoning({ userPrompt: fullPrompt, schema: customDomainSchema, temperature: attempt === 0 ? 0.2 : 0.1 });
			const r = result.response;
			const oracleJs = sanitizeOracleJs(transpileToJs(r.oracle_js));

			const spec: DomainSpec = {
				name: r.domain_name,
				invariants: r.invariants,
				requiredConfidence: r.required_confidence as 1 | 2 | 3 | 4,
				solutionFormat: r.solution_format,
				async run(proposal: Proposal, _ctx: WorkingContext, artifact: Artifact) {
					return runCustomOracle(oracleJs, proposal, artifact, r.domain_name);
				},
			};

			registerDomain(spec);
			if (attempt > 0) console.log(`[auto-detect] Domain generation succeeded on attempt ${attempt + 1}`);
			console.log(`[auto-detect] Registered custom domain: "${r.domain_name}"`);
			console.log(`  Invariants: ${r.invariants.length}`);
			console.log(`  Required confidence: ${r.required_confidence}`);
			console.log(`  Solution format: ${r.solution_format}`);
			return spec;
		} catch (err) {
			lastError = err;
			console.warn(`[auto-detect] Domain generation attempt ${attempt + 1} failed: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
		}
	}

	console.error("[auto-detect] All domain generation attempts failed");
	return null;
}

// ── Custom oracle runner ──────────────────────────────────────────────────────

function runCustomOracle(
	oracleJs: string,
	proposal: Proposal,
	artifact: Artifact,
	domainName: string
) {
	const { overallPassed, stages, finalMetrics } = (() => {
		const rawSource = artifact.sourceCode ?? (proposal.executable.type === "code" ? proposal.executable.source : null);
		const sourceCode = rawSource
			? rawSource.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\'/g, "'")
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
			// ── Verify with oracle — pass the function (or a thunk for Python) ──
			let verifyHarness: string;

			if (isPython) {
				// Normalize literal escape sequences first (jsonrepair may have escaped real newlines)
				const rawNorm = sourceCode
					.replace(/\\n/g, "\n")
					.replace(/\\t/g, "\t")
					.replace(/\\'/g, "'");

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
				const pyWrapper = `import sys, json, math\n${normalizedSource}\n\ndef _json_safe(v):\n    if isinstance(v, float) and (math.isinf(v) or math.isnan(v)):\n        return None\n    return v\n\n_args = json.loads(sys.stdin.read() or "[]")\n_result = proposedSolution(*_args)\n# If function returned None (in-place mutation), return the mutated first arg so the oracle can check it\nif _result is None and _args:\n    _result = _args[0]\nprint(json.dumps(_json_safe(_result)))`;
				fs.writeFileSync(pyFile, pyWrapper);
				// JS fn(args...) → calls python3 solution.py with args as JSON on stdin
				const pyFileSafe = JSON.stringify(pyFile);
				verifyHarness = `
var { execFileSync } = require('child_process');
var __lastPyError = null;
var __fn = function() {
  var _args = Array.prototype.slice.call(arguments);
  var _raw;
  try {
    _raw = execFileSync('python3', [${pyFileSafe}], { input: JSON.stringify(_args), timeout: 10000 }).toString().trim();
  } catch (_e) {
    __lastPyError = (_e.stderr ? _e.stderr.toString() : _e.message || 'crash').split('\\n').filter(function(l){return l.trim();}).slice(-3).join(' | ');
    throw new Error('py-crash: ' + __lastPyError);
  }
  if (!_raw) { __lastPyError = 'empty output from python'; throw new Error('py-empty'); }
  var _result;
  try { _result = JSON.parse(_raw); } catch(_e2) { __lastPyError = 'bad json: ' + _raw.slice(0,80); throw new Error('py-json'); }
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
  return _result;
};
${oracleJs}
var __result;
try {
  __result = verify(__fn);
} catch (_verifyErr) {
  __result = { passed: false, reason: __lastPyError ? __lastPyError.slice(0, 200) : (_verifyErr.message || 'verify-threw').slice(0, 200) };
}
process.stdout.write(JSON.stringify(__result));
`.trim();
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
			const r = JSON.parse(raw) as { passed: boolean; reason: string };

			if (r.passed) {
				console.log(`  [oracle] Passed: ${r.reason}`);
			}

			return {
				overallPassed: r.passed,
				stages: [{
					stageName: "CustomOracle",
					passed: r.passed,
					reason: r.passed ? undefined : r.reason,
					artifacts: r.passed ? { computed_output: r.reason } : undefined,
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

// ── Public API ────────────────────────────────────────────────────────────────

export interface AutoDetectResult {
	domain: string;
	spec: DomainSpec;
	wasGenerated: boolean;
}

/**
 * Detect or generate the domain for a problem statement.
 * Returns the resolved DomainSpec (always registered in the registry before returning).
 */
export async function detectOrGenerateDomain(problem: string): Promise<AutoDetectResult> {
	const registered = listDomains();

	console.log("[auto-detect] Classifying problem against registered domains…");
	const { matched, confidence } = await classifyDomain(problem, registered);

	// Post-process: "math" domain is ONLY for formal proofs (Lean4/Coq).
	// If the problem doesn't explicitly mention proof/theorem/formal/lean/coq, reject math.
	const isFormalProof = /\b(proof|theorem|lean4?|coq|formal|prove|axiom|lemma)\b/i.test(problem);
	let domain = matched;
	if (domain === "math" && !isFormalProof) {
		console.log(`[auto-detect] Override: problem doesn't ask for formal proof, rejecting "math"`);
		domain = null;
	}

	if (domain && confidence >= 0.7) {
		const existing = getDomainSpec(domain);
		if (existing) {
			console.log(`[auto-detect] Matched domain: "${domain}" (confidence=${confidence.toFixed(2)})`);
			return { domain: domain!, spec: existing, wasGenerated: false };
		}
	}

	console.log(`[auto-detect] No confident match (best="${matched ?? "none"}", conf=${confidence.toFixed(2)}) — generating custom domain…`);
	const spec = await generateCustomDomain(problem);

	if (!spec) {
		// Last resort: fall back to "project" domain
		console.warn("[auto-detect] Custom domain generation failed — falling back to 'project'");
		const fallback = getDomainSpec("project")!;
		return { domain: "project", spec: fallback, wasGenerated: false };
	}

	return { domain: spec.name, spec, wasGenerated: true };
}
