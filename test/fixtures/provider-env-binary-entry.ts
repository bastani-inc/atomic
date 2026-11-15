import assert from "node:assert/strict";
import { isBunBinary } from "../../packages/coding-agent/src/config.js";
import { loadExtensions } from "../../packages/coding-agent/src/core/extensions/loader.js";
import { getVirtualModules } from "../../packages/coding-agent/src/core/extensions/loader-virtual-modules.js";

async function main(): Promise<void> {
	// The production loader disables source aliases in this mode.
	assert.equal(isBunBinary, true, "fixture must run through the compiled split launcher");
	const extensionPath = process.argv[2];
	assert.ok(extensionPath, "missing extension path");
	const loaded = await loadExtensions([extensionPath], process.cwd());
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
	const flags = loaded.extensions[0]!.flags;
	assert.equal(flags.get("provider-env-process")?.default, "process-value");
	assert.equal(flags.get("provider-env-scoped")?.default, "scoped-value");

	const hosted = (await getVirtualModules())["@bastani/atomic-ai/utils/provider-env"] as
		| typeof import("@bastani/atomic-ai/utils/provider-env")
		| undefined;
	assert.equal(hosted?.getProviderEnvValue("ATOMIC_PROVIDER_ENV_PROBE"), "process-value");
	console.log("compiled provider-env extension: OK");
}

void main().catch((error: Error) => {
	console.error(error);
	process.exitCode = 1;
});
