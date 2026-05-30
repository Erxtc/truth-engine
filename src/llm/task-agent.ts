/**
 * TaskAgent — agentic ReAct loop for strong models (deepseek-cloud, Claude).
 *
 * Gives the model tools (read/write/execute in a sandbox) and lets it drive
 * its own problem-solving loop. The model iterates until it produces a final
 * answer or exhausts its turn budget.
 *
 * This is the Claude Code pattern: model sees task → thinks → acts → observes →
 * repeats until done. No harness-driven propose/execute/repair — the model
 * decides what to do next based on what it observes.
 */

import { queryDeepseekRaw, queryRawReasoning } from "./index";
import { Sandbox } from "../executors/sandbox/index";
import { searchWeb, formatSearchResults, fetchWebPage, formatFetchResult } from "./web-search";
import { getPreset } from "./workflow-presets";
import { buildSystemPrompt, buildSubAgentSystemPrompt } from "./task-agent-prompt";
import { StuckLoopDetector, isSelfTerminated } from "./stuck-loop-detector";
import { parseOracleOutput, sha256 } from "../utils/general";
import type { TurnRecord } from "./stuck-loop-detector";
import { HealthMonitor } from "../core/health-monitor";

// ── Types ────────────────────────────────────────────────────────────────────

/** Describes the expected workflow for a problem domain.
 *  The task-agent adapts its system prompt and verification strategy accordingly. */
export interface WorkflowConfig {
  /** Primary file(s) the agent should create (e.g. "solution.py", "paper.tex", "simulation.py") */
  solutionFiles: string[];
  /** Command to run for verification (e.g. "python3 oracle.py", "python3 simulate.py") */
  verifyCommand: string;
  /** Description of what the agent should produce */
  outputDescription: string;
  /** Language hint for code blocks */
  language: string;
  /** If true, the agent writes tests first then solution (spec-is-code). If false, oracle is pre-loaded. */
  testFirst: boolean;
  /** Additional rules specific to this workflow */
  extraRules?: string[];
  /** Domain invariants injected directly into system prompt */
  invariants?: string[];
  /** Enable web search tool for this workflow */
  enableWebSearch?: boolean;
  /** Enable write_note tool for research notes, plans, and todo tracking */
  enableNotes?: boolean;
  /** If true, the agent follows a 3-phase research→implement→verify workflow */
  researchPhases?: boolean;
  /** What the agent is producing (drives system prompt tone) */
  outputType?: "code" | "document" | "analysis";
  /** Paths to read after finish() for non-code output extraction */
  outputPaths?: string[];
  /** Shell commands to run before the agent starts (e.g., pip install numpy). Non-blocking. */
  workspaceSetup?: string[];
  /** If true, verifyCommand is a verifier script (e.g. "node verify-cli-project.js"), not an oracle.
   *  Changes the system prompt to say "verifier" instead of "oracle" and references the correct script. */
  isVerifierScript?: boolean;
}

export interface TaskAgentConfig {
  /** Max conversation turns before forcing termination */
  maxTurns: number;
  /** Sandbox timeout per command (ms) */
  commandTimeout: number;
  /** Total timeout for the entire task (ms) */
  taskTimeout: number;
  /** Whether to use the strong model (deepseek-cloud) or local 7B */
  useStrongModel: boolean;
  /** If true, the model is prompted to write tests first (spec-is-code pattern) */
  testFirst: boolean;
  /** Files to pre-load into the sandbox before the agent starts (path → content) */
  setupFiles?: Record<string, string>;
  /** Domain-specific workflow configuration. Defaults to single-file Python + oracle. */
  workflow?: Partial<WorkflowConfig>;
  /** If true, the web_search tool is available to the model */
  enableWebSearch?: boolean;
  /** Domain hint for auto-selecting workflow preset (e.g. "physics", "law") */
  domain?: string;
  /** Domain type/category for preset fallback (e.g. "cryptography", "engineering") */
  domainType?: string;
  /** If true, enable write_note tool for research notes, plans, and todo tracking */
  enableNotes?: boolean;
  /** If true, the agent follows a 3-phase research→implement→verify workflow */
  researchPhases?: boolean;
  /** Workspace ID for persistence across runs. When set, the sandbox dir is reused. */
  workspaceId?: string;
  /** If true, keep the sandbox directory after the run ends. */
  persistentWorkspace?: boolean;
  /** Enable container isolation (bubblewrap). Default: true (safe by default). */
  enableSandboxIsolation?: boolean;
  /** Sub-agent recursion depth (0 = top-level, 1 = sub-agent, etc.). Max 1. */
  depth?: number;
  /** Optional health monitor for per-turn progress tracking and stagnation detection. */
  healthMonitor?: HealthMonitor;
  /** Problem complexity — affects workflow, turn budget, and stuck-loop behavior. */
  complexity?: string;
  /** Supervisor direction hint — injected as an active constraint when the supervisor
   *  pivots the approach. Tells the task-agent what strategy to try instead. */
  supervisorHint?: string;
  /** Summary of previous attempt's failure — gives the task-agent context about
   *  what was already tried and why it failed. Prevents repeating the same mistakes. */
  previousAttemptSummary?: string;
  /** Domain-level invariants from auto-detected DomainSpec. Merged into the
   *  workflow invariants after preset resolution. Ensures LLM-generated domain
   *  constraints reach the task-agent even when no hand-crafted preset exists. */
  domainInvariants?: string[];
  /** Raw oracle source code (verify function). When set, it's included in the
   *  first observation so the model knows the test cases without spending a
   *  turn on read_file("oracle.js"). */
  oracleContent?: string;
  /** Reference data for standard algorithms (S-boxes, constants, pseudocode).
   *  Injected into the first user message so the model doesn't need to recall
   *  or web-search canonical values for AES, RSA, SHA, etc. */
  referenceData?: string;
  /** Internal: override the system prompt entirely (used by sub-agents). Not for external use. */
  _systemPromptOverride?: string;
}

export interface TaskAgentResult {
  success: boolean;
  /** The final answer (code or explanation) */
  answer: string;
  /** Extracted source code (if any) */
  sourceCode?: string;
  /** Number of turns taken */
  turns: number;
  /** Conversation transcript for debugging */
  transcript: string;
  /** Concise summary of what the agent tried — tools used, errors seen, final state.
   *  Feeds the supervisor so it can give specific, actionable guidance. */
  turnSummary: string;
  /** Hash of the system prompt used (for prompt version tracking) */
  systemPromptHash?: string;
}

