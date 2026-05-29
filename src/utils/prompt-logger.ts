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

function rotateLogs(logsDir: string): void {
    try {
        const rotateFiles = (prefix: string, suffix: string, max: number) => {
            const files = fs.readdirSync(logsDir)
                .filter(f => f.startsWith(prefix) && f.endsWith(suffix))
                .map(f => path.join(logsDir, f))
                .sort(); // oldest first
            while (files.length > max) {
                try { fs.unlinkSync(files.shift()!); } catch {}
            }
        };
        rotateFiles("truth-engine-", ".log", 50);
        rotateFiles("truth-engine-", ".full.log", 50);
        rotateFiles("truth-engine-", ".meta.json", 50);
    } catch {}
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
        rotateLogs(logsDir);
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

// ── Structured metadata sidecar (.meta.json) ──────────────────────────────────
// Generated once at the end of each run so scripts can read O(1) JSON
// instead of O(n) grep-scanning the full log.

export interface LogMetadata {
    logFile: string;
    calls: number;
    totalTokens: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalCost: number;
    result: "PASS" | "FAIL" | "UNKNOWN";
    failureClassification: string | null;
    durationSeconds: number | null;
    oracleResults: string[];
    errors: string[];
    agentActions: string[];
    pipelineStages: string[];
    callsDetail: Array<{
        num: number;
        role: string;
        model: string;
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        cost: number;
    }>;
}

/** Generate a .meta.json sidecar from the completed log file.
 *  Called at process exit — does a single O(n) scan, then scripts
 *  get O(1) reads forever after. */
export function finalizeLog(): void {
    const p = getLogPath();
    if (!p) return;
    try {
        const content = fs.readFileSync(p, "utf-8");

        // ── Basic stats ──
        const calls = (content.match(/── RAW RESPONSE/g) || []).length;

        const tokenMatches = content.match(/tokens:\s*(\d+)p\s*\+\s*(\d+)c\s*=\s*(\d+)/g);
        let totalTokens = 0, totalPromptTokens = 0, totalCompletionTokens = 0;
        if (tokenMatches) {
            for (const m of tokenMatches) {
                const pm = m.match(/(\d+)p/);
                const cm = m.match(/(\d+)c/);
                const tm = m.match(/=\s*(\d+)/);
                if (pm) totalPromptTokens += parseInt(pm[1]!);
                if (cm) totalCompletionTokens += parseInt(cm[1]!);
                if (tm) totalTokens += parseInt(tm[1]!);
            }
        }

        const costMatches = content.match(/cost:\s*\$([\d.]+)/g);
        let totalCost = 0;
        if (costMatches) {
            for (const m of costMatches) {
                const val = parseFloat(m.match(/\$([\d.]+)/)?.[1] ?? "0");
                if (!isNaN(val)) totalCost += val;
            }
        }

        // ── Result ──
        let result: "PASS" | "FAIL" | "UNKNOWN" = "UNKNOWN";
        if (/EVENT.*(?:✓ SOLVED|PROBLEM SOLVED|PASS:)/i.test(content) ||
            /"solved":\s*true/i.test(content) ||
            /all tests passed/i.test(content)) {
            result = "PASS";
        } else if (/EVENT.*(?:✗ FAILED|killed|ABORT)/i.test(content) ||
                   /"solved":\s*false/i.test(content)) {
            result = "FAIL";
        }

        // ── Duration ──
        let durationSeconds: number | null = null;
        const startedMatch = content.match(/Started:\s*(\S+)/);
        if (startedMatch) {
            const logStat = fs.statSync(p);
            const logMtime = Math.floor(logStat.mtimeMs / 1000);
            const startDate = new Date(startedMatch[1]!);
            if (!isNaN(startDate.getTime())) {
                durationSeconds = logMtime - Math.floor(startDate.getTime() / 1000);
            }
        }

        // ── Failure classification ──
        let failureClassification: string | null = null;
        if (result !== "PASS") {
            if (/ZOOM OUT|LOOP DETECTED|STAGNATION DETECTED|terminated.*loop|same action.*3/i.test(content))
                failureClassification = "stuck-loop";
            else if (/finish.*without.*test|finish.*before.*pass|not.*all.*pass.*finish/i.test(content))
                failureClassification = "premature-finish";
            else if (/No valid Action|invalid action|could not produce a valid|parse.*fail/i.test(content))
                failureClassification = "parse-failure";
            else if (/max.*turns|budget.*exhaust|turn.*limit|auto-finish/i.test(content))
                failureClassification = "budget-exhausted";
            else if (/TERMINATED:|FAILURE STORM/i.test(content))
                failureClassification = "failure-storm";
            else if (/ABORTED|supervisor.*abort/i.test(content))
                failureClassification = "supervisor-abort";
            else if (/supervisor loop exhausted|exhausted supervisor/i.test(content))
                failureClassification = "supervisor-exhausted";
            else if (/oracle.*hardening.*fail|weak oracle|broken stub/i.test(content))
                failureClassification = "oracle-hardening-failed";
            const failCount = (content.match(/FAILED.*expected|oracle.*FAIL|✗ FAILED/gi) || []).length;
            const passCount = (content.match(/PASS.*expected|oracle.*PASS|✓ PASS/gi) || []).length;
            if (failCount >= 3 && passCount === 0 && !failureClassification)
                failureClassification = "all-tests-failing";
        }

        // ── Strip prompt/PARSED JSON sections for error extraction ──
        const strippedLines: string[] = [];
        let inSkip = false, inJson = false;
        for (const line of content.split("\n")) {
            if (line.startsWith("── SYSTEM PROMPT") || line.startsWith("── USER PROMPT")) { inSkip = true; continue; }
            if (line.startsWith("── PARSED JSON")) { inJson = true; continue; }
            if (line.includes("── STATUS: OK")) { inJson = false; }
            if (line.startsWith("── RAW RESPONSE")) { inSkip = false; inJson = false; }
            if (!inSkip && !inJson) strippedLines.push(line);
        }
        const stripped = strippedLines.join("\n");

        const errors: string[] = [];
        for (const m of stripped.matchAll(/── ERROR\b.*/gi)) errors.push(m[0].trim());
        for (const m of stripped.matchAll(/(?:Error|error|Traceback|Exception)[:\s].*/g)) {
            if (!/possible_failure|fail.*mode/i.test(m[0])) errors.push(m[0].trim());
        }

        const oracleResults: string[] = [];
        for (const m of content.matchAll(/oracle.*?(?:PASS|FAIL|Passed|Failed)[:\s].*/gi)) {
            oracleResults.push(m[0].trim());
        }

        const agentActions: string[] = [];
        for (const m of content.matchAll(/\[task-agent\] Turn (\d+)\/(\d+)/g)) {
            agentActions.push(`Turn ${m[1]}/${m[2]}`);
        }
        for (const m of content.matchAll(/Action:\s*(.*)/g)) {
            agentActions.push(`→ ${(m[1] ?? "").trim().slice(0, 150)}`);
        }
        for (const m of content.matchAll(/(?:ZOOM OUT|LOOP DETECTED|STAGNATION|TERMINATED|FAILURE STORM)[:\s].*/gi)) {
            agentActions.push(`🔴 ${m[0].trim()}`);
        }

        const pipelineStages: string[] = [];
        for (const m of content.matchAll(/EVENT\s+(.*)/gi)) {
            pipelineStages.push((m[1] ?? "").trim());
        }

        const callsDetail: LogMetadata["callsDetail"] = [];
        const callRoles: Array<{ num: number; role: string; model: string }> = [];
        for (const m of content.matchAll(/CALL #(\d+)\s+role=(\S+)\s+model=(\S+)/g)) {
            callRoles.push({ num: parseInt(m[1]!), role: m[2]!, model: m[3]! });
        }
        const tokenMatches2 = [...content.matchAll(/tokens:\s*(\d+)p\s*\+\s*(\d+)c\s*=\s*(\d+)/g)];
        const costMatches2 = [...content.matchAll(/cost:\s*\$([\d.]+)/g)];
        for (let i = 0; i < callRoles.length; i++) {
            callsDetail.push({
                num: callRoles[i]!.num,
                role: callRoles[i]!.role,
                model: callRoles[i]!.model,
                promptTokens: tokenMatches2[i] ? parseInt(tokenMatches2[i]![1]!) : 0,
                completionTokens: tokenMatches2[i] ? parseInt(tokenMatches2[i]![2]!) : 0,
                totalTokens: tokenMatches2[i] ? parseInt(tokenMatches2[i]![3]!) : 0,
                cost: costMatches2[i] ? parseFloat(costMatches2[i]![1]!) : 0,
            });
        }

        const meta: LogMetadata = {
            logFile: path.basename(p),
            calls,
            totalTokens,
            totalPromptTokens,
            totalCompletionTokens,
            totalCost: Math.round(totalCost * 1000000) / 1000000,
            result,
            failureClassification,
            durationSeconds,
            oracleResults: oracleResults.slice(-10),
            errors: errors.slice(-20),
            agentActions,
            pipelineStages: pipelineStages.slice(-10),
            callsDetail,
        };

        const metaPath = p.replace(/\.log$/, ".meta.json");
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    } catch (_err) {
        // Never crash — metadata is best-effort
    }
}
