import * as v from 'valibot';
import { toJsonSchema } from '@valibot/to-json-schema';
import { jsonrepair } from 'jsonrepair';
import { CustomError } from '../utils/log';
import { ThrottledSemaphore, valibotParse } from '../utils/general';

export interface LlamaModelConfig {
    baseUrl: string;
    modelName: string;
    contextSize?: number;
}

export interface LlmQueryOptions<T extends v.BaseSchema> {
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
export async function queryLlamaCpp<T extends v.BaseSchema>(
    options: LlmQueryOptions<T>
): Promise<QueryLlmResponse<v.InferOutput<T>>> {
    await semaphore.acquire();
    try {
        const config = options.modelConfig ?? DEFAULT_CONFIG;
        const { $schema: _, ...jsonSchema } = toJsonSchema(options.schema);

        const payload = {
            model: config.modelName,
            messages: [
                {
                    role: 'system',
                    content:
                        options.systemPrompt ??
                        'You are an AI assistant. Return ONLY valid JSON that conforms to the expected schema.',
                },
                { role: 'user', content: options.userPrompt },
            ],
            temperature: options.temperature ?? 0.2,
            max_tokens: options.maxTokens ?? 2048,
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

        const data = await response.json();
        if (LOG_RESPONSE) console.dir(data, { depth: 6 });

        const content = data.choices?.[0]?.message?.content;
        if (!content) throw new CustomError('No content in LLM response', { data });

        let parsedJson;
        try {
            parsedJson = fixJson(content);
        } catch (err) {
            throw new CustomError('Failed to parse JSON from LLM', { content, error: err });
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