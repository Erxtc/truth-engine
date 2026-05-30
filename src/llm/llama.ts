import * as v from 'valibot';

import { jsonrepair } from 'jsonrepair';
import { ThrottledSemaphore, valibotParse, stripThinkTags } from '../utils/general';
import { quietMode } from '../utils/prompt-logger';
import { logLlmStart, logLlmResult } from '../utils/prompt-logger';
import { cacheKey, cacheGet, cacheSet } from './cache';

export interface LlamaModelConfig {
    baseUrl: string;
    modelName: string;
    contextSize?: number;
    /** API key for cloud providers (sent as Bearer token). Omit for local llama.cpp. */
    apiKey?: string;
    /** USD per 1M tokens. null/undefined = free. */
    pricing?: { inputPerMTok: number; outputPerMTok: number } | null;
}

export interface RawQueryOptions {
    userPrompt: string;
    systemPrompt?: string;
    temperature?: number;
    maxTokens?: number;
    modelConfig?: LlamaModelConfig;
    _role?: string;
    /** When set, included in cache key to force a fresh response for retries.
     *  Use a counter or timestamp — same nonce = same cache key. */
    nonce?: string;
    /** Override the default message construction (for multi-turn conversations). */
    messages?: Array<{ role: string; content: string }>;
}

export interface LlmQueryOptions<T extends v.GenericSchema> {
    userPrompt: string;
    systemPrompt?: string;
    schema: T;
    temperature?: number;
    maxTokens?: number;
    modelConfig?: LlamaModelConfig;
    /** Agent role for logging (e.g. "repair", "baseline", "supervisor") */
    _role?: string;
    /** Transform parsed JSON before schema validation (fixes model output quirks) */
    preprocess?: (raw: object) => object;
    /** When set, included in cache key to force a fresh response for retries. */
    nonce?: string;
}

export interface QueryLlmResponse<T> {
    response: T;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    /** Cost in USD for this call */
    cost?: number;
}

// Default config — env vars override the fallback
export const DEFAULT_CONFIG: LlamaModelConfig = {
    baseUrl: process.env.LLAMA_BASE_URL || 'http://localhost:8080',
    modelName: process.env.REASONING_MODEL || 'deepseek-r1-distill-qwen-7b',
    contextSize: 8192,
};

// Throttle concurrent requests (llama.cpp server limited to --parallel 2)
const semaphore = new ThrottledSemaphore(2);

/**
 * Fix malformed JSON from LLM.
 * Handles: markdown fences, single-quoted values, and bare arrays (takes first element).
 */
function fixJson(input: string): object {
    let wrapped = input.trim();
    // Strip markdown code fences
    wrapped = wrapped.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

    // Try jsonrepair first — it handles most issues natively
    try {
        // If the LLM wrapped the response in an array, unwrap the first element
        if (wrapped.startsWith('[')) {
            const arr = JSON.parse(jsonrepair(wrapped));
            if (Array.isArray(arr) && arr.length > 0) return arr[0] as object;
            return arr; // empty array
        }
        if (!wrapped.startsWith('{') && !wrapped.startsWith('[')) wrapped = `{${wrapped}}`;
        return JSON.parse(jsonrepair(wrapped));
    } catch {
        // jsonrepair failed — try regex-based fixes for single-quoted keys/values
    }

    wrapped = wrapped.replace(/"([^"]*?)'([^"]*?)"/g, `"$1\\'$2"`);
    wrapped = wrapped.replace(/:\s*'([^']*?)'/g, ': "$1"');
    if (!wrapped.startsWith('{') && !wrapped.startsWith('[')) wrapped = `{${wrapped}}`;
    const repaired = jsonrepair(wrapped);
    return JSON.parse(repaired);
}

// ── Shared HTTP/cache/logging core ─────────────────────────────────────────────

interface LlmCallResult {
    rawContent: string;
    cleaned: string;
    usage: any;
    cacheHit: boolean;
    cost: number;
}

/** Single HTTP call with cache, auth, think-tag handling, and error logging.
 *  Payload already includes model, messages, temperature, max_tokens, etc.
 *  Nonce must be spread into payload before calling if needed. */
