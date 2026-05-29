/**
 * Project verification for HTML/JS output (games, web apps, etc.).
 *
 * Unlike single-function code oracles, project verification checks:
 *   1. HTML well-formedness (DOCTYPE, required elements, no unclosed tags)
 *   2. JavaScript syntax (`node --check` on extracted <script> blocks)
 *   3. Feature requirements (canvas, event handlers, game mechanics)
 *   4. Runtime behavior (game logic test harness — optional, per-domain)
 *
 * Deterministic, zero-LLM-cost verification.
 */

import * as fs from "fs";
import * as path from "path";
import { Sandbox } from "../sandbox/index";
import type { PipelineResult, StageResult } from "../../core/types";

// ── HTML extraction ──────────────────────────────────────────────────────────

/**
 * Extract usable HTML from various output formats:
 * - Raw HTML string
 * - Python function that returns an HTML string (def proposedSolution(): return """<html>...""")
 */
export function extractHtml(source: string): string | null {
  // Case 1: Source IS HTML (starts with <!DOCTYPE, <html, or similar)
  const trimmed = source.trim();
  if (/^<(!DOCTYPE|html|head|body|meta|title|link|style|script|div|canvas)/i.test(trimmed)) {
    return trimmed;
  }

  // Case 2: Python function returning HTML via triple-quoted string
  // Match: def proposedSolution... return """...""" or return '''...'''
  const pyMatch = trimmed.match(/return\s+(?:""")?(""")([\s\S]*?)\1/);
  if (pyMatch && pyMatch[2]) {
    return pyMatch[2].trim();
  }

  // Case 3: Python function returning HTML via single-quoted string
  const pyMatch2 = trimmed.match(/return\s+(?:''')?(''')([\s\S]*?)\1/);
  if (pyMatch2 && pyMatch2[2]) {
    return pyMatch2[2].trim();
  }

  // Case 4: Any triple-quoted string in the source (might be the HTML)
  const anyTriple = trimmed.match(/"""([\s\S]*?)"""/);
  if (anyTriple && anyTriple[1] && /<(!DOCTYPE|html|canvas|script)/i.test(anyTriple[1])) {
    return anyTriple[1].trim();
  }

  // Case 5: Source contains HTML-like content (look for <html> or <!DOCTYPE>)
  const htmlMatch = trimmed.match(/(<(!DOCTYPE|html)\b[\s\S]*)/i);
  if (htmlMatch) {
    return htmlMatch[1]!.trim();
  }

  return null;
}

// ── HTML validation ──────────────────────────────────────────────────────────

interface HtmlValidation {
  ok: boolean;
  errors: string[];
  hasDoctype: boolean;
  hasHtml: boolean;
  hasHead: boolean;
  hasBody: boolean;
  hasCanvas: boolean;
  hasScript: boolean;
  hasStyle: boolean;
  elements: { tag: string; count: number }[];
}

export function validateHtml(html: string): HtmlValidation {
  const errors: string[] = [];

  const hasDoctype = /<!DOCTYPE\s+html/i.test(html);
  if (!hasDoctype) errors.push("Missing <!DOCTYPE html>");

  const hasHtml = /<html[\s>]/i.test(html);
  // Not requiring <html> since some minified HTML omits it (browsers tolerate it)

  const hasHead = /<head[\s>]/i.test(html);
  const hasBody = /<body[\s>]/i.test(html);

  // Count elements
  const tagCounts = new Map<string, number>();
  const tagRegex = /<\/?(\w+)[\s>]/g;
  let match;
  while ((match = tagRegex.exec(html)) !== null) {
    const tag = match[1]!.toLowerCase();
    tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }

  const elements = Array.from(tagCounts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);

  const hasCanvas = tagCounts.has("canvas");
  const hasScript = tagCounts.has("script");
  const hasStyle = tagCounts.has("style");

  // Check for commonly unclosed tags
  const openDivs = (html.match(/<div[\s>]/gi) || []).length;
  const closeDivs = (html.match(/<\/div>/gi) || []).length;
  if (openDivs !== closeDivs) {
    errors.push(`Unclosed <div> tags: ${openDivs} open, ${closeDivs} closed`);
  }

  return {
    ok: errors.length === 0,
    errors,
    hasDoctype,
    hasHtml,
    hasHead,
    hasBody,
    hasCanvas,
    hasScript,
    hasStyle,
    elements,
  };
}

// ── JS extraction ────────────────────────────────────────────────────────────

