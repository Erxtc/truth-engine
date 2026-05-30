/**
 * LLM response cache — persists to disk so re-running the same problem
 * with unchanged prompts costs zero API calls.
 *
 * Cache key: SHA256(model + messages + temperature + max_tokens + response_format)
 * Cache value: raw API response JSON (content, usage, etc.)
 *
 * Controlled by CACHE_MODE env var:
 *   "on"    (default) — read and write cache
 *   "off"   — bypass cache entirely
 *   "clear" — delete the cache file on startup, then behave as "on"
 */

import { unlinkSync } from "fs";
import { JsonFileStore } from "../utils/json-file-store";
import { sha256 } from "../utils/general";

const CACHE_PATH = import.meta.dir + "/.llm-cache.json";

type CacheMode = "on" | "off" | "clear";

function resolveCacheMode(): CacheMode {
  const val = (process.env.CACHE_MODE ?? "on").toLowerCase();
  if (val === "off" || val === "clear") return val;
  return "on";
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
    return store.load();
  }
  return store.load();
}

/** Build a deterministic cache key from the request payload. */
export function cacheKey(payload: Record<string, unknown>): string {
  const { model, messages, temperature, max_tokens, response_format, nonce } = payload;
  const normalized = JSON.stringify({ model, messages, temperature, max_tokens, response_format, nonce });
  return sha256(normalized, 32);
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
