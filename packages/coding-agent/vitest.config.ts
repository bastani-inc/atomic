import { defineConfig } from "vitest/config";
import { DurationSequencer } from "../../test/helpers/duration-sequencer.js";
import { sharedAliases } from "../../vitest.base.js";

/**
 * Windows runners are slower enough that the shared 30 s budget is genuinely
 * structural here; this branch predates the toolchain migration and stays local
 * to this project rather than leaking into the repository-wide value.
 */
const defaultTestTimeoutMs = process.platform === "win32" ? 90_000 : 30_000;

/**
 * Setup and teardown hooks here create git sandboxes and open SQLite session stores. Under a loaded
 * Windows shard that structural work regularly passes vitest's 10 s hook default, so Windows hooks get
 * the same headroom ratio as the tests; other platforms keep the default.
 */
const defaultHookTimeoutMs = process.platform === "win32" ? 30_000 : 10_000;

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
 * Suites that test/unit/test-suite-runner.test.ts writes under `test/` to run through this config, each there only
 * while one of its tests runs. Another run globbing this suite in the same checkout meanwhile would collect a file
 * about to vanish: the duration sequencer's check, globbing once per shard beside that test, saw it in some shards'
 * file lists and not in others', so files went to two shards or to none. Only the run that test starts for its own
 * suite, which sets `ATOMIC_TEST_COLLECT_SCRATCH_SUITES` and names the suite's file on its command line, collects them.
 */
const scratchSuites =
	process.env.ATOMIC_TEST_COLLECT_SCRATCH_SUITES === "1" ? [] : ["**/.tmp-test-suite-runner-real-*/**"];

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
		// Drop every mock's records before each test; vi.restoreAllMocks() keeps them for the rest of the file (#5552).
		clearMocks: true,
		environment: "node" as const,
		setupFiles: [
			"../../test/helpers/provider-rate-limit-isolation.ts",
			"../../test/helpers/checkout-snapshot-isolation.ts",
		],
		globalSetup: [
			"../../test/global-setup-lost-workers.ts",
			"../../test/global-setup-herdr-isolation.ts",
			"../../test/global-setup-provider-credential-isolation.ts",
			"../../test/global-setup-debug-isolation.ts",
			"../../test/global-setup-intercom-startup-join.ts",
			"../../test/global-setup-test-directory.ts",
			"./test/global-setup-warm-transpile-cache.ts",
		],
		testTimeout: defaultTestTimeoutMs,
		hookTimeout: defaultHookTimeoutMs,
		include,
		exclude: ["**/node_modules/**", ...scratchSuites, ...exclude],
		server: { deps: { external: [/@silvia-odwyer\/photon-node/] } },
	},
});

export default defineConfig({
	test: {
		// Longest files first, and duration-balanced `--shard` (the CI agent-suite job runs three shards per OS).
		sequence: { sequencer: DurationSequencer },
		projects: [
			project("agent", ["test/**/*.test.ts", "test/**/*.spec.ts", "test/**/*.suite.ts"], skippedSuites),
		],
	},
});
