import * as v from 'valibot';

import { jsonrepair } from 'jsonrepair';
import { CustomError } from '../utils/log';
import { ThrottledSemaphore, valibotParse } from '../utils/general';

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
const LOG_RESPONSE = false;

/**
 * Fix malformed JSON from LLM (same as before)
 */
function fixJson(input: string): object {
    let wrapped = input.trim();
    // Strip markdown code fences the model often wraps output in
    wrapped = wrapped.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    if (!wrapped.startsWith('{')) wrapped = `{${wrapped}}`;
    wrapped = wrapped.replace(/"([^"]*?)'([^"]*?)"/g, `"$1\\'$2"`);
    wrapped = wrapped.replace(/:\s*'([^']*?)'/g, ': "$1"');
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
    try {
        const config = options.modelConfig ?? DEFAULT_CONFIG;

        const payload = {
            model: config.modelName,
            messages: [
                {
                    role: 'system',
                    content: options.systemPrompt ??
                        'You are an AI assistant. Return ONLY a raw JSON object — no markdown, no code fences, no explanation, no prose. Start your response with { and end with }.',
                },
                { role: 'user', content: options.userPrompt },
            ],
            temperature: options.temperature ?? 0.2,
            max_tokens: options.maxTokens ?? 4096,
            response_format: { type: 'json_object' },
            stream: false,
        };

        const url = `${config.baseUrl}/v1/chat/completions`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`llama.cpp API error (${response.status}): ${errorText}`);
        }

        const data = await response.json() as any;
        if (LOG_RESPONSE) console.dir(data, { depth: 6 });

        let content = data.choices?.[0]?.message?.content as string | undefined;
        if (!content) throw new CustomError('No content in LLM response', { data });
        // DeepSeek R1 emits <think>...</think> reasoning before the JSON answer
        content = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

        let parsedJson;
        try {
            parsedJson = fixJson(content);
        } catch {
            // One silent retry with a nudge prompt before giving up
            const retryResp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...payload,
                    messages: [
                        ...payload.messages,
                        { role: 'assistant', content },
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
                throw new CustomError('Failed to parse JSON from LLM', { content, retryContent, error: err2 });
            }
        }

        const validated = valibotParse(options.schema, parsedJson);
        return {
            response: validated,
            usage: data.usage,
        };
    } finally {
        semaphore.release();
    }
}