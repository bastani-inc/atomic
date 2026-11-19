import { defineConfig } from "vitest/config";
import { sharedAliases } from "./vitest.base.js";
import { DurationSequencer } from "./test/helpers/duration-sequencer.js";
import { TEST_TIMEOUT_MS } from "./test/helpers/test-timeout.js";

export { TEST_TIMEOUT_MS };

const setupFiles = [
	"./test/helpers/provider-rate-limit-isolation.ts",
	"./test/helpers/checkout-snapshot-isolation.ts",
];

/**
 * Global setups run once per project in the orchestrator process, before any
 * file is collected.
 *
 * `global-setup-herdr-isolation` strips inherited pane credentials before any
 * workers or CLI fixtures can report to the developer's live Herdr pane.
 *
 * `global-setup-provider-credential-isolation` strips inherited provider
 * credentials and endpoints, so a developer's shell cannot make a provider
 * available to tests that expect only their fixtures' providers.
 *
 * `global-setup-test-directory` creates the per-run directory where workers keep isolated agent homes.
 *
 * `global-setup-natives` builds `@bastani/atomic-natives` only when no
 * compiled binding exists, because a missing binding no longer degrades
 * gracefully: `packages/subagents` imports the Rust control plane statically,
 * and the compiled extension/native boundary contract executes real `glob` and
 * `grep` calls from the syntax-minified sidecar. On the happy path this is a
 * single `existsSync`, so CI — which builds the binding in an explicit step
 * first — and any warm worktree pay nothing.
 */
const lostWorkersSetup = "./test/global-setup-lost-workers.ts";
const herdrSetup = "./test/global-setup-herdr-isolation.ts";
const providerCredentialSetup = "./test/global-setup-provider-credential-isolation.ts";
const debugSetup = "./test/global-setup-debug-isolation.ts";
const directorySetup = "./test/global-setup-test-directory.ts";
const nativeSetup = "./test/global-setup-natives.ts";

const project = (
	name: string,
	include: string,
	options: {
		readonly exclude?: readonly string[];
		readonly groupOrder?: number;
	} = {},
) => ({
	resolve: { alias: sharedAliases },
	test: {
		name,
		root: import.meta.dirname,
		environment: "node" as const,
		globals: true,
		// Drop every mock's records (arguments, `this`, results) before each test: vitest 4's vi.restoreAllMocks() keeps
		// them for the rest of the file, so files that spy on busy code grew by megabytes a test (#5552).
		clearMocks: true,
		include: [include],
		exclude: ["**/node_modules/**", ...(options.exclude ?? [])],
		sequence: { groupOrder: options.groupOrder ?? 0 },
		setupFiles,
		globalSetup: [lostWorkersSetup, herdrSetup, providerCredentialSetup, debugSetup, directorySetup, nativeSetup],
		testTimeout: TEST_TIMEOUT_MS,
		hookTimeout: TEST_TIMEOUT_MS,
	},
});

const uiGate = "test/integration/interactive-event-loop-guard.test.ts";

/**
 * One project per suite directory, so the CI job split and the
 * diagnostics artifact names all survive the move off `bun test <dir>`
 * unchanged, plus the interactive event-loop gate on its own.
 *
 * All projects use native setup: the CI project now executes the minified
 * extension/native binary boundary instead of limiting itself to source inspection.
 *
 * No `pool`, `maxWorkers`, `poolOptions` or `fileParallelism`: pi sets none, and
 * a suite that only passes serialized is concealing a test that assumes an idle
 * machine rather than fixing it.
 */
export default defineConfig({
	test: {
		// Longest files first, and duration-balanced `--shard` (CI runs the unit and integration suites in shards).
		sequence: { sequencer: DurationSequencer },
		projects: [
			project("unit", "test/unit/**/*.test.ts"),
			project("integration", "test/integration/**/*.test.ts", {
				exclude: [uiGate],
			}),
			project("integration-ui-gate", uiGate, { groupOrder: 1 }),
			project("ci", "test/ci/**/*.test.ts"),
		],
	},
});
