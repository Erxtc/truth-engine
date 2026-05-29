import * as v from 'valibot';
import { queryLlamaCpp, queryRaw, DEFAULT_CONFIG, type LlamaModelConfig } from './llama';
import { emit } from '../ui/events';
import { getRegistry, type TaskProfile } from './registry';

/** Known LLM roles for model routing and logging. */
export type LlmRole = "supervisor" | "repair" | "baseline" | "deepseek" | "deepseek-raw" | "reasoning" | "prompter" | "task-agent";

const REASONING_MODEL = DEFAULT_CONFIG;

// ── Model tier ──────────────────────────────────────────────────────────────

/** Pipeline behavior tier based on the best available model's reasoning capability.
 *  Tier 1 (reasoning < 0.6): stripped-down pipeline for local 7B models
 *  Tier 2 (reasoning 0.6–0.9): full pipeline — context builder, multi-branch, exploration
 *  Tier 3 (reasoning > 0.9):   maximum capability — critics, consensus, deep search
 */
export type ModelTier = 1 | 2 | 3;

let _cachedTier: ModelTier | null = null;

export async function getModelTier(): Promise<ModelTier> {
    if (_cachedTier !== null) return _cachedTier;
    try {
        const registry = await getRegistry();
        const models = registry.getModels();
        if (models.length === 0) {
            _cachedTier = 1;
            return 1;
        }
        // Use the best available model's reasoning as the tier ceiling
        const bestReasoning = Math.max(...models.map(m => m.capabilities.reasoning));
        if (bestReasoning >= 0.9)  _cachedTier = 3;
        else if (bestReasoning >= 0.6) _cachedTier = 2;
        else _cachedTier = 1;
    } catch {
        _cachedTier = 1;
    }
    return _cachedTier;
}

// ── Role → TaskProfile mapping ──────────────────────────────────────────────

function roleToProfile(role: string): TaskProfile {
    switch (role) {
        case "supervisor":
            return { type: "reasoning", priority: "quality", requiresJsonMode: true };
        case "repair":
            return { type: "code-generation", priority: "speed", requiresJsonMode: true };
        case "baseline":
            return { type: "baseline", priority: "quality", requiresJsonMode: true };
        case "prompter":
            // Prompter is used for oracle generation AND code generation.
            // Raw mode is the default; the quality/speed split depends on context.
            return { type: "code-generation", priority: "quality", requiresRawMode: true };
        default:
            return { type: "reasoning", priority: "speed", requiresJsonMode: true };
    }
}

/** Roles that do meta-cognition (supervision, oracle generation).
 *  These are typically routed to stronger models; overridden by MODEL_OVERRIDE_META. */
const META_ROLES = new Set(["supervisor", "prompter"]);

/** Roles that do implementation (code generation, repair, baseline).
 *  These can run on weaker/cheaper models; overridden by MODEL_OVERRIDE_IMPL. */
const IMPL_ROLES = new Set(["repair", "baseline"]);

/** Resolve the best available model for a given agent role.
 *
 *  Override precedence (first match wins):
 *    1. MODEL_OVERRIDE_META  — for meta-cognitive roles (supervisor, prompter)
 *    2. MODEL_OVERRIDE_IMPL  — for implementation roles (repair, baseline)
 *    3. MODEL_OVERRIDE       — global override for ALL roles
 *
 *  Without overrides, routes via registry capability scoring.
 *  Falls back to REASONING_MODEL if the registry is unavailable. */
