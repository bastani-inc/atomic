/**
 * Shared vitest resolution, in upstream pi's shape: `resolve.alias` and the path
 * constants that build it, and nothing else.
 *
 * Deliberately absent: `pool`, `maxWorkers`, `poolOptions`, `fileParallelism`.
 * pi sets none of them, and a suite that only passes with parallelism disabled
 * is hiding a test that assumes an idle machine. Load-sensitive tests are fixed
 * where they live instead (see test/unit/subagents-attempt-watchdog.test.ts).
 */
import { fileURLToPath } from "node:url";
import type { Alias } from "vite";

/** Repository root, with a trailing separator. */
export const repositoryRoot = fileURLToPath(new URL(".", import.meta.url));

/**
 * `@bastani/atomic` resolves to its unbuilt source under test. Without this,
 * packages/workflows/src/engine/workflow-activity.ts fails to resolve the host
 * entry and takes test/unit/executor-concurrency-limiter.test.ts down with it.
 */
export const atomicSrcIndex = fileURLToPath(
	new URL("./packages/coding-agent/src/index.ts", import.meta.url),
);

/** Every alias each vitest project shares. */
export const sharedAliases: readonly Alias[] = [
	{ find: /^@bastani\/atomic$/, replacement: atomicSrcIndex },
	// The unpublished workflow workspace is still exercised by source-level tests. Installed-package
	// tests run Node outside Vitest so they see the real package exports, not these fixture aliases.
	{
		find: /^@bastani\/atomic\/workflows$/,
		replacement: fileURLToPath(new URL("./packages/workflows/src/index.ts", import.meta.url)),
	},
	{
		find: /^@bastani\/atomic\/workflows\/builtin$/,
		replacement: fileURLToPath(new URL("./packages/workflows/builtin/index.ts", import.meta.url)),
	},
	{
		find: /^@bastani\/atomic\/workflows\/builtin\/(.+)$/,
		replacement: fileURLToPath(new URL("./packages/workflows/builtin/$1.ts", import.meta.url)),
	},
	{
		find: /^@bastani\/atomic\/storage$/,
		replacement: fileURLToPath(new URL("./packages/coding-agent/src/core/storage/index.ts", import.meta.url)),
	},
];

/** The base every vitest config in the repository merges with. */
export const baseConfig = { resolve: { alias: sharedAliases } };
