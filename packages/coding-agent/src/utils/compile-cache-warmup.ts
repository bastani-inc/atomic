/**
 * The compile-cache helper of an interactive session whose cache was cold (see `compile-cache.ts`). It owns no
 * session, settings or terminal: it loads the modules an interactive session and its engine load, writes Node's compile
 * cache for them and then marks the cache warm for this Atomic build. Its host starts it with `--no-addons`, so it maps
 * no native module, and outside the installation, so an upgrade or an uninstall never finds a file of it in use.
 *
 * Only one helper warms a build at a time: it holds the build's lock file open in exclusive sharing mode while it
 * runs, and the system closes that handle when the helper ends, however it ends. It ends without writing anything more
 * when its stdin ends (its session is gone) and when it runs out of time.
 *
 * Argument: the build id.
 */
import { closeSync, existsSync, constants as fsConstants, mkdirSync, openSync } from "node:fs";
import nodeModule from "node:module";
import { constants, setPriority } from "node:os";
import { dirname, join } from "node:path";
import { BUILTIN_PACKAGE_DIR_NAMES, INSTALLED_EXTENSION_ENTRIES } from "../core/builtin-install-layout.ts";
import { compileCacheBaseDir, currentCompileCacheWarmMarker } from "./compile-cache.ts";
import {
	COMPILE_CACHE_WARMUP_BUSY,
	COMPILE_CACHE_WARMUP_DONE,
	WINDOWS_EXCLUSIVE_OPEN_FLAG,
} from "./compile-cache-warmup-status.ts";

/** A helper that has not finished by then stops; the next session tries again. */
export const COMPILE_CACHE_WARMUP_TIME_LIMIT_MS = 5 * 60 * 1000;

/** Modules an interactive session and its engine load at startup, relative to this file; each brings its imports. */
const SESSION_MODULES = [
	"../main.js",
	"../core/http-dispatcher.js",
	"../cli/settings-startup.js",
	"../modes/interactive-engine/engine-prewarm.js",
	"../index.js",
	"highlight.js/lib/index.js",
	...BUILTIN_PACKAGE_DIR_NAMES.map((name) => `../builtin/${name}/${INSTALLED_EXTENSION_ENTRIES[name]}`),
];

/** End at once: a normal exit would write whatever the cache still holds. */
function stop(): never {
	process.kill(process.pid, "SIGKILL");
	process.exit(1);
}

/** Open the build's lock so that no other helper can until this one ends; false when another helper holds it. */
function holdBuildLock(buildId: string): boolean {
	const dir = compileCacheBaseDir();
	mkdirSync(dir, { recursive: true });
	try {
		// Kept open until this process ends.
		openSync(
			join(dir, `atomic-warmup-${buildId}.lock`),
			fsConstants.O_RDWR | fsConstants.O_CREAT | (process.platform === "win32" ? WINDOWS_EXCLUSIVE_OPEN_FLAG : 0),
		);
		return true;
	} catch {
		return false;
	}
}

async function warm(buildId: string): Promise<number> {
	const marker = currentCompileCacheWarmMarker(buildId);
	if (existsSync(marker)) return COMPILE_CACHE_WARMUP_DONE;
	if (!holdBuildLock(buildId)) return COMPILE_CACHE_WARMUP_BUSY;
	// Another helper may have finished between the first look and the lock.
	if (existsSync(marker)) return COMPILE_CACHE_WARMUP_DONE;
	try {
		setPriority(constants.priority.PRIORITY_BELOW_NORMAL);
	} catch {
		// Normal priority still leaves the session its own process.
	}
	const status = (nodeModule.enableCompileCache() as { status?: number }).status;
	if (status !== nodeModule.constants.compileCacheStatus.ENABLED) return 1;
	for (const specifier of SESSION_MODULES) {
		try {
			await import(specifier.startsWith(".") ? new URL(specifier, import.meta.url).href : specifier);
		} catch {
			// A module that cannot load here is compiled by the session that needs it.
		}
		nodeModule.flushCompileCache();
	}
	mkdirSync(dirname(marker), { recursive: true });
	closeSync(openSync(marker, "w"));
	return COMPILE_CACHE_WARMUP_DONE;
}

const buildId = process.argv[2];
if (!buildId) process.exit(1);
process.stdin.on("end", stop);
process.stdin.on("error", stop);
process.stdin.resume();
setTimeout(stop, COMPILE_CACHE_WARMUP_TIME_LIMIT_MS).unref();
warm(buildId).then(
	(code) => process.exit(code),
	() => process.exit(1),
);
