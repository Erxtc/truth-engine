/**
 * Prompt Template Hash — produces a STABLE fingerprint of the current system prompt
 * code. Unlike `hashSystemPrompt(fullPromptText)` which includes dynamic content
 * (supervisor hints, failure summaries, domain invariants, oracle-preloaded flags),
 * this hashes the TEMPLATE STRUCTURE — only changing when the prompt source code changes.
 *
 * This is the hash used for prompt VERSION TRACKING:
 *   - All runs sharing the same template hash ran under the "same" prompt code
 *   - Trusted-problem caching keys on this hash (not instance hashes)
 *   - Cross-prompt comparison uses this to group runs by prompt version
 */

import { buildSystemPrompt } from "../llm/task-agent-prompt";
import type { WorkflowConfig } from "../llm/task-agent";
import { hashSystemPrompt } from "./prompt-version-tracker";

/** The canonical "clean" workflow config used for template fingerprinting.
 *  Uses the minimal config — no dynamic fields, no domain-specific rules. */
const TEMPLATE_WF: WorkflowConfig = {
  solutionFiles: ["solution.py"],
  verifyCommand: "python3 verify.py",
  outputDescription: "python function",
  language: "python",
  testFirst: false,
};

/**
 * Produce a stable hash of the current prompt TEMPLATE.
 * Hash changes ONLY when the buildSystemPrompt() source code changes.
 * Does NOT include supervisor hints, failure summaries, oracle content,
 * domain invariants, or other per-run dynamic content.
 *
 * @param options.complexity — the problem complexity tier (affects template structure)
 * @param options.language — the problem language (affects template structure)
 * @returns 16-char hex SHA-256 hash
 */
export function hashPromptTemplate(options?: {
  complexity?: string;
  language?: string;
}): string {
  // Build with NO dynamic options — no supervisor hints, no failure summaries,
  // no oracle-preloaded flag, no domain invariants. Just the structural params.
  const cleanOpts = {
    complexity: options?.complexity,
    // intentionally omit: supervisorHint, previousAttemptSummary, oraclePreloaded
  };
  const systemPrompt = buildSystemPrompt(TEMPLATE_WF, cleanOpts);
  return hashSystemPrompt(systemPrompt);
}

/**
 * Convenience: hash the template using the provided complexity and language.
 * Used by benchmark.ts to get a stable hash without importing task-agent internals.
 */
export function getStableTemplateHash(complexity?: string, language?: string): string {
  return hashPromptTemplate({ complexity, language });
}
