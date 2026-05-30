// ── Core types ───────────────────────────────────────────────────────────────────

/** Confidence level: 0=proposed, 2=execution-verified, 3=peer-consensus, 4=formally-proven */
export type ConfidenceLevel = 0 | 1 | 2 | 3 | 4;

export interface RunParams {
	maxDepth: number;
	maxBranches: number;
	requiredConfidence: ConfidenceLevel;
	budgetLlmCalls: number;
}

export type Domain =
	| "sorting" | "compression" | "math" | "ml" | "physics" | "chemistry"
	| "engineering" | "economics" | "biology" | "cryptography" | "project"
	| "typescript" | "python" | "c";

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
	failureDetail?: {
		passedCount: number;
		failedCount: number;
		failures: string[];
		oracleFullOutput: string;
		oracleSource?: string;
	};
}

/** Lightweight artifact record — the minimal shape needed by domain executors. */
export interface Artifact {
	id: string;
	sourceCode?: string | null;
	status?: string;
	type?: string;
	depth?: number;
	score?: number;
	hypothesisText?: string | null;
	title?: string | null;
	confidenceLevel?: number;
	problemId?: string;
	parentId?: string | null;
	workspacePath?: string | null;
	formalStatement?: string | null;
	latestExecutionId?: string | null;
	provenance?: unknown;
	payload?: unknown;
	createdAt?: Date;
	updatedAt?: Date;
}

export interface WorkingContext {
	domain: string;
	problem: string;
	depth: number;
	oracle_spec?: string;
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
