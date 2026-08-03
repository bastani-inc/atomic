import { defineConfig } from "vitest/config";
import { sharedAliases } from "../../vitest.base.js";

/**
 * Windows runners are slower enough that the shared 30 s budget is genuinely
 * structural here; this branch predates the toolchain migration and stays local
 * to this project rather than leaking into the repository-wide value.
 */
const defaultTestTimeoutMs = process.platform === "win32" ? 90_000 : 30_000;

/**
 * The `exclude` list is preserved verbatim from before the migration. Narrowing
 * it is a separate change and must not ride along in a toolchain migration.
 */
const skippedSuites = [
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
];

/**
 * Both projects share everything except which files they collect, so a setting
 * cannot drift between the Node-hosted and Bun-hosted halves of one suite.
 *
 * `resolve.alias` is repeated per project deliberately: vitest builds each
 * project as its own vite config, so a root-level `resolve` would not reach
 * them. The base supplies the `@bastani/atomic` and sibling
 * pi-source aliases.
 */
const project = (name: string, include: string[], exclude: string[]) => ({
	resolve: { alias: sharedAliases },
	test: {
		name,
		globals: true,
		environment: "node" as const,
		testTimeout: defaultTestTimeoutMs,
		include,
		exclude: ["**/node_modules/**", ...exclude],
		server: { deps: { external: [/@silvia-odwyer\/photon-node/] } },
	},
});

export default defineConfig({
	test: {
		projects: [
			project("agent", ["test/**/*.test.ts", "test/**/*.spec.ts", "test/**/*.suite.ts"], skippedSuites),
		],
	},
});
