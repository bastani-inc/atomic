/**
 * Best-effort wrappers around the runtime's on-disk compile cache. On Node >= 22.8
 * the cache persists compiled module bytecode across runs, which substantially
 * reduces module-graph load time on platforms with slow cold starts (Windows).
 * Bun implements the same calls and keeps its own bytecode for the modules it
 * loads afterwards. Older Node versions do not expose these APIs, so both
 * wrappers are silent no-ops there.
 *
 * Node writes one cache file per compiled module when the process exits, and an
 * interactive session compiles a few thousand modules. While the cache is warm
 * that write is empty; on the first run after an install or an upgrade it covers
 * the whole module graph, which takes seconds on Windows after the session has
 * ended (#6132). On Windows an interactive session therefore leaves a cold cache
 * alone: it runs without it (after an install there is nothing to read; after an
 * upgrade it gives up the entries of files the upgrade left unchanged), and a
 * helper process that owns nothing else loads the same modules and writes the
 * cache (`compile-cache-warmup-host.ts`), finishing after the session if the
 * session ends first. The helper marks the cache warm for this Atomic build when
 * it is done, and later sessions use the cache as before. Elsewhere the exit-time write takes a fraction of a second and
 * the cache works as it always did.
 */
import { existsSync } from "node:fs";
import nodeModule from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachedDataVersionTag, setFlagsFromString } from "node:v8";
import { splitNodeOptions } from "@bastani/atomic-codemode/node-options";

interface CompileCacheApi {
	enableCompileCache?: () => unknown;
	flushCompileCache?: () => void;
	getCompileCacheDir?: () => string | undefined;
}

const compileCacheApi: CompileCacheApi = nodeModule;

/** Set by a host that warms its engine's cache, so the engine leaves a cold cache to that helper too. */
export const COMPILE_CACHE_ENGINE_WARMUP_ENV = "ATOMIC_INTERNAL_COMPILE_CACHE_WARMUP";

/** What decides how a process starts with the compile cache. */
export interface CompileCacheStartInput {
	readonly platform: NodeJS.Platform;
	/** Bun keeps its own cache: nothing here applies. */
	readonly runtimeIsBun: boolean;
	/** This Node has no compile cache API. */
	readonly unsupported: boolean;
	/** The runtime enabled the cache before Atomic ran (NODE_COMPILE_CACHE). */
	readonly alreadyEnabled: boolean;
	/** NODE_DISABLE_COMPILE_CACHE is present, whatever its value: Node never enables the cache. */
	readonly disabled: boolean;
	/** An interactive session, or the engine of one whose host warms the engine's cache. */
	readonly interactive: boolean;
	/** Runtime flags and environment a helper can repeat; see `compileCacheHelperRuntime`. */
	readonly helperRuntime: boolean;
	/** Reads the marker a helper leaves when it has written the cache for this build, runtime and flags. */
	readonly warm: () => boolean;
}

/**
 * `defer`: run without the cache now and let a helper write it. `enable`: use it as before. Only an interactive
 * process on Windows whose cache is cold for this build defers. The marker is read last, after every cheaper reason to
 * keep the cache as it was.
 */
export function compileCacheStartMode(input: CompileCacheStartInput): "enable" | "defer" {
	if (input.platform !== "win32" || input.runtimeIsBun || input.unsupported) return "enable";
	if (input.alreadyEnabled || input.disabled || !input.interactive || !input.helperRuntime) return "enable";
	return input.warm() ? "enable" : "defer";
}

/** Whether a session that left its cold cache alone starts a helper to write it: never under CI. */
export function startsCompileCacheHelper(env: NodeJS.ProcessEnv): boolean {
	return !isCiValue(env.CI);
}

/** Whether `CI` names a CI run, as the fullscreen TUI reads it: any value but empty, `0` and `false`. */
export function isCiValue(value: string | undefined): boolean {
	if (value === undefined) return false;
	const normalized = value.trim().toLowerCase();
	return normalized !== "" && normalized !== "0" && normalized !== "false";
}

