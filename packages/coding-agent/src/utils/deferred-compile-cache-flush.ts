import { flushPersistentCompileCache } from "./compile-cache.ts";

const DEFERRED_HOST_CACHE_FLUSH_KEY = Symbol.for("@bastani/atomic/deferred-host-compile-cache-flush");
const state = globalThis as typeof globalThis & { [DEFERRED_HOST_CACHE_FLUSH_KEY]?: boolean };

/**
 * Record that this interactive host adopted a prewarmed engine with derived startup environment whose compile cache
 * should be flushed once startup settles (or after an early prompt is handed to the engine) rather than blocking
 * engine handover synchronously.
 */
export function armDeferredHostCompileCacheFlush(): void {
	state[DEFERRED_HOST_CACHE_FLUSH_KEY] = true;
}

/** Whether a deferred host compile-cache flush is currently pending. */
export function hasDeferredHostCompileCacheFlush(): boolean {
	return state[DEFERRED_HOST_CACHE_FLUSH_KEY] === true;
}

/**
 * Flush this host's compile cache once if a derived prewarm adoption deferred it. Subsequent calls are no-ops until
 * armed again. Returns true when a deferred flush ran.
 */
export function flushDeferredHostCompileCache(flush: () => void = flushPersistentCompileCache): boolean {
	if (!state[DEFERRED_HOST_CACHE_FLUSH_KEY]) return false;
	state[DEFERRED_HOST_CACHE_FLUSH_KEY] = false;
	flush();
	return true;
}
