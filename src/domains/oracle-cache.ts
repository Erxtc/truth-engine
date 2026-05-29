/**
 * Content-addressed oracle cache — avoids re-generating oracles for problems
 * we've already seen. Uses SHA-256 of the problem text as the cache key.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const CACHE_PATH = join(import.meta.dirname ?? ".", "..", ".oracle-cache.json");

export interface CachedOracle {
  domain_name: string;
  invariants: string[];
  required_confidence: number;
  solution_format: string;
  oracle_js: string;
  cachedAt: string;
}

let _cache: Record<string, CachedOracle> | null = null;

function load(): Record<string, CachedOracle> {
  if (_cache) return _cache;
  try {
    if (existsSync(CACHE_PATH)) {
      _cache = JSON.parse(readFileSync(CACHE_PATH, "utf-8")) as Record<string, CachedOracle>;
      return _cache!;
    }
  } catch {
    // corrupt cache — start fresh
  }
  _cache = {};
  return _cache;
}

function save(): void {
  try {
    writeFileSync(CACHE_PATH, JSON.stringify(_cache, null, 2), "utf-8");
  } catch {
    // best-effort
  }
}

function hash(problem: string): string {
  return createHash("sha256").update(problem.trim()).digest("hex").slice(0, 16);
}

export function getCachedOracle(problem: string): CachedOracle | null {
  const key = hash(problem);
  return load()[key] ?? null;
}

export function putCachedOracle(problem: string, oracle: CachedOracle): void {
  const key = hash(problem);
  load()[key] = oracle;
  save();
}
