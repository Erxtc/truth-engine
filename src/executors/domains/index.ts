import type { PipelineResult, Proposal, WorkingContext, Artifact } from "../../core/types";
import { runSortingPipeline } from "./sorting-pipeline";
import { runProjectPipeline } from "./project-pipeline";
import { verifyHtmlProject, VERIFY_CLI_SCRIPT } from "./project-verify";
import { Sandbox, parseSandboxOutput } from "../sandbox/index";
import { buildSortingHarness, buildCompressionHarness } from "../sandbox/harness-builder";
import { transpileToJs, failPipeline } from "../../utils/general";
import { registerDomain, type DomainSpec } from "./registry";
export { getDomainSpec, listDomains, registerDomain, type DomainSpec } from "./registry";

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
	return failPipeline("Project domain requires code or project executable");
};

// ── CLI Project (Python CLI tools) ────────────────────────────────────────────

const cliProjectRun: DomainRun = async (proposal, ctx) => {
	if (proposal.executable.type === "project") return runProjectPipeline(proposal, ctx);
	if (proposal.executable.type === "code") {
		const sb = new Sandbox("truth-cli-verify-");
		try {
			sb.write("main.py", proposal.executable.source);
			sb.write("verify-cli-project.js", VERIFY_CLI_SCRIPT);
			const r = await sb.exec("node verify-cli-project.js 2>&1", { timeoutMs: 30_000 });
			try {
				const parsed = JSON.parse(r.stdout.trim().split("\n").pop() || r.stdout.trim());
				return {
					overallPassed: !!parsed.passed,
					stages: [{
						stageName: "CliProjectVerify",
						passed: !!parsed.passed,
						reason: parsed.reason || (parsed.passed ? "ok" : "failed"),
						runtimeMs: r.runtimeMs,
						artifacts: parsed.details ? { details: parsed.details } : undefined,
					}],
					finalMetrics: {},
				};
			} catch {
				return {
					overallPassed: false,
					stages: [{
						stageName: "CliProjectVerify",
						passed: false,
						reason: `Verify script output not JSON: ${r.stdout.slice(0, 200)}`,
						runtimeMs: r.runtimeMs,
					}],
					finalMetrics: {},
				};
			}
		} finally {
			sb.cleanup();
		}
	}
	return failPipeline("CLI project requires code or project executable");
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
	run: cliProjectRun,
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

// ── Polynomial arithmetic (hand-crafted oracle) ─────────────────────────────

const POLY_DIVISION_ORACLE_JS = `
function verify(fn) {
  function arrEq(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  function check(label, dividend, divisor, expectedQ, expectedR) {
    var r = fn(dividend, divisor);
    // Type check: must return a tuple of two arrays
    if (!Array.isArray(r) || r.length !== 2) {
      return { passed: false, reason: label + "-type: expected [quotient, remainder] array, got " + JSON.stringify(r) };
    }
    if (!Array.isArray(r[0]) || !Array.isArray(r[1])) {
      return { passed: false, reason: label + "-type: quotient and remainder must be arrays" };
    }
    if (!arrEq(r[0], expectedQ)) {
      return { passed: false, reason: label + "-quotient: expected " + JSON.stringify(expectedQ) + " got " + JSON.stringify(r[0]) };
    }
    if (!arrEq(r[1], expectedR)) {
      return { passed: false, reason: label + "-remainder: expected " + JSON.stringify(expectedR) + " got " + JSON.stringify(r[1]) };
    }
    return null; // passed
  }

  // Example 1: (x^2 - 3x + 2) / (x - 1) = x - 2, remainder 0
  var e1 = check("ex1", [1, -3, 2], [1, -1], [1, -2], [0]);
  if (e1) return e1;

  // Example 2: (x^3 - 2x^2 + 0x - 4) / (x - 3) = x^2 + x + 3, remainder 5
  var e2 = check("ex2", [1, -2, 0, -4], [1, -3], [1, 1, 3], [5]);
  if (e2) return e2;

  // Example 3: (2x^3 - 3x^2 + 4x - 5) / (x^2 - 1) = 2x - 3, remainder 6x - 8
  var e3 = check("ex3", [2, -3, 4, -5], [1, 0, -1], [2, -3], [6, -8]);
  if (e3) return e3;

  // Example 4: (3x^2 - 5) / (x^2 - 2) = 3, remainder 0x + 1
  var e4 = check("ex4", [3, 0, -5], [1, 0, -2], [3], [0, 1]);
  if (e4) return e4;

  // Example 5: (x^3 - 8) / (x - 2) = x^2 + 2x + 4, remainder 0
  var e5 = check("ex5", [1, 0, 0, -8], [1, -2], [1, 2, 4], [0]);
  if (e5) return e5;

  // Example 6: dividend degree < divisor degree -> quotient [0], remainder = dividend
  var e6 = check("ex6", [5], [1, 1], [0], [5]);
  if (e6) return e6;

  // Example 7: (x^4 - 16) / (x - 2) = x^3 + 2x^2 + 4x + 8, remainder 0
  var e7 = check("ex7", [1, 0, 0, 0, -16], [1, -2], [1, 2, 4, 8], [0]);
  if (e7) return e7;

  // Example 8: (6x^3 + 5x^2 + 0x - 7) / (3x^2 - 2x - 1) = 2x + 3, remainder 10x - 4
  var e8 = check("ex8", [6, 5, 0, -7], [3, -2, -1], [2, 3], [10, -4]);
  if (e8) return e8;

  return { passed: true, reason: "ok" };
}
`;

import { runCustomOracle } from "../../domains/oracle-runner";

registerDomain({
  name: "polynomial-arithmetic",
  invariants: [
    "Quotient and remainder must be lists of integer coefficients, highest degree first",
    "Leading zeros must be stripped from results (zero polynomial = [0])",
    "Polynomial identity must hold: dividend = quotient * divisor + remainder",
    "Degree of remainder must be less than degree of divisor (unless remainder is [0])",
  ],
  requiredConfidence: 2,
  solutionFormat: "Python function proposedSolution(dividend, divisor) returning (quotient, remainder) tuple of coefficient lists",
  async run(proposal: Proposal, _ctx: WorkingContext, artifact: Artifact) {
    return runCustomOracle(POLY_DIVISION_ORACLE_JS, proposal, artifact, "polynomial-arithmetic");
  },
});
