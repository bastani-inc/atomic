import { defineConfig, mergeConfig } from "vitest/config";
import { baseConfig } from "../../vitest.base.js";

/**
 * Windows runners are slower enough that the shared 30 s budget is genuinely
 * structural here; this branch predates the toolchain migration and stays local
 * to this project rather than leaking into the repository-wide value.
 */
const defaultTestTimeoutMs = process.platform === "win32" ? 90_000 : 30_000;

/**
 * Merged onto the repository's shared resolution, exactly as pi's per-package
 * configs are. The base supplies the `bun:test`, `@bastani/atomic` and sibling
 * pi-source aliases; everything below is this package's own.
 *
 * The `exclude` list is preserved verbatim. Narrowing it is a separate change
 * and must not ride along in a toolchain migration.
 */
export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			globals: true,
			environment: "node",
			testTimeout: defaultTestTimeoutMs,
			include: ["test/**/*.test.ts", "test/**/*.spec.ts", "test/**/*.suite.ts"],
			exclude: [
				"**/node_modules/**",
				"test/agent-session-auto-compaction-queue.test.ts",
				"test/agent-session-concurrent.test.ts",
				"test/auth-storage.test.ts",
				"test/context-compaction-deletion-tool.test.ts",
				"test/context-compaction.test.ts",
				"test/context-window-session.test.ts",
				"test/extensions-runner.test.ts",
				"test/interactive-mode-status.test.ts",
				"test/model-registry.test.ts",
				"test/package-command-paths.test.ts",
				"test/package-manager-extra-suites.test.ts",
				"test/package-manager.test.ts",
				"test/resource-loader.test.ts",
				"test/session-manager/build-context.test.ts",
				"test/tools.test.ts",
				"test/tree-selector.test.ts",
				"test/suite/agent-session-runtime.test.ts",
			],
			server: {
				deps: {
					external: [/@silvia-odwyer\/photon-node/],
				},
			},
		},
	}),
);
