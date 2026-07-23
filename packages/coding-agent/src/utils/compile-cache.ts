/**
 * Best-effort wrappers around Node's on-disk V8 compile cache. On Node >= 22.8
 * the cache persists compiled module bytecode across runs, which substantially
 * reduces module-graph load time on platforms with slow cold starts (Windows).
 * Bun and older Node versions do not expose these APIs, so both wrappers are
 * silent no-ops there.
 */
import nodeModule from "node:module";

interface CompileCacheApi {
	enableCompileCache?: () => unknown;
	flushCompileCache?: () => void;
}

const compileCacheApi: CompileCacheApi = nodeModule;

export function enablePersistentCompileCache(): void {
	try {
		compileCacheApi.enableCompileCache?.();
	} catch {
		// Best effort: an unwritable cache directory must never break startup.
	}
}

/**
 * Persist the compile cache accumulated so far. Called before spawning the
 * interactive engine child so the child's load of the same module graph hits
 * the cache even on the very first run after an install.
 */
export function flushPersistentCompileCache(): void {
	try {
		compileCacheApi.flushCompileCache?.();
	} catch {
		// Best effort.
	}
}
