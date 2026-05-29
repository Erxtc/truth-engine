/**
 * Quick test: verify TaskAgent improvements fix gaussian-elimination regression.
 * Usage: bun run src/test/gaussian-regression-test.ts
 */

import { runTaskAgent } from "../llm/task-agent";

const task = `Write a Python function named proposedSolution(A, b) that solves Ax=b using Gaussian elimination with partial pivoting. A is nxn (list of lists), b is list of length n. Return solution x as list.

Examples:
- proposedSolution([[2,1],[1,-1]], [5,1]) → [2, 1]
- proposedSolution([[3,2],[1,4]], [7,9]) → [1, 2]
- proposedSolution([[1,2,3],[2,5,2],[3,3,8]], [14,18,33]) → [1, 2, 3]

YOUR CODE MUST PASS THESE EXACT TESTS:
\`\`\`python
import sys, json
from solution import proposedSolution

tests = [
    ([[2,1],[1,-1]], [5,1], [2,1], "2x2-ex1"),
    ([[3,2],[1,4]], [7,9], [1,2], "2x2-ex2"),
    ([[1,2,3],[2,5,2],[3,3,8]], [14,18,33], [1,2,3], "3x3-ex3"),
]

failed = 0
for A, b, expected, name in tests:
    try:
        result = proposedSolution(A, b)
        ok = all(abs(r - e) < 1e-6 for r, e in zip(result, expected))
        print(f"{'pass: ok' if ok else 'FAIL: ' + name + '-wrong'}")
        if not ok:
            print(f"  expected: {expected}")
            print(f"  got:      {[round(x,6) for x in result]}")
            failed += 1
    except Exception as e:
        print(f"FAIL: {name}-exception: {e}")
        failed += 1

print(f"\\n{failed} failure(s)")
sys.exit(0 if failed == 0 else 1)
\`\`\`

Write the solution, write the tests (or run the oracle above), run them, fix any failures, then finish.`;

console.log("Testing improved TaskAgent on gaussian-elimination...\n");

const result = await runTaskAgent(task, {
  maxTurns: 10,
  useStrongModel: true,
  testFirst: true,
});

console.log("\n=== RESULT ===");
console.log("Success:", result.success);
console.log("Turns:", result.turns);
console.log("Answer:", result.answer.slice(0, 300));
if (result.sourceCode) {
  console.log("\nCode:");
  console.log(result.sourceCode.slice(0, 800));
}

// Show key transcript snippets
const lines = result.transcript.split("\n");
const observations = lines.filter(l => l.includes("TESTS FAILED") || l.includes("All checks passed") || l.includes("WARNING") || l.includes("REMINDER"));
if (observations.length > 0) {
  console.log("\nKey nudges:");
  for (const o of observations) console.log(`  ${o.slice(0, 200)}`);
}
