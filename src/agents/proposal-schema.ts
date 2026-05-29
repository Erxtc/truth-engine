import * as v from "valibot";

// ── Valibot schemas (kept for repair agent) ────────────────────────────────────

const strOrObj = v.union([
  v.string(),
  v.object({ condition: v.optional(v.string()), issue: v.optional(v.string()), description: v.optional(v.string()), test_name: v.optional(v.string()) }),
]);
const normalizeFailureMode = (item: string | Record<string, unknown>): { condition: string; issue: string } => {
  if (typeof item === "string") return { condition: item, issue: "" };
  return { condition: (item.condition ?? item.description ?? "") as string, issue: (item.issue ?? "") as string };
};
const normalizeTest = (item: string | Record<string, unknown>): { test_name: string; description: string } => {
  if (typeof item === "string") return { test_name: item, description: "" };
  return { test_name: (item.test_name ?? item.description ?? item.test_case ?? item.condition ?? "") as string, description: (item.description ?? "") as string };
};

const arrOrStr = <T>(normalize: (item: string) => T) => v.pipe(
  v.union([v.array(v.string()), v.string()]),
  v.transform((val: string | string[]) => (Array.isArray(val) ? val : [val]).map(normalize)),
);

const failureModesSchema = v.pipe(
  v.union([v.array(strOrObj), v.string(), strOrObj]),
  v.transform((val): { condition: string; issue: string }[] => {
    if (typeof val === "string") return [normalizeFailureMode(val)];
    if (Array.isArray(val)) return val.map(normalizeFailureMode);
    return [normalizeFailureMode(val as Record<string, unknown>)];
  }),
);

const testsSchema = v.pipe(
  v.union([v.array(strOrObj), v.string(), strOrObj]),
  v.transform((val): { test_name: string; description: string }[] => {
    if (typeof val === "string") return [normalizeTest(val)];
    if (Array.isArray(val)) return val.map(normalizeTest);
    return [normalizeTest(val as Record<string, unknown>)];
  }),
);

export const proposalSchema = v.object({
  hypothesis: v.string(),
  expected_benefit: v.fallback(v.string(), ""),
  assumptions: v.fallback(arrOrStr((s: string) => s), [] as string[]),
  possible_failure_modes: v.fallback(failureModesSchema, []),
  suggested_tests: v.fallback(testsSchema, []),
  executable: v.union([
    v.object({
      type: v.literal("code"),
      lang: v.union([v.literal("js"), v.literal("ts"), v.literal("python"), v.literal("c"), v.literal("html"), v.literal("mixed")]),
      source: v.string(),
    }),
    v.object({
      type: v.literal("project"),
      lang: v.union([v.literal("js"), v.literal("ts"), v.literal("python"), v.literal("c"), v.literal("mixed")]),
      files: v.record(v.string(), v.string()),
      gitRepo: v.optional(v.string()),
      installCommand: v.optional(v.string()),
      buildCommand: v.optional(v.string()),
      testCommand: v.optional(v.string()),
      runCommand: v.optional(v.string()),
      entrypoint: v.optional(v.string()),
    }),
  ]),
});
