import { Sandbox, parseSandboxOutput } from "../sandbox/index";
import { buildSortingHarness } from "../sandbox/harness-builder";
import type { PipelineResult, Proposal, WorkingContext } from "../../core/types";
import { transpileToJs, failPipeline, normalizeEscapes } from "../../utils/general";
import { validateAndFixPython, validateAndFixJs, validateAndFixC } from "../../utils/code-validator";

export async function runSortingPipeline(
	proposal: Proposal,
	_ctx: WorkingContext
): Promise<PipelineResult> {
	if (proposal.executable.type !== "code") {
		return failPipeline("Sorting requires a code executable");
	}

	const { lang, source: rawSource } = proposal.executable;
	if (lang !== "js" && lang !== "ts" && lang !== "python" && lang !== "c") {
		return failPipeline(`Unsupported language for sorting: ${lang}`);
	}

	// Pre-execution syntax validation
	if (lang === "python") {
		const v = validateAndFixPython(normalizeEscapes(rawSource));
		if (!v.ok) return failPipeline(v.error ?? "Python syntax error");
		if (v.autoFixed) console.log("  [validator] Auto-fixed Python source before execution");
	} else if (lang === "c") {
		const v = validateAndFixC(rawSource);
		if (!v.ok) return failPipeline(v.error ?? "C syntax error");
	} else if (lang === "js" || lang === "ts") {
		const src = lang === "js" ? transpileToJs(rawSource) : rawSource;
		const v = validateAndFixJs(src);
		if (!v.ok) return failPipeline(v.error ?? "JS syntax error");
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
