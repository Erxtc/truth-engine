/**
 * Self-development test: verifies the pipeline can fix bugs in TypeScript code
 * (its own language). This proves the pipeline can contribute to its own development.
 *
 * Usage:
 *   bun run src/test/self-dev-test.ts              # run all
 *   bun run src/test/self-dev-test.ts fix-return   # single test
 *
 * How it works:
 *   1. Pre-loads TypeScript files with deliberate bugs + a verify.js script
 *   2. The task-agent identifies and fixes the bug using edit_file
 *   3. The agent runs `node verify.js` which checks the fix and outputs JSON
 *   4. Pipeline passes only if verify.js reports {"passed": true}
 */

// Load .env
import { readFileSync } from "fs";
try {
  const envPath = import.meta.dir + "/../db/.env";
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0 && !process.env[trimmed.slice(0, eq).trim()]) {
      process.env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
} catch { }

import { runTaskAgent } from "../llm/task-agent";

// ── Verification scripts (Node.js, no external deps needed) ───────────────────

function verifyScript(checks: string[]): string {
  return [
    `const fs = require('fs');`,
    `let passed = true;`,
    `const reasons = [];`,
    ...checks,
    `process.stdout.write(JSON.stringify({ passed, reason: reasons.join('; ') || 'ok' }));`,
    `process.exit(passed ? 0 : 1);`,
  ].join("\n");
}

// ── Test problems ─────────────────────────────────────────────────────────────

interface SelfDevProblem {
  name: string;
  description: string;
  setupFiles: Record<string, string>;
  task: string;
}

const PROBLEMS: SelfDevProblem[] = [
  {
    name: "fix-return-type",
    description: "Fix a function returning string|null but typed as string",
    setupFiles: {
      "utils.ts": [
        `// Count word frequencies in a string array`,
        `export function wordFrequency(words: string[]): Map<string, number> {`,
        `  const freq = new Map<string, number>();`,
        `  for (const w of words) {`,
        `    freq.set(w, (freq.get(w) ?? 0) + 1);`,
        `  }`,
        `  return freq;`,
        `}`,
        ``,
        `// BUG: return type says string but returns string|null`,
        `export function findMostFrequent(words: string[]): string {`,
        `  const freq = wordFrequency(words);`,
        `  let maxWord: string | null = null;`,
        `  let maxCount = 0;`,
        `  for (const [word, count] of freq) {`,
        `    if (count > maxCount) {`,
        `      maxCount = count;`,
        `      maxWord = word;`,
        `    }`,
        `  }`,
        `  return maxWord;`,
        `}`,
      ].join("\n"),
      "verify.js": verifyScript([
        `const src = fs.readFileSync('utils.ts', 'utf-8');`,
        `// Must have string | null return type`,
        `if (!/\\(words:\\s*string\\[\\]\\):\\s*string\\s*\\|\\s*null/.test(src)) {`,
        `  passed = false;`,
        `  reasons.push("findMostFrequent return type must be string | null");`,
        `}`,
        `// Must NOT have bare :string return type for findMostFrequent`,
        `if (/\\(words:\\s*string\\[\\]\\):\\s*string\\b(?!\\s*\\|)/.test(src)) {`,
        `  passed = false;`,
        `  reasons.push("findMostFrequent still has bare :string return type");`,
        `}`,
      ]),
    },
    task: [
      `A TypeScript project is in your workspace. utils.ts has a type error:`,
      `findMostFrequent's return type is \`string\` but it returns \`maxWord\` which is \`string | null\`.`,
      ``,
      `STEPS:`,
      `1. Read utils.ts to see the current code`,
      `2. Use edit_file to change findMostFrequent's return type from \`: string\` to \`: string | null\``,
      `3. Run: node verify.js`,
      `4. If verify.js says "passed":false → fix the issue and repeat step 3`,
      `5. When verify.js says "passed":true → call finish("Fixed return type")`,
    ].join("\n"),
  },

  {
    name: "fix-undefined-access",
    description: "Fix accessing .name on User|undefined without guard",
    setupFiles: {
      "users.ts": [
        `interface User { id: number; name: string; email: string; }`,
        ``,
        `const DB: User[] = [`,
        `  { id: 1, name: "Alice", email: "alice@example.com" },`,
        `  { id: 2, name: "Bob", email: "bob@example.com" },`,
        `];`,
        ``,
        `// BUG: .find() returns User|undefined, but return type is User`,
        `export function findUser(id: number): User {`,
        `  return DB.find(u => u.id === id);`,
        `}`,
        ``,
        `// BUG: accesses .name on possibly-undefined user`,
        `export function getUserName(id: number): string {`,
        `  return findUser(id).name;`,
        `}`,
      ].join("\n"),
      "verify.js": verifyScript([
        `const src = fs.readFileSync('users.ts', 'utf-8');`,
        `// Must have User | undefined return type`,
        `if (!/User\\s*\\|\\s*undefined/.test(src)) {`,
        `  passed = false;`,
        `  reasons.push("findUser return type must include undefined (User | undefined)");`,
        `}`,
        `// Must NOT have bare .name access on findUser result`,
        `if (/findUser\\([^)]+\\)\\.name/.test(src)) {`,
        `  passed = false;`,
        `  reasons.push("getUserName still accesses .name on possibly undefined findUser result");`,
        `}`,
        `// getUserName must handle undefined case`,
        `if (!/undefined|Unknown|throw|not found/i.test(src.match(/getUserName[\\s\\S]*?^}/m)?.[0] || '')) {`,
        `  passed = false;`,
        `  reasons.push("getUserName does not handle undefined user case");`,
        `}`,
      ]),
    },
    task: [
      `A TypeScript project is in your workspace. users.ts has type errors:`,
      `1. findUser return type says \`User\` but \`.find()\` returns \`User | undefined\``,
      `2. getUserName calls \`.name\` on a possibly-undefined value`,
      ``,
      `STEPS:`,
      `1. Read users.ts to see the bug`,
      `2. Use edit_file to change findUser's return type to \`User | undefined\``,
      `3. Use edit_file to fix getUserName — add a guard for undefined (e.g., return "Unknown" or throw)`,
      `4. Run: node verify.js`,
      `5. If verify.js says "passed":false → fix and repeat step 4`,
      `6. When verify.js says "passed":true → call finish("Fixed type errors")`,
    ].join("\n"),
  },
];

