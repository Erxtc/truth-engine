import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { VerificationStage, StageResult } from "../types";
import type { Artifact } from "../../db/schema";
import type { Proposal } from "../../core/types";

export const unitTests: VerificationStage = {
	name: "UnitTests",
	async run(artifact: Artifact): Promise<StageResult> {
		const sourceCode = artifact.sourceCode;
		const proposal = artifact.payload as Proposal | undefined;
		const testCases = proposal?.suggested_tests || [];

		if (!sourceCode) {
			return { stageName: this.name, passed: false, reason: "No source code", runtimeMs: 0 };
		}

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "truth-unit-"));
		const harnessFile = path.join(tmpDir, "harness.js");

		// Build test harness
		const testLines = testCases.map(tc => {
			// Try to convert test description to actual array input if possible
			const input = tc.test_name.includes("empty") ? "[]" : "[5,3,1]"; // simplified
			return `
  try {
    const input = ${input};
    const expected = [...input].sort((a,b)=>a-b);
    const result = proposedSort([...input]);
    if (JSON.stringify(result) !== JSON.stringify(expected)) {
      return { name: "${tc.test_name}", passed: false, detail: "Output mismatch" };
    }
    return { name: "${tc.test_name}", passed: true };
  } catch(e) {
    return { name: "${tc.test_name}", passed: false, detail: e.message };
  }`;
		}).join(",\n");

		const harnessCode = `
${sourceCode}
const results = [${testLines}];
console.log(JSON.stringify(results));
    `.trim();

		fs.writeFileSync(harnessFile, harnessCode);

		const start = Date.now();
		try {
			const output = execSync(`node ${harnessFile}`, { timeout: 10000, stdio: "pipe" });
			fs.rmSync(tmpDir, { recursive: true, force: true });
			const testResults = JSON.parse(output.toString().trim());
			const allPassed = testResults.every((r: any) => r.passed);
			return {
				stageName: this.name,
				passed: allPassed,
				testResults,
				runtimeMs: Date.now() - start,
				reason: allPassed ? undefined : "Some tests failed",
			};
		} catch (err: any) {
			fs.rmSync(tmpDir, { recursive: true, force: true });
			return { stageName: this.name, passed: false, reason: `Runtime error: ${err.stderr || err.message}`, runtimeMs: Date.now() - start };
		}
	}
};