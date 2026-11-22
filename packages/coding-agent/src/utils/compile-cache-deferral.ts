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

const deferrals: Partial<
	Pick<
		typeof compileCache,
		| "compileCacheDeferral"
		| "COMPILE_CACHE_ENGINE_WARMUP_ENV"
		| "COMPILE_CACHE_ENGINE_MATCH_HOST_ENV"
		| "hostAutoSizedEngineHeap"
	>
> = compileCache;

/** The cache this process left cold for a helper, if any. */
export function processCompileCacheDeferral(): CompileCacheDeferral | undefined {
	return deferrals.compileCacheDeferral?.();
}

/** The environment an engine child gets when this process leaves its cold cache to a helper that warms the engine's too. */
export function engineCompileCacheWarmupEnv(): Record<string, string> {
	const name = deferrals.COMPILE_CACHE_ENGINE_WARMUP_ENV;
	return name !== undefined && processCompileCacheDeferral() ? { [name]: "1" } : {};
}

/**
 * The environment an auto-sized Node engine child gets so on Node 22 it aligns its compile-cache tag with the
 * untouched host (#6222). Omitted on Bun or when the host itself passed an explicit heap size.
 */
export function engineCompileCacheMatchHostEnv(engineRuntimeArgs: readonly string[]): Record<string, string> {
	if ("bun" in process.versions) return {};
	const name = deferrals.COMPILE_CACHE_ENGINE_MATCH_HOST_ENV;
	const check = deferrals.hostAutoSizedEngineHeap;
	if (name === undefined || check === undefined) return {};
	return check(process.execArgv, process.env.NODE_OPTIONS, engineRuntimeArgs) ? { [name]: "1" } : {};
}
