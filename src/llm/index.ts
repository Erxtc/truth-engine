import * as v from 'valibot';
import { queryLlamaCpp, queryRaw, DEFAULT_CONFIG, type LlamaModelConfig } from './llama';
import { getRegistry, type TaskProfile } from './registry';

/** Known LLM roles for model routing and logging. */
export type LlmRole = "supervisor" | "repair" | "baseline" | "deepseek" | "deepseek-raw" | "reasoning" | "prompter" | "task-agent";

const REASONING_MODEL = DEFAULT_CONFIG;

// ── Model tier ──────────────────────────────────────────────────────────────

export type ModelTier = 1 | 2 | 3;

let _cachedTier: ModelTier | null = null;

export async function getModelTier(): Promise<ModelTier> {
    if (_cachedTier !== null) return _cachedTier;
    try {
        const registry = await getRegistry();
        const models = registry.getModels();
        if (models.length === 0) { _cachedTier = 1; return 1; }
        const bestReasoning = Math.max(...models.map(m => m.capabilities.reasoning));
        if (bestReasoning >= 0.9)  _cachedTier = 3;
        else if (bestReasoning >= 0.6) _cachedTier = 2;
        else _cachedTier = 1;
    } catch {
        _cachedTier = 1;
    }
    return _cachedTier;
}

// ── Role-based routing ──────────────────────────────────────────────────────

const META_ROLES = new Set(["supervisor", "prompter"]);
const IMPL_ROLES = new Set(["repair", "baseline"]);

function roleToProfile(role: string): TaskProfile {
    switch (role) {
        case "supervisor": return { type: "reasoning", priority: "quality", requiresJsonMode: true };
        case "repair":     return { type: "code-generation", priority: "speed", requiresJsonMode: true };
        case "baseline":   return { type: "baseline", priority: "quality", requiresJsonMode: true };
        case "prompter":   return { type: "code-generation", priority: "quality", requiresRawMode: true };
        default:           return { type: "reasoning", priority: "speed", requiresJsonMode: true };
    }
}

/** Resolve model config. If `explicitModel` is set, looks it up directly (no role routing).
 *  Otherwise applies env var overrides by role category, then falls back to capability scoring. */
async function resolveModelConfig(role?: string, explicitModel?: string): Promise<LlamaModelConfig> {
    try {
        const registry = await getRegistry();

        // Explicit model override (e.g. "deepseek-cloud") — direct lookup
        if (explicitModel) {
            const model = registry.getModel(explicitModel);
            if (model) return model.modelConfig;
        }

        // Env var override by role category
        const overrideKey = META_ROLES.has(role ?? "") ? "MODEL_OVERRIDE_META"
            : IMPL_ROLES.has(role ?? "") ? "MODEL_OVERRIDE_IMPL"
            : null;
        const override = (overrideKey ? process.env[overrideKey] : null) ?? process.env.MODEL_OVERRIDE;
        if (override) {
            const model = registry.getModel(override);
            if (model) return model.modelConfig;
        }

        // Default: capability-scored routing
        const profile = roleToProfile(role ?? "reasoning");
        return registry.route(profile).modelConfig;
    } catch {
        return REASONING_MODEL;
    }
}

// ── Public query API (2 functions: JSON + raw) ──────────────────────────────

/** Query LLM with JSON schema validation. Pass `model` to force a specific model. */
export async function queryLlm<T extends v.GenericSchema>(options: {
    userPrompt: string;
    systemPrompt?: string;
    schema: T;
    temperature?: number;
    maxTokens?: number;
    role?: string;
    model?: string;
    preprocess?: (raw: object) => object;
    nonce?: string;
}): Promise<{ response: v.InferOutput<T>; usage?: any }> {
    const modelConfig = await resolveModelConfig(options.role, options.model);
    return queryLlamaCpp({ ...options, modelConfig, _role: options.role } as any);
}

/** Query LLM for raw text (no JSON parsing). Pass `model` to force a specific model. */
export async function queryLlmRaw(options: {
    userPrompt: string;
    systemPrompt?: string;
    temperature?: number;
    maxTokens?: number;
    role?: string;
    model?: string;
    nonce?: string;
}): Promise<string> {
    const modelConfig = await resolveModelConfig(options.role, options.model);
    return queryRaw({ ...options, modelConfig, _role: options.role });
}

// ── Backward-compat aliases (for gradual migration) ──────────────────────────

export const queryReasoning = queryLlm;
export const queryRawReasoning = queryLlmRaw;
export function queryDeepseek<T extends v.GenericSchema>(options: any): Promise<{ response: v.InferOutput<T>; usage?: any }> {
    return queryLlm({ ...options, model: "deepseek-cloud" });
}
export function queryDeepseekRaw(options: any): Promise<string> {
    return queryLlmRaw({ ...options, model: "deepseek-cloud" });
}
