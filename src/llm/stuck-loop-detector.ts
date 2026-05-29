/**
 * Deterministic stuck-loop detection for the task agent.
 *
 * Catches common failure patterns without burning LLM calls:
 *  - failure storms (4+ consecutive test failures)
 *  - same-action loops (identical tool+args 3x)
 *  - command cycles (same few commands repeated)
 *  - error repetition (same error appearing 3+ times)
 *  - test stagnation (same pass/fail counts with same reasons)
 *
 * All checks are free (no LLM calls) and run after each turn.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface TurnRecord {
  tool: string;
  key: string;        // tool + first arg for disambiguation
  summary: string;    // first 60 chars of observation
}

interface TestResultSummary {
  passCount: number;
  failCount: number;
  failReasons: string[];
}

export interface TestStagnationState {
  testResultHistory: TestResultSummary[];
}

// ── Detector ─────────────────────────────────────────────────────────────────

// ── Termination message prefixes ─────────────────────────────────────────────

const TERMINATION_PREFIXES = [
  "TERMINATED:",
  "FAILURE STORM",
  "LOOP DETECTED:",
  "STAGNATION DETECTED:",
  "ERROR LOOP",
  "CACHE LOOP",
];

/** Check if a message indicates self-termination (stuck-loop, failure storm, etc.). */
export function isSelfTerminated(summary: string): boolean {
  return TERMINATION_PREFIXES.some(p => summary.startsWith(p));
}

// ── Detector ─────────────────────────────────────────────────────────────────

export class StuckLoopDetector {
  private zoomOutCount = 0;
  private complexity: string;

  constructor(complexity: string = "medium") {
    this.complexity = complexity;
    this.zoomOutCount = 0;
  }

  /** Reset detector state (called at start of each task-agent run). */
  reset(): void {
    this.zoomOutCount = 0;
  }

  // ── Zoom-out messages ───────────────────────────────────────────────

  private zoomOutMessage(reason: string): string {
    this.zoomOutCount++;
    const isComplex = this.complexity === "hard" || this.complexity === "very-hard";
    const researchLine = isComplex
      ? `\n3. If debugging doesn't reveal the bug: STOP. The algorithm itself may be WRONG. Use web_search() to research the correct algorithm from scratch. Delete your solution file and start fresh with a completely different approach.`
      : `\n3. Fix only the specific bug you found; if the algorithm is fundamentally broken (not fixable), then start fresh`;
    return `ZOOM OUT REQUIRED: ${reason}

IMMEDIATE ACTION REQUIRED:
1. Write a DEBUG SCRIPT (debug.py) that calls your function with an example input and prints EVERY intermediate value — show the numbers changing at each step
2. Run debug.py and READ the output carefully — find the exact line where values deviate from expected
${researchLine}
4. Do NOT re-run the same failing commands without first understanding WHY they failed

DEBUG > GUESSING. One debug run is worth 10 random fixes.

This is your zoom-out #${this.zoomOutCount}. After 2 zoom-outs the task terminates.`;
  }

  private zoomOutTerminated(reason: string): string {
    return `LOOP DETECTED: You've been told to zoom out twice and are still ${reason}. The task is being terminated.`;
  }

  // ── Heuristics ──────────────────────────────────────────────────────

  checkFailureStorm(history: TurnRecord[]): string | null {
    const recentRuns = history.filter(t => t.tool === "run_command").slice(-5);
    if (recentRuns.length < 3) return null;
    const failed = recentRuns.filter(t => /Error|rror:|FAILED|Traceback|assert/.test(t.summary));
    if (failed.length >= 4) {
      return `FAILURE STORM DETECTED: ${failed.length}/${recentRuns.length} recent test runs failed. Your fixes are not addressing the root cause. The task is being terminated.\n\nLast errors seen: ${failed.map(t => t.summary.slice(0, 60)).join(" | ")}`;
    }
    if (failed.length === recentRuns.length) {
      return `FAILURE STORM DETECTED: All ${recentRuns.length} test runs have failed. Your code changes aren't fixing any of the issues. The task is being terminated.`;
    }
    return null;
  }

  checkSameActionLoop(history: TurnRecord[]): string | null {
    const last3 = history.slice(-3);
    if (new Set(last3.map(t => `${t.tool}:${t.key}`)).size !== 1) return null;
    if (this.zoomOutCount >= 2) return this.zoomOutTerminated("repeating the same actions");
    return this.zoomOutMessage(`You've called "${last3[0]!.tool}" with the same arguments 3 times in a row. You are stuck in a loop.`);
  }

