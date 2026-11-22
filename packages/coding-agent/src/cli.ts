#!/usr/bin/env node
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: bun src/cli.ts [args...]
 *
 * Deliberately keeps the static entry graph to config, compile-cache support,
 * attribution, and the disabled-by-default lifecycle seam. The full CLI graph
 * loads dynamically so metadata fast paths (for example `--version`) skip it.
 */
import { APP_NAME, getPackageDir, VERSION } from "./config.js";
import { installLifecycleTraceFromEnv, markLifecycleTiming } from "./core/lifecycle-timings.ts";
import { engineHeapRuntimeArgsForHost } from "./modes/interactive-engine/engine-heap.ts";
import { ATOMIC_AI_AGENT } from "./utils/agent-attribution.ts";
import {
	COMPILE_CACHE_ENGINE_MATCH_HOST_ENV,
	COMPILE_CACHE_ENGINE_WARMUP_ENV,
	compileCacheDeferral,
	enablePersistentCompileCache,
	flushPersistentCompileCache,
} from "./utils/compile-cache.ts";
import { warmCompileCache } from "./utils/compile-cache-warmup-host.ts";
import { headlessHeapRelaunchArgs, isHeadlessInvocation, relaunchWithHeap } from "./utils/heap-relaunch.ts";
import { noteInheritedHangup } from "./utils/inherited-hangup.js";
import {
	hasInteractiveEngineBootstrapArg,
	INTERACTIVE_ENGINE_PREWARM_FLAG,
} from "./utils/interactive-engine-bootstrap.ts";
import { isPlainInteractiveSessionInvocation } from "./utils/interactive-invocation.ts";
import { shouldStartSpareDatabaseThread } from "./utils/startup-database-spare.ts";
import { startStartupPrefetch } from "./utils/startup-prefetch.js";
import { updatedInstallError } from "./utils/updated-install.ts";

installLifecycleTraceFromEnv();
markLifecycleTiming("process-entry");

const args = process.argv.slice(2);
// A prewarmed engine child loads the application now and learns its arguments from its host afterwards.
const prewarmedEngine = args[0] === INTERACTIVE_ENGINE_PREWARM_FLAG;
const engineChild = prewarmedEngine || hasInteractiveEngineBootstrapArg(args);
const terminal = { stdinIsTTY: process.stdin.isTTY === true, stdoutIsTTY: process.stdout.isTTY === true };

const engineCacheWarmedByHost = process.env[COMPILE_CACHE_ENGINE_WARMUP_ENV] === "1";
delete process.env[COMPILE_CACHE_ENGINE_WARMUP_ENV];
const engineMatchHostCache = process.env[COMPILE_CACHE_ENGINE_MATCH_HOST_ENV] === "1";
delete process.env[COMPILE_CACHE_ENGINE_MATCH_HOST_ENV];
// An interactive session, and the engine of one that warms the engine's cache, leave a cold compile cache to a helper
// instead of writing it when they exit. An auto-sized engine also aligns its Node 22 cache tag with the untouched host.
enablePersistentCompileCache({
	interactive: engineChild ? engineCacheWarmedByHost : isPlainInteractiveSessionInvocation(args, terminal),
	build: VERSION,
	matchHostTag: engineChild && engineMatchHostCache,
});
// A session that ends before it starts its compile-cache helpers starts them as it exits; they outlive it.
if (compileCacheDeferral() && !engineChild) {
	process.once("exit", () => warmCompileCache(engineHeapRuntimeArgsForHost(true)));
}

process.title = APP_NAME;
process.env[`${APP_NAME.toUpperCase()}_CODING_AGENT`] = "true";
process.env.AI_AGENT = ATOMIC_AI_AGENT;
process.emitWarning = (() => {}) as typeof process.emitWarning;

if (args[0] === "--version" || args[0] === "-v") {
	console.log(VERSION);
	process.exit(0);
}

