import { isAbsolute, relative, resolve, sep } from "node:path";
import { asyncScope } from "../async-scope.ts";
import { mapRestoredPath, mapRestoredPathAsync } from "../session-worktree-snapshots.ts";
import type { PathContinuation, WorktreeRootMapping } from "../worktree-snapshot/types.ts";

/** The restores that apply to the paths resolved by the current work: its own, after those of any work it runs in. */
const scopedMappings = asyncScope<readonly WorktreeRootMapping[]>();

/** Where the current session continued instead of checkouts it worked in, which its file tools follow (#5379). */
const scopedContinuations = asyncScope<readonly PathContinuation[]>();

/** Whether `child` is `parent` or a path below it. */
export function isInside(parent: string, child: string): boolean {
	const path = relative(parent, child);
	return !path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path);
}

/** The restores that apply to work started here: those of the sessions and runs it runs in, outermost first. */
export function currentWorktreeRootMappings(): readonly WorktreeRootMapping[] {
	return scopedMappings.getStore() ?? [];
}

/**
 * Runs `work` with `mappings` (one session's or run's restores, oldest first) applying to the paths its tools resolve,
 * after `outer`: the restores of the sessions and runs the work belongs to, by default those of the work it runs in. A
 * checkout that `mappings` restores follows its own restore, never an outer one. The restores of other sessions and
 * runs never apply.
 */
export function withWorktreeRootMappings<T>(
	mappings: readonly WorktreeRootMapping[],
	work: () => T,
	outer: readonly WorktreeRootMapping[] = currentWorktreeRootMappings(),
	continuations?: readonly PathContinuation[],
): T {
	const restoredHere = new Set(mappings.map((mapping) => resolve(mapping.from)));
	const scoped = () =>
		scopedMappings.run([...outer.filter((mapping) => !restoredHere.has(resolve(mapping.from))), ...mappings], work);
	return continuations === undefined ? scoped() : scopedContinuations.run(continuations, scoped);
}

/** The notices of checkouts the current work's sessions and runs hold only part of, or continued without (#4738). */
const scopedRestoreNotices = asyncScope<readonly string[]>();

/**
 * The notices of the checkouts that the sessions and runs work started here runs in hold less of than their recorded
 * snapshots, or continued without (#4738), outermost first. A session opened here tells its model about them.
 */
export function currentWorktreeRestoreNotices(): readonly string[] {
	return scopedRestoreNotices.getStore() ?? [];
}

/**
 * Runs `work` with `notices`, one per checkout restored with less than its snapshot or not at all, after the outer ones;
 * a notice an outer run already gives is not repeated.
 */
export function withWorktreeRestoreNotices<T>(notices: readonly string[], work: () => T): T {
	const outer = currentWorktreeRestoreNotices();
	const added = notices.filter((notice) => !outer.includes(notice));
	if (added.length === 0) return work();
	return scopedRestoreNotices.run([...outer, ...added], work);
}

/**
 * `path` as it resolves for work in `cwd` under the restores of the current session or run: a path under a checkout it
 * recorded elsewhere (on another node, or a checkout it no longer uses here) moves to the same place in the worktree
 * that checkout was restored into, whether or not the old path exists here. Paths in a recorded checkout that `cwd` is
 * in are never redirected. Outside a session's or run's work, every path is returned unchanged.
 */
export function mapPathForCwd(path: string, cwd: string): string {
	const mapped = mapRestoredPath(path, mappingsForCwd(cwd));
	return mapped === resolve(path) ? path : mapped;
}

export async function mapPathForCwdAsync(path: string, cwd: string): Promise<string> {
	const mapped = await mapRestoredPathAsync(path, mappingsForCwd(cwd));
	return mapped === resolve(path) ? path : mapped;
}

/**
 * The restores, then the directories the session went on in instead of checkouts it worked in (#5379), that apply to
 * paths resolved in `cwd`: a path under a working directory the session left follows it to where it continued.
 */
function mappingsForCwd(cwd: string): readonly Pick<WorktreeRootMapping, "from" | "to">[] {
	const base = resolve(cwd);
	const applies = (mapping: Pick<WorktreeRootMapping, "from">) => !isInside(resolve(mapping.from), base);
	return [...currentWorktreeRootMappings().filter(applies), ...(scopedContinuations.getStore() ?? []).filter(applies)];
}
