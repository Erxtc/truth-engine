/**
 * Model registry — auto-discovers available LLM backends and routes tasks
 * to the best available model based on capability match.
 *
 * Discovery order:
 *   1. Local llama.cpp on localhost:8080 (free, always checked)
 *   2. Cloud providers (checked when API keys are present in env)
 *
 * Routing: each task declares a profile (type + priority) and the registry
 * scores every available model, picking the highest-scoring match.
 */

import type { LlamaModelConfig } from "./llama";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ModelPricing {
  /** USD per 1M input (prompt) tokens */
  inputPerMTok: number;
  /** USD per 1M output (completion) tokens */
  outputPerMTok: number;
}

export interface ModelCapabilities {
  /** 0–1: multi-step reasoning, evaluation, strategic decisions */
  reasoning: number;
  /** 0–1: writing correct, well-structured code */
  codeGeneration: number;
  /** Wall-clock speed per token */
  speed: "fast" | "medium" | "slow";
  /** Monetary / compute cost */
  cost: "free" | "cheap" | "expensive";
  /** USD pricing per 1M tokens (null = free/local model) */
  pricing: ModelPricing | null;
  jsonMode: boolean;
  rawMode: boolean;
}

export interface ModelDescriptor {
  id: string;
  provider: string;
  modelConfig: LlamaModelConfig;
  capabilities: ModelCapabilities;
}

export type TaskType =
  | "reasoning"         // supervisor, complexity estimation, domain detection
  | "code-generation"   // proposer, repair
  | "oracle-generation" // auto-detect oracle generation
  | "planning"          // step plans
  | "analysis"          // feedback analysis, legislator
  | "baseline";         // simple single-shot (used in benchmark)

export interface TaskProfile {
  type: TaskType;
  priority: "quality" | "speed" | "cost";
  requiresJsonMode?: boolean;
  requiresRawMode?: boolean;
}

// ── Discovery ────────────────────────────────────────────────────────────────

async function isHostReachable(url: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    await fetch(url, { method: "GET", signal: ctrl.signal });
    clearTimeout(t);
    return true;
  } catch {
    return false;
  }
}

export async function discoverModels(): Promise<ModelDescriptor[]> {
  const models: ModelDescriptor[] = [];

  // ── Local llama.cpp ──────────────────────────────────────────────────────
  const llamaBaseUrl = process.env.LLAMA_BASE_URL || "http://localhost:8080";
  const llamaReachable = await isHostReachable(llamaBaseUrl);

  if (llamaReachable) {
    const modelName = process.env.REASONING_MODEL || "deepseek-r1-distill-qwen-7b";
    models.push({
      id: "local-7b",
      provider: "llama.cpp",
      modelConfig: {
        baseUrl: llamaBaseUrl,
        modelName,
        contextSize: 8192,
        pricing: null,
      },
      capabilities: {
        reasoning: 0.4,
        codeGeneration: 0.5,
        speed: "medium",
        cost: "free",
        pricing: null,
        jsonMode: true,
        rawMode: true,
      },
    });
  }

  // ── DeepSeek cloud (OpenAI-compatible) ───────────────────────────────────
  if (process.env.DEEPSEEK_API_KEY) {
    models.push({
      id: "deepseek-cloud",
      provider: "deepseek",
      modelConfig: {
        baseUrl: "https://api.deepseek.com",
        modelName: "deepseek-chat",
        contextSize: 65536,
        apiKey: process.env.DEEPSEEK_API_KEY,
        pricing: { inputPerMTok: 0.27, outputPerMTok: 1.10 },
      },
      capabilities: {
        reasoning: 0.85,
        codeGeneration: 0.80,
        speed: "fast",
        cost: "cheap",
        pricing: { inputPerMTok: 0.27, outputPerMTok: 1.10 },
        jsonMode: true,
        rawMode: true,
      },
    });
  }

  // ── Anthropic Claude ─────────────────────────────────────────────────────
  if (process.env.ANTHROPIC_API_KEY) {
    // Anthropic uses a different protocol — not OpenAI-compatible.
    // We register it so the routing table knows it exists, but actual
    // query dispatch needs an anthropic-specific path in llama.ts.
    // For now, flag rawMode/jsonMode as true since we can adapt.
    models.push({
      id: "claude",
      provider: "anthropic",
      modelConfig: {
        baseUrl: "https://api.anthropic.com",
        modelName: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
        contextSize: 200_000,
        apiKey: process.env.ANTHROPIC_API_KEY,
        pricing: { inputPerMTok: 3.00, outputPerMTok: 15.00 },
      },
      capabilities: {
        reasoning: 0.95,
        codeGeneration: 0.90,
        speed: "fast",
        cost: "expensive",
        pricing: { inputPerMTok: 3.00, outputPerMTok: 15.00 },
        jsonMode: true,
        rawMode: true,
      },
    });
  }

  // ── OpenAI ───────────────────────────────────────────────────────────────
  if (process.env.OPENAI_API_KEY) {
    models.push({
      id: "openai",
      provider: "openai",
      modelConfig: {
        baseUrl: "https://api.openai.com",
        modelName: process.env.OPENAI_MODEL || "gpt-4o",
        contextSize: 128_000,
        apiKey: process.env.OPENAI_API_KEY,
        pricing: { inputPerMTok: 2.50, outputPerMTok: 10.00 },
      },
      capabilities: {
        reasoning: 0.85,
        codeGeneration: 0.85,
        speed: "fast",
        cost: "expensive",
        pricing: { inputPerMTok: 2.50, outputPerMTok: 10.00 },
        jsonMode: true,
        rawMode: true,
      },
    });
  }

  return models;
}

