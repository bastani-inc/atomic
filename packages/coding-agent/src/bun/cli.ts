#!/usr/bin/env node
import { registerBunOAuthFlows } from "@bastani/atomic-ai/bun-oauth";
import "../utils/highlight-eager-languages.ts";

// Register before the application graph loads so Bun's standalone compiler embeds every login adapter.
registerBunOAuthFlows();

import { APP_NAME } from "../config.js";

process.title = APP_NAME;
process.emitWarning = (() => {}) as typeof process.emitWarning;

import { type AppHostModuleSpecifier, isAppHostModulesOnly } from "./app-host-modules.js";
import { restoreSandboxEnv } from "./restore-sandbox-env.ts";

restoreSandboxEnv();

/** This bundle's own host modules, for the standalone launcher's Intercom broker. */
export async function loadHostModule(specifier: AppHostModuleSpecifier): Promise<object> {
	if (specifier === "@bastani/atomic") return import("../index.ts");
	if (specifier === "@bastani/atomic/storage") return import("../core/storage/index.js");
	throw new Error(`Host module is unavailable: ${specifier}`);
}

// No top-level await: the compiled binary is built with --bytecode (CJS),
// which forbids TLA anywhere in the bundled graph.
if (!isAppHostModulesOnly()) void import("./register-bedrock.js").then(() => import("../cli.js"));
