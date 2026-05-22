import type { Proposal, WorkingContext, Domain } from "../../core/types";
import type { PipelineResult } from "../../verification/types";
import type { Artifact } from "../../db/schema";
import { runSortingPipeline } from "./sorting-pipeline";
import { runProjectPipeline } from "./project-pipeline";
import { Sandbox, parseSandboxOutput } from "../sandbox";
import { buildSortingHarness, buildCompressionHarness } from "../sandbox/harness-builder";
import { transpileToJs } from "../../utils/general";
import { registerDomain } from "./registry";
import { crossValidateSorting } from "./cross-validate-sorting";
export { getDomainSpec, hasDomain, listDomains, registerDomain } from "./registry";

export interface KillHarness {
	run(proposal: Proposal, ctx: WorkingContext, artifact: Artifact): Promise<PipelineResult>;
}

function fail(reason: string): PipelineResult {
	return {
		overallPassed: false,
		stages: [{ stageName: "Validation", passed: false, reason, runtimeMs: 0 }],
		finalMetrics: {},
	};
}

// ── Sorting (JS / TS / Python / C) ───────────────────────────────────────────

function sortingHarness(): KillHarness {
	return {
		async run(proposal, ctx) {
			if (proposal.executable.type !== "code") return fail("Sorting requires code executable");
			return runSortingPipeline(proposal, ctx);
		},
	};
}

// ── Compression (JS / TS / Python) ───────────────────────────────────────────

function compressionHarness(): KillHarness {
	return {
		async run(proposal) {
			if (proposal.executable.type !== "code") return fail("Compression requires code executable");
			const { lang, source: rawSource } = proposal.executable;
			if (lang !== "js" && lang !== "ts" && lang !== "python") return fail(`Unsupported lang: ${lang}`);
			const source = lang === "js" ? transpileToJs(rawSource) : rawSource;
			const harness = buildCompressionHarness(source, lang as "js" | "ts" | "python");
			const sb = new Sandbox();
			try {
				for (const [p, c] of Object.entries(harness.files)) sb.write(p, c);
				const result = await sb.exec(harness.command, { timeoutMs: harness.timeoutMs });
				return parseSandboxOutput(result, "CompressionPipeline");
			} finally {
				sb.cleanup();
			}
		},
	};
}

// ── TypeScript projects ───────────────────────────────────────────────────────

function typescriptHarness(): KillHarness {
	return {
		async run(proposal, ctx) {
			// Single-function TS: treat as sorting-style code run via bun
			if (proposal.executable.type === "code") {
				const { source } = proposal.executable;
				const harness = buildSortingHarness(source, "ts");
				const sb = new Sandbox();
				try {
					for (const [p, c] of Object.entries(harness.files)) sb.write(p, c);
					const result = await sb.exec(harness.command, { timeoutMs: harness.timeoutMs });
					return parseSandboxOutput(result, "TypeScriptPipeline");
				} finally {
					sb.cleanup();
				}
			}
			// Multi-file TS project
			if (proposal.executable.type === "project") return runProjectPipeline(proposal, ctx);
			return fail("TypeScript harness requires code or project executable");
		},
	};
}

// ── Python domain ─────────────────────────────────────────────────────────────

function pythonHarness(): KillHarness {
	return {
		async run(proposal, ctx) {
			if (proposal.executable.type === "code") {
				const { source } = proposal.executable;
				const harness = buildSortingHarness(source, "python");
				const sb = new Sandbox();
				try {
					for (const [p, c] of Object.entries(harness.files)) sb.write(p, c);
					const result = await sb.exec(harness.command, { timeoutMs: harness.timeoutMs });
					return parseSandboxOutput(result, "PythonPipeline");
				} finally {
					sb.cleanup();
				}
			}
			if (proposal.executable.type === "project") return runProjectPipeline(proposal, ctx);
			return fail("Python harness requires code or project executable");
		},
	};
}

// ── C domain ─────────────────────────────────────────────────────────────────

function cHarness(): KillHarness {
	return {
		async run(proposal, ctx) {
			if (proposal.executable.type === "code") {
				const { source } = proposal.executable;
				const harness = buildSortingHarness(source, "c");
				const sb = new Sandbox();
				try {
					for (const [p, c] of Object.entries(harness.files)) sb.write(p, c);
					const result = await sb.exec(harness.command, { timeoutMs: harness.timeoutMs });
					return parseSandboxOutput(result, "CPipeline");
				} finally {
					sb.cleanup();
				}
			}
			if (proposal.executable.type === "project") return runProjectPipeline(proposal, ctx);
			return fail("C harness requires code or project executable");
		},
	};
}

// ── Math (Lean4 / Coq proof check) ────────────────────────────────────────────

function mathHarness(): KillHarness {
	return {
		async run(proposal) {
			if (proposal.executable.type !== "proof") return fail("Math requires proof executable");
			const { system, source } = proposal.executable;

			const sb = new Sandbox();
			try {
				if (system === "lean4") {
					sb.write("Main.lean", source);
					// Requires `lean` in PATH; falls back to content check if not installed
					const check = await sb.exec("which lean && lean Main.lean 2>&1 | tail -5", { timeoutMs: 60_000 });
					const passed = check.exitCode === 0;
					return {
						overallPassed: passed,
						stages: [{ stageName: "Lean4Check", passed, reason: passed ? undefined : check.stdout.slice(0, 400), runtimeMs: check.runtimeMs }],
						finalMetrics: {},
					};
				}
				if (system === "coq") {
					sb.write("proof.v", source);
					const check = await sb.exec("which coqc && coqc proof.v 2>&1 | tail -5", { timeoutMs: 60_000 });
					const passed = check.exitCode === 0;
					return {
						overallPassed: passed,
						stages: [{ stageName: "CoqCheck", passed, reason: passed ? undefined : check.stdout.slice(0, 400), runtimeMs: check.runtimeMs }],
						finalMetrics: {},
					};
				}
				return fail(`Unknown proof system: ${system}`);
			} finally {
				sb.cleanup();
			}
		},
	};
}

