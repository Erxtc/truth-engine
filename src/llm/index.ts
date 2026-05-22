import * as v from 'valibot';
import { queryLlamaCpp, type LlamaModelConfig } from './llama';
import { emit } from '../ui/events';

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

function promptPreview(p: string, max = 120): string {
    return p.length <= max ? p : p.slice(0, max) + '…';
}

export async function queryReasoning<T extends v.GenericSchema>(options: {
    userPrompt: string;
    systemPrompt?: string;
    schema: T;
    temperature?: number;
    maxTokens?: number;
}): Promise<{ response: v.InferOutput<T>; usage?: any }> {
    const t0 = Date.now();
    emit('llm:start', promptPreview(options.userPrompt), { detail: { model: REASONING_MODEL.modelName, role: 'reasoning', prompt: options.userPrompt } });
    const result = await queryLlamaCpp({ ...options, modelConfig: REASONING_MODEL });
    const ms = Date.now() - t0;
    emit('llm:end', `reasoning done in ${(ms / 1000).toFixed(1)}s`, { ms, detail: { usage: result.usage } });
    return result;
}

export async function queryCritic<T extends v.GenericSchema>(options: {
    userPrompt: string;
    systemPrompt?: string;
    schema: T;
    temperature?: number;
    maxTokens?: number;
}): Promise<{ response: v.InferOutput<T>; usage?: any }> {
    const t0 = Date.now();
    emit('llm:start', promptPreview(options.userPrompt), { detail: { model: CRITIC_MODEL.modelName, role: 'critic', prompt: options.userPrompt } });
    const result = await queryLlamaCpp({ ...options, modelConfig: CRITIC_MODEL });
    const ms = Date.now() - t0;
    emit('llm:end', `critic done in ${(ms / 1000).toFixed(1)}s`, { ms, detail: { usage: result.usage } });
    return result;
}

// queryLlm routes to local model in dev; swap to perplexity for research-enriched runs
export async function queryLlm<T extends v.GenericSchema>(
    userPrompt: string,
    schema: T,
): Promise<{ response: v.InferOutput<T>; usage?: any }> {
    const t0 = Date.now();
    emit('llm:start', promptPreview(userPrompt), { detail: { model: REASONING_MODEL.modelName, role: 'llm', prompt: userPrompt } });
    const result = await queryLlamaCpp({ userPrompt, schema, modelConfig: REASONING_MODEL });
    const ms = Date.now() - t0;
    emit('llm:end', `llm done in ${(ms / 1000).toFixed(1)}s`, { ms, detail: { usage: result.usage } });
    return result;
}
