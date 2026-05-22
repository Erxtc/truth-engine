import { Sandbox, parseSandboxOutput } from "../sandbox";
import { buildSortingHarness } from "../sandbox/harness-builder";
import type { PipelineResult } from "../../verification/types";
import type { Proposal, WorkingContext } from "../../core/types";
import { transpileToJs } from "../../utils/general";

export async function runSortingPipeline(
	proposal: Proposal,
	_ctx: WorkingContext
): Promise<PipelineResult> {
	if (proposal.executable.type !== "code") {
		return noExec("Sorting requires a code executable");
	}

	const { lang, source: rawSource } = proposal.executable;
	if (lang !== "js" && lang !== "ts" && lang !== "python" && lang !== "c") {
		return noExec(`Unsupported language for sorting: ${lang}`);
	}

	// Downgrade TS → JS when lang="js" in case model slipped in type annotations
	const source = lang === "js" ? transpileToJs(rawSource) : rawSource;

	const harness = buildSortingHarness(source, lang as "js" | "ts" | "python" | "c");
	const sb = new Sandbox();
	try {
		for (const [rel, content] of Object.entries(harness.files)) {
			sb.write(rel, content);
		}
		const result = await sb.exec(harness.command, { timeoutMs: harness.timeoutMs });
		return parseSandboxOutput(result, "SortingPipeline");
	} finally {
		sb.cleanup();
	}
}

function noExec(reason: string): PipelineResult {
	return {
		overallPassed: false,
		stages: [{ stageName: "Validation", passed: false, reason, runtimeMs: 0 }],
		finalMetrics: {},
	};
}