async function doLlmCall(
    payload: Record<string, unknown>,
    config: LlamaModelConfig,
    callNum: number,
    t0: number,
): Promise<LlmCallResult> {
    const ck = cacheKey(payload);
    const cached = cacheGet(ck);

    const url = `${config.baseUrl}/v1/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;

    let data: any;
    let cacheHit = false;
    if (cached) {
        data = cached;
        cacheHit = true;
    } else {
        const httpResp = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
        });

        if (!httpResp.ok) {
            const errorText = await httpResp.text();
            const err = `LLM API error (${httpResp.status}): ${errorText}`;
            logLlmResult(callNum, { rawContent: '', rawContentStripped: '', parsedJson: null, validatedResult: null, error: err, retried: false, durationMs: Date.now() - t0, cost: 0 });
            throw new Error(err);
        }

        data = await httpResp.json();
        cacheSet(ck, data);
    }

    const rawContent = data.choices?.[0]?.message?.content as string | undefined;
    if (!rawContent) throw new Error('No content in LLM response');

    const cleaned = stripThinkTags(rawContent);

    const cost = config.pricing && data.usage
        ? (data.usage.prompt_tokens / 1_000_000) * config.pricing.inputPerMTok +
          (data.usage.completion_tokens / 1_000_000) * config.pricing.outputPerMTok
        : 0;

    return { rawContent, cleaned, usage: data.usage, cacheHit, cost };
}

// ── Shared query core ────────────────────────────────────────────────────────

interface LlmCoreResult extends LlmCallResult {
    callNum: number;
    t0: number;
}

/** Acquire semaphore, build payload, execute HTTP call.
 *  Caller must call `semaphore.release()` when done processing.
 *  All shared boilerplate lives here — callers handle only their unique logic. */
async function _queryLlmCore(options: {
    modelConfig?: LlamaModelConfig;
    systemPrompt?: string;
    userPrompt: string;
    temperature?: number;
    maxTokens?: number;
    nonce?: string;
    messages?: Array<{ role: string; content: string }>;
    responseFormat?: { type: string };
    role: string;
    defaultSystemPrompt: string;
    defaultMaxTokens: number;
}): Promise<LlmCoreResult> {
    await semaphore.acquire();
    try {
      const t0 = Date.now();
      const config = options.modelConfig ?? DEFAULT_CONFIG;
      const systemPrompt = options.systemPrompt ?? options.defaultSystemPrompt;
      const temperature = options.temperature ?? 0.2;
      const maxTokens = options.maxTokens ?? options.defaultMaxTokens;

      const messages = options.messages ?? [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: options.userPrompt },
      ];

      const callNum = logLlmStart({
          role: options.role,
          model: config.modelName,
          temperature,
          maxTokens,
          systemPrompt,
          userPrompt: options.userPrompt,
      });

      const basePayload: Record<string, unknown> = {
          model: config.modelName,
          messages,
          temperature,
          max_tokens: maxTokens,
          stream: false,
          ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
      };
      const payload = options.nonce ? { ...basePayload, nonce: options.nonce } : basePayload;

      const { rawContent, cleaned, usage, cacheHit, cost } = await doLlmCall(payload, config, callNum, t0);
      return { rawContent, cleaned, usage, cacheHit, callNum, t0, cost };
    } catch (err) {
      semaphore.release();
      throw err;
    }
}

function _consoleLog(role: string, durationMs: number, usage: any, cacheHit: boolean, callNum?: number, extra?: string, cost?: number): void {
    if (quietMode) return;
    const tok = usage ? ` ${usage.total_tokens}tk` : '';
    const costStr = cost && cost > 0 ? ` $${cost.toFixed(4)}` : '';
    const tag = cacheHit ? '♻' : '✓';
    const cn = callNum ? ` #${callNum}` : '';
    console.log(`  [${role}]${cn} ${tag} ${durationMs}ms${tok}${costStr}${extra ?? ''}`);
}

// ── Public query functions ─────────────────────────────────────────────────────

const JSON_PROMPT = 'Return ONLY a raw JSON object. Start with {. No markdown, no explanation.';
const RAW_PROMPT = 'Return ONLY the requested output. No markdown, no explanation.';

