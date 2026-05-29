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
 * depth / branches / consensus / confidence are all optional.
 * When omitted, the complexity estimator fills them in automatically.
 * When provided, they override the estimator's suggestions.
 *
 * Priority: CLI flags > env vars > complexity estimator > hardcoded safety floor
 */

export interface CliConfig {
	domain: string;
	problem: string;

	// ── Run params — null means "use defaults" ──────────────────────────────
	maxDepth: number | null;
	maxBranches: number | null;
	requiredConfidence: number | null;

	// ── Fixed settings — always have a default ─────────────────────────────────
	scoreThreshold: number;

	// ── Problem metadata ───────────────────────────────────────────────────────
	problemComplexity?: string;
	problemLanguage?: string;
}

const DEFAULTS: CliConfig = {
	domain: "sorting",
	problem: `
Optimize a JavaScript sort function for large integer arrays (>1M elements).
Current baseline: Array.prototype.sort() on [1_000_000 random integers].
Target: measurable throughput improvement with no correctness regression.
`.trim(),
	maxDepth:           null,
	maxBranches:        null,
	requiredConfidence: null,
	scoreThreshold:  60,
};

function parseArgs(argv: string[]): Partial<CliConfig> {
	const result: Partial<CliConfig> = {};
	let i = 0;

	while (i < argv.length) {
		const arg = argv[i]!;

		if (arg === "--help" || arg === "-h") {
			console.log([
				"truth-engine — multi-agent LLM pipeline with oracle verification",
				"",
				"Usage: DOMAIN=auto PROBLEM_DESC='...' bun run src/main.ts [options]",
				"",
				"Options:",
				"  -p, --problem <desc>    Problem description",
				"  -d, --domain <domain>   Domain (auto, sorting, physics, etc.)",
				"  --depth <n>             Max search depth (default: auto)",
				"  --branches <n>          Max branches (default: auto)",
				"  -c, --confidence <1-4>  Required confidence level",
				"  --threshold <n>         Score threshold (default: 60)",
				"  -h, --help              Show this help",
				"",
				"Env vars:",
				"  DOMAIN, PROBLEM_DESC, MAX_DEPTH, MAX_BRANCHES",
				"  CACHE_MODE=off|clear     Control LLM response cache",
				"  MODEL_OVERRIDE=<model>   Force all models to one",
				"  MODEL_OVERRIDE_META=<m>  Override meta-cognitive model",
				"  MODEL_OVERRIDE_IMPL=<m>  Override implementation model",
				"  LOG_PROMPTS=false        Disable prompt logging",
				"",
				"Benchmark:",
				"  bun run src/test/benchmark.ts --all       Full benchmark",
				"  bun run src/test/benchmark.ts --failing   Failing problems only",
				"  bun run src/test/benchmark.ts --tier=hard  All in tier",
				"  PROBLEM_FILTER='name' bun run src/test/benchmark.ts",
				"",
				"Status:",
				"  ./scripts/status.sh       Full dashboard",
				"  ./scripts/logs.sh          Latest run summary",
			].join("\n"));
			process.exit(0);
		} else if (arg === "--problem" || arg === "-p") {
			result.problem = argv[++i] ?? "";
		} else if (arg === "--domain" || arg === "-d") {
			result.domain = argv[++i] ?? "auto";
		} else if (arg === "--confidence" || arg === "-c") {
			const v = Number(argv[++i]);
			result.requiredConfidence = [1, 2, 3, 4].includes(v) ? v : null;
		} else if (arg === "--depth") {
			result.maxDepth = Math.max(1, Number(argv[++i]) || 4);
		} else if (arg === "--branches") {
			result.maxBranches = Math.max(1, Number(argv[++i]) || 2);
		} else if (arg === "--threshold") {
			result.scoreThreshold = Number(argv[++i]) || DEFAULTS.scoreThreshold;
		}

		i++;
	}

	return result;
}

function fromEnv(): Partial<CliConfig> {
	const result: Partial<CliConfig> = {};
	if (process.env.DOMAIN)           result.domain = process.env.DOMAIN;
	if (process.env.PROBLEM_DESC)     result.problem = process.env.PROBLEM_DESC;
	if (process.env.MAX_DEPTH)        result.maxDepth = Number(process.env.MAX_DEPTH);
	if (process.env.MAX_BRANCHES)     result.maxBranches = Number(process.env.MAX_BRANCHES);
	if (process.env.PROBLEM_COMPLEXITY) result.problemComplexity = process.env.PROBLEM_COMPLEXITY;
	if (process.env.PROBLEM_LANGUAGE) result.problemLanguage = process.env.PROBLEM_LANGUAGE;
	return result;
}

export function loadConfig(): CliConfig {
	const args = parseArgs(process.argv.slice(2));
	const env = fromEnv();
	return { ...DEFAULTS, ...env, ...args };
}

