import { queryLlamaCpp, type LlamaModelConfig } from './llama';
import type { BaseSchema } from 'valibot';

const REASONING_MODEL: LlamaModelConfig = {
    baseUrl: process.env.LLAMA_BASE_URL || 'http://localhost:8080',
    modelName: process.env.REASONING_MODEL || 'deepseek-r1-distill-qwen-7b',
    contextSize: 8192,
};

const CRITIC_MODEL: LlamaModelConfig = {
    baseUrl: process.env.LLAMA_BASE_URL || 'http://localhost:8080',
    modelName: process.env.CRITIC_MODEL || 'deepseek-r1-distill-qwen-7b',
    contextSize: 4096,
};

export async function queryReasoning<T extends BaseSchema>(options: {
    userPrompt: string;
    systemPrompt?: string;
    schema: T;
    temperature?: number;
    maxTokens?: number;
}): Promise<{ response: T['_output']; usage?: any }> {
    return queryLlamaCpp({ ...options, modelConfig: REASONING_MODEL });
}

export async function queryCritic<T extends BaseSchema>(options: {
    userPrompt: string;
    systemPrompt?: string;
    schema: T;
    temperature?: number;
    maxTokens?: number;
}): Promise<{ response: T['_output']; usage?: any }> {
    return queryLlamaCpp({ ...options, modelConfig: CRITIC_MODEL });
}

export async function queryLlmForRole<T extends BaseSchema>(
    role: 'reasoning' | 'critic',
    options: Parameters<typeof queryReasoning<T>>[0]
) {
    if (role === 'critic') return queryCritic(options);
    return queryReasoning(options);
}