interface ToolCall {
  tool: string;
  args: Record<string, string>;
}

// ── Default config ───────────────────────────────────────────────────────────

const DEFAULT_CONFIG: TaskAgentConfig = {
  maxTurns: 15,
  commandTimeout: 30_000,
  taskTimeout: 300_000,
  useStrongModel: true,
  testFirst: true,
  enableSandboxIsolation: process.env.SANDBOX_ISOLATION !== "off",
  enableWebSearch: false,
};

const DEFAULT_WORKFLOW: WorkflowConfig = {
  solutionFiles: ["solution.py"],
  verifyCommand: "python3 oracle.py",
  outputDescription: "Python function named proposedSolution that solves the problem",
  language: "python",
  testFirst: true,
  enableWebSearch: false,
  outputType: "code",
};

// buildSystemPrompt is in ./task-agent-prompt.ts (imported above)

// ── Command safety filter ────────────────────────────────────────────────────
// Only block truly dangerous patterns that could escape the sandbox or harm the
// host. Exploration commands (ls, pwd, find, which, env, etc.) are ALLOWED —
// the sandbox isolates via cwd + HOME + TMPDIR, so exploration is safe.

const DANGEROUS_PATTERNS: RegExp[] = [
  /(^|\s)(sudo|su)(\s|$)/,
  /rm\s+(-rf\s+)?\/[^*]/,
  /chmod\s+(-R\s+)?777\s+\//,
  /curl\s+.*\|\s*(ba)?sh/,
  /wget\s+.*\|\s*(ba)?sh/,
  /(^|\s)mount\s/,
  /mkfs\./,
  /dd\s+if=/,
  /chown\s+(-R\s+)?[^:\s]*:[^:\s]*\s+\//,
];

function isBlockedCommand(cmd: string): string | null {
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(cmd.trim())) {
      return `Command rejected: "${cmd.trim().slice(0, 60)}" — this pattern is blocked for host safety. The sandbox directory is your workspace; stay within it.`;
    }
  }
  return null;
}

// ── Tool execution ───────────────────────────────────────────────────────────

/** Extract the content of the nth code block (0-indexed) from text. */
function extractCodeBlock(text: string, blockIndex: number): string | null {
  if (!text.includes("```")) return null;
  const fences: number[] = [];
  let pos = 0;
  while (pos < text.length) {
    const f = text.indexOf("```", pos);
    if (f === -1) break;
    fences.push(f);
    pos = f + 3;
  }
  const startIdx = fences[blockIndex * 2];
  if (startIdx === undefined) return null;
  const afterOpen = text.slice(startIdx + 3);
  const nl = afterOpen.indexOf("\n");
  const contentStart = nl >= 0 ? nl + 1 : 0;
  const inner = afterOpen.slice(contentStart);
  const close = inner.indexOf("\n```");
  const end = close >= 0 ? close : inner.indexOf("```");
  return inner.slice(0, end >= 0 ? end : inner.length).trim();
}

function parseToolCall(response: string): ToolCall | null {
  // Match: Action: tool_name("arg1", "arg2") — handles bold markers (**Action:**)
  const actionMatch = response.match(/^(?:\*\*)?Action:(?:\*\*)?\s*(\w+)\s*\(([\s\S]*?)\)\s*$/m);
  if (!actionMatch) return null;

  const tool = actionMatch[1]!;
  const argsStr = actionMatch[2]!;

  // Detect template echo — model is copying prompt examples instead of acting
  if (tool === "tool_name" || argsStr.includes("arg1") || argsStr.includes("arg2")) {
    return null;
  }

  const args: Record<string, string> = {};

  // Parse quoted arguments (handles escaped quotes and newlines within quotes)
  const argValues: string[] = [];
  let i = 0;
  while (i < argsStr.length) {
    while (i < argsStr.length && (argsStr[i] === " " || argsStr[i] === "," || argsStr[i] === "\n")) i++;
    if (i >= argsStr.length) break;
    if (argsStr[i] !== '"') { i++; continue; }
    i++;
    let val = "";
    while (i < argsStr.length && argsStr[i] !== '"') {
      if (argsStr[i] === "\\" && i + 1 < argsStr.length) {
        const next = argsStr[i + 1];
        if (next === "n") { val += "\n"; i += 2; continue; }
        if (next === "t") { val += "\t"; i += 2; continue; }
        if (next === '"' || next === "\\") { val += next; i += 2; continue; }
      }
      val += argsStr[i];
      i++;
    }
    i++;
    argValues.push(val);
  }

  // Map positional args to names based on tool
  const afterAction = (() => { const idx = response.indexOf("Action:"); return idx >= 0 ? response.slice(idx) : response; })();

  switch (tool) {
    case "write_file":
      args.path = argValues[0] ?? "";
      args.content = argValues[1] ?? "";
      { const cb = extractCodeBlock(afterAction, 0); if (cb && cb.length > args.content.length) args.content = cb; }
      break;
    case "read_file":
      args.path = argValues[0] ?? "";
      break;
    case "run_command":
      args.command = argValues[0] ?? "";
      break;
    case "web_search":
      args.query = argValues[0] ?? "";
      break;
    case "web_fetch":
      args.url = argValues[0] ?? "";
      break;
    case "write_note":
      args.path = argValues[0] ?? "";
      args.content = argValues[1] ?? "";
      { const cb = extractCodeBlock(afterAction, 0); if (cb && cb.length > args.content.length) args.content = cb; }
      break;
    case "edit_file":
      args.path = argValues[0] ?? "";
      args.old_string = argValues[1] ?? "";
      args.new_string = argValues[2] ?? "";
      { const old = extractCodeBlock(afterAction, 0); if (old && old.length > args.old_string.length) args.old_string = old; }
      { const nw = extractCodeBlock(afterAction, 1); if (nw && nw.length > args.new_string.length) args.new_string = nw; }
      break;
    case "spawn_subagent":
      args.task = argValues[0] ?? "";
      break;
    case "finish":
      args.summary = argValues[0] ?? "";
      break;
  }

  return { tool, args };
}

interface TaskState {
  lastAction: { tool: string; time: number };
  lastTestResult: { passCount: number; failCount: number; failReasons: string[]; debugLines: string[] } | null;
  testResultHistory: Array<{ passCount: number; failCount: number; failReasons: string[] }>;
  subAgentCount: number;
  /** Track the most recent write to a solution file — used to detect when model skips testing */
  lastSolutionWrite: { path: string; time: number; tested: boolean } | null;
}

