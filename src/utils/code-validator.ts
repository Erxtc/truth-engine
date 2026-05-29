/**
 * Pre-execution code validator and auto-fixer.
 *
 * Catches common 7B model code generation mistakes before handing off to the oracle:
 *  - Mixed tabs/spaces (Python IndentationError)
 *  - `expression return value` on one line without a newline separator
 *  - Missing `nonlocal` declarations in nested functions
 *  - Single-line compound statements that Python can't parse
 *
 * Returns the (possibly auto-fixed) source and a structured error if unfixable.
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface ValidationResult {
	source: string;   // possibly auto-fixed source
	ok: boolean;
	error?: string;   // human-readable error with hints, for the repair agent
	autoFixed: boolean;
}

// ── Public entry points ──────────────────────────────────────────────────────

export function validateAndFixPython(source: string): ValidationResult {
	let current = source;
	let autoFixed = false;

	// Pass 1: cheap text-level fixes
	const pass1 = textFix(current);
	if (pass1 !== current) { current = pass1; autoFixed = true; }

	// Check after pass 1
	let check = compilePython(current);
	if (check.ok) return { source: current, ok: true, autoFixed };

	// Pass 2: if IndentationError, normalize all indentation to 4-space
	if (isIndentError(check.error)) {
		const pass2 = normalizeIndent(current);
		if (pass2 !== current) {
			const check2 = compilePython(pass2);
			if (check2.ok) return { source: pass2, ok: true, autoFixed: true };
			check = check2;
			current = pass2;
		}
	}

	// Pass 3: if UnboundLocalError or NameError on a simple counter, add nonlocal
	if (isNonlocalError(check.error)) {
		const pass3 = insertNonlocal(current, check.error ?? "");
		if (pass3 !== current) {
			const check3 = compilePython(pass3);
			if (check3.ok) return { source: pass3, ok: true, autoFixed: true };
			check = check3;
			current = pass3;
		}
	}

	// Pass 4: try expanding single-line def bodies
	const pass4 = expandSingleLineDefs(current);
	if (pass4 !== current) {
		const check4 = compilePython(pass4);
		if (check4.ok) return { source: pass4, ok: true, autoFixed: true };
		check = check4;
		current = pass4;
	}

	return {
		source: current,
		ok: false,
		error: formatPythonError(current, check.error ?? "unknown error"),
		autoFixed,
	};
}

export function validateAndFixJs(source: string): ValidationResult {
	const check = compileJs(source);
	if (check.ok) return { source, ok: true, autoFixed: false };
	return {
		source,
		ok: false,
		error: formatJsError(source, check.error ?? "unknown error"),
		autoFixed: false,
	};
}

export function validateAndFixC(source: string): ValidationResult {
	const check = compileC(source);
	if (check.ok) return { source, ok: true, autoFixed: false };
	return {
		source,
		ok: false,
		error: formatCError(source, check.error ?? "unknown error"),
		autoFixed: false,
	};
}

// ── Shared compile helper ────────────────────────────────────────────────────

function compileWith(
  source: string,
  filePrefix: string,
  fileSuffix: string,
  buildCmd: (tmpPath: string) => string,
): { ok: boolean; error?: string } {
  const tmp = path.join(os.tmpdir(), `${filePrefix}_${process.pid}_${Date.now()}${fileSuffix}`);
  try {
    fs.writeFileSync(tmp, source);
    execSync(buildCmd(tmp), { stdio: "pipe", timeout: 5000 });
    return { ok: true };
  } catch (err: any) {
    const raw = (err.stderr?.toString() ?? err.stdout?.toString() ?? err.message ?? "");
    const msg = raw.replace(tmp, "<code>");
    return { ok: false, error: msg };
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// ── Python compile check ─────────────────────────────────────────────────────

function compilePython(source: string): { ok: boolean; error?: string } {
  return compileWith(source, "pycheck", ".py",
    (t) => `python3 -m py_compile ${JSON.stringify(t)}`);
}

// ── C syntax check ───────────────────────────────────────────────────────────

function compileC(source: string): { ok: boolean; error?: string } {
  return compileWith(source, "ccheck", ".c",
    (t) => `gcc -fsyntax-only -Wall -Wextra -x c ${JSON.stringify(t)}`);
}

// ── JS syntax check ──────────────────────────────────────────────────────────

function compileJs(source: string): { ok: boolean; error?: string } {
  return compileWith(source, "jscheck", ".js",
    (t) => `node --check ${JSON.stringify(t)}`);
}

// ── Text-level fixes ─────────────────────────────────────────────────────────

function textFix(src: string): string {
	return src
		// "expr return/raise" on THE SAME LINE without a preceding colon
		// Only match SPACES (not newlines) between the expression and the keyword
		// This fixes: "x = y return z" but NOT cross-line tab/space issues
		.replace(/([)\]a-zA-Z0-9'"]) +(return\b)/g, "$1\n    $2")
		.replace(/([)\]a-zA-Z0-9'"]) +(raise\b)/g, "$1\n    $2")
		// Normalize Windows line endings
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n");
}

// ── Indentation normaliser ───────────────────────────────────────────────────

function normalizeIndent(src: string): string {
	// Strategy: find the nearest enclosing 'def'/'class' before each tab section
	// and use that line's indent level as the base for tab expansion.
	// This handles the common 7B model pattern of outer-function using spaces,
	// inner function body using tabs (where 1 tab = 1 additional indent level).
	const lines = src.split("\n");
	const result: string[] = [];
	let tabBase = 0;
	let inTabSection = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (!line.trim()) { result.push(line); continue; }

		const startsWithTab = line.startsWith("\t");

		if (startsWithTab) {
			if (!inTabSection) {
				// Transition: space → tab. Find nearest enclosing def/class for tabBase.
				inTabSection = true;
				tabBase = findDefBase(lines, i);
			}
			const tabCount = line.match(/^\t*/)?.[0].length ?? 0;
			const absIndent = tabBase + tabCount * 4;
			result.push(" ".repeat(absIndent) + line.slice(tabCount));
		} else {
			inTabSection = false;
			result.push(line);
		}
	}

	return result.join("\n");
}

