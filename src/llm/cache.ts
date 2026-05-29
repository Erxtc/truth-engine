/**
 * LLM response cache — persists to disk so re-running the same problem
 * with unchanged prompts costs zero API calls.
 *
 * Cache key: SHA256(model + messages + temperature + max_tokens + response_format)
 * Cache value: raw API response JSON (content, usage, etc.)
 *
 * Controlled by CACHE_MODE env var:
 *   "auto"  (default) — smart: cache when same prompt seen >2 times,
 *                       using prompt-version-tracker data to decide.
 *                       First 2 runs: no cache (build stats). 3rd+ run: cache.
 *   "on"    — always read and write cache
 *   "off"   — bypass cache entirely
 *   "clear" — delete the cache file on startup, then behave as "auto"
 */

import { createHash } from "crypto";
import { unlinkSync } from "fs";
import { JsonFileStore } from "../utils/json-file-store";

const CACHE_PATH = import.meta.dir + "/.llm-cache.json";

type CacheMode = "on" | "off" | "clear" | "auto";

function resolveCacheMode(): CacheMode {
  const val = (process.env.CACHE_MODE ?? "auto").toLowerCase();
  if (val === "off" || val === "clear" || val === "on" || val === "auto") return val as CacheMode;
  return "auto";
}

interface CacheEntry {
  response: unknown;
  cachedAt: string;
}

type CacheData = Record<string, CacheEntry>;
const store = new JsonFileStore<CacheData>(CACHE_PATH, () => ({}));

let _mode: CacheMode | null = null;

function getMode(): CacheMode {
  if (_mode === null) _mode = resolveCacheMode();
  return _mode;
}

function load(): CacheData {
  if (getMode() === "clear") {
    try { unlinkSync(CACHE_PATH); } catch {}
    store.set({});
    // Switch to auto after clear so subsequent runs still get smart caching
    _mode = "auto";
    return store.load();
  }
  return store.load();
}

/** Build a deterministic cache key from the request payload. */
export function cacheKey(payload: Record<string, unknown>): string {
  const { model, messages, temperature, max_tokens, response_format, nonce } = payload;
  const normalized = JSON.stringify({ model, messages, temperature, max_tokens, response_format, nonce });
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

/** Check if auto-cache should activate based on prompt usage count.
 *  In "auto" mode, caching is enabled only for prompts seen > threshold times.
 *  In "on" mode, always returns true. In "off" mode, always returns false. */
export function shouldEnableAutoCache(systemPromptHash: string, userPrompt: string, threshold: number = 2): boolean {
  const mode = getMode();
  if (mode === "on") return true;
  if (mode === "off") return false;
  // "auto" mode — check prompt-version-tracker
  try {
    const { getPromptUsageCount } = require("../analysis/prompt-version-tracker");
    const count = getPromptUsageCount(systemPromptHash, userPrompt);
    return count > threshold;
  } catch {
    // If tracker not available, default to caching — better safe than wasteful
    return true;
  }
}

/** Look up a cached response. Returns null on miss or if cache is off. */
export function cacheGet(key: string): unknown | null {
  if (getMode() === "off") return null;
  const entry = load()[key];
  return entry ? entry.response : null;
}

/** Store a response in the cache. No-op if cache is off. */
export function cacheSet(key: string, response: unknown): void {
  if (getMode() === "off") return;
  load()[key] = { response, cachedAt: new Date().toISOString() };
  store.markDirty();
}

// Auto-flush on normal exit
process.on("exit", () => { store.save(); });
