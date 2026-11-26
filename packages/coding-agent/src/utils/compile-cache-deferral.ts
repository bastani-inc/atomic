/**
 * This process's compile-cache deferral (see `compile-cache.ts`), for the modules that load after the process's entry.
 *
 * `compile-cache.ts` loads with the entry (`cli.ts`), so a process that started before an update replaced the
 * installation keeps the copy it started with while it loads later modules from the update. 0.10.3's copy has neither
 * a deferral nor the engine warmup variable, and a named import of either would fail to link there; read through here,
 * such a process is one that never deferred its cache, which it is.
 */

import type { CompileCacheDeferral } from "./compile-cache.ts";
import * as compileCache from "./compile-cache.ts";

const deferrals: Partial<Pick<typeof compileCache, "compileCacheDeferral" | "COMPILE_CACHE_ENGINE_WARMUP_ENV">> =
	compileCache;

/** The cache this process left cold for a helper, if any. */
export function processCompileCacheDeferral(): CompileCacheDeferral | undefined {
	return deferrals.compileCacheDeferral?.();
}

/**
 * Gives an engine child no environment. Node.js 22 engines needed it to align their compile-cache tag with their host's
 * (#6222); still exported because a process of 0.10.4 that an in-place update caught imports it from this module's
 * shared file.
 */
export function engineCompileCacheMatchHostEnv(_engineRuntimeArgs: readonly string[]): Record<string, string> {
	return {};
}

/** The environment an engine child gets when this process leaves its cold cache to a helper that warms the engine's too. */
export function engineCompileCacheWarmupEnv(): Record<string, string> {
	const name = deferrals.COMPILE_CACHE_ENGINE_WARMUP_ENV;
	return name !== undefined && processCompileCacheDeferral() ? { [name]: "1" } : {};
}
