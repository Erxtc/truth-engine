/**
 * Oracle generation — LLM-powered custom domain/oracle creation for problems
 * that don't match a registered domain. Includes hardening, auto-repair,
 * and retry loop with hardening error feedback.
 */

import * as v from "valibot";
import { queryReasoning } from "../llm";
import { registerDomain } from "../executors/domains";
import type { DomainSpec } from "../executors/domains/registry";
import type { Proposal, WorkingContext, Artifact } from "../core/types";
import { transpileToJs } from "../utils/general";
import { putCachedOracle } from "./oracle-cache";
import { hardenOracle } from "./oracle-hardener";
import { runCustomOracle } from "./oracle-runner";

// ── Schema for the LLM's custom domain response ───────────────────────────

export const customDomainSchema = v.object({
	domain_name: v.string(),
	invariants: v.pipe(v.array(v.string()), v.minLength(1), v.maxLength(8)),
	required_confidence: v.pipe(v.number(), v.minValue(1), v.maxValue(4)),
	oracle_js: v.string(),
	solution_format: v.string(),
});

// ── Oracle examples for the LLM prompt ────────────────────────────────────

export function buildOracleExamples(): string {
	const examples = [
		{
			domain_name: "arithmetic",
			invariants: ["Result must be the mathematical product", "Function must return a number"],
			required_confidence: 2,
			oracle_js: "function verify(fn) { var out = fn(); var exp = 15 * 17; if (out === exp) return { passed: true, reason: \"ok\" }; return { passed: false, reason: \"wrong: expected \" + exp + \" got \" + out }; }",
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
			oracle_js: "function verify(fn) { if (fn(0) !== 0) return { passed: false, reason: \"fib0-fail: expected 0 got \" + fn(0) }; if (fn(1) !== 1) return { passed: false, reason: \"fib1-fail: expected 1 got \" + fn(1) }; if (fn(10) !== 55) return { passed: false, reason: \"fib10-fail: expected 55 got \" + fn(10) }; return { passed: true, reason: \"ok\" }; }",
			solution_format: "A function proposedSolution(n) that returns the nth Fibonacci number",
		},
		{
			domain_name: "generate_parentheses",
			invariants: ["Returns list of strings", "Each string has correct length 2*n", "Each string is balanced", "Count matches Catalan number"],
			required_confidence: 2,
			// For list-return problems: check count, then check each item is valid — never hardcode the full expected list.
			oracle_js: "function verify(fn) { function isValid(s) { var d = 0; for (var i = 0; i < s.length; i++) { d += s[i] === '(' ? 1 : -1; if (d < 0) return false; } return d === 0; } var r1 = fn(1); if (!Array.isArray(r1) || r1.length !== 1) return { passed: false, reason: \"n1-count\" }; if (!isValid(r1[0])) return { passed: false, reason: \"n1-invalid\" }; var r2 = fn(2); if (!Array.isArray(r2) || r2.length !== 2) return { passed: false, reason: \"n2-count\" }; for (var i = 0; i < r2.length; i++) { if (!isValid(r2[i]) || r2[i].length !== 4) return { passed: false, reason: \"n2-invalid\" }; } var r3 = fn(3); if (!Array.isArray(r3) || r3.length !== 5) return { passed: false, reason: \"n3-count\" }; for (var i = 0; i < r3.length; i++) { if (!isValid(r3[i]) || r3[i].length !== 6) return { passed: false, reason: \"n3-invalid\" }; } return { passed: true, reason: \"ok\" }; }",
			solution_format: "A function proposedSolution(n) that returns a list of all valid combinations of n pairs of parentheses",
		},
		{
			domain_name: "prime_factors",
			invariants: ["Returns sorted list of prime factors with repetition", "12 = [2,2,3], 18 = [2,3,3], 7 = [7]"],
			required_confidence: 2,
			oracle_js: "function verify(fn) { function check(n, exp) { var got = fn(n).slice().sort(function(a,b){return a-b;}); if (got.length !== exp.length) return \"len-\" + n; for (var i=0;i<exp.length;i++) { if (got[i] !== exp[i]) return \"val-\" + n; } return null; } var e12=check(12,[2,2,3]); if(e12) return {passed:false,reason:e12}; var e18=check(18,[2,3,3]); if(e18) return {passed:false,reason:e18}; var e7=check(7,[7]); if(e7) return {passed:false,reason:e7}; var e1=check(1,[]); if(e1) return {passed:false,reason:e1}; return {passed:true,reason:\"ok\"}; }",
			solution_format: "A function proposedSolution(n) that returns a sorted list of prime factors of n (with repetition)",
		},
		{
			domain_name: "word_frequency",
			invariants: ["Returns dict/object mapping each word to its count", "Case-insensitive", "Punctuation stripped"],
			required_confidence: 2,
			oracle_js: "function verify(fn) { var r = fn(\"the cat sat on the mat\"); if (typeof r !== 'object' || r === null) return {passed:false,reason:\"not-object\"}; if (r[\"the\"] !== 2) return {passed:false,reason:\"the-count\"}; if (r[\"cat\"] !== 1) return {passed:false,reason:\"cat-count\"}; if (r[\"sat\"] !== 1) return {passed:false,reason:\"sat-count\"}; if (r[\"mat\"] !== 1) return {passed:false,reason:\"mat-count\"}; var r2 = fn(\"hello world hello\"); if (r2[\"hello\"] !== 2) return {passed:false,reason:\"hello-count\"}; if (r2[\"world\"] !== 1) return {passed:false,reason:\"world-count\"}; return {passed:true,reason:\"ok\"}; }",
			solution_format: "A function proposedSolution(s) that returns a dict mapping each word to its frequency count",
		},
		{
			domain_name: "nash_pure_equilibrium",
			invariants: ["Returns list of [row, col] index pairs", "Each pair is a pure-strategy Nash equilibrium", "Row player cannot improve by switching rows", "Col player cannot improve by switching columns"],
			required_confidence: 2,
			oracle_js: "function verify(fn) { var game = [[[3,3],[0,5]],[[5,0],[1,1]]]; var r = fn(game); if (!Array.isArray(r)) return {passed:false,reason:\"not-array\"}; var sorted = r.slice().sort(function(a,b){return a[0]-b[0]||a[1]-b[1];}); var exp = [[1,1]]; if (sorted.length !== exp.length || sorted[0][0] !== exp[0][0] || sorted[0][1] !== exp[0][1]) return {passed:false,reason:\"example1-fail: expected \"+JSON.stringify(exp)+\" got \"+JSON.stringify(sorted)}; var game2 = [[[2,1],[0,0]],[[0,0],[1,2]]]; var r2 = fn(game2); if (!Array.isArray(r2)) return {passed:false,reason:\"not-array2\"}; var s2 = r2.slice().sort(function(a,b){return a[0]-b[0]||a[1]-b[1];}); if (s2.length !== 2 || s2[0][0] !== 0 || s2[0][1] !== 0 || s2[1][0] !== 1 || s2[1][1] !== 1) return {passed:false,reason:\"example2-fail: expected [[0,0],[1,1]] got \"+JSON.stringify(s2)}; var game3 = [[[1,-1],[-1,1]],[[-1,1],[1,-1]]]; var r3 = fn(game3); if (!Array.isArray(r3) || r3.length !== 0) return {passed:false,reason:\"example3-fail: expected [] got \"+JSON.stringify(r3)}; return {passed:true,reason:\"ok\"}; }",
			solution_format: "A function proposedSolution(payoffMatrix) that returns a list of [row_idx, col_idx] index pairs for all pure-strategy Nash equilibria (empty list if none)",
		},
	];
	return examples.map(e => JSON.stringify(e, null, 2)).join("\n\n");
}