function findDefBase(lines: string[], transitionIdx: number): number {
	// Look back from the transition point for the nearest def/class/async def
	for (let j = transitionIdx - 1; j >= 0; j--) {
		const line = lines[j];
		if (!line?.trim() || line.startsWith("\t")) continue;
		const trimmed = line.trimStart();
		const spaceCount = line.length - trimmed.length;
		if (/^(async\s+)?def\s|^class\s/.test(trimmed)) {
			return spaceCount;
		}
	}
	return 0;
}

// ── Nonlocal injection ───────────────────────────────────────────────────────

function isNonlocalError(error?: string): boolean {
	return !!(error && (
		error.includes("UnboundLocalError") ||
		(error.includes("NameError") && error.includes("not defined"))
	));
}

function isIndentError(error?: string): boolean {
	return !!(error && (
		error.includes("IndentationError") ||
		error.includes("TabError") ||
		error.includes("unexpected indent") ||
		error.includes("expected an indented block") ||
		error.includes("inconsistent use of tabs")
	));
}

function insertNonlocal(src: string, error: string): string {
	// Extract the variable name from the error message
	const match = error.match(/name '([^']+)' is not defined|local variable '([^']+)'/);
	const varName = match?.[1] ?? match?.[2];
	if (!varName) return src;

	// Find inner functions (def inside def) and add `nonlocal varName` after their first line
	const lines = src.split("\n");
	let outerIndent = -1;
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i]!;
		const trimmed = line.trimStart();
		const indent = line.length - trimmed.length;

		if (trimmed.startsWith("def ") && outerIndent === -1) {
			outerIndent = indent;
			out.push(line);
		} else if (trimmed.startsWith("def ") && indent > outerIndent) {
			// inner function — add nonlocal after the def line
			out.push(line);
			// find the body indent
			const bodyIndent = "    ".repeat(indent / 4 + 1);
			out.push(`${bodyIndent}nonlocal ${varName}`);
		} else {
			out.push(line);
		}
		i++;
	}
	return out.join("\n");
}

// ── Single-line def expander ─────────────────────────────────────────────────

function expandSingleLineDefs(src: string): string {
	// "def f(x): stmt1; stmt2" → proper multi-line
	return src.replace(
		/^(\s*def [^:]+:)\s+(.+)$/gm,
		(_, defLine, body) => {
			const indent = defLine.match(/^(\s*)/)?.[1] ?? "";
			const innerIndent = indent + "    ";
			// Split body by semicolons, skip empty parts
			const stmts = body.split(";").map((s: string) => s.trim()).filter(Boolean);
			return defLine + "\n" + stmts.map((s: string) => innerIndent + s).join("\n");
		}
	);
}

