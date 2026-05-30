/**
 * Oracle generation — LLM-powered custom domain/oracle creation for problems
 * that don't match a registered domain. Includes hardening, auto-repair,
 * and retry loop with hardening error feedback.
 */

import * as v from "valibot";
import { queryReasoning } from "../llm";
import { registerDomain } from "../executors/domains";
import type { DomainSpec } from "../executors/domains/registry";
import type { Proposal, WorkingContext } from "../core/types";
import type { Artifact } from "../db/schema";
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

function buildOracleExamples(): string {
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
function sanitizeOracleJs(js: string): string {
	return js
		.replace(/\bNaN\b/g, "null")
		.replace(/\bundefined\b/g, "null");
}

/** Validate that a JS oracle string is syntactically correct.
 *  Returns { ok: true } or { ok: false, error: string } for the LLM retry loop. */
function validateOracleSyntax(oracleJs: string): { ok: boolean; error?: string } {
  try {
    new Function('"use strict"; ' + oracleJs + ';');
    return { ok: true };
  } catch (err: any) {
    const msg = err.message || String(err);
    return { ok: false, error: 'Oracle JS syntax error: ' + msg.slice(0, 200) };
  }
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

/** Parse example assertions from problem description (e.g. "Example 1: f(X) → Y").
 *  Only returns examples whose expected values are valid JS expressions — skips
 *  examples with English descriptions, "or" alternatives, or other non-JS text. */
function parseProblemExamples(problem: string): ParsedExample[] {
  const examples: ParsedExample[] = [];
  const exampleBlock = /(?:^|\n)\s*(?:Example\s*(\d+)[:.])?\s*(?:proposedSolution|fn)\s*\(([^)]*(?:\([^)]*\)[^)]*)*)\)\s*(?:→|->|returns?|=)\s*(.+?)(?:\n|$)/gm;
  let match;
  while ((match = exampleBlock.exec(problem)) !== null) {
    const num = match[1] || String(examples.length + 1);
    const rawArgs = (match[2] || "").trim();
    const rawExpected = cleanExpected((match[3] || "").trim());
    if (!rawArgs || !rawExpected) continue;
    const jsExpected = pythonToJs(rawExpected);
    if (!isValidJsExpression(jsExpected)) {
      console.log(`[auto-detect] Skipping example ${num} — expected value is not valid JS: "${rawExpected.slice(0, 60)}"`);
      continue;
    }
    examples.push({
      args: pythonToJs(rawArgs),
      expected: jsExpected,
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
      const jsExpected = pythonToJs(rawExpected);
      if (!isValidJsExpression(jsExpected)) {
        console.log(`[auto-detect] Skipping inline example ${count} — expected value is not valid JS: "${rawExpected.slice(0, 60)}"`);
        count++;
        continue;
      }
      examples.push({ args: pythonToJs(rawArgs), expected: jsExpected, label: `problem-example-${count++}` });
    }
  }
  return examples;
}

/** Strip trailing commentary from expected values: "because ...", "since ...", parenthetical notes, "or equivalent X", etc. */
function cleanExpected(raw: string): string {
  // ORDER MATTERS: strip "or [value]" BEFORE parentheticals. For inputs like
  // "[1,3,0,2] (.Q../...Q/Q.../..Q.) or [2,0,3,1]", we must remove the
  // "or [2,0,3,1]" first so the parenthetical becomes the trailing element
  // and can be stripped. Use an iterative loop to handle cascading cleanups.
  let result = raw
    .replace(/[;,]?\s*(?:because|since|where|\(i\.e\.|—|–).*$/i, "")
    .replace(/\.$/, "")
    // Strip "or [alternative]" FIRST — before parenthetical stripping
    .replace(/\s+or\s+(?:\[[^\]]*\](?:\s*\([^)]*\))?|"[^"]*"|'[^']*'|\d[\d.,]*)\s*(?:\([^)]*\))?\s*$/, "")
    .replace(/\s+or\s+\[[^\]]*\](?:\s*\([^)]*\))?/, "");
  // Iteratively strip trailing parentheticals and "or equivalent" notes
  let prev = "";
  while (prev !== result) {
    prev = result;
    result = result
      .replace(/\s*or\s+equivalent\b.*$/i, "")
      .replace(/\s*\([^)]*\)\s*$/, "");
  }
  return result.trim();
}

/** Check whether a string expression is valid JavaScript that can be safely used as an expected value in oracle JS.
 *  Returns true for JS literals (numbers, strings, booleans, null, arrays, objects, and valid nested combinations).
 *  Returns false for English phrases, partial code, and malformed expressions. */
