/**
 * How certain we are that an artifact is correct.
 * 0 = proposed, 2 = execution verified, 3 = peer-consensus, 4 = formally proven
 */
export type ConfidenceLevel = 0 | 1 | 2 | 3 | 4;

/** Concrete run parameters derived from CLI overrides */
export interface RunParams {
	maxDepth: number;
	maxBranches: number;
	requiredConfidence: ConfidenceLevel;
	/** Soft cap on total LLM calls for this run; supervisor enforces it */
	budgetLlmCalls: number;
}

export type Domain =
	| "sorting"
	| "compression"
	| "math"
	| "ml"
	| "physics"
	| "chemistry"
	| "engineering"
	| "economics"
	| "biology"
	| "cryptography"
	| "project"
	| "typescript"
	| "python"
	| "c";

export type ExecutablePayload =
	| { type: "code"; lang: "js" | "ts" | "python" | "c" | "markdown" | "html" | "mixed"; source: string }
	| {
		type: "project";
		lang: "js" | "ts" | "python" | "c" | "mixed";
		files: Record<string, string>;
		gitRepo?: string;
		installCommand?: string;
		buildCommand?: string;
		testCommand?: string;
		runCommand?: string;
		entrypoint?: string;
	};

export interface Proposal {
	hypothesis: string;
	expected_benefit: string;
	assumptions: string[];
	possible_failure_modes: Array<{ condition: string; issue: string }>;
	suggested_tests: Array<{ test_name: string; description: string }>;
	executable: ExecutablePayload;
}

export interface ExecutionResult {
	passed: boolean;
	reason: string;
	iterations: number;
	metrics?: Record<string, number>;
	/** Structured failure detail from the oracle: which tests failed, full output, etc.
	 *  Populated by runExecutor from PipelineResult.stages[].artifacts.
	 *  Used by the repair agent to see exactly which inputs failed. */
	failureDetail?: {
		passedCount: number;
		failedCount: number;
		failures: string[];
		oracleFullOutput: string;
		/** The oracle verification source code (JS) — shows test inputs/expected outputs */
		oracleSource?: string;
	};
}

export interface WorkingContext {
	domain: string;
	problem: string;
	depth: number;
	/** Best known working solution for this problem (confidence ≥ 2). Guides the proposer. */
	calibration_example?: {
		hypothesis: string;
		source_code: string;
		score: number;
	};
	/**
	 * Human-readable description of what a valid solution looks like.
	 * Set from DomainSpec.solutionFormat for auto-detected/custom domains.
	 */
	solution_format?: string;
	/** Oracle test source code (Python). When set, the proposer sees this as an
	 *  implementation target — "make these tests pass." Populated from
	 *  DomainSpec.testSource for custom domains. */
	oracle_spec?: string;
	/** Approximate token count of this context object (diagnostic). */
	token_budget_used?: number;
	/** When set, tells the proposer previous attempts failed and pushes for different approaches.
	   Included in the prompt to change the cache key and steer diversity. */
	retryMessage?: string;
	/** Cache-busting nonce — set by evolve() for retry/escalation/widen to force
	 *  fresh LLM responses. Included as a hidden marker in prompts. */
	nonce?: string;
}

// ── Pipeline verification types ────────────────────────────────────────────────

export interface StageResult {
	stageName: string;
	passed: boolean;
	reason?: string;
	runtimeMs: number;
	testResults?: Array<{ name: string; passed: boolean }>;
	artifacts?: Record<string, unknown>;
	metrics?: Record<string, unknown>;
}

export interface PipelineResult {
	overallPassed: boolean;
	stages: StageResult[];
	finalMetrics: Record<string, unknown>;
}
