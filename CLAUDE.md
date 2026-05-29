# truth-engine — project context

## What this is

A multi-agent LLM pipeline that gives models tools, verification, and iterative
refinement — capabilities no single LLM call has.

**Core bet:** `tools + execution feedback + oracle verification > single LLM call`
A single call produces code and stops. We give it eyes (sandbox), a judge (oracle
tests), tools (file I/O, shell, web search, data fetching), and a second chance (repair).

Entry: `bun run src/main.ts` | Config: `DOMAIN=auto PROBLEM_DESC="..."` | Runtime: Bun/TypeScript, SQLite, Node sandbox

Goal: build toward a general problem-solving engine that researches, simulates,
collects real data, and produces provably correct results across any domain.

### First commands

```bash
./scripts/status.sh          # Dashboard: git, benchmarks, priority targets, failures, logs
./scripts/dev.sh "problem"   # Run a single problem — auto-diagnoses pass/fail + failure mode
```

---

### Where we're going

| Horizon | Domains |
|---------|---------|
| **Now** | Algorithmic problems with oracle verification |
| **Near** | Multi-file projects, real-world data from internet, cross-language APIs |
| **Mid** | Scientific computing, provably correct papers, ML on real datasets, self-built simulation models |
| **Far** | Original math results (unsolved problems), drug/enzyme discovery via simulation, 3D/game design from philosophy, flash-loan/trading algorithms, quantum/chemistry models, new biological facts |
| **Endgame** | Solve anything — cure cancer, prove theorems, build the best game, find new physics. Full computer access, self-built tooling, self-evaluation against real-world ground truth. |

**How we get there:** Iterative, evolutionary. Pick a failing domain → build
verifiable oracles/simulations → define workflow → run baseline vs pipeline →
escalate complexity → cross-domain learning → self-improvement. Start small,
inspect logs to understand what's actually happening, fix root causes, build
upward. Every step proves itself against ground truth. The architecture that
wins emerges from testing, not from guessing.

**The capability library** (`capability-tracker.ts`, benchmarks) must stay honest.
If the system can't solve something, it says so. Fixing a known weakness is
progress; hiding it is not.

---

## Your job

The codebase IS the pipeline. You're improving the autonomous system itself.

**Correctness and validity come first.** If the system produces wrong answers,
nothing else matters. Benchmark numbers are your ground truth.

**Pick a failing problem. Read the logs. Understand WHY it failed. Fix the
smallest thing that addresses the root cause. Re-run to confirm no regressions.**

Be open-minded about better ideas — components that don't pull their weight get
deleted (11 files removed May 2026). Zoom out periodically: are you going down a
dead end? Use your judgment. You're an engineer, not a code monkey.

**Multiple agents work on this simultaneously.** Check `git status` and `git log
--oneline -5` before starting. Coordinate through clean commits.

### What to work on

```
./scripts/status.sh          # ← ALWAYS FIRST. Shows PRIORITY TARGETS, failing tier, git state
```

The **first complexity tier with <100% pass rate** is the development target.
Work bottom-up: trivial → simple → medium → hard → very-hard. Never optimize
for hard problems before easy ones pass at 100%.

If everything passes at 100%: improve efficiency (lower call counts), add harder
problems, or expand into new domains.

---

## Development loop

```
0. ./scripts/status.sh                     ← ALWAYS FIRST. Priority targets, failing tier
1. PICK a failing problem from priority targets
2. ./scripts/dev.sh "problem"              ← Test + diagnose in one command
   └─ Shows: pass/fail, oracle output, errors, failure classification, next steps
3. UNDERSTAND the failure mode (dev.sh classifies it for you)
4. FIX the smallest thing that addresses the root cause
5. ./scripts/dev.sh "problem"              ← Re-test after fix
   └─ Auto-compares to previous run: FAIL→PASS (fixed!), call/token deltas
6. bun run src/test/benchmark.ts --failing ← Confirm no regressions
7. ESCALATE — once a tier passes at 100%, work on next tier up
```

### Complexity tiers

| Tier | Count | Examples |
|------|-------|---------|
| trivial | 8 | fibonacci, binary-search, caesar-cipher, heat-transfer, ph-calculation |
| simple | 13 | coin-change, pkcs7-padding, diffie-hellman, stoichiometry, cournot-duopoly |
| medium | 8 | bfs-shortest-path, sorting-js, sir-model, projectile-motion, valid-sudoku |
| hard | 12 | dijkstra, edit-distance, LIS, topological-sort, gillespie-sir, nash-equilibrium |
| very-hard | 2 | n-queens, aes-cbc-decrypt |

### Baseline comparison

Every change evaluated against a single LLM call (no tools, no verification).
Pipeline wins when baseline fails + pipeline passes. Pipeline loses when baseline
passes + pipeline fails (fix immediately) or uses 10x more calls (simplify).