/** The only runtime flag a helper keeps: the heap size, which the engine gets from its host. */
const HEAP_SIZE_FLAG = /^--max[-_]old[-_]space[-_]size=\d+$/;
/** Heap size option names recognized on Node's command line (mirroring `engine-heap.ts`). */
const HEAP_SIZE_OPTION_NAMES: ReadonlySet<string> = new Set([
	"--max-old-space-size",
	"--max-old-space-size-percentage",
	"--max-heap-size",
]);
/** V8 heap size option names that Node also forwards with a single leading dash. */
const V8_HEAP_SIZE_OPTION_NAMES: ReadonlySet<string> = new Set(["--max-old-space-size", "--max-heap-size"]);
/** Flags that load user code before Atomic does. A helper drops them with their values. */
const PRELOAD_FLAGS = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader"]);

/** What decides whether the host aligns its V8 heap flag with the engine before enabling the compile cache. */
export interface CompileCacheHeapAlignmentInput {
	readonly runtimeIsBun: boolean;
	readonly unsupported: boolean;
	readonly alreadyEnabled: boolean;
	readonly disabled: boolean;
	readonly execArgv: readonly string[];
	readonly targetEngineHeapArgs: readonly string[];
}

function execArgvSetsHeapSize(execArgv: readonly string[]): boolean {
	for (const flag of execArgv) {
		if (flag === "--") break;
		if (!flag.startsWith("-")) continue;
		const dashes = flag.startsWith("--") ? 2 : 1;
		const equals = flag.indexOf("=");
		const name = `--${(equals === -1 ? flag : flag.slice(0, equals)).slice(dashes).replaceAll("_", "-")}`;
		if (!HEAP_SIZE_OPTION_NAMES.has(name)) continue;
		if (dashes === 1 && !V8_HEAP_SIZE_OPTION_NAMES.has(name)) continue;
		return true;
	}
	return false;
}

/**
 * The `--max-old-space-size=<N>` flag the host should adopt via `v8.setFlagsFromString` before enabling the compile
 * cache so host, engine and the Windows warmup helper share one cache tag and directory on Node 22 and one helper on
 * Windows (#6222). Returns `undefined` when the cache is already enabled (`NODE_COMPILE_CACHE`), disabled, unsupported,
 * running under Bun, or when the host command line already sets a heap size.
 */
export function compileCacheSharedHeapFlag(input: CompileCacheHeapAlignmentInput): string | undefined {
	if (input.runtimeIsBun || input.unsupported || input.alreadyEnabled || input.disabled) return undefined;
	if (execArgvSetsHeapSize(input.execArgv)) return undefined;
	const added = input.targetEngineHeapArgs.filter(
		(flag) => HEAP_SIZE_FLAG.test(flag) && !input.execArgv.includes(flag),
	);
	return added.length === 1 ? added[0] : undefined;
}

/** Runtime flags and `NODE_OPTIONS` for a helper, or undefined when these cannot be repeated without side effects. */
export interface CompileCacheHelperRuntime {
	readonly execArgv: readonly string[];
	readonly nodeOptions: string;
}

function keptFlags(flags: readonly string[]): string[] | undefined {
	const kept: string[] = [];
	for (let index = 0; index < flags.length; index++) {
		const flag = flags[index]!;
		if (HEAP_SIZE_FLAG.test(flag)) {
			kept.push(flag);
			continue;
		}
		const name = flag.includes("=") ? flag.slice(0, flag.indexOf("=")) : flag;
		if (!PRELOAD_FLAGS.has(name)) return undefined;
		if (!flag.includes("=")) index++;
	}
	return kept;
}

/**
 * The runtime a helper repeats: this process's heap size (including any engine heap flag adopted before enabling the
 * compile cache), without the preloads (`--require`, `--import`, loaders) that would run user code a second time.
 * Anything else on the command line or in `NODE_OPTIONS` (an inspector, a profiler, coverage, other V8 flags that
 * would give the helper a different cache), and a `NODE_OPTIONS` value Node refuses, with which a helper would not
 * start, leaves the cache as it always was.
 */
export function compileCacheHelperRuntime(
	execArgv: readonly string[],
	env: NodeJS.ProcessEnv,
	adoptedExecArgv: readonly string[] = [],
): CompileCacheHelperRuntime | undefined {
	if (env.NODE_V8_COVERAGE !== undefined) return undefined;
	const words = splitNodeOptions(env.NODE_OPTIONS ?? "");
	if (!words) return undefined;
	const command = keptFlags(execArgv);
	const options = keptFlags(words);
	if (!command || !options) return undefined;
	if (!adoptedExecArgv.every((flag) => HEAP_SIZE_FLAG.test(flag))) return undefined;
	return { execArgv: [...command, ...adoptedExecArgv], nodeOptions: options.join(" ") };
}

