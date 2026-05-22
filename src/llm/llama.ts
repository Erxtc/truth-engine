import * as v from 'valibot';

import { jsonrepair } from 'jsonrepair';
import { CustomError } from '../utils/log';
import { ThrottledSemaphore, valibotParse } from '../utils/general';
import { logLlmStart, logLlmResult } from '../utils/prompt-logger';
import { emit } from '../ui/events';

export interface LlamaModelConfig {
    baseUrl: string;
    modelName: string;
    contextSize?: number;
}

export interface LlmQueryOptions<T extends v.GenericSchema> {
    userPrompt: string;
    systemPrompt?: string;
    schema: T;
    temperature?: number;
    maxTokens?: number;
    modelConfig?: LlamaModelConfig;
}

export interface QueryLlmResponse<T> {
    response: T;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

// Default local server (matches the user's command)
const DEFAULT_CONFIG: LlamaModelConfig = {
    baseUrl: 'http://localhost:8080',
    modelName: 'deepseek-r1-distill-qwen-7b',
    contextSize: 8192,
};

// Throttle concurrent requests (llama.cpp server limited to --parallel 2)
const semaphore = new ThrottledSemaphore(2);

/**
 * Fix malformed JSON from LLM.
 * Handles: markdown fences, single-quoted values, bare arrays from models that
 * wrap multiple objects as [{proposals:[...]}, {proposals:[...]}] instead of
 * a single {proposals:[...]} object.
 */
function fixJson(input: string): object {
    let wrapped = input.trim();
    // Strip markdown code fences the model often wraps output in
    wrapped = wrapped.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    // Repair before array-merge so jsonrepair can normalise nested issues first
    wrapped = wrapped.replace(/"([^"]*?)'([^"]*?)"/g, `"$1\\'$2"`);
    wrapped = wrapped.replace(/:\s*'([^']*?)'/g, ': "$1"');
    // If the model returned an array of objects, merge their contents into one object
    if (wrapped.startsWith('[')) {
        try {
            const arr = JSON.parse(jsonrepair(wrapped));
            if (Array.isArray(arr) && arr.length > 0 && typeof arr[0] === 'object') {
                // Merge: for array-valued keys (like "proposals"), concatenate the arrays
                const merged: Record<string, unknown> = {};
                for (const item of arr) {
                    for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
                        if (Array.isArray(v) && Array.isArray(merged[k])) {
                            (merged[k] as unknown[]).push(...v);
                        } else {
                            merged[k] = v;
                        }
                    }
                }
                return merged;
            }
        } catch { /* fall through to single-object path */ }
    }
    if (!wrapped.startsWith('{')) wrapped = `{${wrapped}}`;
    const repaired = jsonrepair(wrapped);
    return JSON.parse(repaired);
}

/**
 * Query llama.cpp server with OpenAI-compatible chat completions API.
 * Supports JSON schema via response_format: { type: "json_object" }.
 * The actual schema validation is done by valibot after parsing.
 */
export async function queryLlamaCpp<T extends v.GenericSchema>(
    options: LlmQueryOptions<T>
): Promise<QueryLlmResponse<v.InferOutput<T>>> {
    await semaphore.acquire();
    const t0 = Date.now();
    const config = options.modelConfig ?? DEFAULT_CONFIG;
    const systemPrompt = options.systemPrompt ??
        'You are an AI assistant. Return ONLY a raw JSON object — no markdown, no code fences, no explanation, no prose. Start your response with { and end with }.';
    const temperature = options.temperature ?? 0.2;
    const maxTokens = options.maxTokens ?? 4096;

    const callNum = logLlmStart({
        role: (options as any)._role ?? 'llm',
        model: config.modelName,
        temperature,
        maxTokens,
        systemPrompt,
        userPrompt: options.userPrompt,
    });

    try {
        const payload = {
            model: config.modelName,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: options.userPrompt },
            ],
            temperature,
            max_tokens: maxTokens,
            response_format: { type: 'json_object' },
            stream: false,
        };

        const url = `${config.baseUrl}/v1/chat/completions`;
        const httpResp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        if (!httpResp.ok) {
            const errorText = await httpResp.text();
            const err = `llama.cpp API error (${httpResp.status}): ${errorText}`;
            logLlmResult(callNum, { rawContent: '', rawContentStripped: '', parsedJson: null, validatedResult: null, error: err, retried: false, durationMs: Date.now() - t0 });
            throw new Error(err);
        }

        const data = await httpResp.json() as any;

        let rawContent = data.choices?.[0]?.message?.content as string | undefined;
        if (!rawContent) throw new CustomError('No content in LLM response', { data });

        // Capture <think> reasoning for emit + log before stripping
        const thinkMatch = rawContent.match(/<think>([\s\S]*?)<\/think>/i);
        if (thinkMatch?.[1]) {
            const thinking = thinkMatch[1].trim();
            if (thinking) {
                emit('llm:thinking', thinking.slice(0, 120) + (thinking.length > 120 ? '…' : ''), { detail: { thinking } });
            }
        }
        const rawContentStripped = rawContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

        let parsedJson: object | null = null;
        let retried = false;
        try {
            parsedJson = fixJson(rawContentStripped);
        } catch {
            retried = true;
            const retryResp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...payload,
                    messages: [
                        ...payload.messages,
                        { role: 'assistant', content: rawContentStripped },
                        { role: 'user', content: 'The JSON above is malformed. Return ONLY the corrected raw JSON object, starting with { and ending with }. No markdown fences. No extra text.' },
                    ],
                    temperature: 0.1,
                }),
            });
            const retryData = await retryResp.json() as any;
            let retryContent = retryData.choices?.[0]?.message?.content as string | undefined ?? '';
            retryContent = retryContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
            try {
                parsedJson = fixJson(retryContent);
            } catch (err2) {
                const errMsg = `Failed to parse JSON from LLM: ${err2}`;
                logLlmResult(callNum, { rawContent, rawContentStripped, parsedJson: null, validatedResult: null, error: errMsg, retried, durationMs: Date.now() - t0, usage: data.usage });
                throw new CustomError('Failed to parse JSON from LLM', { content: rawContentStripped, retryContent, error: err2 });
            }
        }

        let validated: v.InferOutput<T>;
        try {
            validated = valibotParse(options.schema, parsedJson);
        } catch (err) {
            const errMsg = `Valibot validation failed: ${(err as Error).message?.slice(0, 400)}`;
            logLlmResult(callNum, { rawContent, rawContentStripped, parsedJson, validatedResult: null, error: errMsg, retried, durationMs: Date.now() - t0, usage: data.usage });
            throw err;
        }

        logLlmResult(callNum, { rawContent, rawContentStripped, parsedJson, validatedResult: validated, error: null, retried, durationMs: Date.now() - t0, usage: data.usage });
        return { response: validated, usage: data.usage };
    } finally {
        semaphore.release();
    }
}