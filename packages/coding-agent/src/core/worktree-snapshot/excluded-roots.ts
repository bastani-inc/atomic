const EXCLUDED_ROOTS = Symbol.for("atomic-coding-agent/worktree-snapshot-excluded-roots@1");

type ExcludedRootsSlot = { [EXCLUDED_ROOTS]?: readonly string[] };

/**
 * Keeps worktree snapshots out of the checkouts at `roots`: a snapshot Git command whose working directory is one of
 * them, or lies below one, fails with `not-a-repository` before any Git runs, as outside every repository, so nothing
 * there is captured, verified or restored. Returns the previous roots so callers can restore them. The repository's
 * test suites exclude the checkout they run from (#4414). Not part of the public API.
 *
 * The roots live in a process-wide slot rather than in this module, so they hold for every copy of the snapshot
 * modules in the process, including copies a test runner evaluates again after resetting its module registry.
 */
export function setWorktreeSnapshotExcludedRootsForTest(roots: readonly string[]): readonly string[] {
	const slot = globalThis as ExcludedRootsSlot;
	const previous = slot[EXCLUDED_ROOTS] ?? [];
	slot[EXCLUDED_ROOTS] = Object.freeze([...roots]);
	return previous;
}

/** The roots {@link setWorktreeSnapshotExcludedRootsForTest} set: none unless a test excluded some. */
export function worktreeSnapshotExcludedRoots(): readonly string[] {
	return (globalThis as ExcludedRootsSlot)[EXCLUDED_ROOTS] ?? [];
}
