import * as v from "valibot";
import { queryReasoning } from "../llm";
import type { WorkingContext, Proposal, Critique, Verdict } from "../core/types";

const verdictSchema = v.object({
  decision: v.union([
    v.literal("execute"),
    v.literal("formalize"),
    v.literal("kill"),
  ]),
  score: v.pipe(v.number(), v.minValue(0), v.maxValue(100)),
  reason: v.string(),
  repairs: v.optional(v.array(v.string())),
});

export async function runJudge(ctx: WorkingContext, proposal: Proposal, critiques: Critique[]): Promise<Verdict> {
  const prompt = buildPrompt(ctx, proposal, critiques);
  const result = await queryReasoning({ userPrompt: prompt, schema: verdictSchema });
  return result.response;
}

function buildPrompt(
  ctx: WorkingContext,
  proposal: Proposal,
  critiques: Critique[]
): string {
  const fatalCount = critiques.filter((c) => c.severity === "fatal").length;
  const majorCount = critiques.filter((c) => c.severity === "major").length;
  const constraintsBlock = ctx.active_constraints.length
    ? `\nActive domain constraints (you must not violate):\n${ctx.active_constraints.map(c => `  - ${c}`).join("\n")}`
    : "";

  return `
You are a judge agent. Domain: ${ctx.domain}

Proposal:
  hypothesis: ${proposal.hypothesis}
  expected_benefit: ${proposal.expected_benefit}

Critiques (${critiques.length} total, ${fatalCount} fatal, ${majorCount} major):
${critiques
      .map(
        (c, i) =>
          `  [${i + 1}] severity=${c.severity} type=${c.attack_type}
      ${c.description}
      ${c.counterexample ? `counterexample: ${c.counterexample}` : ""}
      repairable: ${c.repairable}`
      )
      .join("\n")}

${constraintsBlock}

Scoring guide:
  - Start at 100, -40 per fatal, -15 per major, -5 per minor.
  - +10 if builds on proven lemmas, +10 if executable complete.
Routing:
  - Any fatal + non-repairable -> kill
  - Score < 40 -> kill
  - Needs formal proof -> formalize
  - Ready -> execute

Return ONLY valid JSON: { decision, score, reason, repairs? }
`.trim();
}