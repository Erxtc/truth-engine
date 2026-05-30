# truth-engine — project context

## Agent Quick Start

```bash
./scripts/status.sh                    # ← ALWAYS FIRST: priority targets, git, failures
./scripts/dev.sh "problem"             # Test + auto-diagnose one problem
./scripts/dev.sh "problem" --fresh     # Clear LLM cache first
```

**Core bet:** `tools + execution feedback + oracle verification > single LLM call`

```
╔══════════════════════════════════════════════════════════════════╗
║  🛑  CRITICAL: OTHER AGENTS ARE WORKING HERE RIGHT NOW          ║
║                                                                  ║
║  DO NOT DELETE any of these — they are NOT dead code:            ║
║    • scripts/           — all shell scripts, stream-filter.ts    ║
║    • prompts.json       — prompt catalog for bun develop         ║
║    • package.json       — all scripts entries are intentional    ║
║    • CLAUDE.md          — this file, read by every agent         ║
║    • logs/              — agent output and session state         ║
║                                                                  ║
║  BEFORE deleting ANY file:                                       ║
║    1. Is it imported or referenced anywhere? Check with grep.    ║
║    2. Could another agent depend on it? If unsure, leave it.     ║
║    3. Is it in the list above? If yes, NEVER delete.             ║
║                                                                  ║
║  If you need to clean up:                                        ║
║    • Rename or comment out instead of deleting                   ║
║    • Only delete files inside src/ that are truly unreferenced   ║
║    • NEVER delete anything in scripts/, root config files,       ║
║      or any *.json/*.sh/*.ts file at the project root            ║
║                                                                  ║
║  Violating this breaks other agents' workflow. Don't do it.      ║
╚══════════════════════════════════════════════════════════════════╝
```

When you're given a task, follow this cycle:
1. `./scripts/status.sh` — see priority targets and failing tier
2. Pick a failing problem → `./scripts/dev.sh "problem"` — auto-classifies failure
3. Read the log output → understand WHY it failed
4. Fix the smallest thing that addresses the root cause
5. Re-run `./scripts/dev.sh "problem"` — auto-compares to previous run
6. `bun run src/test/benchmark.ts --failing` — confirm no regressions

**Tip:** If dev.sh says it's a stuck loop, the model needs a better prompt or simpler workflow. If all tests fail, it's likely a stub output (return 0/None/[]). If some tests pass, focus on the specific failing cases.

---

## Diagnostic Cheatsheet

| What you need | Command |
|---------------|---------|
| What's failing right now | `./scripts/status.sh` |
| Test one problem + diagnose | `./scripts/dev.sh "problem"` |
| Latest run summary | `./scripts/logs.sh` |
| Errors only (no prompt noise) | `./scripts/logs.sh -e` |
| Agent actions turn-by-turn | `./scripts/logs.sh -a` |
| Deep per-turn analysis | `./scripts/debug.sh "problem"` |
| Full Thought→Action→Observation | `./scripts/debug.sh "problem" --full-transcript` |
| Compare last two runs | `./scripts/logs.sh -c` |
| List all runs + stats | `./scripts/logs.sh -l` |
| Machine-readable failure | `./scripts/debug.sh --json` |
| Token usage per call | `./scripts/logs.sh -t` |
| Raw model outputs | `grep "RAW RESPONSE" latest.log \| head -100` |

### Reading a log quickly

```
./scripts/logs.sh        → oracle results + errors + actions (all in one)
./scripts/logs.sh -e      → just the failures, no prompt sections
./scripts/debug.sh --json → structured JSON for programmatic consumption
```

### Diagnosing a failure (ask in order)

1. Did the model understand the problem? → check first turn's action
2. Did it use tools? → if no `run_command`, prompt didn't make tools compelling
3. Did it read error output? → if it keeps making same fix, errors aren't actionable
4. Did it get stuck? → same action 3x = doesn't understand WHY it failed
5. Did it finish too early? → finish() before tests pass = success criteria unclear

### Common failure patterns

| Pattern | Symptom | Fix |
|---------|---------|-----|
| Premature finish | finish() before tests pass | "MUST see all tests pass" in prompt |
| Stuck loop | Same action 3x | Terminate; forced zoom-out |
| Test blindness | Fixes code, doesn't re-run | Shorter workflow: write→run→observe |
| Oracle confusion | Doesn't understand output | Clear JSON: `{"passed": bool, "reason": "..."}` |
| Domain mismatch | Code treated as document | Check `isDocumentDomain`, `domainSpec.testSource` |
| Format rot | `**Action:**` in output | Parser handles bold/code-fence variants |
| All tests failing | Every test fails | Likely stub output (return 0/None/[]) — check function signature |

---

## Development Loop

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

**Work bottom-up.** Never optimize for hard problems before easy ones pass at 100%.
If everything passes: improve efficiency (lower call counts), add harder problems, or expand domains.

### Baseline comparison

Every change evaluated against a single LLM call (no tools, no verification).
- Pipeline wins: baseline fails + pipeline passes
- Pipeline loses: baseline passes + pipeline fails (fix immediately) or >10x calls (simplify)
- **3-call rule:** If baseline solves in 1 shot, pipeline must solve in ≤3: classify+oracle (1) → 1-shot (1) → execute (free). Exception: repair after genuine oracle failure (4 calls).

---

## Rules

### Execution is the only truth
- Never kill proposals on LLM opinion alone. Execution verdicts only.
- No LLM self-evaluation. Same model, same blind spots.
- Oracle is the ONLY verdict. Oracle must be hardened: reject `return None/0/[]` stubs.
- **Deterministic before LLM.** Code validator, health monitor are free. Run first.
- Code validator runs before every execution — do not bypass.

