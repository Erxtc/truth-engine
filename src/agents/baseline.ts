/**
 * Baseline solver: single LLM call, no multi-agent pipeline.
 * Used to measure what the raw model can do vs. the full system.
 */

import * as v from "valibot";
import { queryReasoning } from "../llm";
import type { DomainSpec } from "../executors/domains/registry";
import type { Proposal } from "../core/types";
import type { Artifact } from "../db/schema";
import { validateAndFixPython } from "../utils/code-validator";

const baselineSchema = v.object({
	code: v.string(),
	language: v.fallback(v.union([v.literal("python"), v.literal("js")]), "python"),
	explanation: v.fallback(v.string(), ""),
});

export interface BaselineResult {
	code: string;
	language: "python" | "js";
	explanation: string;
	passed: boolean;
	reason: string;
	durationMs: number;
	llmMs: number;
}

export async function runBaseline(
	problem: string,
	domainSpec: DomainSpec,
): Promise<BaselineResult> {
	const t0 = Date.now();

	const prompt = `You are a programmer. Solve the following problem by writing a Python function named \`proposedSolution\`.

Problem:
${problem}

${domainSpec.solutionFormat ? `Expected function: ${domainSpec.solutionFormat}` : "Write a function named proposedSolution that returns the answer."}

Rules:
- Language: Python 3. Standard library (math, collections, itertools, heapq, functools, etc.) is allowed. No third-party packages (no numpy, scipy, pandas, etc.)
- Function must be named exactly \`proposedSolution\`
- Return the answer directly
- PYTHON: use proper newlines and indentation — NEVER put an entire function on one line with semicolons

Return ONLY valid JSON:
{
  "code": "<complete Python function as a single string>",
  "language": "python",
  "explanation": "<one sentence>"
}`.trim();

	let code = "";
	let language: "python" | "js" = "python";
	let explanation = "";
	let llmMs = 0;

	try {
		const t1 = Date.now();
		const result = await queryReasoning({
			userPrompt: prompt,
			schema: baselineSchema,
			temperature: 0.2,
			_role: "baseline",
		});
		llmMs = Date.now() - t1;
		code = result.response.code;
		language = result.response.language;
		explanation = result.response.explanation;
	} catch (err) {
		return {
			code: "",
			language: "python",
			explanation: "",
			passed: false,
			reason: `LLM error: ${err instanceof Error ? err.message.slice(0, 100) : String(err)}`,
			durationMs: Date.now() - t0,
			llmMs: 0,
		};
	}

	// Run through the same oracle as the system
	// Normalize literal \n sequences that jsonrepair may have introduced
	const rawCode = code.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\'/g, "'");
	// Apply the same pre-execution validator the system uses
	const validation = language === "python" ? validateAndFixPython(rawCode) : { ok: true, source: rawCode, autoFixed: false };
	const normalizedCode = validation.source;

	const fakeProposal: Proposal = {
		hypothesis: "baseline",
		expected_benefit: "",
		assumptions: [],
		possible_failure_modes: [],
		suggested_tests: [],
		executable: { type: "code", lang: language, source: normalizedCode },
	};

	const fakeArtifact = {
		id: "baseline",
		sourceCode: normalizedCode,
		problemId: "baseline",
		parentId: null,
		depth: 0,
		status: "alive" as const,
		score: null,
		hypothesisText: "baseline",
		formalStatement: null,
		payload: fakeProposal,
		latestExecutionId: null,
		confidenceLevel: 0,
		title: "baseline",
		provenance: null,
		createdAt: new Date().toISOString(),
	} as unknown as Artifact;

	let passed = false;
	let reason = "oracle-not-run";

	try {
		const execResult = await domainSpec.run(fakeProposal, {} as any, fakeArtifact);
		passed = execResult.overallPassed;
		reason = execResult.stages[0]?.reason ?? (passed ? "ok" : "failed");
	} catch (err) {
		reason = `oracle-error: ${err instanceof Error ? err.message.slice(0, 100) : String(err)}`;
	}

	return { code, language, explanation, passed, reason, durationMs: Date.now() - t0, llmMs };
}
