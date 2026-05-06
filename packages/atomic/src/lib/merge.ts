/**
 * Utilities for merging JSON configuration files
 */

import { resolve, dirname } from "node:path";
import { ensureDir, pathExists, copyFile } from "@bastani/atomic-sdk/services/system/copy";

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripKeys(config: JsonObject, keys: readonly string[]): JsonObject {
  if (keys.length === 0) return config;
  const next: JsonObject = { ...config };
  for (const key of keys) delete next[key];
  return next;
}

/**
 * Deep-merge `src` into `dst` with user precedence: every conflict
 * resolves to the destination's existing value. New keys from `src`
 * are added; nested plain objects recurse so the user can customize
 * a single field of a nested entry without losing Atomic's other
 * defaults. Arrays and primitives are atomic — destination wins
 * outright; we never concat or splice.
 */
function deepMergeUserPrecedence(
  dst: JsonObject,
  src: JsonObject,
): JsonObject {
  const merged: JsonObject = { ...src, ...dst };
  for (const key of Object.keys(src)) {
    const dstValue = dst[key];
    const srcValue = src[key];
    if (isPlainObject(dstValue) && isPlainObject(srcValue)) {
      merged[key] = deepMergeUserPrecedence(dstValue, srcValue);
    }
  }
  return merged;
}

/**
 * Merge `srcPath` into `destPath` following the project's golden rule:
 * user (destination) values win on every conflict, except for keys
 * listed in `overwriteKeys` which Atomic forcibly replaces.
 *
 * - `excludeKeys`: stripped from the source before merging — destination
 *   keeps whatever value (if any) it already has.
 * - `overwriteKeys`: top-level keys for which Atomic's value replaces
 *   the destination's outright. Use sparingly — the default is
 *   user precedence.
 *
 * @param srcPath Path to source JSON file
 * @param destPath Path to destination JSON file (modified in place)
 * @param excludeKeys Top-level source keys to drop before merging
 * @param overwriteKeys Top-level source keys that overwrite destination
 */
export async function mergeJsonFile(
  srcPath: string,
  destPath: string,
  excludeKeys: readonly string[] = [],
  overwriteKeys: readonly string[] = [],
): Promise<void> {
  if (resolve(srcPath) === resolve(destPath)) {
    return;
  }

  const [rawSrc, dest] = await Promise.all([
    Bun.file(srcPath).json() as Promise<JsonObject>,
    Bun.file(destPath).json() as Promise<JsonObject>,
  ]);

  const src = stripKeys(rawSrc, excludeKeys);

  const overwrite = new Set(overwriteKeys);
  const userMergeable: JsonObject = {};
  const atomicOverrides: JsonObject = {};
  for (const [key, value] of Object.entries(src)) {
    if (overwrite.has(key)) atomicOverrides[key] = value;
    else userMergeable[key] = value;
  }

  const merged = deepMergeUserPrecedence(dest, userMergeable);
  for (const [key, value] of Object.entries(atomicOverrides)) {
    merged[key] = value;
  }

  await Bun.write(destPath, JSON.stringify(merged, null, 2) + "\n");
}

/**
 * Sync a JSON file from source to destination.
 *
 * - Creates the destination's parent directory if needed
 * - When the destination exists and `merge` is true (the default),
 *   merges via {@link mergeJsonFile} (user precedence by default;
 *   `overwriteKeys` opts specific keys into Atomic-wins behavior)
 * - Otherwise copies the source as-is
 * - `excludeKeys` drops top-level keys from the source before writing,
 *   so they never land in the destination (applies to both the merge
 *   and no-destination-yet code paths).
 *
 * This is the single entry-point for the merge-or-copy pattern used
 * by both project-level onboarding and global config sync.
 */
export async function syncJsonFile(
  srcPath: string,
  destPath: string,
  merge: boolean = true,
  excludeKeys: readonly string[] = [],
  overwriteKeys: readonly string[] = [],
): Promise<void> {
  await ensureDir(dirname(destPath));

  if (merge && (await pathExists(destPath))) {
    await mergeJsonFile(srcPath, destPath, excludeKeys, overwriteKeys);
    return;
  }

  if (excludeKeys.length === 0) {
    await copyFile(srcPath, destPath);
    return;
  }

  const srcConfig = (await Bun.file(srcPath).json()) as JsonObject;
  const stripped = stripKeys(srcConfig, excludeKeys);
  await Bun.write(destPath, JSON.stringify(stripped, null, 2) + "\n");
}