/** Parse test output from a run_command execution and generate strategic guidance. */
function analyzeTestOutput(cmd: string, stdout: string, stderr: string, exitCode: number): {
  passCount: number;
  jsonFailCount: number;
  failReasons: string[];
  debugLines: string[];
  guidance: string;
} {
  let passCount = 0;
  let jsonFailCount = 0;
  const failReasons: string[] = [];
  const debugLines: string[] = [];

  const full = [stdout, stderr].filter(Boolean).join("\n");
  const isTestRun = /test|oracle|pytest|unittest|tsc|--noEmit|--check|--verify|node\s+\S+\.js|python3?\s+\S+\.py/i.test(cmd);

  // Parse JSON test lines + debug lines from oracle output
  const parsed = parseOracleOutput(stdout);
  passCount = parsed.passCount;
  jsonFailCount = parsed.failing.length;
  failReasons.push(...parsed.failing.map(f => f.reason || "unknown"));
  debugLines.push(...parsed.debugLines);

  // Fallback for compiler/lint commands without JSON test lines
  if (isTestRun && passCount === 0 && jsonFailCount === 0) {
    const tscErrors = full.match(/error TS\d+/gi) || [];
    if (exitCode === 0 && tscErrors.length === 0) {
      passCount = 1;
    } else if (tscErrors.length > 0) {
      jsonFailCount = tscErrors.length;
      failReasons.push(...tscErrors.slice(0, 5));
    } else if (exitCode !== 0) {
      jsonFailCount = 1;
      failReasons.push(`Command failed: ${(stderr || stdout || `exit ${exitCode}`).slice(0, 200)}`);
    }
  }

  // Generate strategic guidance
  let guidance = "";
  if (jsonFailCount > 0 || (/\bFAIL(?:ED)?[:\s]/gi.test(full) && isTestRun)) {
    const totalTests = passCount + jsonFailCount;
    const passRate = totalTests > 0 ? passCount / totalTests : 0;
    guidance += `\n\n⚠ TESTS FAILED (${passCount}/${totalTests} passed, ${jsonFailCount} failed). Do NOT call finish() yet.`;
    if (failReasons.length > 0) guidance += `\n- Failures: ${failReasons.join(", ")}`;
    if (debugLines.length > 0) {
      guidance += `\n- Concrete failures (input → expected → got):`;
      for (const dl of debugLines.slice(0, 5)) guidance += `\n    ${dl}`;
    }
    if (passRate === 0) {
      guidance += `\n\n⚠ ALL tests failing — your approach is fundamentally wrong. Re-read the problem carefully. Try a COMPLETELY DIFFERENT algorithm.`;
    } else if (passRate >= 0.5) {
      guidance += `\n\n💡 Most tests pass (${(passRate * 100).toFixed(0)}%) — you're close! Focus on the specific failing cases above. Small targeted fix needed.`;
    } else {
      guidance += `\n\n⚠ Less than half of tests pass — significant rework needed. Study the failing cases above.`;
    }
    guidance += `\n- Fix the code, then RUN TESTS AGAIN to verify`;
  } else if (isTestRun && /\bPASS(?:ED)?[:\s]|ok\b|passed/i.test(full) && exitCode === 0) {
    guidance += `\n\nAll ${passCount} tests passed. You can now call finish().`;
  }

  return { passCount, jsonFailCount, failReasons, debugLines, guidance };
}

