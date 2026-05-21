import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { VerificationStage, StageResult } from "../types";
import type { Artifact } from "../../db/schema";

export const propertyFuzz: VerificationStage = {
  name: "PropertyFuzz",
  async run(artifact: Artifact): Promise<StageResult> {
    const sourceCode = artifact.sourceCode;
    if (!sourceCode) return { stageName: this.name, passed: false, reason: "No source code", runtimeMs: 0 };

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "truth-fuzz-"));
    const testFile = path.join(tmpDir, "fuzz.js");

    // Simple fuzzing harness: generate random arrays and check invariants
    const harnessCode = `
${sourceCode}

function runFuzz(iterations = 500) {
  for (let i = 0; i < iterations; i++) {
    const len = Math.floor(Math.random() * 100);
    const arr = Array.from({ length: len }, () => Math.floor(Math.random() * 1000) - 500);
    const input = [...arr];
    let output;
    try {
      output = proposedSort([...arr]);
    } catch(e) {
      return { passed: false, reason: 'Threw: ' + e.message, iteration: i };
    }
    // Invariant 1: same length
    if (output.length !== input.length) {
      return { passed: false, reason: 'Length mismatch', iteration: i, input, output };
    }
    // Invariant 2: sorted
    for (let j = 1; j < output.length; j++) {
      if (output[j] < output[j-1]) {
        return { passed: false, reason: 'Not sorted', iteration: i, input, output };
      }
    }
    // Invariant 3: multiset equality (simplified)
    const sortedInput = [...input].sort((a,b)=>a-b);
    const sortedOutput = [...output].sort((a,b)=>a-b);
    if (JSON.stringify(sortedInput) !== JSON.stringify(sortedOutput)) {
      return { passed: false, reason: 'Elements changed', iteration: i, input, output };
    }
  }
  return { passed: true, iterations };
}

const result = runFuzz(500);
console.log(JSON.stringify(result));
    `.trim();

    fs.writeFileSync(testFile, harnessCode);

    const start = Date.now();
    try {
      const output = execSync(`node ${testFile}`, { timeout: 15000, stdio: "pipe" });
      fs.rmSync(tmpDir, { recursive: true, force: true });
      const result = JSON.parse(output.toString().trim());
      return {
        stageName: this.name,
        passed: result.passed,
        reason: result.passed ? undefined : result.reason,
        metrics: { iterations: result.iterations || 0 },
        runtimeMs: Date.now() - start,
      };
    } catch (err: any) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return { stageName: this.name, passed: false, reason: `Fuzz error: ${err.stderr || err.message}`, runtimeMs: Date.now() - start };
    }
  }
};