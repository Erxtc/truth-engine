import * as v from "valibot";
import { queryDeepseek } from "../llm";
import type { RunParams } from "../core/types";
import type { HealthReport } from "../core/health-monitor";

// ── Schema ────────────────────────────────────────────────────────────────────

const supervisorSchema = v.object({
	action: v.picklist(["continue", "escalate", "pivot", "abort"]),
	reason: v.string(),
	direction_hint: v.fallback(v.string(), ""),
	// 0 = keep current value; positive int = new value
	new_branches: v.fallback(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(8)), 0),
	new_depth:    v.fallback(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(12)), 0),
});

// ── Public types ──────────────────────────────────────────────────────────────

export type SupervisorAction = "continue" | "escalate" | "pivot" | "abort";

export interface SupervisorDecision {
	action: SupervisorAction;
	reason: string;
	/** Non-empty when action === "pivot": injected as an active constraint */
	directionHint: string;
	/** > 0 when action === "escalate": new values to apply */
	newBranches: number;
	newDepth:    number;
}

// ── Prompt ────────────────────────────────────────────────────────────────────

function buildPrompt(
	domain: string,
	problem: string,
	health: HealthReport,
	params: RunParams,
	lastErrorContext?: string,
	turnSummary?: string,
): string {
	const scoreHistory = health.recentScores.length
		? `Recent scores (oldest→newest): [${health.recentScores.join(", ")}]`
		: "No attempts yet";

	const errorBlock = lastErrorContext
		? `\nLAST ATTEMPT ERROR (what the task-agent reported):\n${lastErrorContext.slice(0, 400)}`
		: "";

	const turnBlock = turnSummary
		? `\nWHAT THE AGENT DID (turn-by-turn):\n${turnSummary.slice(0, 600)}`
		: "";

	return `
You are a supervisor for an automated problem-solving system.

DOMAIN: ${domain}
PROBLEM (first 300 chars): ${problem.slice(0, 300)}

CURRENT RUN PARAMS:
  branches=${params.maxBranches}  depth=${params.maxDepth}
${errorBlock}${turnBlock}
HEALTH REPORT:
  Total attempts (session): ${health.totalAttempts}
  Best score so far: ${health.bestScore}
  Pass rate (session): ${(health.passRate * 100).toFixed(0)}%
  Improvement rate: ${(health.improvementRate * 100).toFixed(0)}%  (0=flat, 100=fast)
  Stagnant: ${health.isStagnant}
  ${health.stagnationReason ? `Stagnation reason: ${health.stagnationReason}` : ""}
  ${health.dominantFailurePattern ? `Dominant failure pattern: "${health.dominantFailurePattern}"` : ""}
  ${scoreHistory}
  ${health.historicalAttempts != null ? `HISTORICAL (all runs for this domain):\n  Historical pass rate: ${((health.historicalPassRate ?? 0) * 100).toFixed(0)}%\n  Historical attempts: ${health.historicalAttempts}\n  Recent failure patterns: ${(health.historicalFailures ?? []).join(", ") || "none"}` : "HISTORICAL: no data yet"}

DECISION RULES — check in this order and pick the FIRST one that matches:

1. ABORT — total attempts >= 8 AND best score = 0 AND pass rate = 0%
   → The problem is unsolvable. Give up.

2. PIVOT — pass rate = 0% AND total attempts >= 3 AND a dominant failure pattern exists
   → The approach is fundamentally wrong. Provide a specific direction_hint for a DIFFERENT strategy.
   → The direction_hint will be injected into the task-agent as an ACTIVE CONSTRAINT — be specific:
     "Use Kahn's algorithm (indegree-based) instead of DFS for topological sort"
     "Implement the Wagner-Fischer DP algorithm with a 2D table, not recursion"
     "Use a min-heap priority queue, not a sorted list, for Dijkstra"
   NEVER skip this rule: if pass rate is 0% after 3+ attempts, you MUST pivot or abort.

3. ESCALATE — pass rate = 0% AND best score >= 50 AND failure pattern is NOT code-quality
   → The model is on the right track but needs more exploration. Set new_branches=3 or 4.
   Do NOT escalate for code-quality failures ("syntax", "typeerror", "wrong-type",
   "indentation", "not defined") — those need code fixes, not more branches.

4. CONTINUE — best score > 0 (some progress made, even if pass rate is 0%)
   → The approach shows promise but hasn't crossed the finish line. Let the agent retry.
   → ONLY pick this when the last error shows PARTIAL progress (some tests passed, minor bugs remain).
   → If the error shows total failure (all tests fail, wrong algorithm), pick PIVOT instead.

5. ABORT (fallback) — none of the above match and total attempts >= 5
   → Prolonged stagnation with no progress. Cut losses.

CRITICAL: "continue" means "try again with the same strategy" — only pick it when
the approach is correct but has small bugs. If nothing works at all, pivot to a
completely different strategy.

Return ONLY valid JSON:
{
  "action": "continue|escalate|pivot|abort",
  "reason": "one sentence",
  "direction_hint": "non-empty only for pivot — will become an active constraint for the agent",
  "new_branches": 0,
  "new_depth": 0
}
`.trim();
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function runSupervisor(
	domain: string,
	problem: string,
	health: HealthReport,
	currentParams: RunParams,
	lastErrorContext?: string,
	/** Turn-by-turn summary of what the task-agent actually did — gives the
	 *  supervisor concrete visibility into the failed approach. */
	turnSummary?: string,
): Promise<SupervisorDecision> {
	const prompt = buildPrompt(domain, problem, health, currentParams, lastErrorContext, turnSummary);

	try {
		const result = await queryDeepseek({ userPrompt: prompt, schema: supervisorSchema, temperature: 0.2 });
		const r = result.response;
		return {
			action:       r.action,
			reason:       r.reason,
			directionHint: r.direction_hint,
			newBranches:  r.new_branches,
			newDepth:     r.new_depth,
		};
	} catch (err) {
		console.warn("[supervisor] query failed, aborting:", (err as Error).message?.slice(0, 80));
		return { action: "abort", reason: "Supervisor unavailable", directionHint: "", newBranches: 0, newDepth: 0 };
	}
}