// ── Oracle sanitization ───────────────────────────────────────────────────

/** Replace non-JSON-serializable JS literals so oracle comparisons don't blow up. */
export function sanitizeOracleJs(js: string): string {
	return js
		.replace(/\bNaN\b/g, "null")
		.replace(/\bundefined\b/g, "null");
}

// ── Oracle auto-repair ────────────────────────────────────────────────────

/**
 * When the LLM generates an oracle that fails hardening (passes broken stubs),
 * try to inject type-guard checks automatically.
 *
 * Most common failure: oracle accesses r[0]/r[1] on a scalar (0 from "return 0" stub),
 * producing NaN comparisons that silently pass (NaN > threshold is always false).
 *
 * Fix: wrap verify() to inject branded-object checks after every fn() call that
 * produces a scalar result.
 */
function tryRepairOracle(oracleJs: string): string | null {
	const fnSig = "function verify(fn) {";
	if (!oracleJs.includes(fnSig)) return null;

	// Replace fn() to reject scalar returns — if fn returns 0/null/undefined,
	// return a branded object that will fail all array/number checks.
	const repaired = oracleJs.replace(
		fnSig,
		fnSig + `
  // Auto-injected: wrap fn to detect broken stubs (return 0, null, [])
  var _raw = fn;
  fn = function() {
    var _r = _raw.apply(null, arguments);
    if (_r === 0 || _r === null) return { __BROKEN_STUB: true, _val: _r };
    if (Array.isArray(_r) && _r.length === 0) return { __BROKEN_STUB: true, _val: "[]" };
    return _r;
  };`
	);

	return repaired !== oracleJs ? repaired : null;
}

