import type { PipelineResult, Proposal, WorkingContext } from "../../core/types";
import type { Artifact } from "../../db/schema";
import { runSortingPipeline } from "./sorting-pipeline";
import { runProjectPipeline } from "./project-pipeline";
import { verifyHtmlProject } from "./project-verify";
import { Sandbox, parseSandboxOutput } from "../sandbox/index";
import { buildSortingHarness, buildCompressionHarness } from "../sandbox/harness-builder";
import { transpileToJs, failPipeline } from "../../utils/general";
import { registerDomain, type DomainSpec } from "./registry";
export { getDomainSpec, hasDomain, listDomains, registerDomain, type DomainSpec } from "./registry";

type DomainRun = DomainSpec['run'];

// ── Sandbox helper ──────────────────────────────────────────────────────────

async function runSandboxHarness(files: Record<string, string>, command: string, timeoutMs: number | undefined, pipelineName: string): Promise<PipelineResult> {
	const sb = new Sandbox();
	try {
		for (const [p, c] of Object.entries(files)) sb.write(p, c);
		return parseSandboxOutput(await sb.exec(command, { timeoutMs }), pipelineName);
	} finally {
		sb.cleanup();
	}
}

// ── Sorting (JS / TS / Python / C) ───────────────────────────────────────────

const sortingRun: DomainRun = async (proposal, ctx) => {
	if (proposal.executable.type !== "code") return failPipeline("Sorting requires code executable");
	return runSortingPipeline(proposal, ctx);
};

// ── Compression (JS / TS / Python) ───────────────────────────────────────────

const compressionRun: DomainRun = async (proposal) => {
	if (proposal.executable.type !== "code") return failPipeline("Compression requires code executable");
	const { lang, source: rawSource } = proposal.executable;
	if (lang !== "js" && lang !== "ts" && lang !== "python") return failPipeline(`Unsupported lang: ${lang}`);
	const source = lang === "js" ? transpileToJs(rawSource) : rawSource;
	const harness = buildCompressionHarness(source, lang as "js" | "ts" | "python");
	return runSandboxHarness(harness.files, harness.command, harness.timeoutMs, "CompressionPipeline");
};

// ── Sorting-style code domain factory (ts / python / c) ────────────────────────

function sortingCodeRun(lang: "ts" | "python" | "c", pipelineName: string): DomainRun {
	return async (proposal, ctx) => {
		if (proposal.executable.type === "code") {
			const harness = buildSortingHarness(proposal.executable.source, lang);
			return runSandboxHarness(harness.files, harness.command, harness.timeoutMs, pipelineName);
		}
		if (proposal.executable.type === "project") return runProjectPipeline(proposal, ctx);
		return failPipeline(`${lang} harness requires code or project executable`);
	};
}

// ── Generic Python runner (ML, chemistry, engineering, economics, biology) ────

function pythonRunner(fileName: string, stageName: string, opts?: { timeoutMs?: number; pipeTail?: boolean }): DomainRun {
	return async (proposal) => {
		if (proposal.executable.type !== "code") return failPipeline(`${stageName} requires code executable`);
		if (proposal.executable.lang !== "python") return failPipeline(`${stageName} requires python`);
		const sb = new Sandbox();
		try {
			sb.write(fileName, proposal.executable.source);
			const cmd = opts?.pipeTail ? `python3 ${fileName} 2>&1 | tail -20` : `python3 ${fileName} 2>&1`;
			const r = await sb.exec(cmd, { timeoutMs: opts?.timeoutMs ?? 120_000 });
			const passed = r.exitCode === 0 && r.stdout.trim().length > 0;
			return {
				overallPassed: passed,
				stages: [{
					stageName,
					passed,
					reason: passed ? undefined
						: r.exitCode !== 0 ? r.stdout.slice(0, 500) || r.stderr?.slice(0, 500) || "Non-zero exit"
						: "No output produced",
					runtimeMs: r.runtimeMs,
				}],
				finalMetrics: {},
			};
		} finally {
			sb.cleanup();
		}
	};
}

// ── Project (multi-file, any lang) ────────────────────────────────────────────

const projectRun: DomainRun = async (proposal, ctx) => {
	if (proposal.executable.type === "project") return runProjectPipeline(proposal, ctx);
	if (proposal.executable.type === "code") return verifyHtmlProject(proposal.executable.source);
	return runProjectPipeline(proposal, ctx);
};

// ── Registry ─────────────────────────────────────────────────────────────────

registerDomain({
	name: "sorting",
	invariants: [
		"Output array must be sorted in non-decreasing order",
		"Output must be a permutation of input (same multiset of elements)",
		"No mutation of input array",
		"Must handle empty arrays, single elements, duplicates, negative numbers",
	],
	requiredConfidence: 2,
	run: sortingRun,
});

registerDomain({
	name: "compression",
	invariants: [
		"decompress(compress(data)) === data for all inputs",
		"No data loss under any input",
		"Compression ratio must be > 1 for non-trivial data",
	],
	requiredConfidence: 2,
	run: compressionRun,
});

