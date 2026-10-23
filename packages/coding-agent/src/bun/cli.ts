#!/usr/bin/env node
import { registerBunOAuthFlows } from "@bastani/pi-ai/bun-oauth";

// Register before the application graph loads so Bun's standalone compiler embeds every login adapter.
registerBunOAuthFlows();

import { APP_NAME } from "../config.js";

process.title = APP_NAME;
process.emitWarning = (() => {}) as typeof process.emitWarning;

import { type AppHostModuleSpecifier, isAppHostModulesOnly } from "./app-host-modules.js";
import { restoreSandboxEnv } from "./restore-sandbox-env.ts";

restoreSandboxEnv();

/** This bundle's own host modules, for the standalone launcher's Intercom broker. */
export function loadHostModule(specifier: AppHostModuleSpecifier): Promise<object> {
	return specifier === "@bastani/atomic" ? import("../index.js") : import("../core/storage/index.js");
}

// No top-level await: the compiled binary is built with --bytecode (CJS),
// which forbids TLA anywhere in the bundled graph.
if (!isAppHostModulesOnly()) void import("./register-bedrock.js").then(() => import("../cli.js"));
