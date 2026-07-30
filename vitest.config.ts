import { defineConfig } from "vitest/config";
import { sharedAliases } from "./vitest.base.js";

/**
 * The one per-test budget for the whole repository, declared once.
 *
 * It replaces the `--timeout 30000` that `test:unit`, `test:integration` and
 * `test:ci-contracts` each used to spell out, and it keeps that policy's intent:
 * one platform-neutral value, enforced identically locally and in CI, never a
 * Windows-only branch. test/ci/ci-workflow-contracts.test.ts asserts all three
 * projects still resolve to this single value.
 */
export const TEST_TIMEOUT_MS = 30_000;

/**
 * `bunfig.toml`'s `[test] preload` moved here verbatim. The file registers one
 * `beforeEach` installing a fresh in-memory durable backend, and needs no edit:
 * its `beforeEach` import resolves through the `bun:test` alias.
 */
const setupFiles = ["./test/setup-workflow-durability.ts"];

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
		testTimeout: TEST_TIMEOUT_MS,
		hookTimeout: TEST_TIMEOUT_MS,
	},
});

/**
 * Three projects, one per suite directory, so the CI job split, the per-suite
 * flake retry and the diagnostics artifact names all survive the move off
 * `bun test <dir>` unchanged.
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
