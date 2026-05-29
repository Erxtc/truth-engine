/**
 * Domain workflow presets for the TaskAgent.
 *
 * Each preset configures the agent's tools, verification strategy, and system
 * prompt for a specific problem domain. Presets are applied automatically when
 * `config.domain` is set, or can be overridden with `config.workflow`.
 *
 * The key insight: the system is "better than the model alone" because it
 * provides web search (facts the model doesn't know), oracle execution
 * (verification the model can't do), and domain-specific guardrails
 * (invariants that catch hallucinations).
 */

import type { WorkflowConfig } from "./task-agent";

// ── Preset table ─────────────────────────────────────────────────────────────

const DOMAIN_PRESETS: Record<string, Partial<WorkflowConfig>> = {
  // ── Physics ──────────────────────────────────────────────────────────────
  physics: {
    solutionFiles: ["simulation.py"],
    verifyCommand: "python3 oracle.py",
    outputDescription:
      "Python physics simulation computing the requested values with proper formulas and units",
    language: "python",
    testFirst: false,
    enableWebSearch: true,
    enableNotes: true,
    researchPhases: true,
    outputType: "code",
    workspaceSetup: ["pip install numpy scipy 2>/dev/null 1>&2 || true"],
    invariants: [
      "Use standard physics formulas (kinematics, dynamics, thermodynamics as appropriate)",
      "Print computed values with appropriate decimal precision",
      "Use math.sqrt, math.sin, math.cos, math.pi for calculations",
      "Include units in comments next to key variables",
    ],
  },

  // ── Engineering ──────────────────────────────────────────────────────────
  engineering: {
    solutionFiles: ["calculation.py"],
    verifyCommand: "python3 oracle.py",
    outputDescription:
      "Python engineering calculation with proper formulas, safety factors, and units",
    language: "python",
    testFirst: false,
    enableWebSearch: true,
    enableNotes: true,
    researchPhases: true,
    outputType: "code",
    workspaceSetup: ["pip install numpy 2>/dev/null 1>&2 || true"],
    invariants: [
      "Use correct engineering formulas for the domain (structural, electrical, fluid, etc.)",
      "Apply appropriate safety factors where relevant",
      "Print ALL computed values — the oracle checks every output",
      "Use math.sqrt, math.pi, and standard Python math",
    ],
  },

  // ── Math (formal proofs) ─────────────────────────────────────────────────
  math: {
    solutionFiles: ["proof.lean"],
    verifyCommand: "lean proof.lean",
    outputDescription: "Lean4 formal proof of the stated theorem",
    language: "lean",
    testFirst: false,
    enableWebSearch: false,
    outputType: "code",
  },

  // ── Law ──────────────────────────────────────────────────────────────────
  law: {
    solutionFiles: ["analysis.md"],
    verifyCommand: "",
    outputDescription:
      "Legal analysis with: 1) Relevant legal principles, 2) Application to facts, 3) Conclusion with confidence level, 4) Citations",
    language: "markdown",
    testFirst: false,
    enableWebSearch: true,
    outputType: "document",
    outputPaths: ["analysis.md"],
    invariants: [
      "Cite specific statutes, cases, or legal principles for every claim",
      "Distinguish between settled law and open questions",
      "Note jurisdiction-specific variations",
      "Include confidence assessment (high/medium/low) for each conclusion",
    ],
  },

  // ── Geography ────────────────────────────────────────────────────────────
  geography: {
    solutionFiles: ["answer.md"],
    verifyCommand: "",
    outputDescription: "Factual answers with specific data and cited sources",
    language: "markdown",
    testFirst: false,
    enableWebSearch: true,
    outputType: "document",
    outputPaths: ["answer.md"],
    invariants: [
      "Verify ALL factual claims (populations, capitals, areas) with web_search()",
      "Cite specific URLs for key data points",
      "Note the date/source of information since data changes over time",
      "Use consistent units (metric where possible)",
    ],
  },

  // ── History ──────────────────────────────────────────────────────────────
  history: {
    solutionFiles: ["analysis.md"],
    verifyCommand: "",
    outputDescription:
      "Historical analysis with chronological accuracy and cited sources",
    language: "markdown",
    testFirst: false,
    enableWebSearch: true,
    outputType: "document",
    outputPaths: ["analysis.md"],
    invariants: [
      "Cross-reference dates and events across multiple sources",
      "Distinguish between well-established facts and historical debate",
      "Note the specific sources used for each key claim",
      "Consider multiple perspectives on contested events",
    ],
  },

  // ── Data Science ─────────────────────────────────────────────────────────
  "data-science": {
    solutionFiles: ["analysis.py"],
    verifyCommand: "python3 oracle.py",
    outputDescription:
      "Python data analysis script that reads data and outputs computed statistics",
    language: "python",
    testFirst: false,
    enableWebSearch: true,
    outputType: "code",
    workspaceSetup: ["pip install numpy pandas 2>/dev/null 1>&2 || true"],
    invariants: [
      "Handle missing values explicitly (don't silently drop data)",
      "Use csv.reader or json.load for input parsing",
      "Print ALL requested statistics clearly labeled",
      "Round floating-point results to 4 decimal places",
    ],
  },

  // ── Biology ──────────────────────────────────────────────────────────────
  biology: {
    solutionFiles: ["simulation.py"],
    verifyCommand: "python3 oracle.py",
    outputDescription:
      "Python biology simulation (population dynamics, enzyme kinetics, epidemiology, metabolic models)",
    language: "python",
    testFirst: false,
    enableWebSearch: true,
    enableNotes: true,
    researchPhases: true,
    outputType: "code",
    workspaceSetup: ["pip install numpy scipy 2>/dev/null 1>&2 || true"],
    invariants: [
      "Use standard biological models (Lotka-Volterra, SIR, Michaelis-Menten, logistic growth, etc.)",
      "Simulate using ODE solvers or discrete-time difference equations with small timesteps",
      "All populations, concentrations, and rates must be non-negative",
      "Print time-series data clearly labeled (t, S, I, R, etc.) or final equilibrium values",
      "Use scipy.integrate.solve_ivp for ODE systems when available, otherwise Euler/RK4",
      "Include biological parameter interpretations in comments",
    ],
  },

  // ── Chemistry ────────────────────────────────────────────────────────────
  chemistry: {
    solutionFiles: ["calculation.py"],
    verifyCommand: "python3 oracle.py",
    outputDescription:
      "Python chemistry calculation (stoichiometry, thermodynamics, equilibrium, kinetics)",
    language: "python",
    testFirst: false,
    enableWebSearch: true,
    enableNotes: true,
    researchPhases: true,
    outputType: "code",
    workspaceSetup: ["pip install numpy 2>/dev/null 1>&2 || true"],
    invariants: [
      "Balance chemical equations correctly",
      "Use correct units (mol, g, L, atm, K, J)",
      "Apply sigfigs appropriately in final answers",
      "Use periodic table values when needed (molar masses from web_search if uncertain)",
    ],
  },

  // ── Economics ──────────────────────────────────────────────────────────
  economics: {
    solutionFiles: ["analysis.py"],
    verifyCommand: "python3 oracle.py",
    outputDescription:
      "Python economic analysis (supply/demand equilibrium, game theory, market dynamics) computing requested values",
    language: "python",
    testFirst: false,
    enableWebSearch: true,
    enableNotes: true,
    researchPhases: true,
    outputType: "code",
    workspaceSetup: ["pip install numpy 2>/dev/null 1>&2 || true"],
    invariants: [
      "Equilibrium solutions must satisfy market clearing conditions",
      "Game theory solutions must be Nash equilibria (no profitable unilateral deviation)",
      "All prices and quantities must be non-negative",
      "Print ALL computed values clearly labeled (price, quantity, payoff, etc.)",
    ],
  },

  // ── Cryptography ───────────────────────────────────────────────────────
  cryptography: {
    solutionFiles: ["solution.py"],
    verifyCommand: "python3 oracle.py",
    outputDescription:
      "Python cryptography implementation (ciphers, hashes, key exchange, encodings) matching exact test vectors",
    language: "python",
    testFirst: false,
    enableWebSearch: false,
    outputType: "code",
    invariants: [
      "Implement the exact algorithm specified — do NOT substitute a different cipher/hash/encoding",
      "Match test vectors EXACTLY — cryptography is deterministic, no tolerance for approximation",
      "Handle edge cases: empty input, single character, inputs not aligned to block size, non-ASCII characters",
      "Use only Python built-ins (bytes, bytearray, struct) — do NOT import external crypto libraries",
      "For padding: implement PKCS#7 exactly (pad value equals number of pad bytes added)",
      "For ciphers: preserve case for alphabetic ciphers, leave non-alphabetic characters unchanged",
      "For encodings: implement the full algorithm without relying on base64 or binascii stdlib modules",
    ],
    extraRules: [
      "TEST SUB-COMPONENTS FIRST: For compound implementations (AES-CBC, HMAC, etc.), write a small test_component.py that verifies the core primitive (e.g. AES-ECB block encrypt) against a known test vector BEFORE integrating into the full mode. Run it with run_command('python3 test_component.py').",
      "SURGICAL FIXES: When only one part is broken, use edit_file to fix JUST the broken function — do NOT rewrite the entire file. Full rewrites introduce new bugs.",
      "PRINT TRACING: If verification fails with 'expected X got Y', add print() statements to trace intermediate values (key expansion output, round 1 state, XOR inputs/outputs). Compare against known intermediate test vectors from the specification.",
      "ISOLATE THE BUG: If the output is wrong but code runs without crashing, determine WHICH layer failed — is it the core primitive, the mode/chaining, or the padding? Test each layer independently.",
    ],
  },

  // ── CLI Project (compiler, interpreter, database, CLI tool) ─────────────
  "cli-project": {
    solutionFiles: ["main.py", "README.md"],
    verifyCommand: "node verify-cli-project.js",
    outputDescription:
      "Working Python CLI application with all required features implemented and tested",
    language: "python",
    testFirst: false,
    enableWebSearch: true,
    enableNotes: true,
    researchPhases: true,
    outputType: "code",
    invariants: [
      "Write a COMPLETE, working Python CLI application — no stubs, no TODOs",
      "Include a README.md explaining the project design, architecture decisions, and usage",
      "Run the program with example inputs to verify it works before calling finish()",
      "All Python files must be syntactically valid — run 'python3 -m py_compile <file>' to check",
      "Handle edge cases and errors gracefully — don't crash on unexpected input",
    ],
    extraRules: [
      "SINGLE FILE: Write ALL code in main.py. Do NOT create subdirectories or packages — the sandbox works best with flat, single-file projects. Organize with clear class definitions and sections within main.py.",
      "DESIGN FIRST: Before writing code, write a README.md explaining your language design decisions — syntax choices, type system, evaluation model. This prevents rewrites.",
      "TEST MANUALLY: After writing code, run it with at least 3 different inputs to verify it works. Create example input files and test them.",
      "RUN THE VERIFIER: node verify-cli-project.js checks syntax and execution. It must pass before finish().",
    ],
  },

  // ── Project / Game (multi-file HTML/JS/CSS) ─────────────────────────────
  project: {
    solutionFiles: ["index.html"],
    verifyCommand: "node verify-project.js",
    outputDescription:
      "Complete HTML/JavaScript application with all required features working",
    language: "html",
    testFirst: false,
    enableWebSearch: false,
    outputType: "code",
    invariants: [
      "HTML must be valid and well-formed — DOCTYPE, proper tags, no unclosed elements",
      "JavaScript must have NO syntax errors — run 'node --check' if unsure",
      "All features must be fully implemented — no stubs, no TODOs, no placeholder functions",
      "Event handlers must be wired up (keyboard, mouse, touch as needed)",
      "Test with the verify command before calling finish() — do not skip verification",
    ],
  },

  // ── Research-then-implement (general purpose) ─────────────────────────────
  "research-then-implement": {
    solutionFiles: ["solution.py"],
    verifyCommand: "python3 oracle.py",
    outputDescription:
      "Correct implementation verified against oracle test cases",
    language: "python",
    testFirst: false,
    enableWebSearch: true,
    enableNotes: true,
    researchPhases: true,
    outputType: "code",
    invariants: [
      "Research formulas, constants, and known approaches BEFORE writing code",
      "Decompose the problem into independently verifiable substeps",
      "Verify each substep before composing into the final solution",
      "Track progress in notes/todos.md — mark items done when verified",
    ],
  },

  // ── General research (any factual question) ──────────────────────────────
  research: {
    solutionFiles: ["answer.md"],
    verifyCommand: "",
    outputDescription:
      "Well-researched answer with specific facts and cited sources",
    language: "markdown",
    testFirst: false,
    enableWebSearch: true,
    outputType: "document",
    outputPaths: ["answer.md"],
    invariants: [
      "Use web_search() for every factual claim",
      "Cross-reference important facts with multiple sources",
      "Cite specific URLs",
      "Note uncertainty or conflicting sources when present",
    ],
  },
};

// ── Public API ───────────────────────────────────────────────────────────────

export function getPreset(domain: string): Partial<WorkflowConfig> | undefined {
  return DOMAIN_PRESETS[domain];
}