registerDomain({
	name: "chemistry",
	invariants: [
		"Chemical equations must be balanced (atom counts equal on both sides)",
		"Use correct units (mol, g, L, atm, K, J) and label outputs clearly",
		"Stoichiometric calculations must use correct molar ratios",
		"Molar masses must match periodic table values within 0.1 g/mol",
		"Gas law calculations must use appropriate R constant for the units",
	],
	requiredConfidence: 2,
	run: pythonRunner("calculation.py", "ChemistryCalc"),
});

registerDomain({
	name: "engineering",
	invariants: [
		"Use correct engineering formulas for the domain (structural, fluid, thermal, electrical)",
		"Apply appropriate safety factors where relevant",
		"Results must include units in comments or output labels",
		"All computed values must be physically plausible (non-negative lengths, positive stress, etc.)",
	],
	requiredConfidence: 2,
	run: pythonRunner("calculation.py", "EngineeringCalc"),
});

registerDomain({
	name: "economics",
	invariants: [
		"Supply/demand equilibria must satisfy market clearing conditions",
		"Game theory solutions must be Nash equilibria (no profitable unilateral deviation)",
		"All quantities and prices must be non-negative",
		"Results must be clearly labeled (equilibrium price, quantity, payoffs, etc.)",
	],
	requiredConfidence: 2,
	run: pythonRunner("analysis.py", "EconomicsCalc"),
});

registerDomain({
	name: "biology",
	invariants: [
		"Simulation must use standard biological models (ODE systems, kinetics, population dynamics)",
		"All quantities must be non-negative (populations, concentrations, rates)",
		"Conservation laws must hold where applicable (mass, energy, population totals)",
		"Parameters must be biologically plausible (rates, capacities, thresholds)",
		"Output must include time-series data or equilibrium states as specified",
	],
	requiredConfidence: 2,
	run: pythonRunner("simulation.py", "BiologySim"),
});

registerDomain({
	name: "ml",
	invariants: [
		"Model must not overfit (validation loss within 10% of training loss)",
		"Inference time < 100ms per sample",
		"Must include training loop, validation loop, and inference function",
	],
	requiredConfidence: 2,
	run: pythonRunner("model.py", "MLRun", { timeoutMs: 300_000, pipeTail: true }),
});

registerDomain({
	name: "typescript",
	invariants: [
		"Must be valid TypeScript with no type errors",
		"All exported functions must have explicit types",
	],
	requiredConfidence: 2,
	run: sortingCodeRun("ts", "TypeScriptPipeline"),
});

registerDomain({
	name: "python",
	invariants: [
		"Must be valid Python 3.8+",
		"No bare except clauses",
	],
	requiredConfidence: 2,
	run: sortingCodeRun("python", "PythonPipeline"),
});

registerDomain({
	name: "c",
	invariants: [
		"No undefined behavior",
		"All memory must be freed",
		"No buffer overflows",
	],
	requiredConfidence: 2,
	run: sortingCodeRun("c", "CPipeline"),
});

registerDomain({
	name: "project",
	invariants: [
		"All tests must pass",
		"Build must succeed",
		"No runtime crashes on happy path",
	],
	requiredConfidence: 2,
	run: projectRun,
});

registerDomain({
	name: "cli-project",
	invariants: [
		"Python syntax must be valid (no import errors, no syntax errors)",
		"Program must run without crashing on valid input",
		"All CLI commands/features documented in README.md must work",
	],
	requiredConfidence: 2,
	run: projectRun,
});

// ── Document-type domains (research, law, history, geography) ──────────────
// These use the task-agent with web_search + document output. Verification is
// structural: minimum content, headers, citations. The real verification happens
// inside the task-agent loop (web_search cross-referencing).

function documentDomainSpec(name: string): DomainSpec {
	return {
		name,
		invariants: [
			"Must contain specific facts with cited sources",
			"Must distinguish between established facts and uncertain claims",
			"Must have clear structure with headers/sections",
		],
		requiredConfidence: 2,
		solutionFormat: "Markdown document with sections, citations, and source URLs",
		async run(proposal: Proposal, _ctx: WorkingContext, artifact: Artifact) {
			const source = artifact.sourceCode
				?? (proposal.executable.type === "code" ? proposal.executable.source : null)
				?? "";
			const content = source.length > 50 ? source : proposal.hypothesis;
			const hasStructure = /^#+\s/m.test(content);
			const hasCitations = /https?:\/\//.test(content) || /\[.+\]/.test(content) || /citation|source|reference/i.test(content);
			const minLength = content.length > 200;
			const passed = hasStructure && minLength;
			return {
				overallPassed: passed,
				stages: [{
					stageName: "DocumentCheck",
					passed,
					reason: passed ? undefined
						: [!hasStructure && "No headers/sections", !minLength && "Too short (<200 chars)", !hasCitations && "No citations"].filter(Boolean).join("; "),
					runtimeMs: 0,
				}],
				finalMetrics: {},
			};
		},
	};
}

for (const name of ["research", "law", "history", "geography"]) {
	registerDomain(documentDomainSpec(name));
}
