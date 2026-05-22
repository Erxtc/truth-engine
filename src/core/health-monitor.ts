import type { KnowledgeGraph } from "../db/knowledge-graph";

export interface HealthReport {
	totalAttempts: number;
	/** Scores of the last N attempts (oldest first) */
	recentScores: number[];
	bestScore: number;
	/** Fraction of recent attempts that passed execution (0–1) */
	passRate: number;
	/** True when recent attempts show no meaningful improvement */
	isStagnant: boolean;
	stagnationReason?: string;
	/** Most common token in recent kill reasons — useful for supervisor prompt */
	dominantFailurePattern?: string;
	/** 0 = flat/declining, 1 = strongly improving */
	improvementRate: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function slope(xs: number[]): number {
	if (xs.length < 2) return 0;
	const n = xs.length;
	const sumX = (n * (n - 1)) / 2;
	const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6;
	const sumY = xs.reduce((a, b) => a + b, 0);
	const sumXY = xs.reduce((acc, y, i) => acc + i * y, 0);
	const denom = n * sumX2 - sumX * sumX;
	if (denom === 0) return 0;
	return (n * sumXY - sumX * sumY) / denom;
}

function dominantToken(texts: (string | null)[]): string | undefined {
	const freq: Record<string, number> = {};
	for (const t of texts) {
		if (!t) continue;
		for (const w of t.toLowerCase().split(/\W+/).filter(w => w.length > 4)) {
			freq[w] = (freq[w] ?? 0) + 1;
		}
	}
	const best = Object.entries(freq).sort((a, b) => b[1] - a[1])[0];
	return best?.[0];
}

// ── HealthMonitor ─────────────────────────────────────────────────────────────

const STAGNATION_WINDOW   = 5;   // look at last N attempts
const STAGNATION_PASS_CAP = 0.2; // < 20% pass rate = stagnant
const IMPROVEMENT_MIN     = 1.5; // need at least +1.5 pts/attempt slope to be "improving"

export class HealthMonitor {
	constructor(private kg: KnowledgeGraph) {}

	async checkHealth(problemId: string, windowSize = STAGNATION_WINDOW): Promise<HealthReport> {
		const attempts = await this.kg.getRecentAttempts(problemId, windowSize * 2);
		const window   = attempts.slice(0, windowSize).reverse(); // oldest-first for slope calc

		const totalAttempts    = attempts.length;
		const recentScores     = window.map(a => a.score);
		const bestScore        = attempts.reduce((m, a) => Math.max(m, a.score), 0);
		const passed           = window.filter(a => a.status === "lemma");
		const passRate         = window.length > 0 ? passed.length / window.length : 1;
		const improvementRate  = Math.max(0, Math.min(1, slope(recentScores) / IMPROVEMENT_MIN));
		const dominantFailurePattern = dominantToken(
			window.filter(a => a.status === "dead").map(a => a.hypothesisText)
		);

		const isStagnant = window.length >= STAGNATION_WINDOW
			&& passRate < STAGNATION_PASS_CAP
			&& improvementRate < 0.2;

		let stagnationReason: string | undefined;
		if (isStagnant) {
			if (dominantFailurePattern) {
				stagnationReason = `All recent attempts fail with similar pattern: "${dominantFailurePattern}"`;
			} else {
				stagnationReason = `${window.length} consecutive failures with no score improvement`;
			}
		}

		return {
			totalAttempts,
			recentScores,
			bestScore,
			passRate,
			isStagnant,
			stagnationReason,
			dominantFailurePattern,
			improvementRate,
		};
	}
}
