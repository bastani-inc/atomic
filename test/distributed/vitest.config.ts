/**
 * The distributed scenarios, run only by test/distributed/run.mjs against the database it started. They are not part
 * of `npm test`: the root vitest.config.ts does not include test/distributed.
 *
 * One file at a time: the database faults restart, pause and fill the one database every scenario shares, so a file
 * running beside them would see faults it did not inject.
 */
import { defineConfig } from "vitest/config";
import { repositoryRoot, sharedAliases } from "../../vitest.base.js";

/** Each scenario sets its own bounds on what it waits for; this only stops a hung file. */
const SCENARIO_TIMEOUT_MS = 900_000;

export default defineConfig({
	resolve: { alias: sharedAliases },
	test: {
		name: "distributed",
		root: repositoryRoot,
		environment: "node",
		globals: true,
		clearMocks: true,
		include: ["test/distributed/scenarios/**/*.test.ts"],
		exclude: ["**/node_modules/**"],
		fileParallelism: false,
		setupFiles: ["./test/helpers/provider-rate-limit-isolation.ts", "./test/helpers/checkout-snapshot-isolation.ts"],
		globalSetup: [
			// Node processes run this checkout's sources and build; stop when node_modules belongs to another checkout.
			"./test/global-setup-workspace-links.ts",
			"./test/global-setup-lost-workers.ts",
			"./test/global-setup-herdr-isolation.ts",
			"./test/global-setup-provider-credential-isolation.ts",
			"./test/global-setup-debug-isolation.ts",
			"./test/global-setup-intercom-startup-join.ts",
			"./test/global-setup-test-directory.ts",
			"./test/global-setup-natives.ts",
		],
		testTimeout: SCENARIO_TIMEOUT_MS,
		hookTimeout: SCENARIO_TIMEOUT_MS,
	},
});