  checkCommandCycle(history: TurnRecord[]): string | null {
    const last3 = history.slice(-3);
    if (!last3.every(t => t.tool === "run_command") || history.length < 4) return null;
    const uniqueCommands = new Set(history.slice(-4).map(t => t.key)).size;
    if (uniqueCommands > 2) return null;
    if (this.zoomOutCount >= 2) return this.zoomOutTerminated("running the same commands");
    return this.zoomOutMessage("You've been running the same few commands without progress. You are stuck.");
  }

  /** Detect repeating action SEQUENCES — the most common cache-poisoning pattern.
   *  Example: write_file("x.py") → ls → node oracle.js → read_file("oracle.js") → repeat.
   *  SameActionLoop misses it because each action is different.
   *  CommandCycle misses it because the cycle includes write_file and read_file.
   *
   *  Uses array comparison (not string matching) to avoid separator alignment
   *  bugs that made the old string-based approach miss cycles like
   *  run_command → read_file repeating 30+ times. */
  checkSequenceLoop(history: TurnRecord[]): string | null {
    // Need enough history: at least 3 repetitions of a 2-action sequence = 6 turns
    if (history.length < 6) return null;
    // Try sequence lengths 2, 3, 4 — look for 3+ repetitions
    for (const seqLen of [2, 3, 4]) {
      if (history.length < seqLen * 3) continue;
      const sigs = history.map(t => `${t.tool}:${t.key}`);
      const pattern = sigs.slice(-seqLen);
      // Count non-overlapping occurrences of the pattern starting from the end
      let count = 0;
      let i = sigs.length - seqLen;
      while (i >= 0 && i + seqLen <= sigs.length) {
        let match = true;
        for (let j = 0; j < seqLen; j++) {
          if (sigs[i + j] !== pattern[j]) { match = false; break; }
        }
        if (match) {
          count++;
          i -= seqLen; // non-overlapping: skip back by full pattern
        } else {
          break; // only count consecutive repetitions from the end
        }
      }
      if (count >= 3) {
        if (this.zoomOutCount >= 2) {
          return this.zoomOutTerminated(`repeating the same ${seqLen}-action sequence ${count} times`);
        }
        const actionNames = history.slice(-seqLen).map(t => t.tool).join(" → ");
        return this.zoomOutMessage(`You've repeated the same ${seqLen}-step sequence (${actionNames}) ${count} times with no progress. You are stuck in a loop.`);
      }
    }
    return null;
  }

  checkEarlyWarning(history: TurnRecord[]): string | null {
    if (history.length < 2) return null;
    const last2 = history.slice(-2);
    if (last2[0]!.tool !== last2[1]!.tool || last2[0]!.key !== last2[1]!.key) return null;
    return `WARNING: You've called "${last2[0]!.tool}" with the same arguments twice. If you repeat it again you will be forced to zoom out and start over. Read the output carefully and try a different approach NOW.`;
  }

  checkErrorRepetition(history: TurnRecord[]): string | null {
    if (history.length < 5) return null;
    function errorSig(t: TurnRecord): string {
      if (!t.summary.includes("Error") && !t.summary.includes("rror:")) return "";
      const m = t.summary.match(/(\w+Error|SyntaxError|TypeError|KeyError|NameError|ValueError|AttributeError|ImportError|IndexError)[:\s]*([^|]*)/);
      return m ? `${m[1]}: ${(m[2] ?? "").trim().slice(0, 60)}` : t.summary.slice(0, 80);
    }
    const sigs = history.map(errorSig).filter(Boolean);
    for (const sig of sigs.slice(-5)) {
      if (sigs.filter(s => s === sig).length >= 3) {
        return `ERROR LOOP DETECTED: The same error has appeared 3+ times: "${sig}". Your fixes are NOT addressing the root cause. READ the error carefully — what line and variable does it point to? Fix THAT specific line, or delete the file and try a completely different implementation.`;
      }
    }
    return null;
  }

