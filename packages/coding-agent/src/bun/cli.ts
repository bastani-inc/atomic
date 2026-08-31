#!/usr/bin/env node
import { registerBunOAuthFlows } from "@bastani/pi-ai/bun-oauth";

// Register before the application graph loads so Bun's standalone compiler embeds every login adapter.
registerBunOAuthFlows();

import { APP_NAME } from "../config.js";

process.title = APP_NAME;
process.emitWarning = (() => {}) as typeof process.emitWarning;

import { restoreSandboxEnv } from "./restore-sandbox-env.ts";

restoreSandboxEnv();

// No top-level await: the compiled binary is built with --bytecode (CJS),
// which forbids TLA anywhere in the bundled graph.
void import("./register-bedrock.ts").then(() => import("../cli.ts"));
