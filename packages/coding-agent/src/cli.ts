#!/usr/bin/env node
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: npx tsx src/cli-new.ts [args...]
 *
 * Deliberately imports only config.ts statically: the full CLI module graph is
 * loaded dynamically so metadata fast paths (e.g. --version) skip it entirely.
 */
import { APP_NAME, VERSION } from "./config.ts";
import { enablePersistentCompileCache } from "./utils/compile-cache.ts";

enablePersistentCompileCache();

process.title = APP_NAME;
process.env[`${APP_NAME.toUpperCase()}_CODING_AGENT`] = "true";
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
