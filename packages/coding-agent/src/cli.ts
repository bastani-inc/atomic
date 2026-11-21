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
import { APP_NAME, VERSION } from "./config.js";
import { installLifecycleTraceFromEnv, markLifecycleTiming } from "./core/lifecycle-timings.ts";
import { ATOMIC_AI_AGENT } from "./utils/agent-attribution.ts";
import {
	COMPILE_CACHE_ENGINE_WARMUP_ENV,
	enablePersistentCompileCache,
	flushPersistentCompileCache,
} from "./utils/compile-cache.ts";
import { headlessHeapRelaunchArgs, isHeadlessInvocation, relaunchWithHeap } from "./utils/heap-relaunch.ts";
import { noteInheritedHangup } from "./utils/inherited-hangup.js";
import {
	hasInteractiveEngineBootstrapArg,
	INTERACTIVE_ENGINE_PREWARM_FLAG,
	INTERACTIVE_ENGINE_PREWARM_NO_DATABASE,
} from "./utils/interactive-engine-bootstrap.ts";
import { isPlainInteractiveSessionInvocation } from "./utils/interactive-invocation.ts";

installLifecycleTraceFromEnv();
markLifecycleTiming("process-entry");

const args = process.argv.slice(2);
// A prewarmed engine child loads the application now and learns its arguments from its host afterwards.
const prewarmedEngine = args[0] === INTERACTIVE_ENGINE_PREWARM_FLAG;
const terminal = { stdinIsTTY: process.stdin.isTTY === true, stdoutIsTTY: process.stdout.isTTY === true };

const engineCacheWarmedByHost = process.env[COMPILE_CACHE_ENGINE_WARMUP_ENV] === "1";
delete process.env[COMPILE_CACHE_ENGINE_WARMUP_ENV];
// An interactive session, and the engine of one that warms the engine's cache, leave a cold compile cache to a helper
// instead of writing it when they exit.
enablePersistentCompileCache({
	interactive:
		prewarmedEngine || hasInteractiveEngineBootstrapArg(args)
			? engineCacheWarmedByHost
			: isPlainInteractiveSessionInvocation(args, terminal),
	build: VERSION,
});

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
	const prewarm =
		prewarmedEngine || interactiveHost ? import("./modes/interactive-engine/engine-prewarm.ts") : undefined;
	// An interactive session's database opens on a thread of its own: start that thread now, while the modules load.
	// `--no-session` keeps the session in memory and opens no database; a prewarmed engine learns it from its host.
	const opensDatabase = prewarmedEngine
		? args[1] !== INTERACTIVE_ENGINE_PREWARM_NO_DATABASE
		: isPlainInteractiveSessionInvocation(args, terminal) && !args.includes("--no-session");
	if (opensDatabase)
		void import("./core/storage/node-sqlite-thread.js").then(
			({ ThreadConnection }) => ThreadConnection.startSpare(),
			() => {},
		);
	const started = interactiveHost
		? prewarm!.then(({ prewarmInteractiveEngineForArgs }) => prewarmInteractiveEngineForArgs(args)).catch(() => {})
		: Promise.resolve();
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
				void Promise.all([loaded, prewarm!]).then(([, module]) => {
					const flag = (module as { INTERACTIVE_ENGINE_PREWARM_WRITE_CACHE_FLAG?: string })
						.INTERACTIVE_ENGINE_PREWARM_WRITE_CACHE_FLAG;
					if (!adopted && flag !== undefined && args.includes(flag)) flushPersistentCompileCache();
				});
			return Promise.all([loaded, mainArgs]);
		})
		.then(([[{ configureHttpDispatcher }, { main }, { exitOnDecisionConfigError }], runArgs]) => {
			configureHttpDispatcher();
			main(runArgs).catch(exitOnDecisionConfigError);
		});
}