async function executeTool(
  call: ToolCall,
  sandbox: Sandbox,
  timeout: number,
  state: TaskState,
  workflow: WorkflowConfig,
  config: TaskAgentConfig,
  parentTask?: string,
): Promise<string> {
  switch (call.tool) {
    case "write_file": {
      state.lastAction = { tool: "write_file", time: Date.now() };
      const path = call.args.path || "solution.py";
      const content = call.args.content || "";
      if (!content || content.length < 5) {
        return `Error: write_file requires non-empty content. Got: "${content.slice(0, 100)}"`;
      }
      sandbox.write(path, content);
      let msg = `File written: ${path} (${content.split("\n").length} lines, ${content.length} chars)`;
      // Track writes to solution files — used to detect when model skips testing
      const isSolutionFile = workflow.solutionFiles?.some(f => path === f || path.endsWith(`/${f}`));
      if (isSolutionFile && workflow.verifyCommand) {
        state.lastSolutionWrite = { path, time: Date.now(), tested: false };
        msg += `\n\nNEXT STEP: Run \`${workflow.verifyCommand}\` NOW to verify your code. Do NOT write prove.py or any other file — run the verification command directly.`;
      }
      return msg;
    }

    case "read_file": {
      const path = call.args.path || "solution.py";
      try {
        const result = await sandbox.exec(`cat ${path}`, { timeoutMs: 15_000 });
        if (result.exitCode !== 0) {
          return `Error reading ${path}: ${result.stderr || "file not found"}`;
        }
        const content = result.stdout;
        if (content.length > 4000) {
          return `File: ${path}\n${content.slice(0, 4000)}\n... (truncated, ${content.length} total chars)`;
        }
        return `File: ${path}\n${content}`;
      } catch (err) {
        return `Error reading ${path}: ${err}`;
      }
    }

    case "run_command": {
      state.lastAction = { tool: "run_command", time: Date.now() };
      const cmd = call.args.command || "";
      if (!cmd || cmd.length < 2) {
        return "Error: run_command requires a command string";
      }
      // Reject exploration commands
      const blocked = isBlockedCommand(cmd);
      if (blocked) return blocked;
      try {
        const result = await sandbox.exec(cmd, { timeoutMs: timeout });
        const parts: string[] = [];
        // 8000 char stdout limit — long enough for board-based oracle debug output
        if (result.stdout) parts.push(result.stdout.slice(0, 8000));
        if (result.stderr) parts.push(`[stderr]\n${result.stderr.slice(0, 3000)}`);
        if (result.timedOut) parts.push("[Command timed out]");
        if (result.exitCode !== 0) parts.push(`[Exit code: ${result.exitCode}]`);

        let output = parts.join("\n") || `[Command completed with no output, exit ${result.exitCode}]`;

        // Analyze test output
        const analysis = analyzeTestOutput(cmd, result.stdout, result.stderr, result.exitCode);
        output += analysis.guidance;

        // Track test results across turns for pattern detection
        const isTestRun = /test|oracle|pytest|unittest|tsc|--noEmit|--check|--verify|node\s+\S+\.js|python3?\s+\S+\.py/i.test(cmd);
        if (isTestRun) {
          state.lastTestResult = { passCount: analysis.passCount, failCount: analysis.jsonFailCount, failReasons: analysis.failReasons, debugLines: analysis.debugLines };
          state.testResultHistory.push({ passCount: analysis.passCount, failCount: analysis.jsonFailCount, failReasons: analysis.failReasons });
          if (state.testResultHistory.length > 10) state.testResultHistory.shift();
          // Mark that the model tested after writing solution code
          if (state.lastSolutionWrite) state.lastSolutionWrite.tested = true;
        }

        return output;
      } catch (err) {
        return `Error executing command: ${err}`;
      }
    }

    case "web_search": {
      const query = call.args.query || "";
      if (!query || query.length < 3) {
        return "Error: web_search requires a non-empty query (at least 3 characters)";
      }
      try {
        const results = await searchWeb(query);
        return formatSearchResults(results);
      } catch (err) {
        return `[SEARCH ERROR for "${query}": ${err}]`;
      }
    }

    case "web_fetch": {
      const url = call.args.url || "";
      if (!url || !url.startsWith("http")) {
        return "Error: web_fetch requires a valid URL (must start with http:// or https://)";
      }
      try {
        const result = await fetchWebPage(url);
        return formatFetchResult(result);
      } catch (err) {
        return `[FETCH ERROR for "${url}": ${err}]`;
      }
    }

    case "edit_file": {
      state.lastAction = { tool: "edit_file", time: Date.now() };
      const path = call.args.path || "";
      const oldStr = call.args.old_string || "";
      const newStr = call.args.new_string || "";
      if (!path) return "Error: edit_file requires a file path";
      if (!oldStr) return "Error: edit_file requires old_string (the text to replace). Put it in a ``` code block after the Action line.";
      if (oldStr === newStr) return "Error: old_string and new_string are identical. Nothing to change.";

      const content = sandbox.read(path);
      if (content === null) return `Error: File not found: ${path}`;

      // Count occurrences of old_string
      const occurrences = content.split(oldStr).length - 1;
      if (occurrences === 0) {
        return `Error: old_string not found in ${path}. The file content may have changed since you last read it. Use read_file("${path}") to see current content, then try again.`;
      }
      if (occurrences > 1) {
        return `Error: old_string matches ${occurrences} locations in ${path}. Provide more surrounding context to make the match unique.`;
      }

      const newContent = content.replace(oldStr, newStr);
      sandbox.write(path, newContent);
      let msg = `File edited: ${path} — replaced 1 occurrence (${oldStr.length} → ${newStr.length} chars). Use read_file("${path}") to verify.`;
      // Track edits to solution files — used to detect when model skips testing
      const isSolutionFile = workflow.solutionFiles?.some(f => path === f || path.endsWith(`/${f}`));
      if (isSolutionFile && workflow.verifyCommand) {
        state.lastSolutionWrite = { path, time: Date.now(), tested: false };
      }
      return msg;
    }

    case "write_note": {
      const notePath = call.args.path || "note.md";
      const content = call.args.content || "";
      if (!content || content.length < 5) {
        return `Error: write_note requires non-empty content. Got: "${content.slice(0, 100)}"`;
      }
      // Write to notes/ directory — auto-create via sandbox
      const fullPath = `notes/${notePath}`;
      sandbox.write(fullPath, content);
      return `Note written: ${fullPath} (${content.split("\n").length} lines, ${content.length} chars). Use read_file("${fullPath}") to review, edit_file to update.`;
    }

    case "spawn_subagent": {
      // Recursion guard: max depth 1 (top-level can spawn sub-agents; sub-agents cannot)
      const currentDepth = config.depth ?? 0;
      if (currentDepth >= 1) {
        return `Error: spawn_subagent is not available at depth ${currentDepth}. Sub-agents cannot spawn further sub-agents. Solve this sub-problem directly.`;
      }
      const subTask = call.args.task || "";
      if (!subTask || subTask.length < 10) {
        return "Error: spawn_subagent requires a meaningful task description (at least 10 characters). Describe the sub-problem clearly so the sub-agent knows what to solve.";
      }
      try {
        // Enrich the sub-agent task with parent context so it understands
        // the big picture and how its output integrates.
        const parentCtx = parentTask || "";
        const domainCtx = config.domain || config.domainType || "";
        const enrichedTask = [
          domainCtx ? `[Domain: ${domainCtx}]` : "",
          subTask,
          parentCtx ? `\n\nParent context (for awareness only — your job is the sub-task above):\n${parentCtx.slice(0, 300)}` : "",
        ].filter(Boolean).join("\n");

        // Build a sub-agent-specific workflow that uses its dedicated system prompt
        const subWorkflow: Partial<WorkflowConfig> = {
          solutionFiles: ["solution.py"],
          verifyCommand: "python3 prove.py",
          outputDescription: "A Python function named proposedSolution that solves the sub-problem",
          language: workflow.language || "python",
          testFirst: true,
          outputType: "code",
          // Override system prompt via override pattern — see runTaskAgent below
        };

        const subFileName = `_sub_${state.subAgentCount}.py`;
        const subSystemPrompt = buildSubAgentSystemPrompt({
          domain: config.domain,
          domainType: config.domainType,
          parentTask: parentCtx || "unknown parent task",
          integrationHint: `Your solution.py will be saved as ${subFileName} and imported by the parent: from ${subFileName.replace(".py", "")} import proposedSolution as helper${state.subAgentCount}. The parent will call helper${state.subAgentCount}() to use your result in its larger solution.`,
        });

        const subAgent = await runTaskAgent(enrichedTask, {
          ...config,
          setupFiles: undefined,
          domain: config.domain,
          domainType: config.domainType,
          workflow: subWorkflow,
          maxTurns: Math.min(config.maxTurns, 8),
          depth: currentDepth + 1,
          persistentWorkspace: false,
          _systemPromptOverride: subSystemPrompt,
        });
        // Auto-write sub-agent code into parent sandbox so the parent can import it
        let importHint = "";
        if (subAgent.sourceCode && subAgent.success) {
          sandbox.write(subFileName, subAgent.sourceCode);
          state.subAgentCount++;
          importHint = `\n\nSub-agent code written to ${subFileName}. Import it with: from ${subFileName.replace(".py", "")} import *`;
        }
        let resultMsg = `[SUBAGENT RESULT] Success: ${subAgent.success}\nAnswer: ${subAgent.answer}\nTurns: ${subAgent.turns}${importHint}`;
        if (subAgent.sourceCode && !subAgent.success) {
          resultMsg += `\n\nSub-agent source code (FAILED — use for reference only):\n\`\`\`\n${subAgent.sourceCode.slice(0, 2000)}\n\`\`\``;
        } else if (subAgent.sourceCode) {
          resultMsg += `\n\nSub-agent source code:\n\`\`\`\n${subAgent.sourceCode.slice(0, 2000)}\n\`\`\``;
        }
        return resultMsg;
      } catch (err) {
        return `[SUBAGENT ERROR] Failed to spawn sub-agent: ${err}`;
      }
    }

    case "finish":
      // Guard: reject premature finish() — must have done at least some work
      if (state.lastAction.tool === "") {
        return `WARNING: You called finish() without doing any work. You must write code, run verification, and confirm success before finishing. Start by analyzing the problem and writing the solution.`;
      }
      if (state.lastAction.tool === "write_file" || state.lastAction.tool === "edit_file") {
        return `WARNING: You called finish() but haven't run tests since your last ${state.lastAction.tool}. Run tests to verify your changes work, then call finish() again.`;
      }
      // Guard: reject finish() if no test was ever run and passed.
      // Document domains (research, law, etc.) don't have a verify command — allow finish
      // after the model has done some work.
      if (!state.lastTestResult && workflow.verifyCommand) {
        return `WARNING: You called finish() without ever running the verification tests. Run the oracle/verification command FIRST. You MUST see all tests pass before calling finish().`;
      }
      if (state.lastTestResult && state.lastTestResult.failCount > 0) {
        return `WARNING: You called finish() but the last test run had ${state.lastTestResult.failCount} FAILING test(s). Fix the code, re-run the verification, and confirm ALL tests pass before calling finish(). Failing tests: ${state.lastTestResult.failReasons.join(", ")}`;
      }
      state.lastAction = { tool: "finish", time: Date.now() };
      return `Task completed: ${call.args.summary || "no summary"}`;

    default:
      return `Unknown tool: ${call.tool}. Available: write_file, read_file, write_note, edit_file, run_command, web_search, web_fetch, spawn_subagent, finish`;
  }
}