**3-call rule:** If baseline solves in 1 shot, pipeline must solve in ≤3:
classify+oracle (1) → 1-shot (1) → execute (free). Exception: repair after genuine
oracle failure (4 calls total).

---

## Debugging

All calls logged to `logs/truth-engine-*.log` with `latest.log` symlink.

**Start with `./scripts/dev.sh "problem"`** — it classifies the failure mode and
shows next steps. For deeper investigation:

```bash
./scripts/logs.sh -l              # List all runs with call + token counts
./scripts/logs.sh                 # Latest run summary (oracle, errors, actions)
./scripts/logs.sh -e              # Errors only (filtered — no prompt noise)
./scripts/logs.sh -a              # Agent actions turn-by-turn
./scripts/logs.sh -t              # Token usage per call
./scripts/logs.sh -c              # Compare last two runs (delta + result change)
./scripts/debug.sh "problem"      # Deep: per-turn breakdown, stuck-loop, failure mode
./scripts/debug.sh "problem" --full-transcript  # Full Thought→Action→Observation
grep "RAW RESPONSE" latest.log | head -100      # Model outputs directly
```

### Diagnostic questions (ask in order)

1. Did the model understand the problem? (confused → prompt wrong)
2. Did it use tools? (skipped → prompt didn't make tools compelling)
3. Did it read error output? (guessing → error messages not actionable)
4. Did it get stuck? (same action 3x → doesn't understand WHY it failed)
5. Did it finish too early? (finish() without verifying → success criteria unclear)

### Common failure patterns

| Pattern | Symptom | Fix |
|---------|---------|-----|
| Premature finish | finish() before tests pass | "MUST see all tests pass" |
| Stuck loop | Same action 3x | Terminate; forced zoom-out |
| Test blindness | Fixes code, doesn't re-run | Shorter workflow: write→run→observe |
| Oracle confusion | Doesn't understand output | Clear JSON: `{"passed": bool, "reason": "..."}` |
| Domain mismatch | Code treated as document | Check `isDocumentDomain`, `domainSpec.testSource` |
| Format rot | `**Action:**` in output | Parser handles bold/code-fence variants |

---

## Rules (do not break)

### Execution is the only truth
- Never kill proposals on LLM opinion alone. Execution verdicts only.
- No LLM self-evaluation. Same model, same blind spots.
- Oracle is the ONLY verdict. Oracle must be hardened: reject `return None/0/[]` stubs.
- **Deterministic before LLM.** Inspector, code validator, health monitor are free. Run first.
- Code validator runs before every execution — do not bypass.
- Scientific method is not optional for data-driven domains. Real data, proper methodology, reproducible.

### Efficiency
- **Cache on by default.** `CACHE_MODE=on` uses SHA256 content-addressed cache. Re-runs free.
- **One model per role.** Cheap model for classification. Don't use Claude when DeepSeek suffices.
- **Kill loops fast.** 2 identical actions → warn. 3 → terminate.
- **Skip when possible.** If a step doesn't change outcomes, delete it.
- **Before adding a new LLM call:** can a deterministic check do this? Can a cheaper model? Has it ever changed the outcome?
- **Monitor efficiency.** Benchmark auto-tracks per-problem call counts to `.efficiency-state.json`. A change that increases calls without improving pass rate gets reverted.
- **Workflow simplicity:** >5 steps is too complex. The model skips steps. Prefer `1. Write → 2. Run → 3. Fix → 4. finish()`.

### Budget caps (hard stops)

| Tier | Model | Calls | Behavior |
|------|-------|-------|----------|
| 1 | local 7B | 4-6 max | Direct-first, repair, abort |
| 2 | DeepSeek | 8 max (most ≤5) | Tier 1 + context builder, task-agent |
| 3 | Claude | 15 max | Tier 2 + consensus, deep search |

### Components removed — DO NOT REBUILD

These were deleted for cause. If you're thinking of rebuilding one, read the reason first:

| Component | Why removed |
|-----------|-------------|
| Critics | Same blind spots as proposer — rubber-stamping |
| Judge | Almost never killed proposals. Execution is the only real judge. |
| Complexity estimator | Always scored 3-4. No signal. |
| Planner | Task-agent handles multi-step problems naturally. |
| Formalizer | Confidence level 4 unreachable without Lean4/Coq tooling. |

Execution feedback is the only reliable signal. Concrete errors enable repair
(30-40% fix rate). Abstract critique ("this approach seems wrong") does not.

---

## Architecture

### Hot path (tier 2, ~3 calls solved)

```
classify + oracle (1 call)
  → oracle hardening: reject broken stubs (free)
  → 1-shot baseline (1 call)
    → execute against oracle (free)
    → if passes: 3 calls ✓
    → if fails: inspector (free) → repair (1 call) → re-execute (free)
      → if still fails: task-agent (N turns) → supervisor-guided evolution
```

### Components

| Component | File | Role |
|-----------|------|------|
| **Task-agent** | `src/llm/task-agent.ts` | ReAct loop: write_file → run_command → observe → fix. Tools: write_file, read_file, run_command (python3, node, pip install), web_search, finish. Max 5 turns. Stuck-loop detection. Premature finish guard. |
| **Oracle** | `src/domains/auto-detect.ts` | JS `verify(fn)`. Must reject 3 broken stubs. Auto-hardened (3 attempts). Cached to disk. |
| **Supervisor** | `src/agents/supervisor.ts` | Meta-cognition: continue/pivot/escalate/abort. Prevents spinning and budget burn. |
| **Repair** | `src/agents/repair.ts` | Code repair with oracle failure context. |
| **Baseline** | `src/agents/baseline.ts` | 1-shot single LLM call (no tools) for comparison. |
| **Inspector** | `src/analysis/inspector.ts` | Deterministic failure classifier (free). |
| **Capability tracker** | `src/analysis/capability-tracker.ts` | Cross-run capability learning. |
| **Efficiency tracker** | `src/analysis/efficiency-tracker.ts` | Per-problem call count tracking. |
| **Health monitor** | `src/core/health-monitor.ts` | Deterministic health checks (free). |
| **Code validator** | `src/utils/code-validator.ts` | Python/JS syntax fixing (free). |
| **LLM client** | `src/llm/llama.ts` | HTTP client, JSON repair, cache integration. |
| **Cache** | `src/llm/cache.ts` | Content-addressed response cache. |
| **Workflows** | `src/llm/workflow-presets.ts` | Domain workflow configs. |
| **Sandbox** | `src/executors/sandbox/index.ts` | Sandbox execution, code validation. |
| **Benchmark** | `src/test/benchmark.ts` | Full pipeline vs baseline comparison. |
| **Problems** | `src/test/benchmark-problems.ts` | Problem definitions (add new problems here). |

---

## Reference

### Scripts

| Script | What it does |
|--------|-------------|
| `./scripts/status.sh` | One-command dashboard: git, benchmarks, efficiency, priority targets, failures |
| `./scripts/dev.sh "problem"` | **Primary dev tool.** Runs single problem + auto-diagnoses + auto-compares to previous run (FAIL→PASS, call deltas) |
| `./scripts/logs.sh` | Latest run summary (oracle, errors, actions) |
| `./scripts/logs.sh -l` | List recent runs with call + token counts |
| `./scripts/logs.sh -e` | Errors only (filtered, no prompt noise) |
| `./scripts/logs.sh -a` | Agent actions turn-by-turn |
| `./scripts/logs.sh -t` | Token usage per call |
| `./scripts/logs.sh -c` | Compare last two runs (delta: calls, tokens, pass→fail) |
| `./scripts/debug.sh "problem"` | Deep diagnostic: per-turn breakdown, stuck-loop, failure mode, agent events |
| `./scripts/debug.sh "problem" --full-transcript` | Above + full Thought→Action→Observation transcript |

### Running the system

```bash
# ── Visibility (always first) ──
./scripts/status.sh

# ── Dev loop (test + diagnose in one command) ──
./scripts/dev.sh "fibonacci"                       # auto domain, cache on
./scripts/dev.sh "sort array" --domain=sorting     # explicit domain
./scripts/dev.sh "problem" --fresh                 # clear cache first

# ── Deep debugging ──
./scripts/debug.sh                                 # latest log analysis
./scripts/debug.sh glycolysis --full-transcript     # full turn-by-turn for matching log
./scripts/logs.sh -c                               # compare last two runs

# ── Benchmark ──
bun run src/test/benchmark.ts --failing             # only problems that failed last run
bun run src/test/benchmark.ts --tier=hard           # all problems in a tier
bun run src/test/benchmark.ts                       # full benchmark (all 41)
PROBLEM_FILTER="dijkstra" bun run src/test/benchmark.ts  # single problem

# ── Escape hatches (rarely needed) ──
CACHE_MODE=off DOMAIN=auto PROBLEM_DESC="..." bun run src/main.ts
```

### Current state (2026-05-29)

- Latest full benchmark (05-26): **37/38 (97%)** | LLM-alone: 76% | 1-shot: 79%
- Latest partial (05-29): **16/16 (100%)** at 1.6 avg calls
- **1 known failure:** glycolysis-model (energy conservation drift)
- Avg 3.6 calls/problem on full runs, ~1.6 on cache-assisted
- Check `.efficiency-state.json` and `./scripts/status.sh` for latest data
