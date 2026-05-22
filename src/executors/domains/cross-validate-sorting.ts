import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Proposal } from "../../core/types";
import type { CrossValidationResult } from "./registry";
import { transpileToJs } from "../../utils/general";

const CASES = 500;
const MAX_LEN = 200;

/**
 * Cross-validate two sorting proposals by running both on the same random inputs
 * and comparing their outputs. Both proposals must be code-type with a proposedSort function.
 */
export async function crossValidateSorting(
	a: Proposal,
	b: Proposal
): Promise<CrossValidationResult> {
	if (a.executable.type !== "code" || b.executable.type !== "code") {
		return { agree: false, summary: "One or both proposals are not code-type", agreementRate: 0 };
	}

	const srcA = transpileToJs(a.executable.source);
	const srcB = transpileToJs(b.executable.source);

	const harness = `
${srcA}
const _sortA = typeof proposedSort !== "undefined" ? proposedSort : null;

// Rename B's function to avoid collision
const _srcB = ${JSON.stringify(srcB)};
let _sortB = null;
try {
  const _b = new Function(_srcB + "\\nreturn proposedSort;")();
  _sortB = _b;
} catch(e) {
  process.stdout.write(JSON.stringify({ error: "B load failed: " + e.message }));
  process.exit(0);
}

if (!_sortA) {
  process.stdout.write(JSON.stringify({ error: "A has no proposedSort" }));
  process.exit(0);
}

function randArray() {
  const len = Math.floor(Math.random() * ${MAX_LEN});
  return Array.from({ length: len }, () => Math.floor(Math.random() * 2001) - 1000);
}

let agreed = 0;
let total = ${CASES};
let firstDiff = null;

for (let i = 0; i < total; i++) {
  const arr = randArray();
  let outA, outB;
  try { outA = _sortA([...arr]); } catch(e) { firstDiff = { case: i, error: "A threw: " + e.message }; break; }
  try { outB = _sortB([...arr]); } catch(e) { firstDiff = { case: i, error: "B threw: " + e.message }; break; }
  if (JSON.stringify(outA) === JSON.stringify(outB)) {
    agreed++;
  } else if (!firstDiff) {
    firstDiff = { case: i, input: arr.slice(0, 10), outA: outA?.slice(0, 10), outB: outB?.slice(0, 10) };
  }
}

process.stdout.write(JSON.stringify({ agreed, total, firstDiff }));
`.trim();

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "truth-xval-"));
	const tmpFile = path.join(tmpDir, "xval.js");

	try {
		fs.writeFileSync(tmpFile, harness);
		const raw = execSync(`node ${tmpFile}`, { timeout: 20_000, stdio: "pipe" }).toString().trim();
		const result = JSON.parse(raw) as { agreed?: number; total?: number; firstDiff?: any; error?: string };

		if (result.error) {
			return { agree: false, summary: result.error, agreementRate: 0 };
		}

		const rate = (result.agreed ?? 0) / (result.total ?? CASES);
		const agree = rate >= 0.99; // allow 1% tolerance for floating point edge cases
		const summary = agree
			? `Both sort functions agreed on ${result.agreed}/${result.total} random test cases`
			: `Disagreed on ${(result.total ?? 0) - (result.agreed ?? 0)} cases. First diff: ${JSON.stringify(result.firstDiff)}`;

		return { agree, summary, agreementRate: rate };
	} catch (err: any) {
		return {
			agree: false,
			summary: `Cross-validation script failed: ${err.stderr?.toString().slice(0, 200) ?? err.message}`,
			agreementRate: 0,
		};
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}