// ── Chat turn (single LLM call with conversation history) ────────────────────

async function chatTurn(
  messages: Array<{ role: string; content: string }>,
  useStrongModel: boolean
): Promise<string> {
  const userPrompt = messages.map(m => {
    if (m.role === "system") return `<system>\n${m.content}\n</system>`;
    if (m.role === "user") return `<user>\n${m.content}\n</user>`;
    if (m.role === "assistant") return `<assistant>\n${m.content}\n</assistant>`;
    if (m.role === "observation") return `<observation>\n${m.content}\n</observation>`;
    return m.content;
  }).join("\n\n");

  if (useStrongModel) {
    return queryDeepseekRaw({
      userPrompt,
      systemPrompt: messages.find(m => m.role === "system")?.content,
      temperature: 0.3,
      maxTokens: 4096,
    });
  }

  return queryRawReasoning({
    userPrompt,
    systemPrompt: messages.find(m => m.role === "system")?.content,
    temperature: 0.2,
    maxTokens: 4096,
    role: "task-agent",
  });
}

// ── Extract final answer ─────────────────────────────────────────────────────

function extractFinalAnswer(response: string): { summary: string; code?: string } {
  // Look for finish action
  const finishMatch = response.match(/Action:\s*finish\s*\(\s*"([^"]*?)"\s*\)/);
  const summary = finishMatch?.[1] ?? "Task completed";

  // Extract code block if present
  const codeMatch = response.match(/```(?:python|py)?\s*\n?([\s\S]*?)```/);
  const code = codeMatch?.[1]?.trim();

  return { summary, code };
}

// Stuck-loop detection is in ./stuck-loop-detector.ts (imported above)

// ── Public API ───────────────────────────────────────────────────────────────

