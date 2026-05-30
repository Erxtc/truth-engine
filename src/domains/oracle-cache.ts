/**
 * Content-addressed oracle cache — avoids re-generating oracles for problems
 * we've already seen. Uses SHA-256 of the problem text as the cache key.
 *
 * Backed by JsonFileStore for persistence (lazy-load, dirty-flag, auto-save).
 */
import { join } from "node:path";
import { JsonFileStore } from "../utils/json-file-store";
import { sha256 } from "../utils/general";

const CACHE_PATH = join(import.meta.dir, "..", ".oracle-cache.json");

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

export function getCachedOracle(problem: string): CachedOracle | null {
  return store.load()[sha256(problem.trim())] ?? null;
}

export function putCachedOracle(problem: string, oracle: CachedOracle): void {
  store.load()[sha256(problem.trim())] = oracle;
  store.markDirty();
}

// Auto-save on normal exit
process.on("exit", () => { store.save(); });
