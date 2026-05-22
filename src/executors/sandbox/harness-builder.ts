/**
 * Builds language-specific test harnesses for code proposals.
 * Each harness writes the proposed source + a test driver, runs it,
 * and emits a JSON line to stdout: { stages: StageResult[], passed: bool }
 */

export interface HarnessSpec {
	files: Record<string, string>;
	command: string;
	timeoutMs?: number;
}

// ── Sorting domain ────────────────────────────────────────────────────────────

export function buildSortingHarness(source: string, lang: "js" | "ts" | "python" | "c"): HarnessSpec {
	switch (lang) {
		case "ts":
			return { files: { "harness.ts": jsSortingHarness(source) }, command: "bun run harness.ts", timeoutMs: 20_000 };
		case "js":
			return { files: { "harness.js": jsSortingHarness(source) }, command: "node harness.js", timeoutMs: 20_000 };
		case "python":
			return { files: { "harness.py": pythonSortingHarness(source) }, command: "python3 harness.py", timeoutMs: 20_000 };
		case "c":
			return {
				files: { "solution.c": source, "harness.c": cSortingHarness() },
				command: "gcc -O2 -o test solution.c harness.c && ./test",
				timeoutMs: 30_000,
			};
	}
}

// ── Compression domain ────────────────────────────────────────────────────────

export function buildCompressionHarness(source: string, lang: "js" | "ts" | "python"): HarnessSpec {
	const code = lang === "python" ? pythonCompressionHarness(source) : jsCompressionHarness(source);
	const file = lang === "python" ? "harness.py" : `harness.${lang}`;
	const cmd = lang === "python" ? "python3 harness.py" : lang === "ts" ? "bun run harness.ts" : "node harness.js";
	return { files: { [file]: code }, command: cmd, timeoutMs: 20_000 };
}

// ── Project / generic ─────────────────────────────────────────────────────────

export interface ProjectHarnessSpec {
	files: Record<string, string>;
	installCommand?: string;
	buildCommand?: string;
	testCommand: string;
	timeoutMs?: number;
	gitRepo?: string;
}

export function buildProjectHarness(spec: ProjectHarnessSpec): { command: string; timeoutMs: number } {
	const parts: string[] = [];
	if (spec.installCommand) parts.push(`(${spec.installCommand}) 2>&1 | tail -5`);
	if (spec.buildCommand) parts.push(spec.buildCommand);
	parts.push(spec.testCommand);
	return {
		command: parts.join(" && "),
		timeoutMs: spec.timeoutMs ?? 120_000,
	};
}

// ── JS/TS harness template ────────────────────────────────────────────────────

function jsSortingHarness(source: string): string {
	return `
// ── proposed solution ────────────────────────────────────────────────────────
${source}

// ── test harness ─────────────────────────────────────────────────────────────
function stageWrap(name, fn) {
  const t0 = Date.now();
  try {
    const r = fn();
    return { stageName: name, ...r, runtimeMs: Date.now() - t0 };
  } catch (e) {
    return { stageName: name, passed: false, reason: "Threw: " + e.message, runtimeMs: Date.now() - t0 };
  }
}

const CASES = [
  ["empty",      []],
  ["single",     [42]],
  ["sorted",     [1,2,3,4,5]],
  ["reversed",   [5,4,3,2,1]],
  ["duplicates", [3,1,4,1,5,9,2,6,5]],
  ["negatives",  [-5,-3,0,2,8,-1]],
  ["all_same",   [7,7,7,7,7]],
  ["large_desc", Array.from({length:1000}, (_,i) => 1000 - i)],
];

const stages = [];

stages.push(stageWrap("UnitTests", () => {
  const results = CASES.map(([name, arr]) => {
    const a = [...arr];
    const result = proposedSort([...a]);
    const expected = [...a].sort((x,y) => x-y);
    if (!Array.isArray(result))
      return { name, passed: false, reason: "Not an array" };
    if (result.length !== a.length)
      return { name, passed: false, reason: "Length " + result.length + " vs " + a.length };
    if (JSON.stringify(result) !== JSON.stringify(expected))
      return { name, passed: false, reason: "Got [" + result.slice(0,5) + "]" };
    return { name, passed: true };
  });
  const fail = results.find(r => !r.passed);
  return { passed: !fail, testResults: results, reason: fail ? fail.reason : undefined };
}));

stages.push(stageWrap("PropertyFuzz", () => {
  for (let i = 0; i < 500; i++) {
    const len = Math.floor(Math.random() * 300);
    const arr = Array.from({length: len}, () => Math.floor(Math.random() * 2001) - 1000);
    const result = proposedSort([...arr]);
    const expected = [...arr].sort((x,y) => x-y);
    if (result.length !== arr.length)
      return { passed: false, reason: "Fuzz length on " + JSON.stringify(arr.slice(0,4)) };
    if (JSON.stringify(result) !== JSON.stringify(expected))
      return { passed: false, reason: "Fuzz wrong on " + JSON.stringify(arr.slice(0,4)) };
  }
  return { passed: true, metrics: { iterations: 500 } };
}));

const passed = stages.every(s => s.passed);
process.stdout.write(JSON.stringify({ stages, passed }) + "\\n");
process.exit(passed ? 0 : 1);
`.trimStart();
}

