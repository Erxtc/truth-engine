/**
 * Logs every LLM prompt + response to a timestamped file.
 * Always on by default. Disable with --quiet or LOG_PROMPTS=false.
 *
 * Each call gets a numbered block showing:
 *   - which agent triggered it (role)
 *   - the system + user prompts
 *   - the raw model output (including <think> reasoning blocks)
 *   - the parsed JSON result
 *   - timing + token usage
 *   - any errors (valibot, JSON parse)
 */

import * as fs from "fs";
import * as path from "path";

let logPath: string | null = null;
let fullLogPath: string | null = null;  // sidecar for truncated content
let callCounter = 0;
const startTime = new Date();
export let quietMode = false;
export function setQuietMode(q: boolean) { quietMode = q; }

/** Truncate a long string for the main log, saving the full version to a sidecar.
 *  Returns the (possibly truncated) string for in-line logging. */
function logContent(label: string, content: string, callNum: number): string {
    if (content.length <= 4000) return content;
    const fp = getFullLogPath();
    if (!fp) return content.slice(0, 4000) + `\n... [${content.length - 4000} chars truncated — enable full logging with LOG_FULL=1]`;
    const trunc = content.slice(0, 3000) + `\n... [${content.length - 3800} chars truncated — see ${path.basename(fp)} #${callNum}] ...\n` + content.slice(-800);
    fs.appendFileSync(fp, `\n${"=".repeat(70)}\nCALL #${callNum} ${label} (${content.length} chars)\n${"=".repeat(70)}\n${content}\n`);
    return trunc;
}

/** Log a key system event to the prompt log so the log analysis script can detect outcomes. */
export function logEvent(label: string, detail?: string) {
    const p = getLogPath();
    if (!p) return;
    const ts = new Date().toISOString().slice(11, 23);
    const msg = detail ? `  ${label}: ${detail}` : `  ${label}`;
    append(`[${ts}] EVENT ${msg}\n`);
}

function getLogPath(): string | null {
    if (process.env.LOG_PROMPTS === "false") return null;
    if (!logPath) {
        const ts = startTime.toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const logsDir = path.join(process.cwd(), "logs");
        if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
        logPath = path.join(logsDir, `truth-engine-${ts}.log`);
        fullLogPath = path.join(logsDir, `truth-engine-${ts}.full.log`);
        fs.writeFileSync(logPath,
            `Truth Engine Prompt Log\nStarted: ${startTime.toISOString()}\nPID: ${process.pid}\n` +
            `${"═".repeat(70)}\n\n`
        );
        // Symlink for quick access: cat latest.log | grep …
        const latest = path.join(process.cwd(), "latest.log");
        try { fs.unlinkSync(latest); } catch {}
        try { fs.symlinkSync(logPath, latest); } catch {}
        // Rotate: keep only the last 50 log files
        try {
            const files = fs.readdirSync(logsDir)
                .filter(f => f.startsWith("truth-engine-") && f.endsWith(".log"))
                .map(f => path.join(logsDir, f))
                .sort(); // oldest first
            while (files.length > 50) {
                try { fs.unlinkSync(files.shift()!); } catch {}
            }
            // Also rotate .full.log sidecar files
            const fullFiles = fs.readdirSync(logsDir)
                .filter(f => f.startsWith("truth-engine-") && f.endsWith(".full.log"))
                .map(f => path.join(logsDir, f))
                .sort();
            while (fullFiles.length > 50) {
                try { fs.unlinkSync(fullFiles.shift()!); } catch {}
            }
        } catch {}
        if (!quietMode) console.log(`[log] ${logPath}  (→ latest.log)`);
    }
    return logPath;
}

function getFullLogPath(): string | null {
    if (process.env.LOG_PROMPTS === "false" || process.env.LOG_FULL !== "1") return null;
    getLogPath(); // ensure paths are initialized
    return fullLogPath;
}

function append(text: string) {
    const p = getLogPath();
    if (!p) return;
    fs.appendFileSync(p, text);
}

export interface LlmCallLog {
    role: string;
    model: string;
    temperature: number;
    maxTokens: number;
    systemPrompt: string;
    userPrompt: string;
}

export interface LlmResultLog {
    rawContent: string;          // full raw string before <think> stripping
    rawContentStripped: string;  // after stripping <think>
    parsedJson: object | null;
    validatedResult: unknown;
    error: string | null;
    retried: boolean;
    durationMs: number;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    /** Cost in USD for this call */
    cost?: number;
}

export function logLlmStart(call: LlmCallLog): number {
    const p = getLogPath();
    if (!p) return ++callCounter;
    const n = ++callCounter;
    const bar = "═".repeat(70);
    const ts = new Date().toISOString().slice(11, 23);
    const sysPrompt = logContent("SYSTEM PROMPT", call.systemPrompt, n);
    const usrPrompt = logContent("USER PROMPT", call.userPrompt, n);
    const sysLen = call.systemPrompt.length > 4000 ? ` [${call.systemPrompt.length} chars, truncated]` : "";
    const usrLen = call.userPrompt.length > 4000 ? ` [${call.userPrompt.length} chars, truncated]` : "";
    append(
        `${bar}\n` +
        `[${ts}] CALL #${n}  role=${call.role}  model=${call.model}  temp=${call.temperature}  max_tokens=${call.maxTokens}\n` +
        `${bar}\n\n` +
        `── SYSTEM PROMPT ${"─".repeat(53)}${sysLen}\n` +
        `${sysPrompt}\n\n` +
        `── USER PROMPT ${"─".repeat(55)}${usrLen}\n` +
        `${usrPrompt}\n\n`
    );
    return n;
}

export function logLlmResult(_callNum: number, result: LlmResultLog) {
    const p = getLogPath();
    if (!p) return;
    const hasThink = /<think>/i.test(result.rawContent);
    let block = `── RAW RESPONSE (${result.durationMs}ms${result.retried ? ", retried" : ""}) ${"─".repeat(30)}\n`;

    if (hasThink) {
        // Show <think> block separately so reasoning is visible
        const thinkMatch = result.rawContent.match(/<think>([\s\S]*?)<\/think>/i);
        if (thinkMatch) {
            block += `<think> REASONING:\n${thinkMatch[1]!.trim()}\n</think>\n\n`;
        }
        block += `JSON OUTPUT:\n${result.rawContentStripped}\n\n`;
    } else {
        block += `${result.rawContent}\n\n`;
    }

    if (result.parsedJson !== null) {
        const jsonStr = JSON.stringify(result.parsedJson, null, 2);
        const truncated = logContent("PARSED JSON", jsonStr, _callNum);
        const lenNote = jsonStr.length > 4000 ? ` [${jsonStr.length} chars, truncated]` : "";
        block += `── PARSED JSON ${"─".repeat(56)}${lenNote}\n${truncated}\n\n`;
    }

    if (result.error) {
        block += `── ERROR ${"─".repeat(62)}\n${result.error}\n\n`;
        block += `── STATUS: FAILED ──\n\n`;
    } else {
        const tokens = result.usage
            ? `  tokens: ${result.usage.prompt_tokens}p + ${result.usage.completion_tokens}c = ${result.usage.total_tokens}`
            : "";
        const costStr = result.cost && result.cost > 0
            ? `  cost: $${result.cost.toFixed(6)}`
            : "";
        const info = tokens + costStr;
        block += `── STATUS: OK${info} ${"─".repeat(Math.max(0, 57 - info.length))}\n\n`;
    }

    append(block);
}