async function resolveModel(role: string): Promise<LlamaModelConfig> {
    try {
        const registry = await getRegistry();
        const overrideKey = META_ROLES.has(role) ? "MODEL_OVERRIDE_META"
            : IMPL_ROLES.has(role) ? "MODEL_OVERRIDE_IMPL"
            : null;
        const override = (overrideKey ? process.env[overrideKey] : null)
            ?? process.env.MODEL_OVERRIDE;
        if (override) {
            const model = registry.getModel(override);
            if (model) return model.modelConfig;
            console.warn(`[registry] override="${override}" not found — using routed model`);
        }
        const profile = roleToProfile(role);
        const descriptor = registry.route(profile);
        return descriptor.modelConfig;
    } catch {
        return REASONING_MODEL;
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function promptPreview(p: string, max = 120): string {
    return p.length <= max ? p : p.slice(0, max) + '…';
}

function previewResponse(obj: unknown, maxChars = 4000): string {
    try {
        const s = JSON.stringify(obj);
        return s.length <= maxChars ? s : s.slice(0, maxChars) + '…';
    } catch { return String(obj).slice(0, maxChars); }
}

// ── Timing + emit wrapper ────────────────────────────────────────────────────

async function withEmit<T>(params: {
    userPrompt: string;
    role: string;
    resolveModel: () => Promise<LlamaModelConfig>;
    execute: (modelConfig: LlamaModelConfig) => Promise<T>;
    endDetail: (result: T) => Record<string, unknown>;
    endLabel?: (ms: number) => string;
}): Promise<T> {
    const t0 = Date.now();
    const modelConfig = await params.resolveModel();
    emit('llm:start', promptPreview(params.userPrompt), { detail: { model: modelConfig.modelName, role: params.role, prompt: params.userPrompt } });
    const result = await params.execute(modelConfig);
    const ms = Date.now() - t0;
    const label = params.endLabel ? params.endLabel(ms) : `${params.role} done in ${(ms / 1000).toFixed(1)}s`;
    emit('llm:end', label, { ms, detail: params.endDetail(result) });
    return result;
}

// ── Public query functions ──────────────────────────────────────────────────

export async function queryReasoning<T extends v.GenericSchema>(options: {
    userPrompt: string;
    systemPrompt?: string;
    schema: T;
    temperature?: number;
    maxTokens?: number;
    _role?: LlmRole;
    preprocess?: (raw: object) => object;
    nonce?: string;
}): Promise<{ response: v.InferOutput<T>; usage?: any }> {
    const role = options._role ?? 'reasoning';
    return withEmit({
        userPrompt: options.userPrompt,
        role,
        resolveModel: () => resolveModel(role),
        execute: (mc) => queryLlamaCpp({ ...options, _role: role, modelConfig: mc } as any),
        endDetail: (r) => ({ usage: r.usage, responsePreview: previewResponse(r.response) }),
    });
}

export async function queryRawReasoning(options: {
    userPrompt: string;
    systemPrompt?: string;
    temperature?: number;
    maxTokens?: number;
    _role?: LlmRole;
    nonce?: string;
}): Promise<string> {
    const role = options._role ?? 'prompter';
    return withEmit({
        userPrompt: options.userPrompt,
        role,
        resolveModel: () => resolveModel(role),
        execute: (mc) => queryRaw({ ...options, modelConfig: mc, _role: role }),
        endDetail: (r) => ({ responsePreview: r.slice(0, 200) }),
    });
}

/** Resolve the model for meta-cognitive tasks (those that call queryDeepseek*).
 *  Checks MODEL_OVERRIDE_META first, then defaults to deepseek-cloud.
 *  Falls back to REASONING_MODEL if registry is unavailable. */
async function resolveDeepseek(): Promise<LlamaModelConfig> {
    try {
        const registry = await getRegistry();
        const override = process.env.MODEL_OVERRIDE_META ?? process.env.MODEL_OVERRIDE;
        if (override) {
            const model = registry.getModel(override);
            if (model) return model.modelConfig;
            console.warn(`[registry] META override="${override}" not found — using deepseek-cloud`);
        }
        const model = registry.getModel("deepseek-cloud");
        if (model) return model.modelConfig;
    } catch {}
    return REASONING_MODEL;
}

export async function queryDeepseek<T extends v.GenericSchema>(options: {
    userPrompt: string;
    systemPrompt?: string;
    schema: T;
    temperature?: number;
    maxTokens?: number;
    preprocess?: (raw: object) => object;
}): Promise<{ response: v.InferOutput<T>; usage?: any }> {
    return withEmit({
        userPrompt: options.userPrompt,
        role: 'deepseek',
        resolveModel: resolveDeepseek,
        execute: (mc) => queryLlamaCpp({ ...options, modelConfig: mc, _role: 'deepseek' } as any),
        endDetail: (r) => ({ usage: r.usage, responsePreview: previewResponse(r.response) }),
    });
}

export async function queryDeepseekRaw(options: {
    userPrompt: string;
    systemPrompt?: string;
    temperature?: number;
    maxTokens?: number;
}): Promise<string> {
    return withEmit({
        userPrompt: options.userPrompt,
        role: 'deepseek-raw',
        resolveModel: resolveDeepseek,
        execute: (mc) => queryRaw({ ...options, modelConfig: mc, _role: 'deepseek-raw' }),
        endDetail: (r) => ({ responsePreview: r.slice(0, 200) }),
    });
}

