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

/** `@bastani/atomic` resolves to the same unbuilt host source in every test project. */
export const atomicSrcIndex = fileURLToPath(
	new URL("./packages/coding-agent/src/index.ts", import.meta.url),
);

/** Every alias each vitest project shares. */
export const sharedAliases: readonly Alias[] = [
	{ find: /^@bastani\/atomic$/, replacement: atomicSrcIndex },
	{
		find: /^@bastani\/atomic\/storage$/,
		replacement: fileURLToPath(new URL("./packages/coding-agent/src/core/storage/index.ts", import.meta.url)),
	},
];

/** The base every vitest config in the repository merges with. */
export const baseConfig = { resolve: { alias: sharedAliases } };
