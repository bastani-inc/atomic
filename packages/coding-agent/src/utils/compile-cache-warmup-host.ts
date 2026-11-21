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
import { parse } from "node:path";
import { fileURLToPath } from "node:url";
import { type CompileCacheHelperRuntime, compileCacheDeferral } from "./compile-cache.ts";

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
	return {
		command: process.execPath,
		args: [...runtime.execArgv, "--no-addons", script, buildId, encodeCompileCacheWarmupPlan(plan)],
		cwd: parse(script).root,
		env: helperEnv,
		detached: true,
	};
}

/** Start a helper that runs on its own: nothing of it keeps this process alive, and it outlives this process. */
export function startCompileCacheHelper(launch: CompileCacheHelperLaunch): boolean {
	try {
		const child = spawn(launch.command, [...launch.args], {
			cwd: launch.cwd,
			env: launch.env,
			detached: launch.detached,
			stdio: "ignore",
			windowsHide: true,
		});
		child.on("error", () => {});
		child.unref();
		return true;
	} catch {
		return false;
	}
}

let warmupStarted = false;

/**
 * Warm the cache this session left cold: first for the engine's runtime flags (`engineExecArgv`), then for this
 * process's own. Called once the session is on screen, and when it exits before that, so even a session that ends at
 * once leaves the cache warm; only the first call starts the helpers. A helper that finds another one warming this
 * build, or fails, ends the chain; the next session that finds the cache cold starts it again.
 */
export function warmCompileCache(engineExecArgv: readonly string[]): void {
	const deferral = compileCacheDeferral();
	if (!deferral || warmupStarted) return;
	warmupStarted = true;
	const own = deferral.runtime;
	const engine = { execArgv: engineExecArgv, nodeOptions: own.nodeOptions };
	const same =
		engine.execArgv.length === own.execArgv.length &&
		engine.execArgv.every((arg, index) => arg === own.execArgv[index]);
	const [first, ...next] = same ? [own] : [engine, own];
	startCompileCacheHelper(
		compileCacheHelperLaunch(first!, deferral.buildId, undefined, undefined, { next, required: [] }),
	);
}