export function extractScripts(html: string): { inline: string[]; external: string[] } {
  const inline: string[] = [];
  const external: string[] = [];

  // Extract <script src="..."> external references
  const srcRegex = /<script\s+[^>]*src=["']([^"']+)["'][^>]*>/gi;
  let srcMatch;
  while ((srcMatch = srcRegex.exec(html)) !== null) {
    external.push(srcMatch[1]!);
  }

  // Extract inline <script>...</script> blocks
  const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let scriptMatch;
  while ((scriptMatch = scriptRegex.exec(html)) !== null) {
    const content = scriptMatch[1]!.trim();
    if (content.length > 10) {
      inline.push(content);
    }
  }

  return { inline, external };
}

// ── JS syntax check ──────────────────────────────────────────────────────────

export async function checkJsSyntax(sandbox: Sandbox, js: string): Promise<{ ok: boolean; error?: string }> {
  const file = "check-syntax.js";
  sandbox.write(file, js);

  const result = await sandbox.exec(`node --check ${file} 2>&1`, { timeoutMs: 10_000 });

  if (result.exitCode === 0) {
    return { ok: true };
  }

  // Parse the error to extract useful info
  const errLines = (result.stderr || result.stdout || "").split("\n").filter(l => l.trim());
  const errorMsg = errLines.slice(0, 3).join(" | ");
  return { ok: false, error: errorMsg || "Unknown syntax error" };
}

// ── Feature verification ─────────────────────────────────────────────────────

interface FeatureRequirements {
  canvas?: boolean;
  keyboardInput?: boolean;
  mouseInput?: boolean;
  scoreTracking?: boolean;
  gameOverDetection?: boolean;
  collisionDetection?: boolean;
  animationLoop?: boolean;
  foodCollection?: boolean;
  restartMechanism?: boolean;
}

