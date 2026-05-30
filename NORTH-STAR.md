# North Star — aspirational agent targets

This file defines the long-term vision for what truth-engine agents should eventually
be able to tackle. It exists to orient development: every capability improvement,
every architectural decision, and every new problem added to the benchmark should
move us closer to being able to attack at least one target on this list.

**Guiding principle:** `tools + execution feedback + oracle verification > single LLM call`
scales. The same architecture that solves fibonacci should, with enough domain
expertise, better oracles, and smarter workflows, solve open research problems.

**This is NOT a roadmap with dates.** It's a direction. Targets are grouped by
domain, ordered roughly by difficulty within each domain. The question for any
development decision is: *does this move us closer to being able to tackle the
next target in at least one domain?*

---

## Mathematics

### Now (benchmark problems)
- Fibonacci, binary search, sorting, BFS/Dijkstra, edit distance, LIS
- PKCS#7 padding, Diffie-Hellman key exchange, AES-CBC decrypt
- SIR model, Gillespie SIR, Cournot duopoly, Nash equilibrium

### Next (harder solved problems — verify the pipeline can match known results)
- **Number theory**: find new proof of quadratic reciprocity; verify properties of
  Mersenne primes up to M₁₃; implement and verify prime-counting function π(x)
- **Graph theory**: prove Kuratowski's theorem (planarity); implement graph
  isomorphism for small graphs; verify the four-color theorem for specific graphs
- **Linear algebra**: implement and verify SVD, PCA from scratch; eigenvalue
  algorithms with correctness proofs
- **Optimization**: implement simplex method, interior-point methods; verify
  KKT conditions on concrete problems
- **Category theory**: verify natural transformations, adjunctions in concrete
  categories; implement and check monad laws for known monads

### Later (novel results — verified by the pipeline, not by known answers)
- Find a new fact about prime numbers (new pattern, new bound, new relationship)
- Discover a new combinatorial identity and prove it
- Generate a novel conjecture in number theory, test it against computational
  search, and either prove or disprove it
- Solve a problem from the American Mathematical Monthly or similar

### Ambitious (years-scale)
- Make genuine progress on an open problem (e.g., improve a known bound,
  find a counterexample to a conjecture, classify a new family of objects)
- Discover a new mathematical structure with useful properties

### Oracle strategy
- Symbolic verification (computer algebra systems)
- Proof assistants (Lean 4, Coq, Isabelle) — formalize result + verify
- Computational exhaustion for finite cases
- Cross-validation: independent derivation via different methods

---

## Programming Languages & Compilers

### Now
- Write correct implementations of known algorithms in JS/TS/Python

### Next
- Implement a simple interpreter for a toy language (arithmetic + variables
  + functions) that passes a test suite
- Implement a type checker for a simply-typed lambda calculus
- Write a peephole optimizer for a small IR
- Implement Hindley-Milner type inference for a minimal language
- Write a register allocator (graph-coloring or linear scan) that passes tests

### Later
- Design and implement a small but useful programming language with:
  - Sound type system (proven properties, not just "seems right")
  - Self-hosting compiler or at least a bootstrap compiler
  - Optimization passes that are verified correct on test cases
- Implement a JIT compiler for a subset of a dynamic language
- Verify compiler optimizations: prove that an optimization preserves semantics
  for a formalized subset of the language

### Ambitious
- **Best programming language**: unify types, compiler, optimal computation, and
  consistent formal semantics into a single coherent design
- Design a language that is simultaneously:
  - Formally specified (operational/denotational semantics)
  - Dependently typed with decidable type checking
  - Compiles to efficient native code
  - Has a verified core (the type checker or the runtime is formally verified)
- Discover a new compiler optimization that is correct and measurably useful

### Oracle strategy
- Reference interpreter (execution match)
- Property-based testing (QuickCheck-style) for compiler invariants
- Formal verification of optimizations (translation validation)
- Differential testing: same program, different optimization levels → same output

---

## Physics Simulation

### Now
- Heat transfer (1D PDE), projectile motion (ODE), SIR model (ODE system)

