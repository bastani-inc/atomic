/**
 * Starts the compile-cache helper of an interactive session that left a cold cache alone (see `compile-cache.ts`).
 *
 * The helper for the engine's runtime flags runs first and the helper for this host's own flags last, so the host's
 * marker, which decides whether later sessions defer, is written only once both caches are warm. Each helper ends
 * with this session: it is stopped when the session exits, and the system ends it when the session ends any other way
 * (it runs in a job that is closed with the session). Where that job cannot be made, it stops by itself once its stdin
 * ends, after the step it is in.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { parse } from "node:path";
import { fileURLToPath } from "node:url";
import { containProcessTree } from "../core/process-tree-containment.ts";
import { type CompileCacheHelperRuntime, compileCacheDeferral } from "./compile-cache.ts";
import { COMPILE_CACHE_WARMUP_DONE } from "./compile-cache-warmup-status.ts";

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
): CompileCacheHelperLaunch {
	const helperEnv = { ...env };
	if (runtime.nodeOptions) helperEnv.NODE_OPTIONS = runtime.nodeOptions;
	else delete helperEnv.NODE_OPTIONS;
	return {
		command: process.execPath,
		args: [...runtime.execArgv, "--no-addons", script, buildId],
		cwd: parse(script).root,
		env: helperEnv,
		detached: true,
	};
}

/** Run one helper to its end. True when the cache for its runtime flags is warm. */
function runHelper(runtime: CompileCacheHelperRuntime, buildId: string): Promise<boolean> {
	let child: ChildProcess;
	try {
		const launch = compileCacheHelperLaunch(runtime, buildId);
		child = spawn(launch.command, [...launch.args], {
			cwd: launch.cwd,
			env: launch.env,
			detached: launch.detached,
			// The helper stops when this pipe ends, which it does when this process is gone.
			stdio: ["pipe", "ignore", "ignore"],
			windowsHide: true,
		});
	} catch {
		return Promise.resolve(false);
	}
	// The system ends the helper when this process ends, however it ends.
	const containment = child.pid === undefined ? undefined : containProcessTree(child.pid);
	const stopAtExit = () => {
		try {
			child.kill("SIGKILL");
		} catch {
			// Already gone.
		}
	};
	process.once("exit", stopAtExit);
	child.stdin?.on("error", () => {});
	child.unref();
	(child.stdin as { unref?: () => void } | null)?.unref?.();
	return new Promise((resolve) => {
		child.once("error", () => {
			process.off("exit", stopAtExit);
			containment?.close();
			resolve(false);
		});
		child.once("exit", (code) => {
			process.off("exit", stopAtExit);
			containment?.close();
			resolve(code === COMPILE_CACHE_WARMUP_DONE);
		});
	});
}

/**
 * Warm the cache this session left cold: first for the engine's runtime flags (`engineExecArgv`), then for this
 * process's own. A helper that finds another one warming this build, fails or is stopped ends the warmup; the next
 * session that finds the cache cold tries once more.
 */
export async function warmCompileCache(engineExecArgv: readonly string[]): Promise<void> {
	const deferral = compileCacheDeferral();
	if (!deferral) return;
	const own = deferral.runtime;
	const engine = { execArgv: engineExecArgv, nodeOptions: own.nodeOptions };
	const same =
		engine.execArgv.length === own.execArgv.length &&
		engine.execArgv.every((arg, index) => arg === own.execArgv[index]);
	for (const runtime of same ? [own] : [engine, own]) {
		if (!(await runHelper(runtime, deferral.buildId))) return;
	}
}