// ── Problem example injection ──────────────────────────────────────────────

interface ParsedExample {
  args: string;
  expected: string;
  label: string;
}

/** Parse example assertions from problem description (e.g. "Example 1: f(X) → Y"). */
function parseProblemExamples(problem: string): ParsedExample[] {
  const examples: ParsedExample[] = [];
  const exampleBlock = /(?:^|\n)\s*(?:Example\s*(\d+)[:.])?\s*(?:proposedSolution|fn)\s*\(([^)]*(?:\([^)]*\)[^)]*)*)\)\s*(?:→|->|returns?|=)\s*(.+?)(?:\n|$)/gm;
  let match;
  while ((match = exampleBlock.exec(problem)) !== null) {
    const num = match[1] || String(examples.length + 1);
    const rawArgs = (match[2] || "").trim();
    const rawExpected = cleanExpected((match[3] || "").trim());
    if (!rawArgs || !rawExpected) continue;
    examples.push({
      args: pythonToJs(rawArgs),
      expected: pythonToJs(rawExpected),
      label: `example-${num}`,
    });
  }
  if (examples.length === 0) {
    const inlineRe = /proposedSolution\s*\(([^)]+(?:\([^)]*\)[^)]*)*)\)\s*(?:returns?|→|->)\s*(.+?)(?:\.|\n|$)/g;
    let m, count = 1;
    while ((m = inlineRe.exec(problem)) !== null) {
      const rawArgs = (m[1] || "").trim();
      const rawExpected = cleanExpected((m[2] || "").trim());
      if (!rawArgs || !rawExpected) continue;
      examples.push({ args: pythonToJs(rawArgs), expected: pythonToJs(rawExpected), label: `problem-example-${count++}` });
    }
  }
  return examples;
}

