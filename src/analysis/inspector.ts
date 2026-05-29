/**
 * Inspector — classifies failures for the capability tracker.
 *
 * The full inspection pipeline (inspect, classifyError, extractOracleResults,
 * buildRepairContext, etc.) was removed — it was disconnected from the current
 * pipeline. Only FailureClass remains as it's used by capability-tracker.ts.
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export type FailureClass =
  | "parse_error"       // AST/validator caught it — fix in code, no LLM
  | "syntax_error"      // SyntaxError, IndentationError, NameError — repair with exact error
  | "type_error"        // TypeError, AttributeError, NoneType — repair with error + oracle
  | "wrong_output"      // Some oracle tests pass, some fail — repair with pass/fail detail
  | "wrong_approach"    // All tests fail, or fundamentally wrong direction — repurpose
  | "capability_gap";   // Same classification 3+ times, repair never helped — decompose/abort