### Efficiency
- **Cache on by default.** `CACHE_MODE=on` uses SHA256 content-addressed cache. Re-runs free.
- **One model per role.** Cheap model for classification. Don't use Claude when DeepSeek suffices.
- **Kill loops fast.** 2 identical actions → warn. 3 → terminate.
- **Skip when possible.** If a step doesn't change outcomes, delete it.
- **Before adding a new LLM call:** can a deterministic check do this? Can a cheaper model?
- **Workflow simplicity:** >5 steps is too complex. Prefer `1. Write → 2. Run → 3. Fix → 4. finish()`.

### Budget caps (hard stops)

| Tier | Model | Calls | Behavior |
|------|-------|-------|----------|
| 1 | local 7B | 4-6 max | Direct-first, repair, abort |
| 2 | DeepSeek | 8 max (most ≤5) | Tier 1 + context builder, task-agent |
| 3 | Claude | 15 max | Tier 2 + consensus, deep search |

### Components removed — DO NOT REBUILD

| Component | Why removed |
|-----------|-------------|
| Critics | Same blind spots as proposer — rubber-stamping |
| Judge | Almost never killed proposals. Execution is the only real judge. |
| Complexity estimator | Always scored 3-4. No signal. |
| Planner | Task-agent handles multi-step problems naturally. |
| Formalizer | Confidence level 4 unreachable without Lean4/Coq tooling. |

Execution feedback is the only reliable signal. Concrete errors enable repair (30-40% fix rate).

### Protected infrastructure — do NOT delete or modify without explicit request

This section refers ONLY to pipeline agent components above. Scripts, config files,
package.json entries, and prompts.json are INFRASTRUCTURE — never delete them.

- `package.json` scripts — all of them (`develop`, `start`, `test`, `typecheck`, etc.)
- `scripts/*.sh` — all shell scripts are intentional infrastructure
- `scripts/*.ts` — stream-filter and other script utilities
- `prompts.json` — prompt catalog for `bun develop`
- `CLAUDE.md` — this file (you're reading it)

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
| **Task-agent** | `src/llm/task-agent.ts` | ReAct loop with tools (write_file, run_command, web_search, etc.), stuck-loop detection, premature finish guard |
| **Task-agent prompt** | `src/llm/task-agent-prompt.ts` | System prompt builder — the single biggest lever for model behavior |
| **Oracle** | `src/domains/auto-detect.ts` | JS `verify(fn)`. Auto-hardened (3 attempts). Cached to disk. |
| **Supervisor** | `src/agents/supervisor.ts` | Meta-cognition: continue/pivot/escalate/abort |
| **Repair** | `src/agents/repair.ts` | Code repair with oracle failure context |
| **Baseline** | `src/agents/baseline.ts` | 1-shot single LLM call (no tools) for comparison |
| **Stuck-loop detector** | `src/llm/stuck-loop-detector.ts` | Deterministic loop detection (free) |
| **Capability tracker** | `src/analysis/capability-tracker.ts` | Cross-run capability learning |
| **Health monitor** | `src/core/health-monitor.ts` | Deterministic health checks (free) |
| **Workflows** | `src/llm/workflow-presets.ts` | Domain workflow configs |
| **Sandbox** | `src/executors/sandbox/index.ts` | Sandbox execution |
| **Benchmark** | `src/test/benchmark.ts` | Full pipeline vs baseline comparison |
| **Problems** | `src/test/benchmark-problems.ts` | Problem definitions (add new problems here) |
| **Reference data** | `src/domains/reference-data.ts` | Canonical constants for standard algorithms (S-boxes, etc.) |
| **Prompt logger** | `src/utils/prompt-logger.ts` | Logs every LLM call to `logs/` |

---

## Reference

### Scripts

| Script | What it does |
|--------|-------------|
| `./scripts/status.sh` | Dashboard: git, benchmarks, priority targets, failures |
| `./scripts/dev.sh "problem"` | **Primary dev tool.** Single problem + auto-diagnose + compare to previous |
| `./scripts/dev.sh "problem" --fresh` | Clear cache first |
| `./scripts/dev.sh "problem" --domain=X` | Force explicit domain |
| `./scripts/logs.sh -l` | List all runs with call + token counts |
| `./scripts/logs.sh` | Latest run summary (oracle, errors, actions) |
| `./scripts/logs.sh -e` | Errors only (filtered, no prompt noise) |
| `./scripts/logs.sh -a` | Agent actions turn-by-turn |
| `./scripts/logs.sh -t` | Token usage per call |
| `./scripts/logs.sh -c` | Compare last two runs (delta + result change) |
| `./scripts/debug.sh "problem"` | Per-turn breakdown, stuck-loop, failure mode |
| `./scripts/debug.sh "problem" --full-transcript` | Full Thought→Action→Observation |
| `./scripts/debug.sh --json` | Machine-readable failure analysis (JSON) |

### Running the system

```bash
# ── Visibility (always first) ──
./scripts/status.sh

# ── Dev loop ──
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

# ── Escape hatches ──
CACHE_MODE=off DOMAIN=auto PROBLEM_DESC="..." bun run src/main.ts
```

### Agent philosophy

This is a group of **peer researchers working together.** Every agent (including
sub-agents) has full tool access, full file system, full shell, full web search.
No agent is subordinate. Agents spawn other researchers for independent sub-problems.

### Current state (2026-05-29)

- Latest full benchmark (05-26): **37/38 (97%)** | LLM-alone: 76% | 1-shot: 79%
- Latest partial (05-29): **16/16 (100%)** at 1.6 avg calls
- **1 known failure:** glycolysis-model (energy conservation drift)
- Avg 3.6 calls/problem on full runs, ~1.6 on cache-assisted
- Check `.efficiency-state.json` and `./scripts/status.sh` for latest data