// A run without a terminal started under `nohup` keeps SIGHUP ignored; read that before anything listens for it.
if (!prewarmedEngine && isHeadlessInvocation(args, terminal)) noteInheritedHangup();
const heapArgs = prewarmedEngine ? [] : headlessHeapRelaunchArgs(args);
if (heapArgs.length > 0) {
	relaunchWithHeap(heapArgs, args);
} else {
	// An interactive host starts its engine child first, so the child loads the application while this process does;
	// a prewarmed child loads it while it waits for its arguments.
	const interactiveHost = !prewarmedEngine && terminal.stdinIsTTY && terminal.stdoutIsTTY;
	// Read the files an interactive session loads ahead of the module loader, in parallel: on a cold start each one is
	// scanned by an antivirus when first opened. This also covers the engine child, which loads the same files.
	if (interactiveHost && isPlainInteractiveSessionInvocation(args, terminal)) startStartupPrefetch(getPackageDir());
	const prewarm =
		prewarmedEngine || interactiveHost ? import("./modes/interactive-engine/engine-prewarm.ts") : undefined;
	// A session's database opens on a thread of its own: start that thread now, while the modules load.
	// `--no-session` keeps the session in memory and opens no database; a prewarmed engine learns it from its host.
	const opensDatabase = shouldStartSpareDatabaseThread(args, prewarmedEngine, terminal);
	if (opensDatabase)
		void import("./core/storage/node-sqlite-thread.js").then(
			({ ThreadConnection }) => ThreadConnection.startSpare(),
			() => {},
		);
	const prewarmed = interactiveHost
		? prewarm!.then(({ prewarmInteractiveEngineForArgs }) => prewarmInteractiveEngineForArgs(args)).catch(() => {})
		: Promise.resolve();
	// An interactive session shows its editor and takes typing before the rest of Atomic has loaded, where nothing it
	// shows before its editor would come first (startup-shell.ts). Its eligibility module loads concurrently with
	// prewarmInteractiveEngineForArgs; planStartupShell still waits for prewarmed so argument env overrides apply first.
	const started =
		interactiveHost && isPlainInteractiveSessionInvocation(args, terminal)
			? Promise.all([prewarmed, import("./modes/interactive/startup-shell-eligibility.ts")])
					.then(async ([, { planStartupShell }]) => {
						const plan = planStartupShell(args, process.cwd());
						if (!plan) return;
						const shell = await import("./modes/interactive/startup-shell.ts");
						shell.startStartupShell(plan);
						// While it shows, the rest loads in stages with turns of the event loop between, so it keeps
						// answering keys: one import would run the whole module graph without a turn.
						if (shell.startupShellTerminal() !== undefined)
							await (await import("./utils/startup-stages.ts")).loadStartupStages();
					})
					.catch(() => {})
			: prewarmed;
	const mainArgs = prewarmedEngine
		? prewarm!.then(({ readPrewarmedEngineArgs }) => readPrewarmedEngineArgs())
		: Promise.resolve(args);
	let adopted = false;
	void mainArgs.then(() => {
		adopted = true;
	});
	// No top-level await: the compiled binary is built with --bytecode (CJS),
	// which forbids TLA anywhere in the bundled graph.
	void started
		.then(() => {
			const loaded = Promise.all([
				import("./core/http-dispatcher.ts"),
				import("./main.ts"),
				import("./cli/settings-startup.ts"),
			]);
			// A prewarmed child asked to write its compile cache does it once loaded, while it waits for its host, and not
			// once its host has taken it over: then it starts its session at once and writes the cache as it exits.
			if (prewarmedEngine)
				void Promise.all([loaded, prewarm!]).then(([[, mainModule], module]) => {
					const flag = (module as { INTERACTIVE_ENGINE_PREWARM_WRITE_CACHE_FLAG?: string })
						.INTERACTIVE_ENGINE_PREWARM_WRITE_CACHE_FLAG;
					if (!adopted && flag !== undefined && args.includes(flag)) flushPersistentCompileCache();
					if (!adopted) {
						const prewarmApi = (mainModule as { prewarmDefaultModelApi?: () => Promise<void> })
							.prewarmDefaultModelApi;
						if (typeof prewarmApi === "function") void prewarmApi().catch(() => {});
					}
				});
			return Promise.all([loaded, mainArgs]);
		})
		.then(([[{ configureHttpDispatcher }, { main }, { exitOnDecisionConfigError }], runArgs]) => {
			configureHttpDispatcher();
			main(runArgs).catch(exitOnDecisionConfigError);
		})
		// An update that replaced the installation while this process started leaves modules that no longer load: say
		// to start again instead of failing with the runtime's error. Any other failure stays the runtime's own.
		.catch(async (error: unknown) => {
			const updated = await updatedInstallError(error, APP_NAME);
			if (!updated) throw error;
			console.error(updated.message);
			process.exit(1);
		});
}
