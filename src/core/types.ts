export type Domain = "sorting" | "compression" | "math" | "ml" | "physics" | "project";

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
	| { type: "code"; lang: "js" | "ts" | "python"; source: string }
	| { type: "proof"; system: "lean4" | "coq"; source: string }
	| { type: "sim"; engine: "qutip" | "custom"; config: Record<string, unknown> }
	| {
		type: "project";
		lang: "js" | "ts" | "python" | "mixed";
		files: Record<string, string>;
		buildCommand?: string;
		testCommand?: string;
		runCommand?: string;
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
}