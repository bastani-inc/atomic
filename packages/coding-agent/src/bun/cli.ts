#!/usr/bin/env node
import { APP_NAME } from "../config.ts";

process.title = APP_NAME;
process.emitWarning = (() => {}) as typeof process.emitWarning;

import { restoreSandboxEnv } from "./restore-sandbox-env.ts";

restoreSandboxEnv();

// No top-level await: the compiled binary is built with --bytecode (CJS),
// which forbids TLA anywhere in the bundled graph.
void import("./register-bedrock.ts").then(() => import("../cli.ts"));