/**
 * Query with JSON schema — structured output via response_format + valibot.
 * Retries once on JSON parse failure with a corrective nudge.
 */
export async function queryLlamaCpp<T extends v.GenericSchema>(
    options: LlmQueryOptions<T>
): Promise<QueryLlmResponse<v.InferOutput<T>>> {
    const role = options._role ?? 'llm';
    const { rawContent, cleaned, usage, cacheHit, callNum, t0, cost } = await _queryLlmCore({
        modelConfig: options.modelConfig,
        systemPrompt: options.systemPrompt,
        userPrompt: options.userPrompt,
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        nonce: options.nonce,
        responseFormat: { type: 'json_object' },
        role,
        defaultSystemPrompt: JSON_PROMPT,
        defaultMaxTokens: 4096,
    });

    let parsedJson: object | null = null;
    let retried = false;
    try {
        parsedJson = fixJson(cleaned);
    } catch {
        retried = true;
        const retryMessages = [
            { role: 'system', content: JSON_PROMPT },
            { role: 'user', content: options.userPrompt },
            { role: 'assistant', content: cleaned },
            { role: 'user', content: 'Malformed JSON. Return ONLY the corrected JSON object, starting with {.' },
        ];
        const retryPayload: Record<string, unknown> = {
            model: (options.modelConfig ?? DEFAULT_CONFIG).modelName,
            messages: retryMessages,
            temperature: 0.1,
            max_tokens: options.maxTokens ?? 4096,
            response_format: { type: 'json_object' },
            stream: false,
        };
        const retryResult = await doLlmCall(retryPayload, options.modelConfig ?? DEFAULT_CONFIG, callNum, t0);
        try {
            parsedJson = fixJson(retryResult.cleaned);
        } catch (err2) {
            logLlmResult(callNum, { rawContent, rawContentStripped: cleaned, parsedJson: null, validatedResult: null, error: `JSON parse failed: ${err2}`, retried: true, durationMs: Date.now() - t0, usage, cost });
            semaphore.release();
            throw new Error(`Failed to parse JSON from LLM (after retry): ${cleaned.slice(0, 200)}`);
        }
    }

    if (options.preprocess && typeof parsedJson === "object" && parsedJson !== null) {
        parsedJson = options.preprocess(parsedJson);
    }

    let validated: v.InferOutput<T>;
    try {
        validated = valibotParse(options.schema, parsedJson);
    } catch (err) {
        const errMsg = `Valibot validation failed: ${(err as Error).message?.slice(0, 400)}`;
        logLlmResult(callNum, { rawContent, rawContentStripped: cleaned, parsedJson, validatedResult: null, error: errMsg, retried, durationMs: Date.now() - t0, usage, cost });
        semaphore.release();
        throw err;
    }

    const durationMs = Date.now() - t0;
    logLlmResult(callNum, { rawContent, rawContentStripped: cleaned, parsedJson, validatedResult: validated, error: null, retried, durationMs, usage, cost });
    _consoleLog(role, durationMs, usage, cacheHit, callNum, retried ? ' (retried)' : '', cost);
    semaphore.release();
    return { response: validated, usage, cost };
}

/**
 * Query for raw text — no JSON parsing, no valibot, no response_format.
 * Used by the Prompter pattern where output is executable code, not JSON.
 */
export async function queryRaw(
    options: RawQueryOptions
): Promise<string> {
    const role = options._role ?? 'llm';
    const { rawContent, cleaned, usage, cacheHit, callNum, t0, cost } = await _queryLlmCore({
        modelConfig: options.modelConfig,
        systemPrompt: options.systemPrompt,
        userPrompt: options.userPrompt,
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        nonce: options.nonce,
        messages: options.messages,
        role,
        defaultSystemPrompt: RAW_PROMPT,
        defaultMaxTokens: 2048,
    });

    const durationMs = Date.now() - t0;
    logLlmResult(callNum, { rawContent, rawContentStripped: cleaned, parsedJson: null, validatedResult: null, error: null, retried: false, durationMs, usage, cost });
    _consoleLog(role, durationMs, usage, cacheHit, callNum, '', cost);
    semaphore.release();
    return cleaned;
}