/**
 * Best-effort wrappers around the runtime's on-disk compile cache. On Node >= 22.8
 * the cache persists compiled module bytecode across runs, which substantially
 * reduces module-graph load time on platforms with slow cold starts (Windows).
 * Bun implements the same calls and keeps its own bytecode for the modules it
 * loads afterwards. Older Node versions do not expose these APIs, so both
 * wrappers are silent no-ops there.
 */
import nodeModule from "node:module";
import { runtimeCacheDirectories } from "../config.js";

interface CompileCacheApi {
	enableCompileCache?: (directory?: string) => { status: number };
	flushCompileCache?: () => void;
}

const compileCacheApi: CompileCacheApi = nodeModule;

export function enablePersistentCompileCache(): void {
	try {
		if (!compileCacheApi.enableCompileCache || process.env.NODE_DISABLE_COMPILE_CACHE === "1") return;
		if (process.env.NODE_COMPILE_CACHE) {
			compileCacheApi.enableCompileCache(process.env.NODE_COMPILE_CACHE);
			return;
		}
		for (const dir of runtimeCacheDirectories("node")) {
			const result = compileCacheApi.enableCompileCache(dir);
			if (result?.status !== nodeModule.constants.compileCacheStatus.FAILED) return;
		}
		compileCacheApi.enableCompileCache();
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