// ── Routing ──────────────────────────────────────────────────────────────────

/** Score a model for a task profile. Higher = better fit. */
function scoreModel(model: ModelDescriptor, profile: TaskProfile): number {
  const cap = model.capabilities;
  let score = 0;

  // Capability match by task type
  switch (profile.type) {
    case "reasoning":
    case "planning":
    case "analysis":
      score += cap.reasoning * 60;
      score += cap.codeGeneration * 10;
      break;
    case "code-generation":
    case "baseline":
      score += cap.codeGeneration * 50;
      score += cap.reasoning * 20;
      break;
    case "oracle-generation":
      score += cap.reasoning * 40;
      score += cap.codeGeneration * 30;
      break;
  }

  // Priority bonus
  switch (profile.priority) {
    case "quality":
      score += cap.reasoning * 15;
      break;
    case "speed":
      score += cap.speed === "fast" ? 15 : cap.speed === "medium" ? 8 : 0;
      break;
    case "cost":
      score += cap.cost === "free" ? 15 : cap.cost === "cheap" ? 8 : 0;
      break;
  }

  // Cost penalty: expensive models must be significantly better to win the route.
  // DeepSeek (cheap + capable) should win routine tasks over Claude (expensive + best).
  switch (cap.cost) {
    case "expensive": score -= 15; break;
    case "cheap":     /* neutral */ break;
    case "free":      score += 5;  break;  // always prefer local when adequate
  }

  // Required mode penalties
  if (profile.requiresJsonMode && !cap.jsonMode) score -= 100;
  if (profile.requiresRawMode && !cap.rawMode) score -= 100;

  return score;
}

export function routeTask(
  profile: TaskProfile,
  models: ModelDescriptor[]
): ModelDescriptor {
  if (models.length === 0) {
    throw new Error("No models available. Start llama.cpp or set an API key.");
  }

  let best = models[0]!;
  let bestScore = scoreModel(best, profile);

  for (let i = 1; i < models.length; i++) {
    const s = scoreModel(models[i]!, profile);
    if (s > bestScore) {
      bestScore = s;
      best = models[i]!;
    }
  }

  return best;
}

// ── Registry singleton ───────────────────────────────────────────────────────

export class ModelRegistry {
  private models: ModelDescriptor[] = [];
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    this.models = await discoverModels();
    this.initialized = true;
  }

  getModels(): ModelDescriptor[] {
    return this.models;
  }

  getModel(id: string): ModelDescriptor | undefined {
    return this.models.find(m => m.id === id);
  }

  route(profile: TaskProfile): ModelDescriptor {
    return routeTask(profile, this.models);
  }

  /** Short summary for logging (e.g. "3 models: local-7b, deepseek-cloud, claude") */
  summary(): string {
    if (this.models.length === 0) return "no models available";
    return `${this.models.length} model(s): ${this.models.map(m => m.id).join(", ")}`;
  }

  /** Print discovery results to console */
  printDiscovery(): void {
    console.log(`\n[registry] Discovered ${this.models.length} model(s):`);
    for (const m of this.models) {
      const flags: string[] = [];
      if (m.capabilities.cost === "free") flags.push("FREE");
      else if (m.capabilities.cost === "cheap") flags.push("cheap");
      else flags.push("$$$");
      flags.push(m.capabilities.speed);
      flags.push(`ctx=${(m.modelConfig.contextSize ?? 0) / 1000}k`);
      console.log(`  ${m.id.padEnd(18)} ${m.provider.padEnd(12)} ${flags.join(" ")}`);
    }
  }
}

// Module-level singleton
let _registry: ModelRegistry | null = null;

export async function getRegistry(): Promise<ModelRegistry> {
  if (!_registry) {
    _registry = new ModelRegistry();
    await _registry.init();
    _registry.printDiscovery();
  }
  return _registry;
}
