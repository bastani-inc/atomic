import { defineConfig } from "vitest/config";
import { sharedAliases } from "../../vitest.base.js";

/**
 * Windows runners are slower enough that the shared 30 s budget is genuinely
 * structural here; this branch predates the toolchain migration and stays local
 * to this project rather than leaking into the repository-wide value.
 */
const defaultTestTimeoutMs = process.platform === "win32" ? 90_000 : 30_000;

/**
 * The files that only mean anything under Bun.
 *
 * `src/core/tools/resource-selectors.ts` reaches for `bun:sqlite` and throws
 * "SQLite selectors require Atomic's Bun runtime" without it, so every SQLite
 * selector test is testing the shipped Bun-compiled binary's runtime, not
 * Node's. Under Node these files do not fail -- they degrade: one declaration
 * becomes `it.skip`, and eleven others keep their names, keep passing, and run
 * no assertions at all behind a `if (!sqlite) return`. A green suite cannot see
 * that, which is exactly why the split is a config fact rather than a guard
 * inside each test.
 *
 * These four files therefore run under `bun --bun vitest` (the `agent-bun`
 * project), which is what the whole suite ran under before the migration, and
 * the guards inside them are hard requires again: absent `bun:sqlite` they
 * fail loudly instead of quietly measuring nothing.
 */
export const BUN_HOSTED_TESTS = [
	"test/read-sqlite-search-meta-parity.test.ts",
	"test/resource-selector-hardening.test.ts",
	"test/resource-selector-tools.test.ts",
	"test/resource-write-parity-edges.test.ts",
];

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
 * them. The base supplies the `bun:test`, `@bastani/atomic` and sibling
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
			project("agent", ["test/**/*.test.ts", "test/**/*.spec.ts", "test/**/*.suite.ts"], [...skippedSuites, ...BUN_HOSTED_TESTS]),
			project("agent-bun", BUN_HOSTED_TESTS, []),
		],
	},
});
