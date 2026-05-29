/**
 * Auto-domain detector.
 *
 * Given a natural language problem statement, either:
 *   (a) maps to a registered domain if the problem clearly fits one, or
 *   (b) generates a custom DomainSpec with LLM-derived invariants and a
 *       JavaScript oracle function that verifies proposed solutions.
 *
 * The generated oracle is a JS function `verify(output, input)` that returns
 * `{ passed: boolean, reason: string }`. It gets compiled and sandboxed at
 * runtime (same node-based harness as other domains).
 */

import * as v from "valibot";
import { queryReasoning } from "../llm";
import { getDomainSpec, listDomains, registerDomain } from "../executors/domains";
import type { DomainSpec } from "../executors/domains/registry";
import type { Proposal, WorkingContext } from "../core/types";
import type { Artifact } from "../db/schema";
import { getCachedOracle } from "./oracle-cache";
import { generateCustomDomain } from "./oracle-generator";
import { runCustomOracle } from "./oracle-runner";

// ── Schema for the LLM's domain classification response ──────────────────────

const classifySchema = v.object({
	matched_domain: v.nullable(v.string()),
	confidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
	reasoning: v.string(),
});

// ── Domain classification ─────────────────────────────────────────────────────

async function classifyDomain(problem: string, _registered: string[]): Promise<{ matched: string | null; confidence: number }> {
	const prompt = `
You are a domain classifier for an automated problem-solving system.

Problem statement:
${problem}

Does this problem clearly fit one of these SPECIFIC domains?
- "sorting": ONLY if the problem literally says "implement merge sort", "implement quicksort", "implement bubble sort", etc. — the word "sort" must describe what to BUILD, not how to solve it.
- "compression": the ONLY goal is lossless data compression/decompression
- "math": a formal mathematical PROOF in Lean4 or Coq — NOT arithmetic, NOT code
- "chemistry": the problem asks to compute chemical quantities (molar mass, stoichiometry, reaction balancing, pH, equilibrium, gas laws, thermodynamics) — uses Python code, NOT a document
- "engineering": the problem asks to compute engineering quantities (structural analysis, beam deflection, truss forces, fluid dynamics, heat transfer, circuit analysis) — uses Python code, NOT a document
- "physics": the problem asks to compute physical quantities using formulas (kinematics, projectile motion, Newton's laws, energy, momentum, gravitation, electromagnetism, thermodynamics, optics, waves, quantum mechanics) — uses Python code, NOT a document
- "economics": the problem asks to compute economic equilibria, solve game theory, or analyze market dynamics (supply/demand, Nash equilibrium, market clearing, agent-based models) — uses Python code, NOT a document
- "biology": the problem asks to simulate a biological system (population dynamics, epidemiology, enzyme kinetics, metabolic pathways, protein interactions, ecological models, neural dynamics, genetic regulatory networks) or compute biological quantities from models
- "project": a multi-file software project with build/test commands
- "law": the problem asks for legal analysis, interpretation of laws/statutes/cases, or legal reasoning
- "history": the problem asks about historical events, analysis of historical periods, or historical figures
- "geography": the problem asks about geographic facts, demographic data, country comparisons, or spatial analysis
- "research": the problem asks for a research paper, report, analysis, or in-depth investigation that requires finding and citing sources

IMPORTANT: "law", "history", "geography", "research" are DOCUMENT domains that produce markdown reports with cited sources, NOT code.
"chemistry", "engineering", "physics", "economics", "biology" are CODE domains that produce Python code, not documents.

ALWAYS RETURN null FOR (no matter how high your confidence):
- "find the kth largest" → null (uses sorting internally, not a sorting problem)
- "topological sort" → null (graph algorithm, not a sorting algorithm)
- "group/count/frequency" → null
- Any function that computes a single answer value
- Any function involving primes, fibonacci, parentheses, arrays, strings, graphs, DP, cycles, paths
- Arithmetic ("what is X*Y") → null
- Any problem that USES sorting as a technique but isn't IMPLEMENTING a sort algorithm
- "detect cycle", "find path", "count islands", "shortest path" → null (graph problems)

Only return a domain if you are HIGHLY confident (>= 0.8) it fits exactly.
If in doubt, return null — a custom domain will be generated.

Return ONLY valid JSON:
{ "matched_domain": "sorting" | "compression" | "math" | "chemistry" | "engineering" | "physics" | "economics" | "biology" | "project" | "law" | "history" | "geography" | "research" | null, "confidence": 0.0-1.0, "reasoning": "brief explanation" }
`.trim();

	try {
		const result = await queryReasoning({ userPrompt: prompt, schema: classifySchema, temperature: 0.1 });
		return { matched: result.response.matched_domain, confidence: result.response.confidence };
	} catch {
		return { matched: null, confidence: 0 };
	}
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface AutoDetectResult {
	domain: string;
	spec: DomainSpec;
	wasGenerated: boolean;
	/** When set, the task-agent uses this domain's workflow preset
	 *  (e.g. "chemistry" → chemistry preset invariants + tool config). */
	domainType?: string;
}

/**
 * Detect or generate the domain for a problem statement.
 * Returns the resolved DomainSpec (always registered in the registry before returning).
 */
export async function detectOrGenerateDomain(problem: string): Promise<AutoDetectResult> {
	const registered = listDomains();

	// Check oracle cache FIRST — before any LLM calls
	const cached = getCachedOracle(problem);
	if (cached) {
		console.log(`[auto-detect] ♻ Reusing cached oracle for "${cached.domain_name}" (from ${cached.cachedAt.slice(0, 10)})`);
		const cachedSpec: DomainSpec = {
			name: cached.domain_name,
			invariants: cached.invariants,
			requiredConfidence: cached.required_confidence as 2 | 3,
			solutionFormat: cached.solution_format,
			testSource: cached.oracle_js,
			async run(proposal: Proposal, _ctx: WorkingContext, artifact: Artifact) {
				return runCustomOracle(cached.oracle_js, proposal, artifact, cached.domain_name);
			},
		};
		registerDomain(cachedSpec);
		return { domain: cached.domain_name, spec: cachedSpec, wasGenerated: true };
	}

	// ── Keyword pre-check (deterministic, free) ─────────────────────────
	// Registered domains with built-in verification are detected purely by
	// keyword matching, avoiding an LLM call. This is deterministic and saves
	// ~700 tokens per run for the most common domains.
	const probLower = problem.toLowerCase();

	// Sorting
	if (
		/\b(merge\s*sort|quicksort|bubble\s*sort|insertion\s*sort|selection\s*sort|heap\s*sort|radix\s*sort|shell\s*sort|sorting\s+algorithm|implement\b[^.!?]*\bsorts?\b.*sort|write\b[^.!?]*\bmerge\s*sort|write\b[^.!?]*\bquicksort)\b/i.test(probLower) &&
		!/topological\s*sort|sort.*topological|sort.*graph|sort.*dag/i.test(probLower) &&
		!/kth\s+largest|find.*(?:kth|median)|nth\s+(?:largest|smallest)|comparator|custom\s+sort/i.test(probLower)
	) {
		const s = getDomainSpec("sorting");
		if (s) { console.log("[auto-detect] Keyword → sorting"); return { domain: "sorting", spec: s, wasGenerated: false }; }
	}

	// Compression
	if (/\b(?:lossless\s+compression|compress\s+(?:and|then)\s+decompress|huffman\s+coding|lempel|deflate|gzip|bzip2|lz77|lz78|lzw|run-length\s+encod|data\s+compression\s+algorithm)\b/i.test(probLower)) {
		const s = getDomainSpec("compression");
		if (s) { console.log("[auto-detect] Keyword → compression"); return { domain: "compression", spec: s, wasGenerated: false }; }
	}

	// CLI Project
	const pCliKws = ["programming language", "compiler for", "interpreter for",
		"create a language", "design a language", "build a shell",
		"build a database", "command-line tool", "command line tool",
		"cli tool", "virtual machine", "bytecode interpreter",
		"lexer and parser", "tokenizer and parser",
		"write a compiler", "write an interpreter", "implement a language",
		"type checker", "type system", "code generator"];
	if (pCliKws.some(kw => probLower.includes(kw))) {
		const s = getDomainSpec("cli-project");
		if (s) { console.log("[auto-detect] Keyword → cli-project"); return { domain: "cli-project", spec: s, wasGenerated: false, domainType: "cli-project" }; }
	}

	// Project / Game
	const pProjKws = ["game", "snake", "pong", "tetris", "platformer", "breakout",
		"maze", "pac-man", "space invaders", "flappy bird",
		"html game", "js game", "javascript game", "web game",
		"browser game", "canvas game", "video game", "arcade game",
		"build a game", "create a game", "make a game",
		"html/css", "web app", "single page app", "single-page app",
		"frontend", "front-end", "interactive web", "web page with"];
	if (pProjKws.some(kw => probLower.includes(kw))) {
		const s = getDomainSpec("project");
		if (s) { console.log("[auto-detect] Keyword → project"); return { domain: "project", spec: s, wasGenerated: false, domainType: "project" }; }
	}

	// Document domains
	const pDocKws: [string, string[]][] = [
		["research", ["research paper", "write a report", "literature review", "analyze the", "compare the", "investigation of"]],
		["geography", ["demographic", "country compar", "population", "gdp per capita", "land area", "geographic fact", "capital of", "square kilometer", "square mile"]],
		["law", ["legal analysis", "legal implications", "statute", "jurisdiction", "constitutional", "court ruling", "case law", "legislat"]],
		["history", ["historical event", "history of", "ancient", "medieval", "world war", "cold war", "renaissance", "industrial revolution", "century"]],
	];
	for (const [dn, kwl] of pDocKws) {
		if (kwl.some(kw => probLower.includes(kw))) {
			const s = getDomainSpec(dn);
			if (s) { console.log(`[auto-detect] Keyword → document "${dn}"`); return { domain: dn, spec: s, wasGenerated: false }; }
		}
	}

	console.log("[auto-detect] No keyword match — classifying with LLM…");
	const { matched, confidence } = await classifyDomain(problem, registered);

	// Post-process: "math" domain is ONLY for formal proofs (Lean4/Coq).
	// If the problem doesn't explicitly mention proof/theorem/formal/lean/coq, reject math.
	const isFormalProof = /\b(proof|theorem|lean4?|coq|formal|prove|axiom|lemma)\b/i.test(problem);
	let domain = matched;
	if (domain === "math" && !isFormalProof) {
		console.log(`[auto-detect] Override: problem doesn't ask for formal proof, rejecting "math"`);
		domain = null;
	}
	// "project" domain is only for HTML/JS/game projects. If the problem contains
	// cli-project keywords (compiler, interpreter, programming language, etc.),
	// reject the LLM's "project" match so it falls through to cli-project detection.
	if (domain === "project") {
		const cliKeywords = [
			"programming language", "compiler for", "interpreter for",
			"create a language", "design a language", "build a shell",
			"build a database", "command-line tool", "command line tool",
			"cli tool", "virtual machine", "bytecode interpreter",
			"lexer and parser", "tokenizer and parser",
			"write a compiler", "write an interpreter", "implement a language",
			"type checker", "type system", "code generator",
		];
		if (cliKeywords.some(kw => problem.toLowerCase().includes(kw))) {
			console.log(`[auto-detect] Override: cli-project keywords detected, rejecting LLM "project" match`);
			domain = null;
		}
	}
	// Code domains (biology, chemistry, engineering, economics) always need
	// custom oracles — each problem has specific test cases. Reject classifier
	// matches so they fall through to keyword detection → custom oracle generation.
	// The registered domain still provides invariants + workflow preset via domainType.
	if (domain === "biology" || domain === "chemistry" || domain === "engineering" || domain === "physics" || domain === "economics") {
		console.log(`[auto-detect] Override: "${domain}" needs custom oracle, rejecting classifier match`);
		domain = null;
	}
	// Compression domain only fits problems asking for compress/decompress
	// function pairs. Huffman/prefix-code problems need custom oracles.
	if (domain === "compression" && !/\b(?:compress\s*\(|decompress\s*\(|compression\s+function|compression\s+utility)\b/i.test(problem)) {
		console.log(`[auto-detect] Override: "${domain}" but no compress/decompress API requested, rejecting classifier match`);
		domain = null;
	}

	if (domain && confidence >= 0.7) {
		const existing = getDomainSpec(domain);
		if (existing) {
			console.log(`[auto-detect] Matched domain: "${domain}" (confidence=${confidence.toFixed(2)})`);
			return { domain: domain!, spec: existing, wasGenerated: false };
		}
	}

	// ── Keyword-based domain detection ───────────────────────────────────────
	// Ordered by specificity: each domain's keywords are checked in priority
	// order. First match wins. Custom-oracle domains generate an oracle via LLM;
	// registered domains reuse the existing DomainSpec.

	// Code-domain keywords → custom oracle generation
	const codeDomains: Array<{ type: string; keywords: string[] }> = [
		{
			type: "cryptography", keywords: [
				"cipher", "encrypt", "decrypt", "encryption", "decryption",
				"caesar", "vigenere", "substitution cipher", "polyalphabetic",
				"xor cipher", "repeating-key xor", "single-byte xor",
				"aes", "ecb mode", "cbc mode", "block cipher", "initialization vector",
				"padding", "pkcs7", "pkcs", "pad to", "unpad",
				"base64", "base-64", "hex to base64", "base64 encode",
				"hash function", "sha256", "sha-256", "md5", "merkle-damgard",
				"hmac", "keyed hash", "message authentication",
				"diffie-hellman", "diffie hellman", "key exchange", "shared secret",
				"modular inverse", "modular exponentiation", "fast exponentiation",
				"rsa", "public key", "private key",
				"elliptic curve", "ecdsa", "digital signature",
				"one-time pad", "stream cipher", "prng", "cryptographically secure",
			],
		},
		{
			type: "economics", keywords: [
				"supply and demand", "supply curve", "demand curve", "market equilibrium",
				"deadweight loss", "nash equilibrium", "nash equilibria", "game theory", "prisoner's dilemma",
				"dominant strategy", "pareto efficiency", "marginal cost", "marginal revenue",
				"opportunity cost", "elasticity", "consumer surplus", "producer surplus",
				"monopoly", "oligopoly", "cournot", "bertrand competition",
				"auction", "utility function", "indifference curve", "budget constraint",
				"comparative advantage", "absolute advantage", "terms of trade",
				"aggregate demand", "aggregate supply", "fiscal policy", "monetary policy",
				"gdp", "inflation rate", "unemployment rate", "phillips curve",
				"public goods", "externality", "coase theorem", "moral hazard",
				"adverse selection", "principal-agent", "signaling game",
			],
		},
		{
			type: "biology", keywords: [
				"predator", "prey", "lotka", "volterra", "population dynamic",
				"sir model", "sir compartmental", "sir ", "seir model", "epidem", "infection", "infectious",
				"compartmental model",
				"enzyme", "michaelis", "menten", "protein folding", "polypeptide",
				"amino acid", "dna", "rna", "genome", "genetic", "nucleotide",
				"transcription", "cell cycle", "cell division", "stem cell",
				"t cell", "b cell", "cellular", "membrane", "organelle",
				"mitochondria", "metabolic", "metabolism", "glycolysis", "krebs",
				"atp", "neuron", "neural", "synaptic", "action potential",
				"hodgkin", "ecolog", "ecosystem", "biodiversity", "speciation",
				"mutation", "evolutionary", "phylogen", "natural selection",
				"molecular dynamic", "ligand", "receptor", "signal transduction",
				"morphogen", "turing pattern", "reaction-diffusion",
				"circadian", "homeostasis", "physiolog",
			],
		},
		{
			type: "chemistry", keywords: [
				"stoichiometry", "molar mass", "chemical reaction", "limiting reagent",
				" ph value", " ph of", " ph is", " ph =", "calculate ph", " ph level",
				" ph scale", "measure ph", "titration", "thermodynamics",
				"equilibrium constant", "enthalpy", "entropy", "gibbs free energy",
				"rate constant",
				"activation energy", "half-life", "reaction rate", "mole ratio",
				"empirical formula", "molecular formula", "percent yield",
				"theoretical yield", "ideal gas law", "partial pressure",
				"molality", "molarity", "mol/L", "acid-base", "redox",
				"oxidation number", "heat of reaction", "specific heat capacity",
				"chemical equation", "balanced equation", "reactant", "product",
			],
		},
		{
			type: "engineering", keywords: [
				"beam deflection", "truss", "stress-strain", "young's modulus",
				"shear", "moment of inertia", "bending moment", "cantilever",
				"factor of safety", "reynolds number", "bernoulli", "head loss",
				"heat transfer", "thermal conductivity", "circuit analysis",
				"ohm's law", "kirchhoff", "thevenin", "norton equivalent",
				"op-amp", "bode plot", "control system", "pid controller",
				"structural analysis", "finite element", "fluid dynamics",
				"pipe flow", "mach number", "drag coefficient", "lift coefficient",
				"tensile strength", "compressive strength", "fatigue limit",
			],
		},
	];

	for (const { type, keywords } of codeDomains) {
		if (keywords.some(kw => probLower.includes(kw))) {
			console.log(`[auto-detect] Keyword match → ${type} domain (custom oracle)`);
			const spec = await generateCustomDomain(problem);
			if (spec) {
				return { domain: spec.name, spec, wasGenerated: true, domainType: type };
			}
		}
	}

	console.log(`[auto-detect] No confident match (best="${matched ?? "none"}", conf=${confidence.toFixed(2)}) — generating custom domain…`);
	const spec = await generateCustomDomain(problem);

	if (!spec) {
		// Last resort: fall back to "research-then-implement" which is the most
		// general-purpose code+oracle workflow. Avoid "project" here — it gives an
		// HTML/JS workflow that kills algorithmic problems (e.g. gaussian-elimination
		// went 1/18 because domain detection sent it to project).
		console.warn("[auto-detect] Custom domain generation failed — falling back to 'research-then-implement'");
		const fallback = getDomainSpec("research-then-implement")!;
		return { domain: "research-then-implement", spec: fallback, wasGenerated: false };
	}

	return { domain: spec.name, spec, wasGenerated: true };
}
