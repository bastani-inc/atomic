/**
 * The compile-cache helper of an interactive session whose cache was cold (see `compile-cache.ts`). It owns no
 * session, settings or terminal: it loads the modules an interactive session and its engine load, writes Node's compile
 * cache for them and then marks the cache warm for this Atomic build. Its host starts it with `--no-addons`, so it maps
 * no native module, and outside the installation, so an upgrade or an uninstall never finds a file of it in use.
 *
 * Only one helper warms a build at a time: it holds the build's lock file open in exclusive sharing mode while it
 * runs, and the system closes that handle when the helper ends, however it ends. It does not stop with its session;
 * it ends when it is done, starting the next helper of its plan first, and after five minutes at most, without writing
 * anything more.
 *
 * Arguments: the build id and the plan (`compile-cache-warmup-host.ts`).
 */
import { closeSync, existsSync, constants as fsConstants, mkdirSync, openSync } from "node:fs";
import nodeModule from "node:module";
import { constants, setPriority } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_PACKAGE_DIR_NAMES, INSTALLED_EXTENSION_ENTRIES } from "../core/builtin-install-layout.ts";
import { compileCacheBaseDir, currentCompileCacheWarmMarker } from "./compile-cache.ts";
import {
	type CompileCacheWarmupPlan,
	compileCacheHelperLaunch,
	decodeCompileCacheWarmupPlan,
	startCompileCacheHelper,
} from "./compile-cache-warmup-host.ts";
import {
	COMPILE_CACHE_WARMUP_BUSY,
	COMPILE_CACHE_WARMUP_DONE,
	WINDOWS_EXCLUSIVE_OPEN_FLAG,
} from "./compile-cache-warmup-status.ts";

/** A helper that has not finished by then stops; the next session tries again. */
export const COMPILE_CACHE_WARMUP_TIME_LIMIT_MS = 5 * 60 * 1000;

/**
 * Modules an interactive session and its engine load at startup, relative to this file; each brings its imports. The
 * cache is marked warm only when every one of these loaded: one that is missing means the installation changed under
 * the helper.
 */
const SESSION_MODULES = [
	"../main.js",
	"../core/http-dispatcher.js",
	"../cli/settings-startup.js",
	"../modes/interactive-engine/engine-prewarm.js",
	"../index.js",
];
/** Modules a session loads later; one that cannot load without native modules is compiled by the session instead. */
const LATER_MODULES = [
	"highlight.js/lib/index.js",
	...BUILTIN_PACKAGE_DIR_NAMES.map((name) => `../builtin/${name}/${INSTALLED_EXTENSION_ENTRIES[name]}`),
];

async function load(specifier: string): Promise<boolean> {
	try {
		await import(specifier.startsWith(".") ? new URL(specifier, import.meta.url).href : specifier);
		return true;
	} catch {
		return false;
	} finally {
		nodeModule.flushCompileCache();
	}
}

/** End at once: a normal exit would write whatever the cache still holds. */
function stop(): never {
	process.kill(process.pid, "SIGKILL");
	process.exit(1);
}

/**
 * Open the build's lock so that no other helper can until this one closes it or ends; undefined when another helper
 * holds it.
 */
function holdBuildLock(buildId: string): number | undefined {
	const dir = compileCacheBaseDir();
	mkdirSync(dir, { recursive: true });
	try {
		return openSync(
			join(dir, `atomic-warmup-${buildId}.lock`),
			fsConstants.O_RDWR | fsConstants.O_CREAT | (process.platform === "win32" ? WINDOWS_EXCLUSIVE_OPEN_FLAG : 0),
		);
	} catch {
		return undefined;
	}
}

let lock: number | undefined;

async function warm(buildId: string, plan: CompileCacheWarmupPlan, marker: string): Promise<number> {
	if (existsSync(marker)) return COMPILE_CACHE_WARMUP_DONE;
	lock = holdBuildLock(buildId);
	if (lock === undefined) return COMPILE_CACHE_WARMUP_BUSY;
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
		if (!(await load(specifier))) return 1;
	}
	for (const specifier of LATER_MODULES) await load(specifier);
	// An earlier helper's cache that is gone again (a cleanup of the temporary directory) leaves this one unmarked.
	if (!plan.required.every((earlier) => existsSync(earlier))) return 1;
	mkdirSync(dirname(marker), { recursive: true });
	closeSync(openSync(marker, "w"));
	return COMPILE_CACHE_WARMUP_DONE;
}

/** Hand over to the next helper of the plan: release the lock, then start it. */
function startNext(buildId: string, plan: CompileCacheWarmupPlan, marker: string): void {
	const [next, ...rest] = plan.next;
	if (!next) return;
	if (lock !== undefined) closeSync(lock);
	const script = fileURLToPath(import.meta.url);
	startCompileCacheHelper(
		compileCacheHelperLaunch(next, buildId, script, process.env, {
			next: rest,
			required: [...plan.required, marker],
		}),
	);
}

const [buildId, encodedPlan] = process.argv.slice(2);
if (!buildId) process.exit(1);
setTimeout(stop, COMPILE_CACHE_WARMUP_TIME_LIMIT_MS).unref();
const plan = decodeCompileCacheWarmupPlan(encodedPlan);
const marker = currentCompileCacheWarmMarker(buildId);
warm(buildId, plan, marker).then(
	(code) => {
		if (code === COMPILE_CACHE_WARMUP_DONE) startNext(buildId, plan, marker);
		process.exit(code);
	},
	() => process.exit(1),
);
