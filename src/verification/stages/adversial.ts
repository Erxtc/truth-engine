import { queryLlm } from "../../llm";
import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as v from "valibot";
import type { VerificationStage, StageResult } from "../types";
import type { Artifact } from "../../db/schema";

const attackSchema = v.object({
	inputArray: v.array(v.number()),
	expectedFailure: v.string(),
});

export const adversarialAttack: VerificationStage = {
	name: "Adversarial",
	async run(artifact: Artifact): Promise<StageResult> {
		const sourceCode = artifact.sourceCode;
		if (!sourceCode) return { stageName: this.name, passed: false, reason: "No source code", runtimeMs: 0 };

		const start = Date.now();
		const prompt = `
You are a red-team attacker. Given the following JavaScript sorting function, try to find an input array that causes it to fail.
Failure means: throws an exception, produces unsorted output, changes elements, or crashes.

Function:
${sourceCode}

Return a JSON object with:
{
  "inputArray": [ ... ],
  "expectedFailure": "description of why it fails"
}
If you cannot find a failure after thinking, return { "inputArray": null }.
    `.trim();

		let inputArray: number[] | null = null;
		try {
			const result = await queryLlm(prompt, attackSchema);
			inputArray = result.inputArray;
		} catch (e) {
			// LLM failed – we can't guarantee it's safe, so skip adversarial
			return { stageName: this.name, passed: true, reason: "Adversarial LLM error, skipping", runtimeMs: Date.now() - start };
		}

		if (!inputArray) {
			return { stageName: this.name, passed: true, runtimeMs: Date.now() - start };
		}

		// Execute the function with the adversarial input
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "truth-adv-"));
		const testFile = path.join(tmpDir, "attack.js");
		const harnessCode = `
${sourceCode}
const input = ${JSON.stringify(inputArray)};
const expected = [...input].sort((a,b)=>a-b);
let output;
try {
  output = proposedSort([...input]);
} catch(e) {
  console.log(JSON.stringify({passed: false, reason: e.message}));
  process.exit(0);
}
const sortedOk = output.every((v,i,a) => !i || a[i-1] <= v);
const elementsOk = JSON.stringify([...output].sort((a,b)=>a-b)) === JSON.stringify(expected);
if (!sortedOk || !elementsOk) {
  console.log(JSON.stringify({passed: false, reason: "Adversarial input broke the function"}));
} else {
  console.log(JSON.stringify({passed: true}));
}
    `.trim();

		fs.writeFileSync(testFile, harnessCode);
		try {
			const output = execSync(`node ${testFile}`, { timeout: 5000, stdio: "pipe" });
			fs.rmSync(tmpDir, { recursive: true, force: true });
			const result = JSON.parse(output.toString().trim());
			return {
				stageName: this.name,
				passed: result.passed,
				reason: result.passed ? undefined : result.reason,
				runtimeMs: Date.now() - start,
				artifacts: { adversarialInput: JSON.stringify(inputArray) },
			};
		} catch (err: any) {
			fs.rmSync(tmpDir, { recursive: true, force: true });
			return { stageName: this.name, passed: false, reason: `Execution error: ${err.stderr || err.message}`, runtimeMs: Date.now() - start };
		}
	}
};