function pythonSortingHarness(source: string): string {
	return `
import json, random, sys, time

# ── proposed solution ─────────────────────────────────────────────────────────
${source}

# ── test harness ──────────────────────────────────────────────────────────────
def stage_wrap(name, fn):
    t0 = time.time()
    try:
        r = fn()
        r["stageName"] = name
        r["runtimeMs"] = int((time.time() - t0) * 1000)
        return r
    except Exception as e:
        return {"stageName": name, "passed": False, "reason": f"Threw: {e}", "runtimeMs": int((time.time() - t0) * 1000)}

CASES = [
    ("empty",      []),
    ("single",     [42]),
    ("sorted",     [1,2,3,4,5]),
    ("reversed",   [5,4,3,2,1]),
    ("duplicates", [3,1,4,1,5,9,2,6,5]),
    ("negatives",  [-5,-3,0,2,8,-1]),
    ("all_same",   [7,7,7,7,7]),
    ("large_desc", list(range(1000, 0, -1))),
]

def run_unit_tests():
    results = []
    for name, arr in CASES:
        result = proposed_sort(arr[:])
        expected = sorted(arr)
        if result == expected:
            results.append({"name": name, "passed": True})
        else:
            results.append({"name": name, "passed": False, "reason": f"Got {result[:5]}"})
    fail = next((r for r in results if not r["passed"]), None)
    return {"passed": not fail, "testResults": results, "reason": fail.get("reason") if fail else None}

def run_fuzz():
    for i in range(500):
        arr = [random.randint(-500, 500) for _ in range(random.randint(0, 200))]
        result = proposed_sort(arr[:])
        if result != sorted(arr):
            return {"passed": False, "reason": f"Fuzz wrong on {arr[:4]}"}
    return {"passed": True, "metrics": {"iterations": 500}}

stages = [
    stage_wrap("UnitTests", run_unit_tests),
    stage_wrap("PropertyFuzz", run_fuzz),
]

passed = all(s["passed"] for s in stages)
print(json.dumps({"stages": stages, "passed": passed}))
sys.exit(0 if passed else 1)
`.trimStart();
}

// Output format: one "KEY=VALUE" line per result so there are no quote-escaping
// problems embedding JSON inside a JS template literal. parseSandboxOutput()
// handles both JSON and this key=value format.
function cSortingHarness(): string {
	return [
		"#include <stdio.h>",
		"#include <stdlib.h>",
		"#include <string.h>",
		"",
		"void proposed_sort(int *arr, int n);",
		"",
		"static int cmp_int(const void *a, const void *b) {",
		"    int ia = *(const int *)a, ib = *(const int *)b;",
		"    return (ia > ib) - (ia < ib);",
		"}",
		"",
		"typedef struct { const char *name; int passed; } TR;",
		"",
		"static TR run_case(const char *name, const int *src, int n) {",
		"    int *got = malloc((n+1)*sizeof(int));",
		"    int *exp = malloc((n+1)*sizeof(int));",
		"    memcpy(got, src, n*sizeof(int));",
		"    memcpy(exp, src, n*sizeof(int));",
		"    qsort(exp, n, sizeof(int), cmp_int);",
		"    proposed_sort(got, n);",
		"    int ok = memcmp(got, exp, n*sizeof(int)) == 0;",
		"    free(got); free(exp);",
		"    return (TR){ name, ok };",
		"}",
		"",
		"int main(void) {",
		"    int empty[]  = {0};",
		"    int single[] = {42};",
		"    int srtd[]   = {1,2,3,4,5};",
		"    int rev[]    = {5,4,3,2,1};",
		"    int dups[]   = {3,1,4,1,5,9,2,6,5};",
		"    int negs[]   = {-5,-3,0,2,8,-1};",
		"    int same[]   = {7,7,7,7,7};",
		"    TR cases[] = {",
		"        run_case(\"empty\",      empty,  0),",
		"        run_case(\"single\",     single, 1),",
		"        run_case(\"sorted\",     srtd,   5),",
		"        run_case(\"reversed\",   rev,    5),",
		"        run_case(\"duplicates\", dups,   9),",
		"        run_case(\"negatives\",  negs,   6),",
		"        run_case(\"all_same\",   same,   5),",
		"    };",
		"    int nc = (int)(sizeof(cases)/sizeof(cases[0]));",
		"    int units_pass = 1;",
		"    for (int i = 0; i < nc; i++) {",
		"        printf(\"test_%s=%s\\n\", cases[i].name, cases[i].passed ? \"true\" : \"false\");",
		"        if (!cases[i].passed) units_pass = 0;",
		"    }",
		"    printf(\"units_passed=%s\\n\", units_pass ? \"true\" : \"false\");",
		"    srand(42);",
		"    int fuzz_pass = 1;",
		"    for (int i = 0; i < 300 && fuzz_pass; i++) {",
		"        int n = rand() % 200;",
		"        int *arr = malloc((n+1)*sizeof(int));",
		"        int *exp = malloc((n+1)*sizeof(int));",
		"        for (int j = 0; j < n; j++) arr[j] = exp[j] = (rand()%2001)-1000;",
		"        qsort(exp, n, sizeof(int), cmp_int);",
		"        proposed_sort(arr, n);",
		"        if (memcmp(arr, exp, n*sizeof(int)) != 0) fuzz_pass = 0;",
		"        free(arr); free(exp);",
		"    }",
		"    printf(\"fuzz_passed=%s\\n\", fuzz_pass ? \"true\" : \"false\");",
		"    return (units_pass && fuzz_pass) ? 0 : 1;",
		"}",
	].join("\n");
}

