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
import { COMPILE_CACHE_ENGINE_WARMUP_ENV, enablePersistentCompileCache } from "./utils/compile-cache.ts";
import { headlessHeapRelaunchArgs, isHeadlessInvocation, relaunchWithHeap } from "./utils/heap-relaunch.ts";
import { noteInheritedHangup } from "./utils/inherited-hangup.js";
import {
	hasInteractiveEngineBootstrapArg,
	INTERACTIVE_ENGINE_PREWARM_FLAG,
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
	const prewarmed = interactiveHost
		? prewarm!.then(({ prewarmInteractiveEngine }) => prewarmInteractiveEngine(args)).catch(() => {})
		: Promise.resolve();
	// An interactive session shows its editor and takes typing before the rest of Atomic has loaded, where nothing it
	// shows before its editor would come first (startup-shell.ts). Its modules load before the rest.
	const started =
		interactiveHost && isPlainInteractiveSessionInvocation(args, terminal)
			? prewarmed
					.then(() => import("./modes/interactive/startup-shell-eligibility.ts"))
					.then(async ({ planStartupShell }) => {
						const plan = planStartupShell(args, process.cwd());
						if (plan) (await import("./modes/interactive/startup-shell.ts")).startStartupShell(plan);
					})
					.catch(() => {})
			: prewarmed;
	const mainArgs = prewarmedEngine
		? prewarm!.then(({ readPrewarmedEngineArgs }) => readPrewarmedEngineArgs())
		: Promise.resolve(args);
	// No top-level await: the compiled binary is built with --bytecode (CJS),
	// which forbids TLA anywhere in the bundled graph.
	void started
		.then(() =>
			Promise.all([
				import("./core/http-dispatcher.ts"),
				import("./main.ts"),
				import("./cli/settings-startup.ts"),
				mainArgs,
			]),
		)
		.then(([{ configureHttpDispatcher }, { main }, { exitOnDecisionConfigError }, runArgs]) => {
			configureHttpDispatcher();
			main(runArgs).catch(exitOnDecisionConfigError);
		});
}