// ── Error formatters ─────────────────────────────────────────────────────────

function formatPythonError(src: string, rawError: string): string {
	const lines = src.split("\n");

	// Extract line number
	const lineMatch = rawError.match(/line (\d+)/);
	const lineNum = lineMatch ? parseInt(lineMatch[1]!) : null;
	const offendingLine = lineNum != null ? (lines[lineNum - 1] ?? null) : null;

	let hint = "";
	if (rawError.includes("expected an indented block")) {
		hint = "HINT: An if/for/while/def/else block must have at least one statement in its body. Use 'pass' if the body is empty. Check that the body is indented one level deeper than the block header.";
	} else if (rawError.includes("IndentationError") || rawError.includes("unexpected indent")) {
		hint = "HINT: Use consistent 4-space indentation. Do NOT mix tabs and spaces. Each nested block adds exactly 4 spaces.";
	} else if (rawError.includes("NameError") || rawError.includes("UnboundLocalError")) {
		hint = "HINT: If you modify a variable from an outer scope inside a nested function, add 'nonlocal varname' at the top of the inner function. OR use a mutable container: count=[0] and count[0]+=1.";
	} else if (rawError.includes("SyntaxError")) {
		hint = "HINT: Check for missing colons after def/if/for/while/else. Do not put multiple statements on one line for compound blocks.";
	}

	const parts = ["PYTHON SYNTAX/RUNTIME ERROR:"];
	if (lineNum != null && offendingLine != null) {
		parts.push(`  Line ${lineNum}: ${offendingLine.trim()}`);
	}
	parts.push(`  Error: ${rawError.split("\n").filter(Boolean).slice(-2).join(" | ")}`);
	if (hint) parts.push(`  ${hint}`);
	return parts.join("\n");
}

function formatCError(src: string, rawError: string): string {
	const lines = src.split("\n");
	// GCC format: "<code>:line:col: error: message"
	const lineMatch = rawError.match(/<code>:(\d+):\d+:/);
	const lineNum = lineMatch ? parseInt(lineMatch[1]!) : null;
	const offendingLine = lineNum != null ? (lines[lineNum - 1] ?? null) : null;

	let hint = "";
	if (rawError.includes("undeclared") || rawError.includes("implicit declaration")) {
		hint = "HINT: All variables and functions must be declared before use. Add #include for missing standard headers.";
	} else if (rawError.includes("expected") && rawError.includes("before")) {
		hint = "HINT: Check for missing semicolons, mismatched braces/parens, or stray characters.";
	} else if (rawError.includes("conflicting types") || rawError.includes("redefinition")) {
		hint = "HINT: Function defined twice or prototype conflicts with definition. Remove duplicate or add 'static'.";
	} else if (rawError.includes("no return")) {
		hint = "HINT: Non-void function must return a value on all paths.";
	}

	const parts = ["C SYNTAX ERROR:"];
	if (lineNum != null && offendingLine != null) {
		parts.push(`  Line ${lineNum}: ${offendingLine.trim()}`);
	}
	// GCC gives many lines; take the first 4 meaningful ones
	const errorLines = rawError.split("\n").filter(l => l.includes("error:") || l.includes("warning:")).slice(0, 4);
	parts.push(`  Error: ${errorLines.join(" | ") || rawError.slice(0, 200)}`);
	if (hint) parts.push(`  ${hint}`);
	return parts.join("\n");
}

function formatJsError(src: string, rawError: string): string {
	const lines = src.split("\n");
	const lineMatch = rawError.match(/:(\d+)$/m);
	const lineNum = lineMatch ? parseInt(lineMatch[1]!) : null;
	const offendingLine = lineNum != null ? (lines[lineNum - 1] ?? null) : null;

	const parts = ["JAVASCRIPT SYNTAX ERROR:"];
	if (lineNum != null && offendingLine != null) {
		parts.push(`  Line ${lineNum}: ${offendingLine.trim()}`);
	}
	parts.push(`  Error: ${rawError.split("\n").filter(Boolean).slice(-2).join(" | ")}`);
	return parts.join("\n");
}
