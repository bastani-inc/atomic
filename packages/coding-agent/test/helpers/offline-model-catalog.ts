import { vi } from "vitest";
import { ENV_OFFLINE } from "../../src/config.js";

/**
 * Keeps a test's model-catalog refreshes local, and makes any attempt to leave the machine fail at once.
 *
 * `ModelRuntime.create({ allowModelNetwork: false })` only keeps create()'s own refresh off the network. Every later
 * refresh (the /model selector's, `saveCredential`'s, a plain `runtime.refresh()`) follows the runtime's offline
 * switch, which the runtime reads when it is created. Left online, each of them fetches pi.dev's catalog for every
 * provider that has a credential, so a slow or failed request turns the test into a flake: the selector ends on
 * "Could not refresh anthropic" and never on "Model catalogs refreshed.", and `saveCredential` rejects.
 *
 * Call this before the runtime is created. The caller's `afterEach` restores both stubs with `vi.unstubAllEnvs()` and
 * `vi.unstubAllGlobals()`.
 */
export function stubOfflineModelCatalog(): void {
	vi.stubEnv(ENV_OFFLINE, "1");
	vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0]) => {
		throw new Error(`this test is offline but requested ${String(input)}`);
	});
}
