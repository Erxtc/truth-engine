/**
 * Content-addressed oracle cache — avoids re-generating oracles for problems
 * we've already seen. Uses SHA-256 of the problem text as the cache key.
 *
 * Backed by JsonFileStore for persistence (lazy-load, dirty-flag, auto-save).
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { JsonFileStore } from "../utils/json-file-store";

const CACHE_PATH = join(import.meta.dir, "..", ".oracle-cache.json");

/**
 * Oracle cache version — bump this when oracle generation logic changes
 * (e.g., new hardening checks, different example injection, tolerance changes).
 * Stale caches from older versions are automatically invalidated.
 *
 * History:
 *   1 — initial version with __teq tolerance-aware equality + problem example injection
 */
const ORACLE_CACHE_VERSION = 1;

export interface CachedOracle {
  domain_name: string;
  invariants: string[];
  required_confidence: number;
  solution_format: string;
  oracle_js: string;
  cachedAt: string;
}

type CacheData = Record<string, CachedOracle>;
const store = new JsonFileStore<CacheData>(CACHE_PATH, () => ({}));

function hash(problem: string): string {
  return createHash("sha256").update(`${ORACLE_CACHE_VERSION}:${problem.trim()}`).digest("hex").slice(0, 16);
}

export function getCachedOracle(problem: string): CachedOracle | null {
  return store.load()[hash(problem)] ?? null;
}

export function putCachedOracle(problem: string, oracle: CachedOracle): void {
  store.load()[hash(problem)] = oracle;
  store.markDirty();
}

// Auto-save on normal exit
process.on("exit", () => { store.save(); });