function isValidJsExpression(expr: string): boolean {
  if (!expr || expr.length === 0) return false;

  // Quick rejection: if it starts with a lowercase letter (not true/false/null), it's likely English
  if (/^[a-z]/.test(expr) && !/^(true|false|null)\b/.test(expr)) return false;

  // Quick rejection: common English patterns in expected values
  if (/^(any|some|all|each|every|no|the|a\s|an\s|valid|invalid|saturation|lower|higher|approximately)/i.test(expr)) return false;

  // Quick rejection: contains English conjunctions/words that aren't JS
  if (/\b(?:applied|threshold|configuration|integers?|either|works?|both|length|returns?|yield)\b/i.test(expr) &&
      !/^["'\[]/.test(expr)) return false;

  // Quick rejection: contains "or" which is not a JS operator (|| is JS, "or" is Python/English)
  // But allow "or" inside strings
  if (/\bor\b/.test(expr) && !/".*?\bor\b.*?"/.test(expr) && !/'.*?\bor\b.*?'/.test(expr)) return false;

  try {
    // Use Function constructor to evaluate the expression as a return value.
    // This safely checks syntax without side effects (no closures, no global access via Function).
    const fn = new Function(`"use strict"; return (${expr});`);
    fn();
    return true;
  } catch {
    return false;
  }
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

/**
 * Inject problem-statement examples as AUTHORITATIVE checks at the TOP of verify().
 *
 * Strategy: extracted examples are the ground truth. We place them FIRST so they
 * determine success/failure. The LLM's body is wrapped in try-catch to prevent
 * hallucinated function signatures or bad test data from crashing the real checks.
 */
function injectProblemExamples(problem: string, oracleJs: string): string {
  const examples = parseProblemExamples(problem);
  if (examples.length === 0) return oracleJs;

  // Build check blocks for each valid example
  const checks = examples.map((ex, i) => {
    if (!isValidJsExpression(ex.expected)) {
      console.log(`[auto-detect] Skipping injected example ${ex.label} — expected value invalid: "${ex.expected.slice(0, 60)}"`);
      return "";
    }
    const escapedExpected = JSON.stringify(ex.expected);
    return [
      `  var _p${i} = fn(${ex.args});`,
      `  var _e${i} = ${ex.expected};`,
      `  if (!__teq(_p${i}, _e${i})) { return { passed: false, reason: "${ex.label}-fail: expected " + ${escapedExpected} + " got " + JSON.stringify(_p${i}) }; }`,
    ].join("\n");
  }).filter(Boolean).join("\n\n");

  if (!checks) return oracleJs;

  const authorityBlock = `  // === AUTHORITATIVE: extracted from problem statement ===
  // Tolerance-aware deep equality: rounds floats to 6 decimal places before JSON comparison
  function __teq(a, b) {
    var _r = function(k, v) {
      if (typeof v === 'number' && isFinite(v)) return parseFloat(v.toFixed(6));
      return v;
    };
    return JSON.stringify(a, _r) === JSON.stringify(b, _r);
  }
${checks}
  // === END authoritative ===`;

  // Find "function verify(fn) {" to inject right after it
  const fnOpenRe = /(function\s+verify\s*\(\s*fn\s*\)\s*\{)/;
  const fnMatch = oracleJs.match(fnOpenRe);
  if (!fnMatch) {
    // Can't find function opening — fall back to injecting before final return
    const injected = oracleJs.replace(
      /(\s*)(return\s*\{\s*passed\s*:\s*true\s*,?\s*reason\s*:\s*["']ok["']\s*\}\s*;?\s*)/,
      `\n${checks}\n$1$2`,
    );
    if (injected === oracleJs) {
      const lastBrace = oracleJs.lastIndexOf("}");
      if (lastBrace > 0) return oracleJs.slice(0, lastBrace) + "\n" + checks + "\n}" + oracleJs.slice(lastBrace + 1);
    }
    return injected;
  }

  const fnOpenIdx = fnMatch.index! + fnMatch[0].length;

  // Find the final return { passed: true, reason: "ok" }
  const finalReturnRe = /(\n\s*return\s*\{\s*passed\s*:\s*true\s*,?\s*reason\s*:\s*["']ok["']\s*\}\s*;?\s*)/;
  const returnMatch = oracleJs.match(finalReturnRe);

  if (!returnMatch) {
    // No standard return — inject before closing brace
    const lastBrace = oracleJs.lastIndexOf("}");
    if (lastBrace > 0) {
      return oracleJs.slice(0, lastBrace) + "\n" + authorityBlock + "\n}" + oracleJs.slice(lastBrace + 1);
    }
    return oracleJs;
  }

  const returnIdx = returnMatch.index!;
  const llmBody = oracleJs.slice(fnOpenIdx, returnIdx).trim();

  // Build: function verify(fn) {
  //   [AUTHORITATIVE examples — run first, determine outcome]
  //   try { [LLM body — advisory only] } catch(_oe) {}
  //   return { passed: true, reason: "ok" };
  // }
  const prefix = oracleJs.slice(0, fnOpenIdx);
  const suffix = oracleJs.slice(returnIdx);
  const wrappedLlmBody = llmBody
    ? `\n  // === LLM-generated checks (advisory — try-catch for safety) ===\n  try {\n${llmBody}\n  } catch(_oe) { /* LLM check crashed — authoritative examples already verified */ }\n  // === END LLM-generated ===\n`
    : "\n";

  return `${prefix}\n${authorityBlock}\n${wrappedLlmBody}${suffix}`;
}

// ── Custom domain generation ──────────────────────────────────────────────

export async function generateCustomDomain(problem: string): Promise<DomainSpec | null> {
	const exampleDocs = buildOracleExamples();
	const probExamples = parseProblemExamples(problem);

	// Short, examples-first prompt. The old 100+ line/17-rule prompt caused models
	// to ignore "COPY TEST CASES" and invent their own — the #1 oracle failure mode.
	const jsRules = `JS RULES (critical):
- Use [] for arrays, NEVER () — (a,b) evaluates to just b in JS (comma operator)
- Check type before value: if (!Array.isArray(r)) return {passed:false,reason:"not-array"}
- Float tolerance: if (Math.abs(got - expected) >= 0.01) — use >= not >
- Reason on fail: include expected vs got, use JSON.stringify for values
- NaN → null, undefined → null
- No aggregate/sum checks — check individual values`;

	const prompt = probExamples.length > 0 ? `
Design a verification oracle. Use ONLY these test cases:

PROBLEM:
${problem}

TEST CASES FROM PROBLEM (use EXACTLY these — do NOT create your own):
${probExamples.map((ex) => `  fn(${ex.args}) → ${ex.expected}`).join("\n")}

CRITICAL: Copy the EXACT function signature from the examples above.
These test cases are authoritative — they define the correct inputs/outputs.

${jsRules}

Return JSON: { domain_name, invariants, required_confidence: 2, oracle_js, solution_format }`.trim() : `
Design a verification oracle. IMPLEMENT formulas inside verify():

PROBLEM:
${problem}

No explicit test cases — you MUST implement the problem's formulas/equations
INSIDE verify() to compute expected values programmatically. Use the EXACT
formulas from the problem statement (copy equations verbatim into code).

PATTERN:
  function verify(fn) {
    // Step 1: implement the formula computation
    function computeExpected(...) { /* use problem's exact formulas */ }

    // Step 2: call fn() and computeExpected() with the same inputs
    var got = fn(inputs);
    var exp = computeExpected(inputs);

    // Step 3: compare (check type first, use tolerance for floats)
    if (Math.abs(got.value - exp.value) >= 0.01) return {passed:false, reason:"..."};
    return {passed:true, reason:"ok"};
  }

CRITICAL: Match the problem's EXACT output format. If the problem says
"Return [S, I, R] as final values", test final values — NOT time series.
If it says "return dict with S,I,R lists", test the lists.

Test at least 2 different parameter sets to catch bugs.

${jsRules}

Return JSON: { domain_name, invariants, required_confidence: 2, oracle_js, solution_format }`.trim();

	const promptWithExamples = prompt + `\n\nFORMAT EXAMPLES:\n${exampleDocs}`;

	// Removed old long prompt — use promptWithExamples for LLM calls

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

		const fullPrompt = promptWithExamples + retryHint;
		try {
			const result = await queryReasoning({ userPrompt: fullPrompt, schema: customDomainSchema, temperature: attempt === 0 ? 0.2 : 0.1, nonce: `oracle-gen-${attempt}-${Date.now()}` });
			const r = result.response;
			const oracleJs = sanitizeOracleJs(transpileToJs(r.oracle_js));
			lastOracleJs = oracleJs;

		// Syntax validation: reject oracles that cannot compile before hardening
		const syntaxCheck = validateOracleSyntax(oracleJs);
		if (!syntaxCheck.ok) {
			console.warn(`[auto-detect] Oracle syntax invalid: ${syntaxCheck.error}`);
			lastError = new Error(syntaxCheck.error!);
			continue;
		}

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
