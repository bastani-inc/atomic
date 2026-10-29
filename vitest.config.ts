import { defineConfig } from "vitest/config";
import { sharedAliases } from "./vitest.base.js";
import { DurationSequencer } from "./test/helpers/duration-sequencer.js";
import { TEST_TIMEOUT_MS } from "./test/helpers/test-timeout.js";

export { TEST_TIMEOUT_MS };

/**
 * `bunfig.toml`'s `[test] preload` moved here verbatim. The file registers one
 * `beforeEach` installing a fresh in-memory durable backend, and needs no edit:
 * its `beforeEach` import resolves through the `bun:test` alias.
 */
const setupFiles = ["./test/setup-workflow-durability.ts", "./test/helpers/provider-rate-limit-isolation.ts"];

/**
 * Integration tests start local workers from the shipped bundle, not by transpiling the workflow sources through jiti in
 * every coordinator and worker process; the file explains why. Unit tests keep the source loader.
 */
const packagedWorkerSetup = "./test/setup-packaged-local-worker.ts";

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
 * `global-setup-workflow-artifacts` creates the per-run workflow-artifact
 * directory that `setup-workflow-durability` points workers at, and removes it
 * in teardown. It runs for all three projects.
 *
 * `global-setup-natives` builds `@bastani/atomic-natives` only when no
 * compiled binding exists, because a missing binding no longer degrades
 * gracefully: `packages/subagents` imports the Rust control plane statically,
 * and the compiled extension/native boundary contract executes real `glob` and
 * `grep` calls from the syntax-minified sidecar. On the happy path this is a
 * single `existsSync`, so CI — which builds the binding in an explicit step
 * first — and any warm worktree pay nothing.
 */
const herdrSetup = "./test/global-setup-herdr-isolation.ts";
const providerCredentialSetup = "./test/global-setup-provider-credential-isolation.ts";
const artifactSetup = "./test/global-setup-workflow-artifacts.ts";
const nativeSetup = "./test/global-setup-natives.ts";

const project = (
	name: string,
	include: string,
	options: {
		readonly exclude?: readonly string[];
		readonly groupOrder?: number;
		readonly extraSetupFiles?: readonly string[];
	} = {},
) => ({
	resolve: { alias: sharedAliases },
	test: {
		name,
		root: import.meta.dirname,
		environment: "node" as const,
		globals: true,
		include: [include],
		exclude: ["**/node_modules/**", ...(options.exclude ?? [])],
		sequence: { groupOrder: options.groupOrder ?? 0 },
		setupFiles: [...setupFiles, ...(options.extraSetupFiles ?? [])],
		globalSetup: [herdrSetup, providerCredentialSetup, artifactSetup, nativeSetup],
		testTimeout: TEST_TIMEOUT_MS,
		hookTimeout: TEST_TIMEOUT_MS,
	},
});

/**
 * The pool load gate measures the root's main-thread lag under 150 busy workers against fixed bounds, so other files
 * running beside it would be measured too: with sharding's longest-first order it started beside about five other
 * pool files, and its p99 lag reached 105.6 ms of its 100 ms bound (run 40577049870). It is its own project with a
 * later `groupOrder`, so vitest runs it after every other integration file of the run (or shard) has finished, with
 * nothing beside it. `npm run test:integration` selects both projects.
 */
const loadGate = "test/integration/workflow-pool-load-gate.test.ts";

/**
 * One project per suite directory, so the CI job split and the
 * diagnostics artifact names all survive the move off `bun test <dir>`
 * unchanged, plus the integration load gate on its own (above).
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
				exclude: [loadGate],
				extraSetupFiles: [packagedWorkerSetup],
			}),
			project("integration-load-gate", loadGate, { groupOrder: 1 }),
			project("ci", "test/ci/**/*.test.ts"),
		],
	},
});
