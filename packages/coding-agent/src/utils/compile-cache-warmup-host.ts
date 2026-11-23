/**
 * Starts the compile-cache helpers of an interactive session that left a cold cache alone (see `compile-cache.ts`).
 *
 * The helper for the engine's runtime flags runs first and the helper for this host's own flags last, so the host's
 * marker, which decides whether later sessions defer, is written only once both caches are warm. The session starts
 * the first helper; each helper starts the next one when it is done. A helper does not stop when its session ends: a
 * session that ends before its helpers do still leaves the cache warm. Each helper ends by itself when it is done and
 * after five minutes at most.
 */
import { spawn } from "node:child_process";
import { isAbsolute, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type { CompileCacheHelperRuntime } from "./compile-cache.ts";
import { processCompileCacheDeferral } from "./compile-cache-deferral.ts";
import {
	collectInstallProtectedDirs,
	DEFAULT_WINDOWS_CWD_TIMEOUT_MS,
	isAbsoluteWindowsPath,
	resolveSafeWindowsKillCwdLexical,
	resolveSafeWindowsWorkingDirectoryAsync,
	windowsDriveRoot,
} from "./windows-cwd.js";

/** What a helper does after its own cache: the helpers still to run, and the markers that must still stand. */
export interface CompileCacheWarmupPlan {
	/** Runtimes of the helpers to start after this one, in order. */
	readonly next: readonly CompileCacheHelperRuntime[];
	/** Markers of earlier helpers; this helper marks its cache warm only while they all exist. */
	readonly required: readonly string[];
}

export function encodeCompileCacheWarmupPlan(plan: CompileCacheWarmupPlan): string {
	return Buffer.from(JSON.stringify(plan), "utf8").toString("base64url");
}

export function decodeCompileCacheWarmupPlan(encoded: string | undefined): CompileCacheWarmupPlan {
	if (!encoded) return { next: [], required: [] };
	const plan = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as CompileCacheWarmupPlan;
	return { next: plan.next ?? [], required: plan.required ?? [] };
}

/** How a helper process starts: everything `spawn` gets. */
export interface CompileCacheHelperLaunch {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	/** Without a console: it reads and writes none, and never joins the session's console when that closes. */
	readonly detached: true;
}

function resolveWarmupScriptPath(script: string): string {
	if (process.platform === "win32") {
		if (isAbsoluteWindowsPath(script)) return script;
		try {
			return win32.resolve(process.cwd(), script);
		} catch {
			return script;
		}
	}
	return isAbsolute(script) ? script : resolve(script);
}

function resolveWarmupHelperCwd(resolvedScript: string): string {
	if (process.platform !== "win32") return "/";
	const scriptDir = win32.dirname(resolvedScript);
	return (
		resolveSafeWindowsKillCwdLexical({
			protectedDirs: collectInstallProtectedDirs(scriptDir),
			commandPath: process.execPath,
		}) ??
		windowsDriveRoot(scriptDir) ??
		"C:\\"
	);
}

/**
 * The helper for `runtime`: this runtime with its heap size and without preloads, loading no native module
 * (`--no-addons`), working outside the installation (an upgrade or an uninstall replaces it while the helper may run).
 */
export function compileCacheHelperLaunch(
	runtime: CompileCacheHelperRuntime,
	buildId: string,
	script: string = fileURLToPath(new URL("./compile-cache-warmup.js", import.meta.url)),
	env: NodeJS.ProcessEnv = process.env,
	plan: CompileCacheWarmupPlan = { next: [], required: [] },
): CompileCacheHelperLaunch {
	const helperEnv = { ...env };
	if (runtime.nodeOptions) helperEnv.NODE_OPTIONS = runtime.nodeOptions;
	else delete helperEnv.NODE_OPTIONS;
	const resolvedScript = resolveWarmupScriptPath(script);
	return {
		command: process.execPath,
		args: [...runtime.execArgv, "--no-addons", resolvedScript, buildId, encodeCompileCacheWarmupPlan(plan)],
		cwd: resolveWarmupHelperCwd(resolvedScript),
		env: helperEnv,
		detached: true,
	};
}

/** Start a helper that runs on its own: nothing of it keeps this process alive, and it outlives this process. */
export function startCompileCacheHelper(launch: CompileCacheHelperLaunch): boolean {
	const spawnWithCwd = (cwd: string, allowRetry: boolean): boolean => {
		try {
			const child = spawn(launch.command, [...launch.args], {
				cwd,
				env: launch.env,
				detached: launch.detached,
				stdio: "ignore",
				windowsHide: true,
			});
			child.on("error", (error: NodeJS.ErrnoException) => {
				if (allowRetry && process.platform === "win32" && error.code === "ENOENT") {
					const scriptArg = launch.args[launch.args.length - 3];
					const scriptDir = scriptArg ? win32.dirname(resolveWarmupScriptPath(scriptArg)) : undefined;
					void resolveSafeWindowsWorkingDirectoryAsync({
						installDirs: scriptDir ? [scriptDir] : undefined,
						commandPath: launch.command,
						timeoutMs: DEFAULT_WINDOWS_CWD_TIMEOUT_MS,
					})
						.then((freshCwd) => {
							if (freshCwd !== undefined && freshCwd.toLowerCase() !== cwd.toLowerCase()) {
								spawnWithCwd(freshCwd, false);
							}
						})
						.catch(() => {});
				}
			});
			child.unref();
			return true;
		} catch {
			return false;
		}
	};
	return spawnWithCwd(launch.cwd, true);
}

let warmupStarted = false;

/**
 * Helper runtimes to run in sequence: one when host and engine share a compile-cache tag (either identical flags, or
 * an auto-sized `--max-old-space-size=<N>` which Node 22 engines align back to the host's tag and Node 24 shares
 * natively), else engine first then host.
 */
export function compileCacheWarmupRuntimes(
	own: CompileCacheHelperRuntime,
	engineExecArgv: readonly string[],
): readonly CompileCacheHelperRuntime[] {
	const engine: CompileCacheHelperRuntime = { execArgv: engineExecArgv, nodeOptions: own.nodeOptions };
	const same =
		engine.execArgv.length === own.execArgv.length &&
		engine.execArgv.every((arg, index) => arg === own.execArgv[index]);
	if (same) return [own];
	// An auto-sized engine only adds `--max-old-space-size=<N>` when the host had no heap flag; both processes share
	// the host's tag (Node 22 via engine reset, Node 24 natively), so one host helper warms both (#6222).
	const heapFlag = /^--max[-_]old[-_]space[-_]size=\d+$/;
	const onlyAddedAutoHeap =
		own.execArgv.length === 0 &&
		!heapFlag.test(own.nodeOptions) &&
		engine.execArgv.length === 1 &&
		heapFlag.test(engine.execArgv[0]!);
	return onlyAddedAutoHeap ? [own] : [engine, own];
}

/**
 * Warm the cache this session left cold: first for the engine's runtime flags (`engineExecArgv`), then for this
 * process's own. Called once the session is on screen, and when it exits before that, so even a session that ends at
 * once leaves the cache warm; only the first call starts the helpers. A helper that finds another one warming this
 * build, or fails, ends the chain; the next session that finds the cache cold starts it again.
 */
export function warmCompileCache(engineExecArgv: readonly string[]): void {
	const deferral = processCompileCacheDeferral();
	if (!deferral?.helper || warmupStarted) return;
	warmupStarted = true;
	const [first, ...next] = compileCacheWarmupRuntimes(deferral.runtime, engineExecArgv);
	startCompileCacheHelper(
		compileCacheHelperLaunch(first!, deferral.buildId, undefined, undefined, { next, required: [] }),
	);
}
