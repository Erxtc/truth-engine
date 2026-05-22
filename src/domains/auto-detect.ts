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

async function classifyDomain(problem: string, registered: string[]): Promise<{ matched: string | null; confidence: number }> {
	const prompt = `
You are a domain classifier for an automated problem-solving system.

Registered domains: ${registered.join(", ")}

Problem statement:
${problem}

Does this problem clearly fit one of the registered domains?
- "sorting": algorithm to sort a collection
- "compression": lossless data compression algorithm
- "math": formal mathematical proof
- "physics": physical simulation
- "ml": machine learning model training
- "typescript": TypeScript code/project
- "python": Python code/project
- "c": C code/project
- "project": multi-file software project

If the problem clearly fits a domain, set matched_domain to that domain name.
If it does not clearly fit any domain (new kind of problem, mixed domain, research question, etc.), set matched_domain to null.
Set confidence between 0 and 1.

Return ONLY valid JSON:
{ "matched_domain": "sorting" | null, "confidence": 0.0-1.0, "reasoning": "brief explanation" }
`.trim();

	try {
		const result = await queryReasoning({ userPrompt: prompt, schema: classifySchema, temperature: 0.1 });
		return { matched: result.response.matched_domain, confidence: result.response.confidence };
	} catch {
		return { matched: null, confidence: 0 };
	}
}

// ── Custom domain generation ──────────────────────────────────────────────────

async function generateCustomDomain(problem: string): Promise<DomainSpec | null> {
	const prompt = `
You are designing a verification system for an automated problem-solving engine.

Problem:
${problem}

Your task: design a domain spec that can verify proposed solutions to this problem.

Rules:
- domain_name: short snake_case identifier (e.g. "fibonacci", "graph_coloring")
- invariants: 2-6 properties that every valid solution MUST satisfy
- required_confidence: 2 for most problems, 3 if independent agreement is needed, 4 only for formal proofs
- oracle_js: a complete JavaScript function \`verify(output, input)\` that:
  * receives the solution's output and the original input
  * returns { passed: boolean, reason: string }
  * must be self-contained (no imports)
  * must handle edge cases without crashing
- solution_format: one paragraph describing what a valid solution looks like (code, proof, explanation, etc.)

EXAMPLE for a "fibonacci" problem:
{
  "domain_name": "fibonacci",
  "invariants": [
    "fib(0) = 0, fib(1) = 1",
    "fib(n) = fib(n-1) + fib(n-2) for n >= 2",
    "Function must handle n up to 50 without overflow"
  ],
  "required_confidence": 2,
  "oracle_js": "function verify(output, input) { const expected = [0,1,1,2,3,5,8,13,21,34]; for (let i=0;i<10;i++) { if (output(i) !== expected[i]) return { passed: false, reason: 'fib(' + i + ') returned ' + output(i) + ' expected ' + expected[i] }; } return { passed: true, reason: 'All test cases passed' }; }",
  "solution_format": "A JavaScript function proposedFib(n) that returns the nth Fibonacci number"
}

Return ONLY valid JSON matching the structure above.
`.trim();

	try {
		const result = await queryReasoning({ userPrompt: prompt, schema: customDomainSchema, temperature: 0.2 });
		const r = result.response;

		const oracleJs = transpileToJs(r.oracle_js);

		// Build a minimal DomainSpec backed by the generated oracle
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
		console.log(`[auto-detect] Registered custom domain: "${r.domain_name}"`);
		console.log(`  Invariants: ${r.invariants.length}`);
		console.log(`  Required confidence: ${r.required_confidence}`);
		console.log(`  Solution format: ${r.solution_format}`);
		return spec;
	} catch (err) {
		console.error("[auto-detect] Failed to generate custom domain:", err);
		return null;
	}
}

// ── Custom oracle runner ──────────────────────────────────────────────────────

function runCustomOracle(
	oracleJs: string,
	proposal: Proposal,
	artifact: Artifact,
	domainName: string
) {
	const { overallPassed, stages, finalMetrics } = (() => {
		// Custom oracle stage: execute the verify() function against the proposal's output
		const sourceCode = artifact.sourceCode ?? (proposal.executable.type === "code" ? proposal.executable.source : null);

		if (!sourceCode) {
			return {
				overallPassed: false,
				stages: [{ stageName: "CustomOracle", passed: false, reason: "No source code in artifact", runtimeMs: 0 }],
				finalMetrics: {},
			};
		}

		const harness = `
${transpileToJs(sourceCode)}

${oracleJs}

let result;
try {
  // Pass the proposedSolution function (or any exported name) as output
  const fn = typeof proposedSolution !== 'undefined' ? proposedSolution
           : typeof solution !== 'undefined' ? solution
           : typeof main !== 'undefined' ? main
           : null;
  result = verify(fn, null);
  // Also capture the actual return value for display in the final answer
  if (result.passed && fn) {
    try { result.output = JSON.stringify(fn()); } catch(_) {}
  }
} catch(e) {
  result = { passed: false, reason: 'Oracle threw: ' + e.message };
}
process.stdout.write(JSON.stringify(result));
`.trim();

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `truth-custom-${domainName}-`));
		const tmpFile = path.join(tmpDir, "oracle.js");
		const start = Date.now();

		try {
			fs.writeFileSync(tmpFile, harness);
			const raw = execSync(`node ${tmpFile}`, { timeout: 15_000, stdio: "pipe" }).toString().trim();
			const r = JSON.parse(raw) as { passed: boolean; reason: string; output?: string };
			if (r.passed && r.output !== undefined) {
				console.log(`  [oracle] Computed output: ${r.output}`);
			}
			return {
				overallPassed: r.passed,
				stages: [{
					stageName: "CustomOracle",
					passed: r.passed,
					reason: r.passed ? undefined : r.reason,
					artifacts: r.output !== undefined ? { computed_output: r.output } : undefined,
					runtimeMs: Date.now() - start,
				}],
				finalMetrics: {},
			};
		} catch (err: any) {
			return {
				overallPassed: false,
				stages: [{ stageName: "CustomOracle", passed: false, reason: `Oracle error: ${err.stderr?.toString().slice(0, 300) ?? err.message}`, runtimeMs: Date.now() - start }],
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

	if (matched && confidence >= 0.7) {
		const existing = getDomainSpec(matched);
		if (existing) {
			console.log(`[auto-detect] Matched domain: "${matched}" (confidence=${confidence.toFixed(2)})`);
			return { domain: matched, spec: existing, wasGenerated: false };
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