export async function runTaskAgent(
  task: string,
  config: Partial<TaskAgentConfig> = {}
): Promise<TaskAgentResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const sandbox = new Sandbox({
    prefix: "task-agent-",
    persistent: true,
    workspaceDir: cfg.persistentWorkspace && cfg.workspaceId
      ? `./workspaces/${cfg.workspaceId}/sandbox`
      : undefined,
    container: cfg.enableSandboxIsolation !== false ? { network: false } : null,
  });
  const transcript: string[] = [];
  const turnHistory: TurnRecord[] = [];
  const stuckLoop = new StuckLoopDetector(cfg.complexity ?? "medium");
  const state: TaskState = {
    lastAction: { tool: "", time: 0 },
    lastTestResult: null,
    testResultHistory: [],
    subAgentCount: 0,
    lastSolutionWrite: null,
  };

  // Pre-load setup files (e.g. oracle) into the sandbox before the agent starts
  const hasOracle = (cfg.setupFiles && Object.keys(cfg.setupFiles).some(f => f.includes("oracle"))) ?? false;
  if (cfg.setupFiles) {
    for (const [path, content] of Object.entries(cfg.setupFiles)) {
      sandbox.write(path, content);
      transcript.push(`[setup] Pre-loaded ${path} (${content.split("\n").length} lines)`);
    }
  }

  // Resolve workflow: explicit config > domain preset > default
  let workflow: WorkflowConfig;
  if (cfg.workflow) {
    workflow = { ...DEFAULT_WORKFLOW, testFirst: !hasOracle, ...cfg.workflow };
  } else if (cfg.domain || cfg.domainType) {
    // Try specific domain name first, then fall back to domain type (e.g. "aes_cbc_encryption" → "cryptography")
    const preset = getPreset(cfg.domain ?? "") ?? getPreset(cfg.domainType ?? "");
    if (preset) {
      const matchedKey = getPreset(cfg.domain ?? "") ? cfg.domain : cfg.domainType;
      console.log(`  [task-agent] Using workflow preset for "${matchedKey}"`);
      workflow = { ...DEFAULT_WORKFLOW, testFirst: !hasOracle, ...preset };
    } else {
      console.log(`  [task-agent] No preset for domain "${cfg.domain}" / type "${cfg.domainType}", using default`);
      workflow = { ...DEFAULT_WORKFLOW, testFirst: !hasOracle };
    }
  } else {
    workflow = { ...DEFAULT_WORKFLOW, testFirst: !hasOracle };
  }
  // For hard/very-hard problems without a domain preset, default to
  // research-first workflow with web search. These are typically algorithm-heavy
  // problems (graph, DP, linear algebra, backtracking) where the model needs to
  // look up the correct algorithm before implementing.
  const isHard = cfg.complexity === "hard" || cfg.complexity === "very-hard";
  const hasDomainPreset = !!(cfg.domain && getPreset(cfg.domain)) || !!(cfg.domainType && getPreset(cfg.domainType));
  if (isHard && !hasDomainPreset) {
    workflow = {
      ...workflow,
      researchPhases: true,
      enableWebSearch: true,
      enableNotes: true,
    };
    console.log(`  [task-agent] Hard problem without domain preset — enabling research-first workflow`);
  }
  // Apply enableWebSearch from config if explicitly set (overrides preset)
  if (cfg.enableWebSearch !== undefined) {
    workflow = { ...workflow, enableWebSearch: cfg.enableWebSearch };
  }
  // Merge auto-detected DomainSpec invariants into the workflow. These come from
  // the LLM in auto-detect.ts for custom domains and supplement preset invariants.
  if (cfg.domainInvariants?.length) {
    workflow = {
      ...workflow,
      invariants: [...(workflow.invariants ?? []), ...cfg.domainInvariants],
    };
  }
  // When the setupFiles contain a JS oracle, switch the verify command from
  // "python3 oracle.py" (which doesn't exist) to "node oracle.js <solutionFile>"
  if (hasOracle && cfg.setupFiles) {
    const jsOracle = Object.keys(cfg.setupFiles).find(f => f.endsWith(".js"));
    if (jsOracle) {
      const solutionFile = workflow.solutionFiles?.[0] ?? "solution.py";
      workflow = { ...workflow, verifyCommand: `node ${jsOracle} ${solutionFile}` };
      console.log(`  [task-agent] JS oracle detected — verify command: node ${jsOracle} ${solutionFile}`);
    }
  }

  // Run workspace setup commands (pip install numpy, etc.) before the agent starts
  const setupCommands = workflow.workspaceSetup ?? [];
  if (setupCommands.length > 0) {
    console.log(`  [task-agent] Running ${setupCommands.length} workspace setup command(s)...`);
    for (const cmd of setupCommands) {
      transcript.push(`[setup] Running: ${cmd}`);
      try {
        const setupResult = await sandbox.exec(cmd, { timeoutMs: 120_000 });
        transcript.push(`[setup] Output: ${setupResult.stdout.slice(0, 200)}${setupResult.exitCode !== 0 ? ` (exit ${setupResult.exitCode})` : ""}`);
      } catch (err) {
        transcript.push(`[setup] Failed: ${err}`);
      }
    }
  }

  // Generate a workspace README so the model knows the layout without discovery turns.
  // This persists across conversation turns unlike the pre-loaded oracle content.
  const readmeLines = [`# Workspace — problem: ${task.slice(0, 120)}`];
  if (cfg.setupFiles) {
    readmeLines.push("\n## Files");
    for (const f of Object.keys(cfg.setupFiles)) {
      readmeLines.push(`  - ${f} — pre-loaded, ready to use`);
    }
  }
  readmeLines.push(`\n## Verify`);
  readmeLines.push(`  Run: \`${workflow.verifyCommand}\` (oracle judges correctness)`);
  if (workflow.solutionFiles.length > 0) {
    readmeLines.push(`\n## Solution file to create`);
    for (const f of workflow.solutionFiles) {
      readmeLines.push(`  - ${f}`);
    }
  }
  if (setupCommands.length > 0) {
    readmeLines.push(`\n## Setup already done`);
    for (const cmd of setupCommands) {
      readmeLines.push(`  - ${cmd}`);
    }
  }
  sandbox.write("WORKSPACE.md", readmeLines.join("\n"));
  transcript.push(`[setup] Generated WORKSPACE.md`);

  const isDocument = workflow.outputType === "document" || workflow.outputType === "analysis";
  let systemPrompt = cfg._systemPromptOverride ?? buildSystemPrompt(workflow, {
    complexity: cfg.complexity,
    supervisorHint: cfg.supervisorHint,
    previousAttemptSummary: cfg.previousAttemptSummary,
    oraclePreloaded: !!cfg.oracleContent,
  });

  // SYSTEM_PROMPT_STRATEGY env var: inject a strategy override for benchmark evaluation.
  // Used by --evaluate-strategies to test different prompt strategies against problems.
  const strategyOverride = process.env.SYSTEM_PROMPT_STRATEGY;
  if (strategyOverride) {
    systemPrompt = `${systemPrompt}\n\n─── STRATEGY OVERRIDE (${process.env.SYSTEM_PROMPT_STRATEGY_NAME || "unnamed"}) ───\n${strategyOverride}`;
  }

  const systemPromptHash: string = sha256(systemPrompt);

  // Build the first user message — include oracle content if available so the
  // model knows the test cases without spending a turn on read_file("oracle.js").
  const oracleBlock = cfg.oracleContent
    ? `\n\n── ORACLE TESTS (pre-loaded — you do NOT need to read oracle.js) ──\nThe oracle runs this verify function against your solution. Study these test cases BEFORE writing code:\n\n\`\`\`javascript\n${cfg.oracleContent.slice(0, 2000)}\n\`\`\`\n\nMake sure your solution handles ALL the edge cases shown in the tests above.`
    : "";
  const referenceBlock = cfg.referenceData ?? "";
  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `Task: ${task}${oracleBlock}${referenceBlock}\n\nBegin by thinking about the problem. Then use tools to solve it step by step.` },
  ];

  let finalSummary = "";
  let finalCode: string | undefined;

  try {
    let consecutiveUnknown = 0; // Track consecutive parse failures to detect stuck models
    const previousResponses = new Set<string>(); // Detect cache-poisoning loops (identical responses)
    for (let turn = 0; turn < cfg.maxTurns; turn++) {
      console.log(`  [task-agent] Turn ${turn + 1}/${cfg.maxTurns}…`);

      // Get model response
      let response: string;
      try {
        response = await chatTurn(messages, cfg.useStrongModel);
      } catch (err) {
        transcript.push(`[ERROR] LLM call failed: ${err}`);
        break;
      }

      // Cache-poisoning guard: identical response means the cache is replaying
      // and the model isn't making progress. Common with write→oracle→read→repeat loops.
      if (previousResponses.has(response)) {
        finalSummary = "CACHE LOOP DETECTED: Model produced the exact same response as a previous turn. The LLM cache is replaying identical outputs. The task cannot make progress.";
        transcript.push(`\n─── Terminated ───\nCache-poisoning loop: identical response to a previous turn`);
        break;
      }
      previousResponses.add(response);

      transcript.push(`\n─── Turn ${turn + 1} (assistant) ───\n${response}`);
      messages.push({ role: "assistant", content: response });

      // Parse tool call
      const toolCall = parseToolCall(response);

      if (!toolCall) {
        consecutiveUnknown++;
        // No tool call found — check if it's a final answer
        if (response.includes("finish") || response.includes("Final Answer")) {
          const { summary } = extractFinalAnswer(response);
          finalSummary = summary;
          // Document domains: don't extract Python code — read the markdown file instead
          if (!isDocument) {
            finalCode = extractFinalAnswer(response).code;
          }
          break;
        }
        // 3 consecutive parse failures → model is stuck, terminate
        if (consecutiveUnknown >= 3) {
          finalSummary = "Model could not produce a valid action after 3 attempts. The response format is not being followed.";
          transcript.push(`\n─── Terminated ───\n3 consecutive invalid actions`);
          break;
        }
        // Model might be rambling — nudge it
        messages.push({
          role: "observation",
          content: "No valid Action found in your response. Use EXACTLY: Action: tool_name(\"arg1\", \"arg2\")",
        });
        continue;
      }

      // Execute tool
      consecutiveUnknown = 0; // Reset — valid action parsed
      console.log(`  [task-agent] Action: ${toolCall.tool}(${Object.values(toolCall.args).map(v => `"${v.slice(0, 40)}${v.length > 40 ? '...' : ''}"`).join(", ")})`);
      const observation = await executeTool(toolCall, sandbox, cfg.commandTimeout, state, workflow, cfg, task);

      transcript.push(`\n─── Turn ${turn + 1} (observation) ───\n${observation}`);
      messages.push({ role: "observation", content: observation });

      const turnKey = toolCall.tool === "run_command" ? (toolCall.args.command || "").slice(0, 40)
        : toolCall.tool === "write_file" || toolCall.tool === "edit_file" ? (toolCall.args.path || "")
        : toolCall.tool === "read_file" ? (toolCall.args.path || toolCall.args.url || "").slice(0, 40)
        : (toolCall.args.query || toolCall.args.url || toolCall.args.task || "").slice(0, 40);
      turnHistory.push({ tool: toolCall.tool, key: turnKey, summary: observation.slice(0, 60) });

      // Nudge if model wrote solution code but hasn't tested after 2+ turns
      if (state.lastSolutionWrite && !state.lastSolutionWrite.tested && workflow.verifyCommand) {
        const turnsSinceWrite = turn - turnHistory.findIndex(t => t.tool === "write_file" || t.tool === "edit_file");
        // Reset tested flag if model ran the verification command
        if (toolCall.tool === "run_command") {
          const cmd = (toolCall.args.command || "").toLowerCase();
          if (cmd.includes("oracle") || cmd.includes("prove.py") || /node\s+\S+\.js/.test(cmd)) {
            state.lastSolutionWrite.tested = true;
          }
        }
        if (!state.lastSolutionWrite.tested && turnsSinceWrite >= 1) {
          messages.push({ role: "observation", content: `REMINDER: You wrote ${state.lastSolutionWrite.path} but haven't run the verification yet. Run \`${workflow.verifyCommand}\` NOW to check if your code works. Do NOT write prove.py — run the verification directly.` });
          transcript.push(`\n─── Nudge ───\nVerification skipped for ${turnsSinceWrite} turn(s) after write`);
        }
      }

      // Check for finish
      if (toolCall.tool === "finish") {
        // Guard: for non-document tasks, require oracle verification before allowing finish
        // The model must run the verification command and see all tests pass.
        if (!isDocument && workflow.verifyCommand) {
          // Check if the oracle has actually passed — look at last run_command observation
          const lastRunObs = [...turnHistory].reverse().find(t => t.tool === "run_command");
          const testsPassed = lastRunObs ? /\bAll tests passed\b/i.test(lastRunObs.summary) : false;
          if (!testsPassed) {
            messages.push({
              role: "observation",
              content: `You called finish() but haven't verified your code passes the tests. Run \`${workflow.verifyCommand}\` and see ALL TESTS PASS before calling finish(). Do NOT call finish() until you see "All tests passed" in the output.`,
            });
            transcript.push(`\n─── Rejected finish ───\nModel tried to finish without passing verification`);
            continue; // skip finish — force model to verify first
          }
        }
        finalSummary = toolCall.args.summary || "Task completed";
        // For document domains, the markdown file IS the output — don't extract
        // Python code from the response. The file will be read below.
        if (!isDocument) {
          const { code } = extractFinalAnswer(response);
          finalCode = code;
        }
        break;
      }

      // Auto-finish: observation shows all tests passed — don't wait for model to call finish()
      if (workflow.verifyCommand && /\bAll tests passed\b/i.test(observation)) {
        console.log(`  [task-agent] Auto-finish: all tests passed`);
        finalSummary = "All tests passed — task completed successfully.";
        break;
      }

      // Stuck-loop detection (action pattern)
      const loopMsg = stuckLoop.isStuckLoop(turnHistory);
      if (loopMsg) {
        if (loopMsg.startsWith("LOOP DETECTED:") || loopMsg.startsWith("STAGNATION DETECTED:")) {
          finalSummary = loopMsg;
          transcript.push(`\n─── Terminated ───\n${loopMsg}`);
          break;
        }
        // "ZOOM OUT REQUIRED:" or "WARNING:" — inject as observation
        messages.push({ role: "observation", content: loopMsg });
        transcript.push(`\n─── Nudge ───\n${loopMsg}`);
        continue; // skip stagnation check this turn — zoom-out message handles it
      }

      // Record per-turn health: track test scores for statistical analysis
      if (cfg.healthMonitor && state.lastTestResult && toolCall.tool === "run_command") {
        const totalTests = state.lastTestResult.passCount + state.lastTestResult.failCount;
        const score = totalTests > 0 ? (state.lastTestResult.passCount / totalTests) * 100 : 0;
        const reason = state.lastTestResult.failReasons.join("; ") || "ok";
        cfg.healthMonitor.record(score, state.lastTestResult.failCount === 0, reason);
      }

      // Test stagnation detection (same failures despite code changes)
      const stagnationMsg = stuckLoop.checkTestStagnation(state);
      if (stagnationMsg) {
        if (stagnationMsg.startsWith("STAGNATION DETECTED:")) {
          finalSummary = stagnationMsg;
          transcript.push(`\n─── Terminated ───\n${stagnationMsg}`);
          break;
        }
        // "ZOOM OUT REQUIRED:" or "NOTE:" — inject as observation
        messages.push({ role: "observation", content: stagnationMsg });
        transcript.push(`\n─── Nudge ───\n${stagnationMsg}`);
      }

      // Health-based nudges: use statistical analysis for smarter guidance
      if (cfg.healthMonitor && turn >= 4 && cfg.healthMonitor.count >= 3) {
        const healthReport = cfg.healthMonitor.getReport();
        if (healthReport.isStagnant && healthReport.dominantFailurePattern) {
          const healthNudge = `HEALTH CHECK: Last ${healthReport.recentScores.length} attempts show no improvement (pass rate: ${(healthReport.passRate * 100).toFixed(0)}%, improvement: ${(healthReport.improvementRate * 100).toFixed(0)}%). Dominant failure pattern: "${healthReport.dominantFailurePattern}". Your fixes aren't working — try a FUNDAMENTALLY DIFFERENT approach.`;
          if (!stagnationMsg) {
            messages.push({ role: "observation", content: healthNudge });
            transcript.push(`\n─── Health Nudge ───\n${healthNudge}`);
          }
        } else if (healthReport.improvementRate > 0.5 && !healthReport.isStagnant) {
          const healthNudge = `HEALTH CHECK: Score trend is positive (improvement rate: ${(healthReport.improvementRate * 100).toFixed(0)}%). Your fixes are working — keep going!`;
          messages.push({ role: "observation", content: healthNudge });
          transcript.push(`\n─── Health Nudge ───\n${healthNudge}`);
        }
      }

      // Cumulative error-rate check: if most turns produce errors, the model
      // is fundamentally stuck regardless of error variety. Terminate early.
      // Fire at turn 5+ when 40%+ turns produce errors (lowered from 50% —
      // the write_file/run_command alternation means 50% error rate = stuck model).
      if (turn >= 5) {
        const errorTurns = turnHistory.filter(t =>
          /Error|rror:|FAILED|Traceback|assert|No valid Action/.test(t.summary)
        ).length;
        const errorRate = errorTurns / turnHistory.length;
        if (errorTurns >= 3 && errorRate >= 0.4) {
          finalSummary = `TERMINATED: ${errorTurns}/${turnHistory.length} turns (${(errorRate * 100).toFixed(0)}%) produced errors. The model cannot make progress on this problem.`;
          transcript.push(`\n─── Terminated ───\nError rate ${(errorRate * 100).toFixed(0)}%`);
          break;
        }
      }
    }

    // If no final answer, extract best available code from the sandbox
    if (!finalCode) {
      // For document output types, try outputPaths first, then solutionFiles, then any .md file
      const filesToCheck = isDocument
        ? [...new Set([...(workflow.outputPaths ?? []), ...workflow.solutionFiles])]
        : workflow.solutionFiles;
      for (const f of filesToCheck) {
        try {
          const result = await sandbox.exec(`cat ${f}`, { timeoutMs: 5_000 });
          if (result.exitCode === 0 && result.stdout.length > 10 && !result.stdout.startsWith("def proposedSolution")) {
            finalCode = result.stdout;
            finalSummary = finalSummary || `Extracted from ${f} (model did not call finish)`;
            break;
          }
        } catch { /* file not found, try next */ }
      }
      // Document fallback: find any .md file if configured files not found
      if (isDocument && !finalCode) {
        try {
          const lsResult = await sandbox.exec("ls *.md 2>/dev/null", { timeoutMs: 3_000 });
          if (lsResult.exitCode === 0 && lsResult.stdout.trim()) {
            const mdFile = lsResult.stdout.trim().split("\n")[0]?.trim();
            const catResult = await sandbox.exec(`cat ${mdFile}`, { timeoutMs: 5_000 });
            if (catResult.exitCode === 0 && catResult.stdout.length > 10) {
              finalCode = catResult.stdout;
              finalSummary = finalSummary || `Extracted from ${mdFile}`;
            }
          }
        } catch { /* no md files */ }
      }
    }

    // Self-terminated task agents are NOT successful — the model gave up
    const selfTerminated = isSelfTerminated(finalSummary);

    // Document tasks succeed if they produced an answer (even without code)
    // Code tasks succeed only if the verification actually passed
    const success = selfTerminated ? false : (isDocument
      ? finalSummary.length > 20 || !!finalCode
      : finalSummary.includes("All tests passed") || !!finalCode);

    // Build a concise turn summary for the supervisor
    const turnSummary = (() => {
      if (turnHistory.length === 0) return "No actions taken";
      const lines: string[] = [];
      // Group consecutive same-tool actions
      let i = 0;
      while (i < turnHistory.length) {
        const t = turnHistory[i]!;
        let count = 1;
        while (i + count < turnHistory.length && turnHistory[i + count]!.tool === t.tool && turnHistory[i + count]!.key === t.key) {
          count++;
        }
        const suffix = count > 1 ? ` (x${count})` : "";
        lines.push(`  ${t.tool}(${t.key})${suffix} → ${t.summary}`);
        i += count;
      }
      const errorCount = turnHistory.filter(t => /error|fail|traceback/i.test(t.summary)).length;
      const statusLine = errorCount > 0 ? `\n${errorCount}/${turnHistory.length} turns had errors.` : "\nNo errors.";
      return `Agent took ${turnHistory.length} turns:\n${lines.join("\n")}${statusLine}`;
    })();

    return {
      success,
      answer: finalSummary || "No answer produced",
      sourceCode: finalCode,
      turns: messages.filter(m => m.role === "assistant").length,
      transcript: transcript.join("\n"),
      turnSummary,
      systemPromptHash,
    };
  } finally {
    if (cfg.persistentWorkspace) {
      // Keep the workspace directory — just kill the persistent shell
      sandbox.killShell();
      console.log(`  [task-agent] Workspace preserved at ${sandbox.dir}`);
    } else {
      sandbox.cleanup();
    }
  }
}
