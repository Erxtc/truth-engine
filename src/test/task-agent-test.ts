/**
 * TaskAgent smoke tests — diverse task types to verify the agentic loop works
 * beyond just algorithmic problems.
 *
 * Usage: bun run src/test/task-agent-test.ts [test-name]
 *   Leave empty to run all tests.
 */

import { runTaskAgent } from "../llm/task-agent";

interface TestCase {
  name: string;
  task: string;
  /** Domain preset to apply (physics, engineering, law, etc.) */
  domain?: string;
  /** Quick check on the answer/source to verify success */
  verify?: (answer: string, code?: string) => boolean;
}

const TESTS: TestCase[] = [
  // ── Algorithmic (proven working) ────────────────────────────────────────
  {
    name: "fibonacci",
    task: `Write a Python function named proposedSolution(n) that returns the nth Fibonacci number (fib(0)=0, fib(1)=1).

Examples:
- proposedSolution(0) → 0
- proposedSolution(1) → 1
- proposedSolution(10) → 55
- proposedSolution(20) → 6765

Write tests, run them, fix any failures, then finish.`,
    verify: (_, code) => code?.includes("def proposedSolution") ?? false,
  },

  // ── Data processing ─────────────────────────────────────────────────────
  {
    name: "csv-stats",
    task: `Write a Python script (main.py) that:
1. Reads data.csv (comma-separated, first line is header: "name,score,age")
2. Computes: average score, average age, top scorer name
3. Writes summary.json with: {"avg_score": X, "avg_age": Y, "top_scorer": "name"}
4. Prints "Done." on success

Create a sample data.csv first, then run main.py, verify the output, then finish.`,
    verify: (answer, code) => answer.includes("Done") || answer.includes("avg_score") || (code?.includes("avg_score") ?? false),
  },

  // ── Shell scripting / automation ────────────────────────────────────────
  {
    name: "file-organizer",
    task: `Write a bash script (organize.sh) that:
1. Creates directories: images/, docs/, other/
2. Moves *.png *.jpg *.gif files into images/
3. Moves *.pdf *.txt *.md files into docs/
4. Moves everything else into other/
5. Prints a summary: "Moved X images, Y docs, Z other files"

Create some test files first (touch a.png b.txt c.pdf d.jpg e.md f.unknown),
run the script, verify it worked, then finish.`,
    verify: (answer, code) => answer.includes("Moved") || answer.includes("images") || (code?.includes("mv") ?? false),
  },

  // ── Bug fixing ──────────────────────────────────────────────────────────
  {
    name: "fix-bug",
    task: `Here's a Python function with a bug. Fix it, test it, then finish.

\`\`\`python
def proposedSolution(nums, k):
    """Return True if any two numbers in nums sum to k."""
    seen = set()
    for i in range(len(nums)):
        complement = k - nums[i]
        if complement in seen:
            return True
        seen.add(nums[i])
    # BUG: returns None instead of False when no pair found
\`\`\`

Write tests that verify:
- proposedSolution([1,2,3,4], 7) → True (3+4=7)
- proposedSolution([1,2,3], 7) → False (no pair sums to 7)
- proposedSolution([], 0) → False (empty array)
- proposedSolution([5,5], 10) → True (same value twice)

Fix the bug, run the tests, then finish.`,
    verify: (_, code) => (code?.includes("return False") && code?.includes("def proposedSolution")) ?? false,
  },

  // ── Code refactoring ────────────────────────────────────────────────────
  {
    name: "refactor",
    task: `Here's a working but poorly written Python function. Refactor it to be clean and idiomatic, test it to make sure it still works, then finish.

\`\`\`python
def proposedSolution(s):
    # Count vowels and consonants in a string
    v = 0
    c = 0
    for ch in s:
        if ch.lower() in 'aeiou':
            v = v + 1
        elif ch.isalpha():
            c = c + 1
    r = {'vowels': v, 'consonants': c}
    return r
\`\`\`

Write tests verifying:
- proposedSolution("hello") → {"vowels": 2, "consonants": 3}
- proposedSolution("AEIOU") → {"vowels": 5, "consonants": 0}
- proposedSolution("123!@#") → {"vowels": 0, "consonants": 0}
- proposedSolution("") → {"vowels": 0, "consonants": 0}

Refactor the function (better variable names, cleaner logic, same functionality), test it, then finish.`,
    verify: (_, code) => code?.includes("def proposedSolution") ?? false,
  },

  // ── JSON/API response parsing ───────────────────────────────────────────
  {
    name: "json-transform",
    task: `Write a Python script (transform.py) that:
1. Reads input.json (array of objects with fields: id, name, email, department)
2. Groups employees by department
3. For each department, computes the count of employees
4. Writes output.json with format: {"Engineering": 5, "Sales": 3, ...}

Create a sample input.json with at least 8 employees across 3 departments,
run the script, verify the output is correct, then finish.`,
    verify: (answer) => answer.includes("output.json") || answer.includes("department"),
  },

  // ── Domain: Physics ─────────────────────────────────────────────────────
  {
    name: "projectile-motion",
    domain: "physics",
    task: `Write a Python simulation (simulation.py) that computes the range and maximum height of a projectile.

Given: initial velocity = 25 m/s, launch angle = 45 degrees, gravity = 9.8 m/s².

The script should:
1. Compute range = v² × sin(2θ) / g
2. Compute max height = (v × sin(θ))² / (2g)
3. Print "Range: X.XX meters"
4. Print "Max height: X.XX meters"

Use math.sin, math.cos, math.pi, and math.radians for angle conversion.
Write the script, run it, verify the output, then finish.`,
    verify: (answer) => answer.toLowerCase().includes("range") || answer.includes("63."),
  },

  // ── Domain: Engineering ─────────────────────────────────────────────────
  {
    name: "engineering-beam",
    domain: "engineering",
    task: `Write a Python calculation (calculation.py) that computes the maximum bending moment and deflection of a simply supported beam.

Given:
- Uniformly distributed load w = 5000 N/m
- Beam length L = 6 meters
- Elastic modulus E = 200e9 Pa (steel)
- Moment of inertia I = 4.5e-5 m⁴

Compute:
1. Maximum bending moment: M_max = w × L² / 8
2. Maximum deflection: δ_max = (5 × w × L⁴) / (384 × E × I)

Print "Max bending moment: X.XX N·m"
Print "Max deflection: X.XXX m"

Use proper units and engineering formulas. Run the script, then finish.`,
    verify: (answer) => answer.includes("moment") || answer.includes("deflection") || answer.includes("N"),
  },

  // ── Domain: Chemistry ───────────────────────────────────────────────────
  {
    name: "chemistry-balance",
    domain: "chemistry",
    task: `Write a Python calculation (calculation.py) that solves this stoichiometry problem:

Given the reaction: 2 H₂ + O₂ → 2 H₂O

If we have 10.0 grams of H₂ and 50.0 grams of O₂:
1. Determine the limiting reagent
2. Compute mass of H₂O produced
3. Compute mass of excess reagent remaining

Molar masses: H₂ = 2.016 g/mol, O₂ = 32.00 g/mol, H₂O = 18.015 g/mol

Print each result clearly. Run the script, then finish.`,
    verify: (answer) => answer.includes("limiting") || answer.includes("H₂O") || answer.includes("produced"),
  },

  // ── Domain: Geography (non-code, document output) ────────────────────────
  {
    name: "geography-facts",
    domain: "geography",
    task: `Research and write a document (answer.md) answering these questions:
1. What is the capital of Mongolia?
2. What is the approximate population of Ulaanbaatar?
3. What river flows through it?

Use web_search() to look up facts, but if search returns nothing use your own knowledge. Write answer.md with the answers. Then call finish().

Note: you do NOT need to write Python code or run tests. Just research and write the document. Do ONE search then write the answer — don't loop searching.`,
    verify: (answer, code) => answer.includes("Ulaanbaatar") || answer.includes("Mongolia") || (code?.includes("Ulaanbaatar") ?? false),
  },

  // ── Domain: Research / general knowledge ─────────────────────────────────
  {
    name: "research-facts",
    domain: "research",
    task: `Research and answer this question in answer.md:

"What is the largest moon in our solar system, and how does its diameter compare to Earth's moon?"

Use web_search() to find facts, but if search returns nothing use your own knowledge. Write answer.md with:
1. The name of the largest moon
2. Its exact diameter
3. Comparison to Earth's moon (diameter and ratio)
4. Source URLs if available

Then call finish(). No coding needed — do ONE search then write the answer.`,
    verify: (answer, code) => answer.includes("Ganymede") || answer.includes("moon") || (code?.includes("Ganymede") ?? false),
  },
];