// ── ML (Python training loop) ─────────────────────────────────────────────────

function mlHarness(): KillHarness {
	return {
		async run(proposal) {
			if (proposal.executable.type !== "code") return fail("ML harness requires code executable");
			if (proposal.executable.lang !== "python") return fail("ML harness requires python");
			const sb = new Sandbox();
			try {
				sb.write("model.py", proposal.executable.source);
				const r = await sb.exec("python3 model.py 2>&1 | tail -20", { timeoutMs: 300_000 });
				const passed = r.exitCode === 0;
				return {
					overallPassed: passed,
					stages: [{ stageName: "MLRun", passed, reason: passed ? undefined : r.stdout.slice(0, 500), runtimeMs: r.runtimeMs }],
					finalMetrics: {},
				};
			} finally {
				sb.cleanup();
			}
		},
	};
}

// ── Physics simulation ────────────────────────────────────────────────────────

function physicsHarness(): KillHarness {
	return {
		async run(proposal) {
			if (proposal.executable.type !== "sim") return fail("Physics requires sim executable");
			const { config } = proposal.executable;
			const hasTimestep = config && "timestep" in config;
			const hasDuration = config && "duration" in config;
			const hasConds = config && "initial_conditions" in config;
			const passed = hasTimestep && hasDuration && hasConds;
			return {
				overallPassed: passed,
				stages: [{ stageName: "SimValidation", passed, reason: passed ? undefined : "Missing timestep, duration, or initial_conditions", runtimeMs: 0 }],
				finalMetrics: {},
			};
		},
	};
}

// ── Project (multi-file, any lang) ────────────────────────────────────────────

function projectHarness(): KillHarness {
	return {
		async run(proposal, ctx) {
			return runProjectPipeline(proposal, ctx);
		},
	};
}

// ── Registry ─────────────────────────────────────────────────────────────────

// Keep DOMAINS for any legacy callers; the primary interface is now getDomainSpec()
export const DOMAINS: Partial<Record<Domain, KillHarness>> = {
	sorting:     sortingHarness(),
	compression: compressionHarness(),
	typescript:  typescriptHarness(),
	python:      pythonHarness(),
	c:           cHarness(),
	math:        mathHarness(),
	ml:          mlHarness(),
	physics:     physicsHarness(),
	project:     projectHarness(),
};

// ── Domain specs (invariants + requiredConfidence) ────────────────────────────

registerDomain({
	name: "sorting",
	invariants: [
		"Output array must be sorted in non-decreasing order",
		"Output must be a permutation of input (same multiset of elements)",
		"No mutation of input array",
		"Must handle empty arrays, single elements, duplicates, negative numbers",
	],
	requiredConfidence: 2,
	run: (p, c, a) => DOMAINS.sorting!.run(p, c, a),
	crossValidate: crossValidateSorting,
});

registerDomain({
	name: "compression",
	invariants: [
		"decompress(compress(data)) === data for all inputs",
		"No data loss under any input",
		"Compression ratio must be > 1 for non-trivial data",
	],
	requiredConfidence: 2,
	run: (p, c, a) => DOMAINS.compression!.run(p, c, a),
});

registerDomain({
	name: "math",
	invariants: [
		"Proof must be constructively valid",
		"All lemmas must be referenced",
		"No circular dependencies",
		"No sorry or non-standard axioms",
	],
	requiredConfidence: 4,
	run: (p, c, a) => DOMAINS.math!.run(p, c, a),
});

registerDomain({
	name: "physics",
	invariants: [
		"Simulation must conserve energy and momentum within floating-point tolerance",
		"Timestep must respect the Courant condition",
		"Config must specify: timestep, duration, initial_conditions",
	],
	requiredConfidence: 2,
	run: (p, c, a) => DOMAINS.physics!.run(p, c, a),
});

registerDomain({
	name: "ml",
	invariants: [
		"Model must not overfit (validation loss within 10% of training loss)",
		"Inference time < 100ms per sample",
		"Must include training loop, validation loop, and inference function",
	],
	requiredConfidence: 2,
	run: (p, c, a) => DOMAINS.ml!.run(p, c, a),
});

registerDomain({
	name: "typescript",
	invariants: [
		"Must be valid TypeScript with no type errors",
		"All exported functions must have explicit types",
	],
	requiredConfidence: 2,
	run: (p, c, a) => DOMAINS.typescript!.run(p, c, a),
});

registerDomain({
	name: "python",
	invariants: [
		"Must be valid Python 3.8+",
		"No bare except clauses",
	],
	requiredConfidence: 2,
	run: (p, c, a) => DOMAINS.python!.run(p, c, a),
});

registerDomain({
	name: "c",
	invariants: [
		"No undefined behavior",
		"All memory must be freed",
		"No buffer overflows",
	],
	requiredConfidence: 2,
	run: (p, c, a) => DOMAINS.c!.run(p, c, a),
});

registerDomain({
	name: "project",
	invariants: [
		"All tests must pass",
		"Build must succeed",
		"No runtime crashes on happy path",
	],
	requiredConfidence: 2,
	run: (p, c, a) => DOMAINS.project!.run(p, c, a),
});
