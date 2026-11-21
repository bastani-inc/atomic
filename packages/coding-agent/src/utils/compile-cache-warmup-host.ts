/**
 * Starts the compile-cache helper of an interactive session that left a cold cache alone (see `compile-cache.ts`).
 *
 * The helper for the engine's runtime flags runs first and the helper for this host's own flags last, so the host's
 * marker, which decides whether later sessions defer, is written only once both caches are warm. Each helper ends
 * with this session: it is stopped when the session exits, and stops by itself when the session is gone.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { parse } from "node:path";
import { fileURLToPath } from "node:url";
import { type CompileCacheHelperRuntime, compileCacheDeferral } from "./compile-cache.ts";
import { COMPILE_CACHE_WARMUP_DONE } from "./compile-cache-warmup-status.ts";

function helperEnvironment(runtime: CompileCacheHelperRuntime): NodeJS.ProcessEnv {
	const env = { ...process.env };
	if (runtime.nodeOptions) env.NODE_OPTIONS = runtime.nodeOptions;
	else delete env.NODE_OPTIONS;
	return env;
}

/** Run one helper to its end. True when the cache for its runtime flags is warm. */
function runHelper(runtime: CompileCacheHelperRuntime, buildId: string): Promise<boolean> {
	const script = fileURLToPath(new URL("./compile-cache-warmup.js", import.meta.url));
	let child: ChildProcess;
	try {
		child = spawn(process.execPath, [...runtime.execArgv, "--no-addons", script, buildId], {
			// Outside the installation, which an upgrade replaces while the helper may still run.
			cwd: parse(script).root,
			env: helperEnvironment(runtime),
			// The helper stops when this pipe ends, which it does when this process is gone.
			stdio: ["pipe", "ignore", "ignore"],
			windowsHide: true,
		});
	} catch {
		return Promise.resolve(false);
	}
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
			resolve(false);
		});
		child.once("exit", (code) => {
			process.off("exit", stopAtExit);
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