/** Strip trailing commentary from expected values: "because ...", "since ...", parenthetical notes, "or equivalent X", etc. */
function cleanExpected(raw: string): string {
  // Strip trailing explanations / parenthetical annotations.
  // IMPORTANT: only strip parenthetical content that looks like natural language
  // (does NOT contain [, {, ", or ' — those indicate structured data like lists or dicts).
  const stripped = raw
    .replace(/[;,]?\s*(?:because|since|where|\(i\.e\.|—|–).*$/i, "")
    .replace(/\.$/, "");
  // Only strip trailing paren group if it doesn't contain structured data chars
  const parenStripped = stripped.replace(/\s*\(([^)[\]{}"']*)\)\s*$/, "");
  const result = parenStripped !== stripped ? parenStripped : stripped;
  return result
    // Strip "or equivalent X [note]" patterns: "[...] or equivalent shortest path (length 7)" → "[...]"
    .replace(/\s*or\s+equivalent\b.*$/i, "")
    .trim();
}

function pythonToJs(expr: string): string {
  let js = expr.trim();
  js = js.replace(/\bNone\b/g, "null");
  js = js.replace(/\bTrue\b/g, "true");
  js = js.replace(/\bFalse\b/g, "false");
  // Convert Python tuples to JS arrays (iteratively for nesting)
  let prev = "";
  while (prev !== js) {
    prev = js;
    js = js.replace(/\(([^()]*)\)/g, (_full: string, inner: string) => `[${inner}]`);
  }
  return js;
}

function injectProblemExamples(problem: string, oracleJs: string): string {
  const examples = parseProblemExamples(problem);
  if (examples.length === 0) return oracleJs;

  // Skip injection if the oracle already has its own test cases (var tests = [...])
  // This prevents duplicate tests and avoids JS syntax issues from fallback insertion.
  if (/\bvar\s+tests\s*=\s*\[/.test(oracleJs) || /\bconst\s+tests\s*=\s*\[/.test(oracleJs)) {
    return oracleJs;  // Oracle already has tests, injection would duplicate
  }

  const checks = examples.map((ex, i) =>
    `  var _p${i} = fn(${ex.args});\n  var _e${i} = ${ex.expected};\n  if (JSON.stringify(_p${i}) !== JSON.stringify(_e${i})) { return { passed: false, reason: "${ex.label}-fail: expected " + JSON.stringify(_e${i}) + " got " + JSON.stringify(_p${i}) }; }`
  ).join("\n\n");
  const injected = oracleJs.replace(
    /(\s*)(return\s*\{\s*passed\s*:\s*true\s*,?\s*reason\s*:\s*["']ok["']\s*\}\s*;?\s*)/,
    `\n${checks}\n$1$2`,
  );
  // If the pattern didn't match, return the original oracle — don't use lastIndexOf("}") fallback
  // which can corrupt JS syntax when oracles have nested braces.
  return injected;
}

// ── Custom domain generation ──────────────────────────────────────────────

export async function generateCustomDomain(problem: string): Promise<DomainSpec | null> {
	const examples = buildOracleExamples();
	const prompt = `
You are designing a verification system for an automated problem-solving engine.

Problem:
${problem}

Your task: design a domain spec that can verify proposed solutions to this problem.

CRITICAL — oracle design rules:
  1. oracle_js is a JavaScript function verify(fn) where fn is the proposed solution function.
  2. COPY TEST CASES FROM THE PROBLEM. Every single fn() call in your oracle MUST correspond to an
     example explicitly given in the problem statement. Copy the inputs and expected outputs VERBATIM.
     DO NOT create your own test cases, variations, or "better" examples.
     If the problem has 3 examples, your oracle has exactly those 3 fn() calls — no more, no less.
     This is the #1 cause of wrong oracles — the oracle must test what the problem asks, not what you think.
  3. EXPECTED VALUES — TWO CASES:
     CASE A — PROBLEM HAS EXPLICIT FORMULAS (physics, engineering, chemistry, etc.):
       The problem states equations like "F = m*a" or "δ = (5*w*L⁴)/(384*E*I)". COMPUTE expected values using those formulas.
       Examples can contain ERRORS. Trust the formula, not the example. If computation disagrees with example, use YOUR computed value.
       var expected = /* compute from the stated formula */;
       This is CRITICAL: copying a wrong example value when a formula is available will silently validate wrong code!
     CASE B — NO FORMULAS (algorithmic, sorting, DP, ciphers, etc.):
       Copy expected values VERBATIM from the problem statement — NEVER compute or re-derive them yourself.
       If problem says "f(12)=[2,2,3]", write: var exp=[2,2,3]; (3 elements, copied exactly as stated)
  4. For lists that could come in any order: sort both before comparing. Example:
     var got=fn(n).slice().sort(); var exp=[2,2,3]; if(JSON.stringify(got)!==JSON.stringify(exp)) return {passed:false,reason:"fail"};
  5. For dict/object returns: check each expected key individually, no aggregate sum checks.
  6. For equations: verify by substituting into the equations.
  7. reason strings: For SUCCESS use "ok". For FAILURE, include what was expected vs what was received so the repair agent can fix the bug. Use JSON.stringify() to convert values to strings. Example: "example1-fail: expected [0,1,3,4] got [0,3,4]". This is CRITICAL — without expected/got, the repair agent cannot fix anything.
  8. NO sum/total/aggregate checks — they cause false negatives. Only check the values stated in the problem.
  9. PRESERVE input formats EXACTLY as shown in the problem. If the problem says graph[u] = [(v,w), ...] (list of pairs),
     use arrays-of-arrays in JS: {"A": [["B",1],["C",4]], "D": []} — NEVER convert to {v: w} dict-of-dicts.
     The solver will receive the EXACT structure you pass to fn(), so it must match what the problem describes.
 10. CRITICAL — no Python tuples in JavaScript: JS does NOT have tuples. (a, b) in JS is the comma operator which evaluates to JUST b.
     When the problem uses tuple notation (row_payoff, col_payoff) or (price, quantity), you MUST use ARRAYS [a, b] in your oracle JS.
     Example: if fn() should receive [[[(row_pay, col_pay), ...], ...], ...], write [[[[3, 3], [0, 0]], [[0, 0], [2, 2]]]].
     NEVER write (3, 3) in JS — it silently evaluates to 3, so the function receives a flat number instead of a pair.
 11. For graph/tree inputs: include ALL nodes as keys (with [] or {} for terminal nodes with no outgoing edges).
 12. CRITICAL for in-place mutation: the solution runs in a subprocess — it CANNOT mutate JS variables.
     ALWAYS capture the return value and check it: var r = fn(x); if (r[0][0] !== 7) ...
     NEVER check the original variable after calling fn: fn(m1); if (m1[0][0] ... // WRONG — m1 is unchanged
     The harness returns the first argument when the function returns null/None, so in-place mutations are visible via the return value.
 13. CRITICAL — type-before-value: ALWAYS validate the return type before accessing indices or doing arithmetic.
     If the function should return a tuple: if (!Array.isArray(r) || r.length < 2) return {passed:false,reason:"not-tuple"};
     If the function should return a number: if (typeof r !== "number") return {passed:false,reason:"not-number"};
     If the function returns None/null: if (r === null) return {passed:false,reason:"unexpected-null"} (unless null IS the expected output).
     NEVER do Math.abs(r[0] - expected) on a value that might not be an array.
     Math.abs(undefined - 50) produces NaN, and NaN > 0.01 is false — the oracle silently passes broken code!
 14. CRITICAL — floating-point comparisons: ALWAYS use >= (NOT >) for tolerance checks.
     BAD:  if (Math.abs(got - expected) > 0.01)  ← boundary failures from IEEE 754 precision
     GOOD: if (Math.abs(got - expected) >= 0.01)
     When expected values are marked "(approximately)", use at least 0.5% relative tolerance instead of fixed 0.01.
     GOOD: if (Math.abs(got - expected) >= Math.max(0.01, Math.abs(expected) * 0.005))
 15. CRITICAL — OUTPUT FORMAT: Read the problem's return/output clause LITERALLY. Do NOT substitute a different output
     format based on your training knowledge. Your job is to verify what the problem ASKS FOR, not what you think it should ask for.

     COMMON FAILURE: Problem says "return list of (row_idx, col_idx) tuples for all Nash equilibria" but oracle
     expects [p1, p2] probabilities. WRONG — the problem wants INDEX PAIRS like [[1, 1]] or [[0, 0], [1, 1]], NOT [0.5, 0.5].

     COMMON FAILURE: Problem says "return the shortest path as a list of nodes [start, ..., target]" but oracle
     checks for path length. WRONG — check the actual path nodes.

     The solution_format field MUST describe the exact return type and structure the problem specifies.
     If the problem gives examples of return values, COPY those EXACTLY into the expected values in oracle_js.
     DO NOT reinterpret "index tuples" as probabilities, "paths" as distances, or "indices" as values.

 16. CRITICAL — FUNCTION SIGNATURE: Match the EXACT parameter list from the problem. If the problem says
     proposedSolution(data, block_size, mode), your fn() calls MUST pass ALL three arguments: fn(data, block_size, mode).
     DO NOT drop parameters or change their order. If the problem has both "pad" and "unpad" modes, test BOTH modes
     using the problem's examples — don't test only one mode.

     The solution_format must include ALL required parameters: "A function proposedSolution(data, block_size, mode)
     that pads (mode='pad') or unpads (mode='unpad') data using PKCS#7."

     For cryptographic standards (PKCS#7, AES, etc.): a full block of padding is ALWAYS added, even when the
     input is already block-aligned. This is REQUIRED for unambiguous unpadding.

Fields:
  domain_name: short snake_case identifier
  invariants: 2-6 properties every valid solution must satisfy
  required_confidence: 2 (use 3 only if independent agreement is needed)
  oracle_js: JavaScript function verify(fn) → { passed: boolean, reason: string }
  solution_format: one sentence describing expected function signature and return value

EXAMPLES (copy this exact JSON structure):
${examples}

Return ONLY valid JSON matching the structure above.`.trim();

	// Try up to 3 times. On failure, include the specific hardening error and demand a stricter oracle.
	let lastError: unknown;
	let lastOracleJs: string | null = null;  // saved for auto-repair after all retries fail
	for (let attempt = 0; attempt < 3; attempt++) {
		const retryHint = attempt === 0 ? "" : `
PREVIOUS ATTEMPT FAILED: ${lastError instanceof Error ? lastError.message.slice(0, 200) : String(lastError)}
YOUR ORACLE MUST REJECT BROKEN STUBS. The oracle must call fn() with test inputs and verify the result.

IF THE FUNCTION RETURNS A TUPLE/LIST (e.g., "Return (price, quantity) as a tuple"):
  You MUST add this EXACT check at the TOP of verify(), right after declaring variables:
    if (!Array.isArray(r) || r.length !== EXPECTED_COUNT) return { passed: false, reason: "expected-array-got-" + (typeof r) };
  Without this check, fn() returning 0 produces r[0]=undefined, and Math.abs(undefined - 50) = NaN,
  and NaN > 0.01 is FALSE — so your oracle silently passes the broken "return 0" stub!

IF THE FUNCTION RETURNS A NUMBER:
  if (typeof r !== "number") return { passed: false, reason: "expected-number-got-" + (typeof r) };

IF THE FUNCTION RETURNS A DICT/OBJECT:
  if (typeof r !== "object" || r === null || Array.isArray(r)) return { passed: false, reason: "expected-object-got-" + (typeof r) };

FAILING TO ADD THESE CHECKS MEANS YOUR ORACLE WILL PASS BROKEN CODE.`.trimStart();

		const fullPrompt = prompt + retryHint;
		try {
			const result = await queryReasoning({ userPrompt: fullPrompt, schema: customDomainSchema, temperature: attempt === 0 ? 0.2 : 0.1, nonce: `oracle-gen-${attempt}-${Date.now()}` });
			const r = result.response;
			const oracleJs = sanitizeOracleJs(transpileToJs(r.oracle_js));
			lastOracleJs = oracleJs;

			// Inject problem-statement examples as ground-truth checks BEFORE hardening.
			// This catches oracles that only have weak structural checks — the deterministic
			// examples add value-level assertions so broken stubs like return-first-arg fail.
			const oracleJsWithExamples = injectProblemExamples(problem, oracleJs);
			const oracleForHardening = oracleJsWithExamples !== oracleJs ? oracleJsWithExamples : oracleJs;
			if (oracleJsWithExamples !== oracleJs) {
				console.log(`[auto-detect] Injected problem examples into oracle ✓`);
			}

			// Validate oracle: must reject at least basic broken stubs
			const hardened = hardenOracle(oracleForHardening);
			if (!hardened.ok) {
				console.warn(`[auto-detect] Oracle hardening failed: ${hardened.error}`);
				// Try deterministic auto-repair BEFORE spending another LLM call
				const repaired = tryRepairOracle(oracleForHardening);
				if (repaired) {
					const recheck = hardenOracle(repaired);
					if (recheck.ok) {
						console.log(`[auto-detect] Oracle auto-repaired: injected type guards ✓`);
						const domainName = r.domain_name || "auto_repaired";
						const invariants = r.invariants?.length ? r.invariants : ["Solution must pass oracle verification"];
						const spec: DomainSpec = {
							name: domainName,
							invariants,
							requiredConfidence: (r.required_confidence ?? 2) as 1 | 2 | 3 | 4,
							solutionFormat: r.solution_format || "Function that passes all oracle test cases",
							testSource: repaired,
							async run(proposal: Proposal, _ctx: WorkingContext, artifact: Artifact) {
								return runCustomOracle(repaired, proposal, artifact, domainName);
							},
						};
						registerDomain(spec);
						putCachedOracle(problem, {
							domain_name: domainName,
							invariants,
							required_confidence: r.required_confidence ?? 2,
							solution_format: spec.solutionFormat ?? "Function that passes all oracle test cases",
							oracle_js: repaired,
							cachedAt: new Date().toISOString(),
						});
						return spec;
					}
					console.warn(`[auto-detect] Auto-repaired oracle still failed hardening: ${recheck.error} — retrying`);
				}
				lastError = new Error(hardened.error);
				lastOracleJs = oracleJs;
				continue;
			}
			console.log(`[auto-detect] Oracle hardening: rejects broken stubs ✓`);

			const spec: DomainSpec = {
				name: r.domain_name,
				invariants: r.invariants,
				requiredConfidence: r.required_confidence as 1 | 2 | 3 | 4,
				solutionFormat: r.solution_format,
				testSource: oracleForHardening,
				async run(proposal: Proposal, _ctx: WorkingContext, artifact: Artifact) {
					return runCustomOracle(oracleForHardening, proposal, artifact, r.domain_name);
				},
			};

			registerDomain(spec);
			if (attempt > 0) console.log(`[auto-detect] Domain generation succeeded on attempt ${attempt + 1}`);
			console.log(`[auto-detect] Registered custom domain: "${r.domain_name}"`);
			console.log(`  Invariants: ${r.invariants.length}`);
			console.log(`  Required confidence: ${r.required_confidence}`);
			console.log(`  Solution format: ${r.solution_format}`);
			// Cache for future re-runs
			putCachedOracle(problem, {
				domain_name: r.domain_name,
				invariants: r.invariants,
				required_confidence: r.required_confidence,
				solution_format: r.solution_format,
				oracle_js: oracleForHardening,
				cachedAt: new Date().toISOString(),
			});
			return spec;
		} catch (err) {
			lastError = err;
			console.warn(`[auto-detect] Domain generation attempt ${attempt + 1} failed: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
		}
	}

	console.error("[auto-detect] All domain generation attempts failed");

	// Auto-repair: try to inject type guards into the best oracle we got.
	if (lastOracleJs) {
		// Inject problem examples first for extra deterministic value checks
		const withExamples = injectProblemExamples(problem, lastOracleJs);
		const baseOracle = withExamples !== lastOracleJs ? withExamples : lastOracleJs;
		const repaired = tryRepairOracle(baseOracle);
		if (repaired) {
			const recheck = hardenOracle(repaired);
			if (recheck.ok) {
				console.log("[auto-detect] Oracle auto-repaired: injected type guards ✓");
				const domainName = "auto_repaired";
				const invariants: string[] = ["Solution must pass oracle verification"];
				const spec: DomainSpec = {
					name: domainName,
					invariants,
					requiredConfidence: 2,
					solutionFormat: "Function that passes all oracle test cases",
					testSource: repaired,
					async run(proposal: Proposal, _ctx: WorkingContext, artifact: Artifact) {
						return runCustomOracle(repaired, proposal, artifact, domainName);
					},
				};
				registerDomain(spec);
				putCachedOracle(problem, {
					domain_name: domainName,
					invariants,
					required_confidence: 2,
					solution_format: spec.solutionFormat ?? "Function that passes all oracle test cases",
					oracle_js: repaired,
					cachedAt: new Date().toISOString(),
				});
				return spec;
			}
			console.warn(`[auto-detect] Auto-repaired oracle still failed hardening: ${recheck.error}`);
		}
	}

	return null;
}
