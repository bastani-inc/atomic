#!/usr/bin/env node
import { APP_NAME } from "./config.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { main } from "./main.ts";

process.title = `${APP_NAME}-rpc`;
process.env[`${APP_NAME.toUpperCase()}_CODING_AGENT`] = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

configureHttpDispatcher();

// rpc-entry is the dedicated RPC entry point, so --mode rpc must always win
// over any --mode the caller passes (the last --mode in the args wins).
main([...process.argv.slice(2), "--mode", "rpc"]);
