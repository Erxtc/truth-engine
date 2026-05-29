import type { ConfidenceLevel, PipelineResult, Proposal, WorkingContext } from "../../core/types";
import type { Artifact } from "../../db/schema";

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
	/** Oracle test source code (Python). When set, the proposer receives this as an
	 *  implementation target — "make these tests pass." Set by auto-detect for custom
	 *  domains. Built-in domains (sorting, compression) use their own oracles. */
	testSource?: string;
	/** Execute a proposal through the domain's verification pipeline */
	run(proposal: Proposal, ctx: WorkingContext, artifact: Artifact): Promise<PipelineResult>;
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
