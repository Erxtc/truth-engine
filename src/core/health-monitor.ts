/**
 * HealthMonitor — deterministic statistical analysis of pipeline attempts.
 *
 * Tracks scores, pass/fail, and failure reasons across attempts. Computes:
 *  - Pass rate over a sliding window
 *  - Improvement slope via linear regression
 *  - Dominant failure pattern via token frequency
 *  - Stagnation detection
 *
 * All computations are deterministic (no LLM). Feeds the supervisor and
 * provides the "scientific method" foundation — the system knows whether
 * it's improving or spinning its wheels.
 */

import { getDomainCapability } from "../analysis/capability-tracker";

// ── Types ──────────────────────────────────────────────────────────────────────

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
  /** Historical pass rate for this domain from prior runs (0–1), if available */
  historicalPassRate?: number;
  /** Total historical attempts for this domain, if available */
  historicalAttempts?: number;
  /** Recent failure classes for this domain from prior runs */
  historicalFailures?: string[];
}

interface AttemptRecord {
  score: number;
  passed: boolean;
  reason: string;
}

// ── Statistics helpers ─────────────────────────────────────────────────────────

/** Linear regression slope of y-values (one per step, x = 0,1,2,...).
 *  Positive = improving, negative = declining, near 0 = flat. */
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

/** Find the most frequent word (≥5 chars) across failure reasons.
 *  Simple tf-idf-like token frequency — deterministic, zero LLM cost. */
function dominantToken(texts: string[]): string | undefined {
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

// ── HealthMonitor ──────────────────────────────────────────────────────────────

const STAGNATION_WINDOW   = 5;   // look at last N attempts
const STAGNATION_PASS_CAP = 0.2; // < 20% pass rate = stagnant
const IMPROVEMENT_MIN     = 1.5; // need at least +1.5 pts/attempt slope to be "improving"

export class HealthMonitor {
  private attempts: AttemptRecord[] = [];

  /** Record an attempt outcome. Call after each pipeline step (baseline, repair, task-agent). */
  record(score: number, passed: boolean, reason: string): void {
    this.attempts.push({ score, passed, reason });
  }

  /** Build a health report from all recorded attempts, plus optional historical data.
   *  Pass `domain` to include cross-run historical data from the capability tracker. */
  getReport(windowSize = STAGNATION_WINDOW): HealthReport {
    const window = this.attempts.slice(-windowSize).reverse(); // oldest-first for slope

    const totalAttempts    = this.attempts.length;
    const recentScores     = window.map(a => a.score);
    const bestScore        = this.attempts.reduce((m, a) => Math.max(m, a.score), 0);
    const passed           = window.filter(a => a.passed);
    const passRate         = window.length > 0 ? passed.length / window.length : 1;
    const rawSlope         = slope(recentScores);
    const improvementRate  = Math.max(0, Math.min(1, rawSlope / IMPROVEMENT_MIN));
    const failedReasons    = window.filter(a => !a.passed).map(a => a.reason);
    const dominantFailurePattern = dominantToken(failedReasons);

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

  /** Convenience: build report with historical data from capability tracker. */
  getReportWithHistory(domain: string, windowSize?: number): HealthReport {
    const report = this.getReport(windowSize);
    const historical = getDomainCapability(domain);
    if (historical) {
      report.historicalPassRate = historical.passRate;
      report.historicalAttempts = historical.attempts;
      report.historicalFailures = historical.recentFailures;
    }
    return report;
  }

  /** Number of recorded attempts. */
  get count(): number {
    return this.attempts.length;
  }
}