### Next
- N-body gravitational simulation with energy conservation verification
- Electromagnetic field simulation (FDTD for Maxwell's equations)
- Quantum mechanics: solve Schrödinger equation for simple potentials
  (harmonic oscillator, finite square well), verify eigenvalues
- Fluid dynamics: implement Navier-Stokes solver for simple geometries
  (lid-driven cavity), verify against benchmark solutions
- Statistical mechanics: Ising model Monte Carlo, verify phase transition

### Later
- Molecular dynamics with verified energy conservation and correct
  thermodynamic properties
- Quantum many-body: Hartree-Fock, DFT for small molecules, verify against
  experimental data
- General relativity: numerically solve Einstein field equations for simple
  spacetimes (Schwarzschild, Kerr), verify geodesics
- Plasma physics: PIC simulation with verified dispersion relations

### Ambitious
- **Best physics simulation model** spanning quantum → classical → astrophysical:
  - Unified or bridged simulation framework
  - Correct across scale transitions
  - Validated against experimental data at every scale
  - Self-verifying: the model can check its own conservation laws
- Discover a new physically meaningful simulation result that matches or
  predicts experimental data

### Oracle strategy
- Conservation laws (energy, momentum, angular momentum — must be constant)
- Known analytical solutions (harmonic oscillator eigenvalues, etc.)
- Experimental data from literature (NIST, PDG, etc.)
- Cross-model validation: different numerical methods must agree
- Symmetry verification: results must respect known symmetries of the system

---

## Biology, Chemistry & Medicine

### Next
- Enzyme kinetics: Michaelis-Menten fitting to experimental data
- Protein folding: implement and verify a simple force-field model
- Chemical reaction networks: simulate and verify mass conservation,
  detailed balance
- Pharmacokinetics: compartment models with verified parameter fitting
- Cell signaling: implement and verify a simple MAPK cascade model

### Later
- **Enzyme properties**: predict or discover new useful properties of enzymes
  from sequence + structure data, validated against experimental databases
- Molecular docking: predict binding affinities, verify against known
  protein-ligand complexes (PDBbind)
- Gene regulatory networks: infer network structure from expression data,
  verify predictions against independent datasets
- Metabolic modeling: FBA on genome-scale models, predict growth rates,
  verify against experimental data
- Protein structure prediction: implement and verify a simplified version
  of AlphaFold-style approaches for small proteins

### Ambitious
- **Most accurate inclusive model of the brain:**
  - Integrate all available data: connectomics, electrophysiology, fMRI,
    single-cell transcriptomics, behavioral assays
  - Model spanning scales: ion channels → synapses → neurons → circuits → regions
  - Self-consistent predictions validated against held-out data
  - Discover new functional properties of neural circuits
- **Cancer modeling**: integrate genomic, transcriptomic, proteomic, and
  clinical data to model cancer progression and treatment response
  - Predict drug sensitivities from tumor profiles
  - Identify novel targets validated by multiple independent data sources
  - Model tumor-immune interactions
- **Cell simulation**: whole-cell model integrating metabolism, signaling,
  gene regulation — verified against experimental measurements
- Discover a new biological mechanism that is experimentally testable and
  subsequently validated

### Oracle strategy
- Experimental databases (PDB, KEGG, STRING, GEO, TCGA, etc.)
- Conservation laws (mass, charge, energy in metabolic models)
- Cross-validation: train on one dataset, verify on held-out independent data
- Literature verification: does the prediction match published results?
- Counter-prediction: generate a falsifiable prediction, then search for
  data that would falsify it

---

## Machine Learning

### Next
- Implement backpropagation, verify gradient correctness via finite differences
- Implement and train a simple neural network on MNIST, verify accuracy
- Implement attention mechanism from scratch, verify against reference
- Implement a small transformer, train on character-level language modeling,
  verify perplexity
- Implement and verify a simple GAN or VAE on toy data

### Later
- **Novel useful ML discoveries**: find a new activation function, normalization
  method, or architecture component that improves on existing benchmarks
- Discover a simpler explanation for an observed empirical phenomenon
  (e.g., why a particular technique works)
- Reproduce a published ML result from scratch, verify against the paper's
  claims, identify any discrepancies
- Find a counterexample to a claimed property of a learning algorithm

### Ambitious
- Discover a genuinely new ML algorithm or architecture with provable
  advantages (theoretical guarantee + empirical verification)
- Find a simpler model that matches or exceeds a complex one on a
  well-established benchmark
- Automatically discover and verify a new scaling law

### Oracle strategy
- Gradient checking (finite differences vs. autodiff)
- Known benchmarks (MNIST, CIFAR, ImageNet, GLUE, etc.)
- Statistical tests: is the improvement significant?
- Reproducibility: run multiple seeds, verify results are stable
- Ablation: does the claimed contribution actually matter when removed?
- Adversarial verification: actively search for cases where the method fails

---

## Scientific Research & Discovery

### Now
- Solve known textbook problems across multiple domains
- Verify solutions against known answers (oracle)

### Next
- Reproduce a published result from the literature independently
  (e.g., re-derive a known formula, re-implement a published method,
  re-analyze public data and match the paper's conclusions)
- Perform a meta-analysis: aggregate results from multiple papers,
  check for consistency, identify contradictions
- **Write a small scientific paper** on a known problem with:
  - Correct mathematical derivation
  - Verified computational results
  - Proper citations to source literature
  - Self-contained reproducibility (code + data)

### Later
- **Write a novel scientific research paper with genuine new correct results:**
  - Start with smaller known problems: novel proof of a known theorem,
    new algorithm for a solved problem, re-analysis yielding new insight
  - Hypothesis generation → experimental design → data collection
    (computation or public data) → analysis → verification → writeup
  - The pipeline must: generate hypotheses, design falsifiable tests,
    execute the tests, analyze results, and determine whether the
    hypothesis survives
- **Follow the scientific method end-to-end:**
  1. Literature search: find what's known (web search + paper retrieval)
  2. Hypothesis generation: propose a novel, testable claim
  3. Experimental design: design a study that could falsify the claim
  4. Execution: run the experiment / computation / analysis
  5. Verification: check results via independent methods
  6. Writeup: produce a complete paper with methods, results, discussion
  7. Self-critique: the agent must try to find flaws in its own work

### Ambitious
- Produce a result that passes peer review at a legitimate venue
- Discover something genuinely new that withstands adversarial verification
  by the pipeline AND by independent human researchers

### Oracle strategy
- Reproducibility: can the result be reproduced from the code + data?
- Adversarial verification: agents tasked specifically with finding flaws
- Cross-method verification: same result via independent approaches
- Statistical rigor: appropriate tests, multiple comparison correction,
  effect sizes, not just p-values
- Literature consistency: does the result contradict known facts? If so,
  the contradiction must be explained, not ignored

---

## Trading & Finance

### Next
- Implement and backtest a simple moving-average crossover strategy,
  verify against buy-and-hold with proper statistical tests
- Implement Black-Scholes option pricing, verify against known values
- Implement mean-variance portfolio optimization, verify with historical data
- Implement a simple market-making bot in simulation, verify PnL

### Later
- **Trading bot**: design, implement, backtest, and paper-trade a strategy
  with verified edge (statistical significance, risk-adjusted returns)
- **Flash loans**: understand the mechanism, simulate arbitrage opportunities
  on historical blockchain data, verify profitability after gas
- Implement and verify a DeFi protocol simulation (AMM, lending pool)
- Discover and verify a new arbitrage or MEV pattern on historical data

### Ambitious
- **Best trading bot**: consistently profitable in paper trading across
  multiple market regimes, with verified risk management
- Discover a novel market inefficiency and verify it exists in out-of-sample
  data across multiple time periods

### Oracle strategy
- Backtesting with proper train/test/validation splits (time-series aware)
- Statistical significance of alpha (not just Sharpe > 1 with p-hacking)
- Transaction costs, slippage, and market impact modeled realistically
- Out-of-sample testing on multiple time periods
- Adversarial: can the strategy be explained by known risk factors?

---

## Video Games & Engines

### Next
- Implement a simple 2D game (Pong, Snake, Tetris) with verified game logic
- Implement a simple ECS (entity-component-system) with verified queries
- Implement basic 2D physics (collision detection + response), verify with tests

### Later
- Implement a simple 3D renderer (rasterizer) with verified triangle setup,
  clipping, and shading
- Implement a game AI (pathfinding, behavior trees), verify with win-rate
  benchmarks
- Implement procedural generation (terrain, dungeons) with verified constraints
  (connectivity, playability)

### Ambitious
- **Best video game / game engine ever**: a complete, working game engine with:
  - Correct physics (verified against analytical solutions)
  - Efficient rendering (verified visual output)
  - Robust multiplayer netcode (verified consistency)
  - Modding / scripting support with a verified sandbox
  - AI that is fun to play against (verified by human or agent playtesting)
- Generate a game that is actually fun — verified by playtesting agents
  that measure engagement metrics

### Oracle strategy
- Deterministic simulation: same inputs → same outputs
- Physics: conservation laws, collision correctness
- Rendering: reference images (pixel-diff against known-correct renderer)
- Game logic: property-based testing (e.g., player cannot walk through walls)
- AI: win rates, diversity of play, human evaluator scores

---

## Agents, Self-Improvement & Meta-Cognition

### Now
- Task-agent: ReAct loop, stuck-loop detection, premature finish guard
- Supervisor: continue/pivot/escalate/abort decisions
- Oracle: auto-hardening with 3 verification attempts

### Next
- Agent that can design and run its own experiments to answer a question
- Agent that can read a paper, implement the method, and verify the claims
- Agent that can identify gaps in its own knowledge and search to fill them
- Agent that can notice when it's wrong and course-correct without external
  prompting

### Later
- **Self-improving pipeline**: agent analyzes its own failure patterns across
  runs and proposes improvements to prompts, workflows, or oracles
- **Capability bootstrapping**: agent uses current capabilities to build the
  tools and oracles needed for the next level of capability
- **Scientific method adherence**: agent follows the full scientific method
  without shortcuts — hypothesis, design, execute, verify, report
- **Novel tool creation**: agent identifies a missing capability, designs a
  tool or oracle for it, and integrates it into the pipeline

### Ambitious
- Agent that can independently conduct a research program: formulate questions,
  design experiments, execute, analyze, write up, and submit for peer review
- Agent that discovers a genuinely new, verified, useful result with minimal
  human guidance — human provides direction, agent does the science

### Oracle strategy
- Meta-oracles: oracles that verify the verification process itself
- Self-consistency: does the agent's output match what it claimed to do?
- Reproducibility: can a second, independent agent reproduce the first
  agent's results?
- Calibration: does the agent's confidence match its actual accuracy?

---

## How These Targets Drive Development

### Which target should we work toward right now?

Look at what's currently failing and ask: **which domain's "Next" target
requires the capability that's currently broken?**

| Current weakness | Target it blocks | What to build |
|-----------------|------------------|---------------|
| Premature finish | Any multi-step research | Better success-criteria enforcement |
| Stuck loops | Any open-ended discovery | Smarter exploration strategies |
| Oracle stub rejection | Any novel result verification | Hardened oracles, cross-validation |
| No long-horizon task tracking | Scientific paper writing | Task decomposition + state tracking |
| No literature search integration | Reproducing published results | Web search → paper retrieval → claim extraction |
| Domain mismatch (code vs. doc) | Math proofs, physics derivations | Better domain detection + domain-specific oracles |
| Baseline beats pipeline (>3 calls) | Any efficiency-sensitive task | Simplify workflow or improve prompts |

### Progressive difficulty within each domain

Each domain follows a ladder:
1. **Implement known solution** → oracle verifies correctness
2. **Reproduce published result** → oracle compares to literature
3. **Solve known problem with novel method** → oracle verifies equivalence
4. **Discover and verify something new** → cross-validation + adversarial oracle
5. **Produce genuinely novel, peer-reviewable result** → full scientific method

The current pipeline is at step 1 across most domains. The next capability
jump is step 2: independent reproduction of published results.

### Oracle evolution

Current oracles are mostly unit-test style (input → expected output). The
targets above require:

- **Conservation law oracles**: energy, mass, momentum, charge must be conserved
- **Cross-method oracles**: same result via two independent approaches
- **Literature oracles**: does the result match published experimental data?
- **Proof assistant oracles**: Lean/Rosette/Coq formal verification of claims
- **Adversarial oracles**: agents specifically prompted to find flaws
- **Statistical oracles**: proper hypothesis testing, not just "looks close"
- **Reproducibility oracles**: can a second, independent agent reproduce it?

### What NOT to do

- Don't build these targets into the benchmark until the pipeline can actually
  approach them. The benchmark is for measuring progress, not wishful thinking.
- Don't add complexity that doesn't serve a specific target. "We might need
  this someday" is not a reason to build it.
- Don't chase all domains at once. Pick the domain where current weaknesses
  are the bottleneck and push that one forward.
- Don't simulate progress. If the pipeline can't genuinely do something new,
  don't dress up LLM-generated text as results.

---

## Related Documents

- `CLAUDE.md` — current architecture, dev loop, rules, diagnostic cheatsheet
- `src/test/benchmark-problems.ts` — current benchmark problem definitions
- `.efficiency-state.json` — current pipeline performance data
- `src/analysis/capability-tracker.ts` — cross-run capability learning
