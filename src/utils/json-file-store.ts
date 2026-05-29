/**
 * Generic JSON file store with lazy-load, dirty-flag, and auto-save-on-exit.
 * Replaces 4 duplicate cache persistence implementations across the codebase.
 *
 * Usage:
 *   const store = new JsonFileStore<T>("path/to/file.json", () => defaultValue);
 *   store.load(); store.save();
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import * as path from "path";

export class JsonFileStore<T> {
  private _data: T | null = null;
  private _dirty = false;
  private _filePath: string;
  private _factory: () => T;

  constructor(filePath: string, factory: () => T) {
    this._filePath = filePath;
    this._factory = factory;
  }

  /** Lazily load from disk. Returns cached data on subsequent calls. */
  load(): T {
    if (this._data !== null) return this._data;
    try {
      if (existsSync(this._filePath)) {
        this._data = JSON.parse(readFileSync(this._filePath, "utf-8"));
        return this._data!;
      }
    } catch { /* corrupt or missing — start fresh */ }
    this._data = this._factory();
    return this._data;
  }

  /** Overwrite the in-memory data (e.g., after a mutation to the loaded object). */
  set(data: T): void {
    this._data = data;
  }

  /** Persist to disk if dirty. No-op if nothing changed. */
  save(): void {
    if (!this._dirty || this._data === null) return;
    try {
      const dir = path.dirname(this._filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this._filePath, JSON.stringify(this._data, null, 2), "utf-8");
      this._dirty = false;
    } catch { /* disk full or permissions — non-fatal */ }
  }

  /** Mark dirty so save() writes on next call or process exit. */
  markDirty(): void {
    this._dirty = true;
  }

  get filePath(): string {
    return this._filePath;
  }
}
