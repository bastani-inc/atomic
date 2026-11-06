import { defineConfig } from "vitest/config";
import { repositoryRoot, sharedAliases } from "../../../vitest.base.js";

/**
 * The fixtures under the shared test setup's agent-directory default and real-home guards, run one at a time as a
 * child by their unit tests, which name the fixture file as the filter.
 */
export default defineConfig({
	resolve: { alias: [...sharedAliases] },
	test: {
		root: repositoryRoot,
		environment: "node",
		include: ["test/fixtures/real-home-storage-guard/*.fixture.ts"],
		setupFiles: ["./test/helpers/checkout-snapshot-isolation.ts"],
	},
});