function jsCompressionHarness(source: string): string {
	return `
${source}

function stageWrap(name, fn) {
  const t0 = Date.now();
  try {
    const r = fn();
    return { stageName: name, ...r, runtimeMs: Date.now() - t0 };
  } catch (e) {
    return { stageName: name, passed: false, reason: "Threw: " + e.message, runtimeMs: Date.now() - t0 };
  }
}

const stages = [];

stages.push(stageWrap("RoundTrip", () => {
  const cases = [
    new Uint8Array([]),
    new Uint8Array([65,66,67]),
    new Uint8Array(256).fill(0).map((_, i) => i),
    new Uint8Array(1000).fill(65),
    new Uint8Array(Array.from({length:1000}, () => Math.floor(Math.random()*256))),
  ];
  for (const c of cases) {
    const compressed = compress(c);
    const decompressed = decompress(compressed);
    if (decompressed.length !== c.length) return { passed: false, reason: "Length mismatch after roundtrip" };
    for (let i = 0; i < c.length; i++) {
      if (decompressed[i] !== c[i]) return { passed: false, reason: "Bytes differ at index " + i };
    }
  }
  return { passed: true };
}));

stages.push(stageWrap("CompressionRatio", () => {
  const repetitive = new Uint8Array(1000).fill(65);
  const compressed = compress(repetitive);
  const ratio = repetitive.length / compressed.length;
  if (ratio <= 1.0) return { passed: false, reason: "No compression: ratio=" + ratio.toFixed(2) };
  return { passed: true, metrics: { ratio } };
}));

const passed = stages.every(s => s.passed);
process.stdout.write(JSON.stringify({ stages, passed }) + "\\n");
process.exit(passed ? 0 : 1);
`.trimStart();
}

function pythonCompressionHarness(source: string): string {
	return `
import json, sys, time

${source}

def stage_wrap(name, fn):
    t0 = time.time()
    try:
        r = fn()
        r["stageName"] = name
        r["runtimeMs"] = int((time.time() - t0) * 1000)
        return r
    except Exception as e:
        return {"stageName": name, "passed": False, "reason": str(e), "runtimeMs": 0}

def run_roundtrip():
    cases = [b"", b"ABC", bytes(range(256)), b"A" * 1000]
    for c in cases:
        d = decompress(compress(c))
        if d != c:
            return {"passed": False, "reason": f"Roundtrip failed: {len(c)} bytes"}
    return {"passed": True}

def run_ratio():
    data = b"A" * 1000
    ratio = len(data) / len(compress(data))
    if ratio <= 1.0:
        return {"passed": False, "reason": f"No compression: ratio={ratio:.2f}"}
    return {"passed": True, "metrics": {"ratio": ratio}}

stages = [stage_wrap("RoundTrip", run_roundtrip), stage_wrap("CompressionRatio", run_ratio)]
passed = all(s["passed"] for s in stages)
print(json.dumps({"stages": stages, "passed": passed}))
sys.exit(0 if passed else 1)
`.trimStart();
}
