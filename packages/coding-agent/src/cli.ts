#!/usr/bin/env node
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: npx tsx src/cli-new.ts [args...]
 *
 * Deliberately keeps the static entry graph to config, compile-cache support,
 * attribution, and the disabled-by-default lifecycle seam. The full CLI graph
 * loads dynamically so metadata fast paths (for example `--version`) skip it.
 */
import { APP_NAME, VERSION } from "./config.js";
import { markLifecycleTiming } from "./core/lifecycle-timings.ts";
import { ATOMIC_AI_AGENT } from "./utils/agent-attribution.ts";
import { enablePersistentCompileCache } from "./utils/compile-cache.ts";

markLifecycleTiming("process-entry");

enablePersistentCompileCache();

process.title = APP_NAME;
process.env[`${APP_NAME.toUpperCase()}_CODING_AGENT`] = "true";
process.env.AI_AGENT = ATOMIC_AI_AGENT;
process.emitWarning = (() => {}) as typeof process.emitWarning;

const args = process.argv.slice(2);

if (args[0] === "--version" || args[0] === "-v") {
	console.log(VERSION);
	process.exit(0);
}

// No top-level await: the compiled binary is built with --bytecode (CJS),
// which forbids TLA anywhere in the bundled graph.
void Promise.all([import("./core/http-dispatcher.ts"), import("./main.ts")]).then(
	([{ configureHttpDispatcher }, { main }]) => {
		configureHttpDispatcher();
		main(args);
	},
);
