import { AsyncLocalStorage } from "node:async_hooks";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { mapRestoredPath } from "../session-worktree-snapshots.ts";
import type { WorktreeRootMapping } from "../worktree-snapshot/types.ts";

/** The restores that apply to the paths resolved by the current work: its own, after those of any work it runs in. */
const scopedMappings = new AsyncLocalStorage<readonly WorktreeRootMapping[]>();

/** Whether `child` is `parent` or a path below it. */
export function isInside(parent: string, child: string): boolean {
	const path = relative(parent, child);
	return !path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path);
}

/**
 * Runs `work` with `mappings` (one session's or run's restores, oldest first) applying to the paths its tools resolve,
 * after the restores of the session or run it runs in. The restores of other sessions and runs never apply.
 */
export function withWorktreeRootMappings<T>(mappings: readonly WorktreeRootMapping[], work: () => T): T {
	return scopedMappings.run([...(scopedMappings.getStore() ?? []), ...mappings], work);
}

/**
 * `path` as it resolves for work in `cwd` under the restores of the current session or run: a path under a checkout it
 * recorded elsewhere (on another node, or a checkout it no longer uses here) moves to the same place in the worktree
 * that checkout was restored into, whether or not the old path exists here. Paths in a recorded checkout that `cwd` is
 * in are never redirected. Outside a session's or run's work, every path is returned unchanged.
 */
export function mapPathForCwd(path: string, cwd: string): string {
	const base = resolve(cwd);
	const mapped = mapRestoredPath(
		path,
		(scopedMappings.getStore() ?? []).filter((mapping) => !isInside(resolve(mapping.from), base)),
	);
	return mapped === resolve(path) ? path : mapped;
}