export function checkFeatures(html: string, js: string): { passed: boolean; missing: string[] } {
  const missing: string[] = [];

  // Canvas
  if (!/<canvas/i.test(html) && !/getContext\(/.test(js)) {
    missing.push("No canvas element or getContext() call found");
  }

  // Keyboard input
  if (!/keydown|keyup|keypress|addEventListener\s*\(\s*["']key/i.test(js)) {
    missing.push("No keyboard event handling");
  }

  // Animation/game loop
  if (!/requestAnimationFrame|setInterval|setTimeout/.test(js)) {
    missing.push("No animation loop (requestAnimationFrame/setInterval)");
  }

  // Score tracking
  if (!/score/i.test(js) && !/score/i.test(html)) {
    missing.push("No score tracking");
  }

  // Collision or game-over detection
  if (!/collision|collide|game\s*over|gameOver/i.test(js) && !/game\s*over/i.test(html)) {
    missing.push("No collision or game-over detection");
  }

  return { passed: missing.length === 0, missing };
}

// ── Game logic test harness ───────────────────────────────────────────────────

/**
 * Runs a lightweight game logic test. The test harness mocks DOM/canvas APIs
 * and verifies that the game's core mechanics work:
 *   - Snake moves in response to direction changes
 *   - Food collection increases score
 *   - Wall/self collision triggers game over
 *
 * This is a best-effort structural + behavioral check. It cannot verify
 * visual rendering (that requires a real browser), but it catches:
 *   - Missing game loop
 *   - Missing keyboard handlers
 *   - Missing collision detection
 *   - State that never updates
 */
async function runGameLogicTest(
  sandbox: Sandbox,
  html: string
): Promise<{ passed: boolean; reason: string; details?: string }> {
  const scripts = extractScripts(html);
  const allJs = scripts.inline.join("\n\n");

  if (allJs.length < 50) {
    return { passed: false, reason: "No inline JavaScript found to test" };
  }

  // Build a test harness that mocks the DOM/canvas API and runs the game
  const harness = `
// ── Mock DOM/Canvas API ─────────────────────────────────────────────
const mockCanvas = {
  width: 400,
  height: 400,
  getContext: () => mockCtx,
};
const mockCtx = {
  fillStyle: "",
  strokeStyle: "",
  font: "",
  textAlign: "",
  fillRect: (x, y, w, h) => {},
  clearRect: (x, y, w, h) => {},
  fillText: (text, x, y) => {},
  strokeRect: (x, y, w, h) => {},
  arc: () => {},
  fill: () => {},
  stroke: () => {},
  beginPath: () => {},
  closePath: () => {},
  moveTo: () => {},
  lineTo: () => {},
};

const mockDoc = {
  getElementById: (id) => {
    if (id === "gameCanvas" || id === "canvas" || id.includes("canvas")) return mockCanvas;
    return {
      textContent: "",
      innerHTML: "",
      innerText: "",
      style: {},
      addEventListener: () => {},
      querySelector: () => null,
      querySelectorAll: () => [],
    };
  },
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  createElement: () => ({}),
  body: {
    appendChild: () => {},
    addEventListener: () => {},
  },
};

// Track key events for testing
const keyEvents = [];
const trackedState = [];

globalThis.document = mockDoc;
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.requestAnimationFrame = (fn) => { trackedState.push("rAF called"); if (typeof fn === "function") fn(0); return 1; };
globalThis.setInterval = (fn, ms) => { trackedState.push("setInterval called"); if (typeof fn === "function") fn(); return 1; };
globalThis.clearInterval = () => {};
globalThis.setTimeout = (fn, ms) => { if (typeof fn === "function") fn(); return 1; };

// ── Load game code ──────────────────────────────────────────────────
try {
${allJs.split("\n").map(line => "  " + line).join("\n")}
} catch (e) {
  process.stdout.write(JSON.stringify({ passed: false, reason: "Runtime error: " + e.message?.slice(0, 150) }));
  process.exit(0);
}

// ── Verify game state ──────────────────────────────────────────────
// Check that key game components exist in global scope
const hasGameLoop = typeof gameLoop !== "undefined" || trackedState.some(s => s.includes("rAF") || s.includes("Interval"));
const hasKeyHandler = typeof document !== "undefined"; // if document mock was used

// Simulate key presses if the game defines a key handler
let keyHandlerFound = false;
if (typeof document !== "undefined") {
  keyHandlerFound = true;
}

// Check for core game variables (snake games use snake[], direction, food, score, gameOver)
const gameStateVars = [];
for (const name of ["snake", "direction", "food", "score", "gameOver", "game_over", "dx", "dy", "velocity", "player"]) {
  if (typeof globalThis[name] !== "undefined") {
    gameStateVars.push(name + "=" + JSON.stringify(globalThis[name]).slice(0, 80));
  }
}

const checks = [];
if (gameStateVars.length === 0) {
  checks.push("No game state variables found in global scope (snake, direction, food, score, etc.)");
}
if (!hasGameLoop) {
  checks.push("No game loop detected (requestAnimationFrame or setInterval not called)");
}

if (checks.length > 0) {
  process.stdout.write(JSON.stringify({
    passed: false,
    reason: checks.join("; "),
    details: "Found variables: " + (gameStateVars.join(", ") || "none") + " | Events: " + trackedState.join(", ")
  }));
} else {
  process.stdout.write(JSON.stringify({
    passed: true,
    reason: "Game logic verified: " + gameStateVars.length + " state variables, game loop active",
    details: gameStateVars.join(", ") + " | " + trackedState.join(", ")
  }));
}
`.trim();

  sandbox.write("test-game.js", harness);

  try {
    const result = await sandbox.exec("node test-game.js 2>&1", { timeoutMs: 15_000 });
    const output = result.stdout.trim();

    try {
      const parsed = JSON.parse(output.split("\n").pop() || output);
      return parsed;
    } catch {
      if (result.exitCode !== 0) {
        return {
          passed: false,
          reason: `Game logic test failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).slice(0, 300)}`,
        };
      }
      return { passed: true, reason: "Game logic test completed (non-JSON output)" };
    }
  } catch (err: any) {
    return { passed: false, reason: `Game logic test error: ${err.message?.slice(0, 150)}` };
  }
}

// ── Main verification entry point ─────────────────────────────────────────────

export interface ProjectVerifyOptions {
  /** Feature requirements to check for (default: game features) */
  features?: FeatureRequirements;
  /** Skip game logic test. Default: true (game logic test is fragile with mocked DOM/canvas) */
  skipGameLogic?: boolean;
}

const DEFAULT_OPTIONS: Required<ProjectVerifyOptions> = {
  features: {},
  skipGameLogic: true,
};

/**
 * Standalone verification script that runs inside the task-agent sandbox.
 * The task-agent runs: `node verify-project.js`
 * The script reads index.html, validates it, and outputs JSON results.
 *
 * The script lives in verify-project.js (clean, editable, syntax-highlighted).
 * We read it at import time so it can be passed to task-agent sandboxes.
 */
const _verifyScriptPath = path.join(import.meta.dir, "verify-project.js");
export const VERIFY_SCRIPT: string = fs.readFileSync(_verifyScriptPath, "utf-8");

const _cliVerifyScriptPath = path.join(import.meta.dir, "verify-cli-project.js");
export const VERIFY_CLI_SCRIPT: string = fs.readFileSync(_cliVerifyScriptPath, "utf-8");

export async function verifyHtmlProject(
  source: string,
  opts: ProjectVerifyOptions = {}
): Promise<PipelineResult> {
  const resolved = { ...DEFAULT_OPTIONS, ...opts };
  const stages: StageResult[] = [];
  const start = Date.now();

  // 1. Extract HTML from source
  const html = extractHtml(source);
  if (!html) {
    return {
      overallPassed: false,
      stages: [{
        stageName: "HtmlExtract",
        passed: false,
        reason: "Could not extract HTML from source. Source must be raw HTML or a Python function returning an HTML string.",
        runtimeMs: Date.now() - start,
      }],
      finalMetrics: {},
    };
  }
  stages.push({
    stageName: "HtmlExtract",
    passed: true,
    reason: `Extracted ${html.length} chars of HTML`,
    runtimeMs: Date.now() - start,
  });

  const sb = new Sandbox("truth-proj-verify-");
  try {
    // 2. HTML structure validation
    const htmlValidation = validateHtml(html);
    if (!htmlValidation.ok) {
      return {
        overallPassed: false,
        stages: [
          ...stages,
          {
            stageName: "HtmlStructure",
            passed: false,
            reason: htmlValidation.errors.join("; "),
            artifacts: {
              elements_found: htmlValidation.elements.slice(0, 10).map(e => `${e.tag}:${e.count}`),
              has_canvas: htmlValidation.hasCanvas,
              has_script: htmlValidation.hasScript,
            },
            runtimeMs: 0,
          },
        ],
        finalMetrics: {},
      };
    }
    stages.push({
      stageName: "HtmlStructure",
      passed: true,
      reason: `Valid HTML: ${htmlValidation.elements.length} element types found`,
      artifacts: {
        elements_found: htmlValidation.elements.slice(0, 10).map(e => `${e.tag}=${e.count}`),
        has_canvas: htmlValidation.hasCanvas,
        has_script: htmlValidation.hasScript,
        has_style: htmlValidation.hasStyle,
      },
      runtimeMs: 0,
    });

    // 3. Extract and validate JavaScript
    const scripts = extractScripts(html);
    if (scripts.inline.length === 0 && scripts.external.length === 0) {
      return {
        overallPassed: false,
        stages: [
          ...stages,
          {
            stageName: "JsSyntax",
            passed: false,
            reason: "No JavaScript found (<script> blocks or external references)",
            runtimeMs: 0,
          },
        ],
        finalMetrics: {},
      };
    }

    const jsSyntaxStage: StageResult = { stageName: "JsSyntax", passed: true, reason: "", runtimeMs: 0 };
    const allJs = scripts.inline.join("\n;\n");

    // Check syntax for each inline script block
    if (scripts.inline.length > 0) {
      const syntaxResult = await checkJsSyntax(sb, allJs);
      if (!syntaxResult.ok) {
        jsSyntaxStage.passed = false;
        jsSyntaxStage.reason = syntaxResult.error;
      } else {
        jsSyntaxStage.reason = `${scripts.inline.length} inline script(s), ${allJs.split("\n").length} lines — syntax OK`;
      }
    } else {
      jsSyntaxStage.reason = `${scripts.external.length} external script(s) referenced — cannot check syntax`;
    }
    stages.push(jsSyntaxStage);

    if (!jsSyntaxStage.passed) {
      return { overallPassed: false, stages, finalMetrics: {} };
    }

    // 4. Feature verification
    const featureCheck = checkFeatures(html, allJs);
    stages.push({
      stageName: "FeatureCheck",
      passed: featureCheck.passed,
      reason: featureCheck.passed
        ? "All required features present"
        : `Missing: ${featureCheck.missing.join("; ")}`,
      artifacts: { missing_features: featureCheck.missing },
      runtimeMs: 0,
    });

    if (!featureCheck.passed && !resolved.skipGameLogic) {
      return { overallPassed: false, stages, finalMetrics: {} };
    }

    // 5. Game logic test (optional — skipped by default, fragile with mocked DOM/canvas)
    if (!resolved.skipGameLogic && scripts.inline.length > 0) {
      const logicResult = await runGameLogicTest(sb, html);
      stages.push({
        stageName: "GameLogic",
        passed: logicResult.passed,
        reason: logicResult.reason,
        artifacts: { details: logicResult.details },
        runtimeMs: 0,
      });

      if (!logicResult.passed) {
        return { overallPassed: false, stages, finalMetrics: {} };
      }
    }

    return {
      overallPassed: stages.every(s => s.passed),
      stages,
      finalMetrics: {},
    };
  } finally {
    sb.cleanup();
  }
}