// ── Runner ────────────────────────────────────────────────────────────────────

interface TestAttempt {
  ok: boolean;
  turns: number;
  infraFail: boolean;
}

async function runOneTest(problem: SelfDevProblem): Promise<TestAttempt> {
  const t0 = Date.now();

  const result = await runTaskAgent(problem.task, {
    maxTurns: 8,
    useStrongModel: true,
    setupFiles: problem.setupFiles,
    enableWebSearch: false,
  });

  const duration = ((Date.now() - t0) / 1000).toFixed(1);

  // Check the final answer and source code for the fix
  const fullText = (result.answer || "") + "\n" + (result.sourceCode || "");
  const hasFix = /string\s*\|\s*null|User\s*\|\s*undefined/.test(fullText);
  const transcript = result.transcript || "";
  const verifyPassed = /"passed"\s*:\s*true/.test(transcript);

  console.log(`  turns: ${result.turns}  time: ${duration}s`);
  console.log(`  fix detected: ${hasFix ? "YES" : "NO"}`);
  console.log(`  verify.js passed: ${verifyPassed ? "YES" : "NO"}`);
  if (result.sourceCode) {
    console.log(`  code (first 300): ${result.sourceCode.slice(0, 300).replace(/\n/g, "\\n")}`);
  }

  // Show key transcript moments
  const lines = transcript.split("\n");
  const highlights = lines.filter(l =>
    l.includes("verify.js") || l.includes("passed") || l.includes("WARNING") || l.includes("edit_file")
  );
  if (highlights.length > 0) {
    console.log(`  transcript highlights:`);
    for (const h of highlights.slice(-8)) console.log(`    ${h.slice(0, 200)}`);
  }

  const ok = hasFix && verifyPassed;
  const infraFail = result.turns === 0;
  if (ok) {
    console.log("  RESULT: PASS\n");
  } else if (infraFail) {
    console.log("  RESULT: INFRA FAIL (0 turns — LLM call may have failed)\n");
  } else {
    console.log(`  RESULT: FAIL (fix=${hasFix} verify=${verifyPassed})\n`);
  }
  return { ok, turns: result.turns, infraFail };
}

async function runSelfDevTests(filter?: string) {
  const selected = filter
    ? PROBLEMS.filter(p => p.name.includes(filter))
    : PROBLEMS;

  if (selected.length === 0) {
    console.log(`No match for "${filter}". Available: ${PROBLEMS.map(p => p.name).join(", ")}`);
    return;
  }

  console.log(`[self-dev] ${selected.length} test(s). Each gives the pipeline a TypeScript regression to fix.\n`);
  console.log("Verification: each test includes a verify.js script — agent runs node verify.js to check the fix.\n");

  let passed = 0;
  let failed = 0;

  for (let i = 0; i < selected.length; i++) {
    const problem = selected[i]!;

    if (i > 0) {
      console.log(`  (waiting 3s between tests to avoid rate limits...)\n`);
      await new Promise(r => setTimeout(r, 3000));
    }

    console.log(`${"=".repeat(60)}`);
    console.log(`[self-dev] ${problem.name}: ${problem.description}`);
    console.log(`${"=".repeat(60)}`);

    try {
      let attempt = await runOneTest(problem);

      // Retry once on infrastructure failures (0 turns = LLM call never connected)
      if (attempt.infraFail) {
        console.log(`  Retrying (infra failure detected)...\n`);
        await new Promise(r => setTimeout(r, 2000));
        attempt = await runOneTest(problem);
      }

      if (attempt.ok) {
        passed++;
      } else {
        failed++;
      }
    } catch (err: any) {
      failed++;
      console.log(`  ERROR: ${err.message?.slice(0, 200)}\n`);
    }
  }

  console.log(`${"=".repeat(60)}`);
  console.log(`[self-dev] ${passed}/${selected.length} passed, ${failed}/${selected.length} failed`);
  console.log(`${"=".repeat(60)}`);

  if (failed > 0) process.exit(1);
}

const filter = process.argv[2];
runSelfDevTests(filter).catch(err => {
  console.error("[self-dev] Fatal:", err);
  process.exit(1);
});