/** FNV-1a: a short, stable name for this Atomic build, without loading a hash library at startup. */
export function compileCacheBuildId(build: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < build.length; index++) {
		hash ^= build.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

/** Node's own default when the cache is enabled without a directory. */
export function compileCacheBaseDir(): string {
	return join(tmpdir(), "node-compile-cache");
}

/**
 * The marker for a build in the cache directory Node uses for this runtime version and these runtime flags. Node
 * names that directory after its version, architecture and V8's cache tag (which changes with flags such as the
 * engine's heap size on Node 22), plus the user id on POSIX, so each flag set has its own marker.
 */
export function compileCacheWarmMarker(options: {
	readonly baseDir: string;
	readonly nodeVersion: string;
	readonly arch: string;
	readonly versionTag: number;
	readonly uid: number | undefined;
	readonly buildId: string;
}): string {
	const tag = `${options.nodeVersion}-${options.arch}-${(options.versionTag >>> 0).toString(16).padStart(8, "0")}${
		options.uid === undefined ? "" : `-${options.uid}`
	}`;
	return join(options.baseDir, tag, `atomic-warm-${options.buildId}`);
}

/** This process's marker for a build. */
export function currentCompileCacheWarmMarker(buildId: string): string {
	return compileCacheWarmMarker({
		baseDir: compileCacheBaseDir(),
		nodeVersion: process.version,
		arch: process.arch,
		versionTag: cachedDataVersionTag(),
		uid: typeof process.getuid === "function" ? process.getuid() : undefined,
		buildId,
	});
}

/** A process that left its cold cache alone: the build, how a helper repeats this runtime, and whether one starts. */
export interface CompileCacheDeferral {
	readonly buildId: string;
	readonly runtime: CompileCacheHelperRuntime;
	/** False under CI: the session still quits without writing the cache, and nothing warms it. */
	readonly helper: boolean;
}

let deferral: CompileCacheDeferral | undefined;

/**
 * Enable the compile cache for this process. When `sharedHeapFlags` names the engine's `--max-old-space-size=<N>`
 * flag and the cache is not already enabled or disabled, the host adopts that V8 flag before enabling the cache so
 * host and engine share one V8 compile-cache tag and directory (#6222). An `interactive` process on Windows whose
 * cache is cold for `build` runs without it instead, and its host starts a helper that writes it.
 */
export function enablePersistentCompileCache(
	options: { interactive?: boolean; build?: string; sharedHeapFlags?: readonly string[] } = {},
): void {
	try {
		const runtimeIsBun = "bun" in process.versions;
		const unsupported = typeof compileCacheApi.enableCompileCache !== "function";
		const alreadyEnabled = compileCacheApi.getCompileCacheDir?.() !== undefined;
		const disabled = process.env.NODE_DISABLE_COMPILE_CACHE !== undefined;
		const adoptedFlag = compileCacheSharedHeapFlag({
			runtimeIsBun,
			unsupported,
			alreadyEnabled,
			disabled,
			execArgv: process.execArgv,
			targetEngineHeapArgs: options.sharedHeapFlags ?? [],
		});
		let adoptedExecArgv: string[] = [];
		if (adoptedFlag !== undefined) {
			try {
				setFlagsFromString(adoptedFlag);
				adoptedExecArgv = [adoptedFlag];
			} catch {
				// Best effort: keep the runtime's existing flags if V8 rejects the flag.
			}
		}
		const runtime = compileCacheHelperRuntime(process.execArgv, process.env, adoptedExecArgv);
		const buildId = compileCacheBuildId(`${import.meta.url}\0${options.build ?? ""}`);
		const mode = compileCacheStartMode({
			platform: process.platform,
			runtimeIsBun,
			unsupported,
			alreadyEnabled,
			disabled,
			interactive: options.interactive === true && options.build !== undefined,
			helperRuntime: runtime !== undefined,
			warm: () => existsSync(currentCompileCacheWarmMarker(buildId)),
		});
		if (mode === "defer" && runtime) {
			deferral = { buildId, runtime, helper: startsCompileCacheHelper(process.env) };
			return;
		}
		compileCacheApi.enableCompileCache?.();
	} catch {
		// Best effort: an unwritable cache directory must never break startup.
	}
}

/** The cache this process left cold for a helper, if any. */
export function compileCacheDeferral(): CompileCacheDeferral | undefined {
	return deferral;
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
