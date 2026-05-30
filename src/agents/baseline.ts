/**
 * Baseline solver: single LLM call, no multi-agent pipeline.
 * Used to measure what the raw model can do vs. the full system.
 */

import * as v from "valibot";
import { queryReasoning } from "../llm";
import type { DomainSpec } from "../executors/domains/registry";
import type { Proposal, WorkingContext, ExecutionResult, Artifact } from "../core/types";
import { validateAndFixPython } from "../utils/code-validator";
import { normalizeEscapes } from "../utils/general";

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
	/** Structured per-test failure detail surfaced to the repair agent. */
	failureDetail?: ExecutionResult["failureDetail"];
}

export async function runBaseline(
	problem: string,
	domainSpec: DomainSpec,
	language: "python" | "js" = "python",
	/** Optional oracle test source — included so the model sees the exact tests it must pass. */
	oracleSpec?: string,
): Promise<BaselineResult> {
	const t0 = Date.now();

	const isJs = language === "js";
	const langLabel = isJs ? "JavaScript" : "Python 3";
	const funcName = "proposedSolution";
	const langRules = isJs
		? `- Language: JavaScript (plain JS, no TypeScript). Standard library only.
- Function must be named exactly \`${funcName}\`
- Return the answer directly
- JS: use proper formatting, no minified code, no one-liners`
		: `- Language: Python 3. Standard library (math, collections, itertools, heapq, functools, etc.) is allowed. No third-party packages (no numpy, scipy, pandas, etc.)
- Function must be named exactly \`${funcName}\`
- Return the answer directly
- PYTHON: use proper newlines and indentation — NEVER put an entire function on one line with semicolons`;

	const oracleBlock = oracleSpec
		? `\n\nVERIFICATION TESTS (your code MUST pass these exact tests):\n\`\`\`python\n${oracleSpec}\n\`\`\`\n\nWrite code that satisfies the test assertions above.`
		: "";

	const prompt = `You are a programmer. Solve the following problem by writing a ${langLabel} function named \`${funcName}\`.

Problem:
${problem}
${oracleBlock}

${domainSpec.solutionFormat ? `Expected function: ${domainSpec.solutionFormat}` : `Write a function named ${funcName} that returns the answer.`}

Rules:
${langRules}

Return ONLY valid JSON:
{
  "code": "<complete ${langLabel} function as a single string>",
  "language": "${language}",
  "explanation": "<one sentence>"
}`.trim();

	let code = "";
	let lang: "python" | "js" = language;
	let explanation = "";
	let llmMs = 0;

	try {
		const t1 = Date.now();
		const result = await queryReasoning({
			userPrompt: prompt,
			schema: baselineSchema,
			temperature: 0.2,
			role: "baseline",
		});
		llmMs = Date.now() - t1;
		code = result.response.code;
		lang = result.response.language;
		explanation = result.response.explanation;
	} catch (err) {
		return {
			code: "",
			language,
			explanation: "",
			passed: false,
			reason: `LLM error: ${err instanceof Error ? err.message.slice(0, 100) : String(err)}`,
			durationMs: Date.now() - t0,
			llmMs: 0,
		};
	}

	// Run through the same oracle as the system
	// Normalize literal \n sequences that jsonrepair may have introduced
	const rawCode = normalizeEscapes(code);
	// Apply the same pre-execution validator the system uses
	const validation = lang === "python" ? validateAndFixPython(rawCode) : { ok: true, source: rawCode, autoFixed: false };
	const normalizedCode = validation.source;

	const fakeContext: WorkingContext = {
		domain: domainSpec.name,
		problem,
		depth: 0,
	};

	const fakeProposal: Proposal = {
		hypothesis: "baseline",
		expected_benefit: "",
		assumptions: [],
		possible_failure_modes: [],
		suggested_tests: [],
		executable: { type: "code", lang, source: normalizedCode },
	};

	const fakeArtifact = {
		id: "baseline",
		sourceCode: normalizedCode,
		problemId: "baseline",
		parentId: null,
		depth: 0,
		status: "active" as const,
		score: 0,
		hypothesisText: "baseline",
		formalStatement: null,
		payload: fakeProposal,
		latestExecutionId: null,
		confidenceLevel: 0,
		title: "baseline",
		provenance: null,
		createdAt: new Date(),
		type: "code_module",
		workspacePath: null,
		updatedAt: new Date(),
	} as Artifact;

	let passed = false;
	let reason = "oracle-not-run";
	let failureDetail: ExecutionResult["failureDetail"] | undefined;

	try {
		const execResult = await domainSpec.run(fakeProposal, fakeContext, fakeArtifact);
		passed = execResult.overallPassed;
		reason = execResult.stages[0]?.reason ?? (passed ? "ok" : "failed");

		// ── Extract per-test failure detail for repair ──
		const stageResults = execResult.stages.flatMap(s => s.testResults ?? []);
		const failedTests = stageResults.filter(t => !t.passed);
		if (failedTests.length > 0 || !passed) {
			// Collect the full stdout/stderr from oracle execution stages
			const oracleOutput = execResult.stages
				.map(s => s.reason ?? "")
				.filter(Boolean)
				.join("\n") || reason;

			failureDetail = {
				passedCount: stageResults.filter(t => t.passed).length,
				failedCount: failedTests.length,
				failures: failedTests.map(t => t.name),
				oracleFullOutput: oracleOutput.slice(0, 2000),
				oracleSource: oracleSpec,
			};
		}
	} catch (err) {
		reason = `oracle-error: ${err instanceof Error ? err.message.slice(0, 100) : String(err)}`;
	}

	return { code, language: lang, explanation, passed, reason, durationMs: Date.now() - t0, llmMs, failureDetail };
}
