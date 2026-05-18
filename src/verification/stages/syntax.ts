import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { VerificationStage, StageResult } from "../types";
import type { Artifact } from "../../db/schema";

export const syntaxCheck: VerificationStage = {
	name: "SyntaxCheck",
	async run(artifact: Artifact): Promise<StageResult> {
		const sourceCode = artifact.sourceCode;
		if (!sourceCode) {
			return { stageName: this.name, passed: false, reason: "No source code", runtimeMs: 0 };
		}

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "truth-syntax-"));
		const testFile = path.join(tmpDir, "check.js");
		const wrapperCode = `
try {
  ${sourceCode}
  if (typeof proposedSort !== 'function') throw new Error('proposedSort not defined');
} catch(e) {
  process.exit(1);
}
    `;
		fs.writeFileSync(testFile, wrapperCode);

		const start = Date.now();
		try {
			execSync(`node --check ${testFile}`, { timeout: 5000, stdio: "pipe" });
			fs.rmSync(tmpDir, { recursive: true, force: true });
			return { stageName: this.name, passed: true, runtimeMs: Date.now() - start };
		} catch (err: any) {
			fs.rmSync(tmpDir, { recursive: true, force: true });
			const errorMsg = err.stderr?.toString() || err.message;
			return { stageName: this.name, passed: false, reason: `Syntax error: ${errorMsg}`, runtimeMs: Date.now() - start };
		}
	}
};