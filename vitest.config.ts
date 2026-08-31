import { defineConfig } from "vitest/config";
import { sharedAliases } from "./vitest.base.js";
import { TEST_TIMEOUT_MS } from "./test/helpers/test-timeout.js";

export { TEST_TIMEOUT_MS };

/**
 * `bunfig.toml`'s `[test] preload` moved here verbatim. The file registers one
 * `beforeEach` installing a fresh in-memory durable backend, and needs no edit:
 * its `beforeEach` import resolves through the `bun:test` alias.
 */
const setupFiles = ["./test/setup-workflow-durability.ts"];

/**
 * Global setups run once per project in the orchestrator process, before any
 * file is collected.
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
const artifactSetup = "./test/global-setup-workflow-artifacts.ts";
const nativeSetup = "./test/global-setup-natives.ts";

const project = (name: string, directory: string) => ({
	resolve: { alias: sharedAliases },
	test: {
		name,
		root: import.meta.dirname,
		environment: "node" as const,
		globals: true,
		include: [`${directory}/**/*.test.ts`],
		exclude: ["**/node_modules/**"],
		setupFiles,
		globalSetup: [artifactSetup, nativeSetup],
		testTimeout: TEST_TIMEOUT_MS,
		hookTimeout: TEST_TIMEOUT_MS,
	},
});

/**
 * Three projects, one per suite directory, so the CI job split, the per-suite
 * flake retry and the diagnostics artifact names all survive the move off
 * `bun test <dir>` unchanged.
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
		projects: [project("unit", "test/unit"), project("integration", "test/integration"), project("ci", "test/ci")],
	},
});
