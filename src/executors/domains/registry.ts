import type { ConfidenceLevel } from "../../core/types";
import type { Proposal, WorkingContext } from "../../core/types";
import type { PipelineResult } from "../../verification/types";
import type { Artifact } from "../../db/schema";

export interface CrossValidationResult {
	agree: boolean;
	/** Human-readable summary of what was compared and what differed */
	summary: string;
	/** Fraction of test cases where both proposals produced identical outputs (0–1) */
	agreementRate: number;
}

export interface DomainSpec {
	name: string;
	/** Domain-level invariants injected into every prompt for this domain */
	invariants: string[];
	/**
	 * Minimum confidence level required to declare the problem solved.
	 * 2 = execution-verified (default)
	 * 3 = peer-consensus (multi-chain agreement)
	 * 4 = formally-proven (math / proof domains)
	 */
	requiredConfidence: ConfidenceLevel;
	/**
	 * Human-readable description of what a valid solution looks like.
	 * Used to generate executable format rules in the proposer prompt.
	 * Optional — built-in domains use hardcoded rules in getDomainFormatRules().
	 */
	solutionFormat?: string;
	/** Execute a proposal through the domain's verification pipeline */
	run(proposal: Proposal, ctx: WorkingContext, artifact: Artifact): Promise<PipelineResult>;
	/**
	 * Cross-validate two independently-derived proposals that have both passed `run()`.
	 * Returns whether they produce equivalent outputs on a shared test suite.
	 * Required for consensus (confidence level 3). Optional for lower levels.
	 */
	crossValidate?(a: Proposal, b: Proposal): Promise<CrossValidationResult>;
}

const registry = new Map<string, DomainSpec>();

export function registerDomain(spec: DomainSpec): void {
	registry.set(spec.name, spec);
}

export function getDomainSpec(domain: string): DomainSpec | undefined {
	return registry.get(domain);
}

export function hasDomain(domain: string): boolean {
	return registry.has(domain);
}

export function listDomains(): string[] {
	return [...registry.keys()];
}