  /** Detect exploration storms: 4+ exploration commands (ls, find, cat, read_file,
   *  pwd, which, type) in the last 5 turns without a write_file or test execution.
   *  Models get stuck "looking around" when they don't understand the problem —
   *  exploring more doesn't help; they need to commit to an approach. */
  checkExplorationStorm(history: TurnRecord[]): string | null {
    if (history.length < 5) return null;
    const EXPLORE_TOOLS = new Set(["ls", "find", "cat", "read_file", "pwd", "which", "type", "head", "tail", "wc"]);
    const PRODUCTIVE_TOOLS = new Set(["write_file", "edit_file", "run_command"]);
    const last5 = history.slice(-5);
    const exploreCount = last5.filter(t => EXPLORE_TOOLS.has(t.tool)).length;
    const productiveCount = last5.filter(t => PRODUCTIVE_TOOLS.has(t.tool)).length;
    // Storm: 4+ exploration, no productive action in last 5
    if (exploreCount >= 4 && productiveCount === 0) {
      if (this.zoomOutCount >= 2) return this.zoomOutTerminated("exploring the workspace without taking action");
      return this.zoomOutMessage(
        `You've spent ${exploreCount}/${last5.length} recent turns exploring (ls/find/cat) without writing code or running tests. ` +
        `You have all the information you need. COMMIT to an approach: write the solution file and run the tests.`
      );
    }
    return null;
  }

  /** Run all action-pattern checks. Returns first detected issue or null. */
  isStuckLoop(history: TurnRecord[]): string | null {
    if (history.length < 3) return null;
    return this.checkFailureStorm(history)
      ?? this.checkSameActionLoop(history)
      ?? this.checkCommandCycle(history)
      ?? this.checkSequenceLoop(history)
      ?? this.checkExplorationStorm(history)
      ?? this.checkEarlyWarning(history)
      ?? this.checkErrorRepetition(history);
  }

  checkTestStagnation(state: TestStagnationState): string | null {
    if (state.testResultHistory.length < 3) return null;

    const last3 = state.testResultHistory.slice(-3);

    // Same pass/fail counts 3 runs in a row — model is stuck
    const allSameCounts = last3.every(
      r => r.passCount === last3[0]!.passCount && r.failCount === last3[0]!.failCount
    );
    if (!allSameCounts) return null;

    // Also check that the fail reasons haven't changed (same bugs)
    const firstReasons = last3[0]!.failReasons.join(",");
    const allSameReasons = last3.every(r => r.failReasons.join(",") === firstReasons);

    if (allSameReasons && last3[0]!.failCount > 0) {
      if (this.zoomOutCount >= 2) {
        return `STAGNATION DETECTED: Same ${last3[0]!.failCount} test failures for 3+ runs despite zoom-outs. The task is being terminated.`;
      }
      this.zoomOutCount++;
      const isComplex = this.complexity === "hard" || this.complexity === "very-hard";
      const researchLine = isComplex
        ? `\n3. Fix that specific bug in solution.py; if the algorithm itself is unfixable, delete the file and research the correct approach from scratch using web_search(). For this problem class, the correct algorithm may be simpler than what you're implementing.`
        : `\n3. Fix that specific bug in solution.py; if the algorithm itself is unfixable, only then write a different approach`;
      return `ZOOM OUT REQUIRED: You've made 3+ attempts and the SAME ${last3[0]!.failCount} tests keep failing with the SAME errors. Your fixes aren't actually changing the behavior.

IMMEDIATE ACTION REQUIRED:
1. Write a DEBUG SCRIPT (debug.py) that calls your solution with the SAME inputs that fail and prints EVERY intermediate value
2. Run debug.py, read the output, and IDENTIFY the exact step where the calculation goes wrong
${researchLine}
4. Do NOT make blind changes — every fix must be guided by debug output

DEBUG FIRST. Guessing wastes turns.

Failures that keep repeating: ${last3[0]!.failReasons.slice(0, 3).join(", ")}

This is your zoom-out #${this.zoomOutCount}. After 2 zoom-outs the task terminates.`;
    }

    // Same counts but different reasons — model is making progress on different bugs
    // but stuck at same pass rate. Less severe — just warn.
    if (allSameCounts && last3[0]!.failCount > 0) {
      return `NOTE: You've had the same number of failures (${last3[0]!.failCount}) for 3 runs. While the errors are changing, you're not reducing the failure count. Step back and think about what ALL the failures have in common — there may be a root cause.`;
    }

    return null;
  }
}
