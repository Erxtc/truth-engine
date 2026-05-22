import * as v from "valibot";
import { queryReasoning } from "../llm";
import type { RunParams } from "../core/types";
import type { HealthReport } from "../core/health-monitor";

// ── Schema ────────────────────────────────────────────────────────────────────

const supervisorSchema = v.object({
	action: v.picklist(["continue", "escalate", "pivot", "abort"]),
	reason: v.string(),
	direction_hint: v.fallback(v.string(), ""),
	// 0 = keep current value; positive int = new value
	new_branches: v.fallback(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(8)), 0),
	new_critics:  v.fallback(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(6)), 0),
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
	newCritics:  number;
	newDepth:    number;
}

// ── Prompt ────────────────────────────────────────────────────────────────────

function buildPrompt(
	domain: string,
	problem: string,
	health: HealthReport,
	params: RunParams
): string {
	const scoreHistory = health.recentScores.length
		? `Recent scores (oldest→newest): [${health.recentScores.join(", ")}]`
		: "No attempts yet";

	return `
You are a supervisor for an automated problem-solving system.

DOMAIN: ${domain}
PROBLEM (first 300 chars): ${problem.slice(0, 300)}

CURRENT RUN PARAMS:
  branches=${params.maxBranches}  critics=${params.criticCount}  depth=${params.maxDepth}

HEALTH REPORT:
  Total attempts: ${health.totalAttempts}
  Best score so far: ${health.bestScore}
  Pass rate (recent): ${(health.passRate * 100).toFixed(0)}%
  Improvement rate: ${(health.improvementRate * 100).toFixed(0)}%  (0=flat, 100=fast)
  Stagnant: ${health.isStagnant}
  ${health.stagnationReason ? `Stagnation reason: ${health.stagnationReason}` : ""}
  ${health.dominantFailurePattern ? `Dominant failure pattern: "${health.dominantFailurePattern}"` : ""}
  ${scoreHistory}

CHOOSE ONE ACTION:
  "continue"  — scores are improving; let the evolution run unchanged
  "escalate"  — try more branches or critics; set new_branches / new_critics / new_depth > 0
  "pivot"     — the current approach direction is fundamentally wrong; provide direction_hint
                (a short constraint like "use a non-comparison sort" or "rewrite in pure math")
  "abort"     — problem appears unsolvable with available resources

GUIDELINES:
- Prefer "continue" if there has been any improvement or fewer than 3 total attempts
- Prefer "escalate" when close (best_score > 50) but stuck
- Prefer "pivot" when stuck with low scores AND a clear repeated failure pattern
- Use "abort" only if best_score = 0 and >10 attempts with no improvement at all
- For escalate: new_branches should not exceed current×2; new_critics not exceed 4

Return ONLY valid JSON:
{
  "action": "continue|escalate|pivot|abort",
  "reason": "one sentence",
  "direction_hint": "non-empty only for pivot",
  "new_branches": 0,
  "new_critics": 0,
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
): Promise<SupervisorDecision> {
	const prompt = buildPrompt(domain, problem, health, currentParams);

	try {
		const result = await queryReasoning({ userPrompt: prompt, schema: supervisorSchema, temperature: 0.2 });
		const r = result.response;
		return {
			action:       r.action,
			reason:       r.reason,
			directionHint: r.direction_hint,
			newBranches:  r.new_branches,
			newCritics:   r.new_critics,
			newDepth:     r.new_depth,
		};
	} catch (err) {
		console.warn("[supervisor] query failed, defaulting to continue:", (err as Error).message?.slice(0, 80));
		return { action: "continue", reason: "Supervisor unavailable", directionHint: "", newBranches: 0, newCritics: 0, newDepth: 0 };
	}
}