// ── Runner ────────────────────────────────────────────────────────────────

async function runTests(filter?: string) {
  const selected = filter
    ? TESTS.filter(t => t.name.includes(filter))
    : TESTS;

  if (selected.length === 0) {
    console.log(`No tests match filter "${filter}". Available: ${TESTS.map(t => t.name).join(", ")}`);
    return;
  }

  console.log(`Running ${selected.length} TaskAgent test(s)...\n`);

  let passed = 0;
  let failed = 0;

  for (const test of selected) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`TEST: ${test.name}`);
    console.log(`${"=".repeat(60)}`);

    try {
      const result = await runTaskAgent(test.task, {
        maxTurns: 10,
        useStrongModel: true,
        testFirst: true,
        domain: test.domain,
      });

      const verified = test.verify ? test.verify(result.answer, result.sourceCode) : result.success;

      console.log(`\n  Success: ${result.success}`);
      console.log(`  Turns:   ${result.turns}`);
      console.log(`  Answer:  ${result.answer.slice(0, 150)}`);
      if (result.sourceCode) {
        console.log(`  Code:    ${result.sourceCode.slice(0, 200).replace(/\n/g, "\\n")}`);
      }
      console.log(`  Verify:  ${verified ? "PASS" : "FAIL"}`);

      if (verified) {
        passed++;
      } else {
        failed++;
        console.log(`\n  [transcript excerpt]:`);
        const lines = result.transcript.split("\n");
        // Show last observation and last assistant message
        const lastObs = lines.filter(l => l.includes("observation") || l.includes("[Exit code]") || l.includes("Error")).slice(-5);
        for (const l of lastObs) console.log(`    ${l.slice(0, 200)}`);
      }
    } catch (err) {
      console.log(`  ERROR: ${(err as Error).message?.slice(0, 200)}`);
      failed++;
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`RESULTS: ${passed}/${selected.length} passed, ${failed}/${selected.length} failed`);
  console.log(`${"=".repeat(60)}`);
}

const filter = process.argv[2];
runTests(filter).catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
