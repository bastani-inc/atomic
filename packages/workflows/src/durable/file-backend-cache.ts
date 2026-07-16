/**
 * Stat-gated parse cache for durable workflow state files.
 *
 * Pure-read paths in the file backend used to re-read and re-parse every
 * state file on each call (up to 4 reads per file per listing), which made
 * `/workflow resume` and `session_start` scale with total workflow history.
 * Writes are atomic tmp-file + rename (see file-lock.ts), so a parsed state
 * keyed by `(path, mtimeMs, size)` stays valid until the file is replaced —
 * readers can skip both the read and the parse when the stat is unchanged.
 *
 * The cache is advisory: any stat mismatch falls through to a fresh read, and
 * writers invalidate their own path after each atomic replace/remove.
 */

import { statSync } from "node:fs";
import { readDurableFileState, type FileStateReadResult } from "./file-state.js";

interface DurableStateCacheEntry {
  readonly mtimeMs: number;
  readonly size: number;
  readonly result: FileStateReadResult;
}

/** Bounded LRU so a large durable directory cannot pin every parsed state in heap. */
const MAX_CACHED_STATES = 512;

const cache = new Map<string, DurableStateCacheEntry>();

const MISSING: FileStateReadResult = { kind: "missing" };

/**
 * Read a durable state file through the stat-gated cache. Returns the cached
 * parse when `(mtimeMs, size)` is unchanged; otherwise re-reads from disk.
 */
export function readDurableFileStateCached(filePath: string): FileStateReadResult {
  let mtimeMs: number;
  let size: number;
  try {
    const stat = statSync(filePath);
    mtimeMs = stat.mtimeMs;
    size = stat.size;
  } catch {
    cache.delete(filePath);
    return MISSING;
  }
  const cached = cache.get(filePath);
  if (cached !== undefined && cached.mtimeMs === mtimeMs && cached.size === size) {
    // Refresh LRU recency.
    cache.delete(filePath);
    cache.set(filePath, cached);
    return cached.result;
  }
  const result = readDurableFileState(filePath);
  cache.delete(filePath);
  cache.set(filePath, { mtimeMs, size, result });
  if (cache.size > MAX_CACHED_STATES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return result;
}

/** Drop one cached path (writers call this after replacing/removing a file). */
export function invalidateDurableFileStateCache(filePath?: string): void {
  if (filePath === undefined) cache.clear();
  else cache.delete(filePath);
}
