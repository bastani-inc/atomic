#!/usr/bin/env node
import { insertForcedOptionsBeforeTerminator } from "./cli/args.ts";
import { APP_NAME } from "./config.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { main } from "./main.ts";

process.title = `${APP_NAME}-rpc`;
process.env[`${APP_NAME.toUpperCase()}_CODING_AGENT`] = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

configureHttpDispatcher();

// rpc-entry is the dedicated RPC entry point, so --mode rpc must always win
// over any --mode the caller passes (the last --mode in the args wins). The
// forced flags are inserted before any `--` end-of-options terminator so they
// are still parsed as options rather than literal message text; caller --mode
// flags can only appear before the terminator, so last-wins is preserved.
main(insertForcedOptionsBeforeTerminator(process.argv.slice(2), ["--mode", "rpc"]));
