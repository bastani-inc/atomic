/**
 * Shared vitest resolution, in upstream pi's shape: `resolve.alias` and the path
 * constants that build it, and nothing else.
 *
 * Deliberately absent: `pool`, `maxWorkers`, `poolOptions`, `fileParallelism`.
 * pi sets none of them, and a suite that only passes with parallelism disabled
 * is hiding a test that assumes an idle machine. Load-sensitive tests are fixed
 * where they live instead (see test/unit/subagents-attempt-watchdog.test.ts).
 */
import { existsSync } from "node:fs";
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

const aiSrcIndex = fileURLToPath(new URL("./packages/ai/src/index.ts", import.meta.url));
const aiSrcOAuth = fileURLToPath(new URL("./packages/ai/src/oauth.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("./packages/agent/src/index.ts", import.meta.url));
const tuiSrcIndex = fileURLToPath(new URL("./packages/tui/src/index.ts", import.meta.url));

/**
 * Prefer sibling pi sources when this repository is checked out beside them.
 * The guard keeps the alias list empty in a normal checkout, where the published
 * packages under node_modules are the right answer.
 */
const workspaceSourceAliases: readonly Alias[] =
	existsSync(aiSrcIndex) && existsSync(aiSrcOAuth) && existsSync(agentSrcIndex) && existsSync(tuiSrcIndex)
		? [
				{ find: /^@earendil-works\/pi-ai$/, replacement: aiSrcIndex },
				{ find: /^@earendil-works\/pi-ai\/oauth$/, replacement: aiSrcOAuth },
				{ find: /^@earendil-works\/pi-agent-core$/, replacement: agentSrcIndex },
				{ find: /^@earendil-works\/pi-tui$/, replacement: tuiSrcIndex },
				{ find: /^@mariozechner\/pi-ai$/, replacement: aiSrcIndex },
				{ find: /^@mariozechner\/pi-ai\/oauth$/, replacement: aiSrcOAuth },
				{ find: /^@mariozechner\/pi-agent-core$/, replacement: agentSrcIndex },
				{ find: /^@mariozechner\/pi-tui$/, replacement: tuiSrcIndex },
			]
		: [];

/** Every alias each vitest project shares. */
export const sharedAliases: readonly Alias[] = [
	{ find: /^@bastani\/atomic$/, replacement: atomicSrcIndex },
	...workspaceSourceAliases,
];

/** The base every vitest config in the repository merges with. */
export const baseConfig = { resolve: { alias: sharedAliases } };
