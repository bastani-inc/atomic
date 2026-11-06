import { defineConfig } from "vitest/config";
import { repositoryRoot, sharedAliases } from "../../../vitest.base.js";

/** One fixture file under the shared test setup's real-home storage guard, run as a child by its unit test. */
export default defineConfig({
	resolve: { alias: [...sharedAliases] },
	test: {
		root: repositoryRoot,
		environment: "node",
		include: ["test/fixtures/real-home-storage-guard/default-session-store.fixture.ts"],
		setupFiles: ["./test/helpers/checkout-snapshot-isolation.ts"],
	},
});
