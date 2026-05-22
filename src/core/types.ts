/**
 * How certain we are that an artifact is correct.
 * 0 = proposed, 1 = survived critique, 2 = execution verified,
 * 3 = peer-consensus (multi-chain), 4 = formally proven
 */
export type ConfidenceLevel = 0 | 1 | 2 | 3 | 4;

export type ComplexityType =
	| "trivial"        // 1–2: single obvious approach
	| "algorithmic"    // 3–4: standard technique, minor implementation effort
	| "optimization"   // 5–6: multiple approaches, tradeoffs
	| "systems"        // 6–7: architecture + multi-component implementation
	| "research"       // 8–9: novel approach, no direct known solution
	| "formal_proof";  // 9–10: requires formal verification

/** Concrete run parameters derived from complexity assessment + CLI overrides */
export interface RunParams {
	maxDepth: number;
	maxBranches: number;
	criticCount: number;
	requiredConfidence: ConfidenceLevel;
	consensus: boolean;
	/** Soft cap on total LLM calls for this run; supervisor enforces it */
	budgetLlmCalls: number;
}

export interface ComplexityAssessment {
	/** 1–10 difficulty score */
	score: number;
	type: ComplexityType;
	/** One or two sentences explaining the rating */
	reasoning: string;
	/** How many independent sub-problems this breaks into (1 = atomic) */
	numSubproblems: number;
	/** Brief description of each sub-problem when numSubproblems > 1 */
	decompositionHint: string[];
	/** Derived run parameters — set by code, not LLM */
	suggestedParams: RunParams;
}

export type Domain =
	| "sorting"
	| "compression"
	| "math"
	| "ml"
	| "physics"
	| "project"
	| "typescript"
	| "python"
	| "c";

export type OracleHint =
	| "unit_tests"
	| "property_fuzz"
	| "benchmark"
	| "lean4_proof"
	| "qutip_sim"
	| "custom_sim"
	| "adversarial"
	| "code_review";

export interface PlanStep {
	index: number;
	goal: string;
	success_criteria: string;
	oracle_hint: OracleHint;
	depends_on: number[];
}

export interface StepPlan {
	steps: PlanStep[];
	rationale: string;
}

export type ExecutablePayload =
	| { type: "code"; lang: "js" | "ts" | "python" | "c"; source: string }
	| { type: "proof"; system: "lean4" | "coq"; source: string }
	| { type: "sim"; engine: "qutip" | "custom"; config: Record<string, unknown> }
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

export interface Critique {
	attack_type: "logic" | "assumption" | "edge_case" | "counterexample" | "complexity";
	description: string;
	severity: "fatal" | "major" | "minor";
	counterexample?: string;
	repairable: boolean;
}

export interface Verdict {
	decision: "execute" | "formalize" | "kill";
	score: number;
	reason: string;
	repairs?: string[];
	advances_step?: boolean;
	step_assessment?: string;
}

export interface ExecutionResult {
	passed: boolean;
	reason: string;
	iterations: number;
	metrics?: Record<string, number>;
}

export interface WorkingContext {
	domain: string;
	problem: string;
	depth: number;
	proven_lemmas: string[];
	failed_approaches: Array<{ summary: string; reason: string }>;
	active_invariants: string[];
	ancestor_proposals: Array<{ hypothesis: string; score: number }>;
	recent_insights: string[];
	active_constraints: string[];
	step_plan: StepPlan | null;
	current_step: PlanStep | null;
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
	/** Approximate token count of this context object (diagnostic). */
	token_budget_used?: number;
}