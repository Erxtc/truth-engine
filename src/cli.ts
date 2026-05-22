/**
 * CLI argument parser for truth-engine.
 *
 * Usage:
 *   bun run src/main.ts --problem "..." --domain sorting
 *   bun run src/main.ts --problem "..." --domain auto
 *   bun run src/main.ts --problem "..." --domain auto --confidence 3
 *   bun run src/main.ts --problem "..." --domain sorting --consensus
 *   bun run src/main.ts --problem "..." --depth 8 --branches 4
 *
 * depth / branches / critics / consensus / confidence are all optional.
 * When omitted, the complexity estimator fills them in automatically.
 * When provided, they override the estimator's suggestions.
 *
 * Priority: CLI flags > env vars > complexity estimator > hardcoded safety floor
 */

export interface CliConfig {
	domain: string;
	problem: string;

	// ── Run params — null means "let the complexity estimator decide" ──────────
	maxDepth: number | null;
	maxBranches: number | null;
	criticCount: number | null;
	requiredConfidence: number | null;
	consensus: boolean | null;

	// ── Fixed settings — always have a default ─────────────────────────────────
	scoreThreshold: number;
	consensusChains: number;
}

const DEFAULTS: CliConfig = {
	domain: "sorting",
	problem: `
Optimize a JavaScript sort function for large integer arrays (>1M elements).
Current baseline: Array.prototype.sort() on [1_000_000 random integers].
Target: measurable throughput improvement with no correctness regression.
`.trim(),
	// All null → complexity estimator decides
	maxDepth:           null,
	maxBranches:        null,
	criticCount:        null,
	requiredConfidence: null,
	consensus:          null,
	// Fixed defaults
	scoreThreshold:  60,
	consensusChains: 2,
};

function parseArgs(argv: string[]): Partial<CliConfig> {
	const result: Partial<CliConfig> = {};
	let i = 0;

	while (i < argv.length) {
		const arg = argv[i]!;

		if (arg === "--problem" || arg === "-p") {
			result.problem = argv[++i] ?? "";
		} else if (arg === "--domain" || arg === "-d") {
			result.domain = argv[++i] ?? "auto";
		} else if (arg === "--confidence" || arg === "-c") {
			const v = Number(argv[++i]);
			result.requiredConfidence = [1, 2, 3, 4].includes(v) ? v : null;
		} else if (arg === "--consensus") {
			result.consensus = true;
		} else if (arg === "--no-consensus") {
			result.consensus = false;
		} else if (arg === "--depth") {
			result.maxDepth = Math.max(1, Number(argv[++i]) || 4);
		} else if (arg === "--branches") {
			result.maxBranches = Math.max(1, Number(argv[++i]) || 2);
		} else if (arg === "--critics") {
			result.criticCount = Math.max(1, Number(argv[++i]) || 2);
		} else if (arg === "--threshold") {
			result.scoreThreshold = Number(argv[++i]) || DEFAULTS.scoreThreshold;
		} else if (arg === "--chains") {
			result.consensusChains = Math.max(2, Number(argv[++i]) || DEFAULTS.consensusChains);
		}

		i++;
	}

	return result;
}

function fromEnv(): Partial<CliConfig> {
	const result: Partial<CliConfig> = {};
	if (process.env.DOMAIN)           result.domain = process.env.DOMAIN;
	if (process.env.PROBLEM_DESC)     result.problem = process.env.PROBLEM_DESC;
	if (process.env.CONSENSUS === "true")  result.consensus = true;
	if (process.env.CONSENSUS === "false") result.consensus = false;
	if (process.env.CONSENSUS_CHAINS) result.consensusChains = Number(process.env.CONSENSUS_CHAINS);
	if (process.env.MAX_DEPTH)        result.maxDepth = Number(process.env.MAX_DEPTH);
	if (process.env.MAX_BRANCHES)     result.maxBranches = Number(process.env.MAX_BRANCHES);
	if (process.env.CRITIC_COUNT)     result.criticCount = Number(process.env.CRITIC_COUNT);
	return result;
}

export function loadConfig(): CliConfig {
	const args = parseArgs(process.argv.slice(2));
	const env = fromEnv();
	return { ...DEFAULTS, ...env, ...args };
}

export function printConfig(cfg: CliConfig, resolvedDepth?: number, resolvedBranches?: number, resolvedCritics?: number): void {
	console.log(`  Domain:      ${cfg.domain}`);
	console.log(`  Problem:     ${cfg.problem.slice(0, 100)}${cfg.problem.length > 100 ? "…" : ""}`);
	const depth    = resolvedDepth    ?? cfg.maxDepth    ?? "auto";
	const branches = resolvedBranches ?? cfg.maxBranches ?? "auto";
	const critics  = resolvedCritics  ?? cfg.criticCount ?? "auto";
	console.log(`  Depth:       ${depth}  Branches: ${branches}  Critics: ${critics}`);
	console.log(`  Threshold:   ${cfg.scoreThreshold}  Confidence: ${cfg.requiredConfidence ?? "auto"}`);
	console.log(`  Consensus:   ${cfg.consensus === null ? "auto" : cfg.consensus ? `yes (${cfg.consensusChains} chains)` : "off"}`);
}
