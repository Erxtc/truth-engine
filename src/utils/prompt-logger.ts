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
let callCounter = 0;
const startTime = new Date();
export let quietMode = false;
export function setQuietMode(q: boolean) { quietMode = q; }

function getLogPath(): string | null {
    if (process.env.LOG_PROMPTS === "false") return null;
    if (!logPath) {
        const ts = startTime.toISOString().replace(/[:.]/g, "-").slice(0, 19);
        logPath = path.join(process.cwd(), `truth-engine-${ts}.log`);
        fs.writeFileSync(logPath,
            `Truth Engine Prompt Log\nStarted: ${startTime.toISOString()}\nPID: ${process.pid}\n` +
            `${"═".repeat(70)}\n\n`
        );
        if (!quietMode) console.log(`[log] ${logPath}`);
    }
    return logPath;
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
}

export function logLlmStart(call: LlmCallLog): number {
    const p = getLogPath();
    if (!p) return ++callCounter;
    const n = ++callCounter;
    const bar = "═".repeat(70);
    const thin = "─".repeat(70);
    const ts = new Date().toISOString().slice(11, 23);
    append(
        `${bar}\n` +
        `[${ts}] CALL #${n}  role=${call.role}  model=${call.model}  temp=${call.temperature}  max_tokens=${call.maxTokens}\n` +
        `${bar}\n\n` +
        `── SYSTEM PROMPT ${"─".repeat(53)}\n` +
        `${call.systemPrompt}\n\n` +
        `── USER PROMPT ${"─".repeat(55)}\n` +
        `${call.userPrompt}\n\n`
    );
    return n;
}

export function logLlmResult(callNum: number, result: LlmResultLog) {
    const p = getLogPath();
    if (!p) return;
    const thin = "─".repeat(70);
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
        block += `── PARSED JSON ${"─".repeat(56)}\n${JSON.stringify(result.parsedJson, null, 2)}\n\n`;
    }

    if (result.error) {
        block += `── ERROR ${"─".repeat(62)}\n${result.error}\n\n`;
        block += `── STATUS: FAILED ──\n\n`;
    } else {
        const tokens = result.usage
            ? `  tokens: ${result.usage.prompt_tokens}p + ${result.usage.completion_tokens}c = ${result.usage.total_tokens}`
            : "";
        block += `── STATUS: OK${tokens} ${"─".repeat(Math.max(0, 57 - tokens.length))}\n\n`;
    }

    append(block);
}
