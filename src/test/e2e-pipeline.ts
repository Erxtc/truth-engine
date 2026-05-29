// End-to-end pipeline test with TaskAgent
// Usage: bun run src/test/e2e-pipeline.ts

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
} catch {}

// Ensure domains are registered
import "../executors/domains";

const problems = [
  {
    name: "fibonacci",
    desc: "Write proposedSolution(n) returning the nth Fibonacci number (fib(0)=0, fib(1)=1). n is a non-negative integer.",
  },
  {
    name: "coin-change",
    desc: "Write proposedSolution(coins, amount) that returns the minimum number of coins needed to make the given amount. coins is a list of coin denominations. Return -1 if the amount cannot be made. Example: proposedSolution([1,5,10], 12) → 3 (10+1+1). Example: proposedSolution([2], 3) → -1. Example: proposedSolution([1], 0) → 0.",
  },
  {
    name: "binary-search",
    desc: "Write proposedSolution(arr, target) that performs binary search on a sorted array of integers. Return the index of target if found, or -1 if not found. Example: proposedSolution([1,3,5,7,9], 5) → 2. Example: proposedSolution([1,3,5,7,9], 6) → -1. Example: proposedSolution([], 1) → -1.",
  },
];

console.log("[e2e] Testing pipeline with TaskAgent (tier 2 path)\n");

let passed = 0;
let failed = 0;

for (const problem of problems) {
  console.log(`─── ${problem.name} ───`);
  const t0 = Date.now();
  const proc = Bun.spawnSync({
    cmd: ["bun", "run", "src/main.ts"],
    env: {
      ...process.env,
      DOMAIN: "auto",
      PROBLEM_DESC: problem.desc,
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 300_000,
  });

  const stdout = proc.stdout?.toString() ?? "";
  const stderr = proc.stderr?.toString() ?? "";
  const duration = Date.now() - t0;

  // Parse structured result from output (preferred) or fall back to regex
  let solved = false;
  const resultMatch = stdout.match(/\{"result":\{[^}]+\}\}/);
  if (resultMatch) {
    try {
      const parsed = JSON.parse(resultMatch[0]);
      solved = parsed.result?.solved === true;
    } catch { /* fall through to regex */ }
  }
  if (!solved && !resultMatch) {
    solved = /✓ SOLVED|PROBLEM SOLVED|FINAL ANSWER/i.test(stdout);
  }
  const taskAgentUsed = stdout.includes("task-agent") || stdout.includes("agentic solver");

  console.log(`  ${solved ? "PASS" : "FAIL"} | ${(duration / 1000).toFixed(1)}s | task-agent: ${taskAgentUsed} | exit=${proc.exitCode}`);
  if (!solved) {
    const lastLines = stdout.split("\n").slice(-5).join("\n");
    console.log(`  Last output:\n${lastLines}`);
    if (stderr) console.log(`  Stderr: ${stderr.slice(0, 300)}`);
    failed++;
  } else {
    passed++;
  }
}

console.log(`\n─── Results ───`);
console.log(`  Passed: ${passed}/${problems.length}`);
console.log(`  Failed: ${failed}/${problems.length}`);
