import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { VerificationStage, StageResult } from "../types";
import type { Artifact } from "../../db/schema";

export const performanceBenchmark: VerificationStage = {
	name: "Performance",
	async run(artifact: Artifact): Promise<StageResult> {
		const sourceCode = artifact.sourceCode;
		if (!sourceCode) return { stageName: this.name, passed: false, reason: "No source code", runtimeMs: 0 };

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "truth-perf-"));
		const testFile = path.join(tmpDir, "perf.js");

		const harnessCode = `
${sourceCode}
const ARRAY_SIZE = 50000; // smaller for speed
const RUNS = 7;

function makeArray(size) {
  return Array.from({ length: size }, () => Math.floor(Math.random() * 1_000_000));
}

function median(times) {
  const s = [...times].sort((a,b)=>a-b);
  return s[Math.floor(s.length/2)];
}

// Warm-up
proposedSort([3,2,1]);

const baselineTimes = [];
const proposedTimes = [];

for (let i = 0; i < RUNS; i++) {
  const arr = makeArray(ARRAY_SIZE);
  const bArr = [...arr];
  const pArr = [...arr];

  const t0 = performance.now();
  bArr.sort((a,b) => a-b);
  baselineTimes.push(performance.now() - t0);

  const t1 = performance.now();
  proposedSort(pArr);
  proposedTimes.push(performance.now() - t1);
}

const baselineMs = median(baselineTimes);
const proposedMs = median(proposedTimes);
const speedupPct = ((baselineMs - proposedMs) / baselineMs) * 100;
const regression = proposedMs > baselineMs * 1.05;

console.log(JSON.stringify({
  baselineMs, proposedMs, speedupPct, regression
}));
    `.trim();

		fs.writeFileSync(testFile, harnessCode);

		const start = Date.now();
		try {
			const output = execSync(`node ${testFile}`, { timeout: 30000, stdio: "pipe" });
			fs.rmSync(tmpDir, { recursive: true, force: true });
			const { baselineMs, proposedMs, speedupPct, regression } = JSON.parse(output.toString().trim());
			return {
				stageName: this.name,
				passed: !regression,
				reason: regression ? `Regression: ${proposedMs}ms vs ${baselineMs}ms` : undefined,
				metrics: { baselineMs, proposedMs, speedupPct },
				runtimeMs: Date.now() - start,
			};
		} catch (err: any) {
			fs.rmSync(tmpDir, { recursive: true, force: true });
			return { stageName: this.name, passed: false, reason: `Perf error: ${err.stderr || err.message}`, runtimeMs: Date.now() - start };
		}
	}
};