import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		clearMocks: true, // vi.restoreAllMocks() keeps spy records for the rest of the file (#5552)
		environment: "node",
		testTimeout: 30000,
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
		exclude: ["**/node_modules/**", "**/dist/**"],
		// Live provider suites skip without credentials; run them with ATOMIC_TEST_KEEP_PROVIDER_CREDENTIALS=1.
		globalSetup: ["../../test/global-setup-provider-credential-isolation.ts"],
	},
});
