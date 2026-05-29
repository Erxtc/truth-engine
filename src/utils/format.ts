/** Shared formatting helpers — used by benchmark, efficiency-tracker, prompt-logger. */

/** Format milliseconds to human-readable string. */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Format token count for display. */
export function formatTokens(t: number): string {
  if (t >= 100_000) return `${(t / 1000).toFixed(0)}k`;
  if (t >= 10_000) return `${(t / 1000).toFixed(1)}k`;
  if (t >= 1000) return `${(t / 1000).toFixed(1)}k`;
  return String(t);
}

/** Format USD cost for display. */
export function formatCost(cents: number): string {
  if (cents === 0) return "$0.00";
  if (cents < 0.01) return "<$0.01";
  if (cents < 1) return `$${cents.toFixed(2)}`;
  if (cents < 100) return `$${cents.toFixed(2)}`;
  return `$${cents.toFixed(2)}`;
}

/** Compute cost in USD from token usage and model pricing.
 *  Returns 0 if pricing is null (free model). */
export function computeCost(
  usage: { prompt_tokens: number; completion_tokens: number },
  pricing: { inputPerMTok: number; outputPerMTok: number } | null
): number {
  if (!pricing) return 0;
  return (usage.prompt_tokens / 1_000_000) * pricing.inputPerMTok +
         (usage.completion_tokens / 1_000_000) * pricing.outputPerMTok;
}
