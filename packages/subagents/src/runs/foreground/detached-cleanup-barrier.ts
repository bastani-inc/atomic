/** Defers run-owned resource cleanup until every detached child closes. */
export interface DetachedCleanupBarrier {
	/** A child's execution ended. */
	readonly recover: (index: number) => void;
	/** The run returned while these children still execute; false when nothing holds cleanup back. */
	readonly defer: (indices: readonly number[]) => boolean;
	/** The run cleaned up on its own; nothing waits on this barrier any more. */
	readonly close: () => void;
}

interface RunWorktreeLifetime {
	readonly park: (index: number) => void;
	readonly unpark: (index: number) => void;
	readonly resume: (index: number) => void;
	readonly recover: (index: number) => void;
}

/** Worktree lifetimes of runs whose worktrees still exist, by run id. */
const runWorktrees = new Map<string, RunWorktreeLifetime>();

/**
 * With `runId`, run control reaches the run's worktree lifetime: a child stopped resumably keeps the worktrees, and a
 * resumed child rejoins the barrier, so they are never removed under a child that is live or can still resume.
 */
export function createDetachedCleanupBarrier(onReady: () => void, runId?: string): DetachedCleanupBarrier {
	const recovered = new Set<number>();
	/** Children paused, quit, or stopped by their stage's pause: they may resume in these worktrees. */
	const parked = new Set<number>();
	/** Children resumed after they stopped; cleanup waits for their new execution to end too. */
	const resumed = new Set<number>();
	let expected: ReadonlySet<number> | undefined;
	let cleaned = false;
	const end = () => {
		cleaned = true;
		if (runId && runWorktrees.get(runId) === lifetime) runWorktrees.delete(runId);
	};
	const finishIfReady = () => {
		if (cleaned || !expected || parked.size > 0) return;
		if (![...expected, ...resumed].every((index) => recovered.has(index))) return;
		end();
		onReady();
	};
	const lifetime: RunWorktreeLifetime = {
		park: (index) => parked.add(index),
		unpark(index) {
			parked.delete(index);
			finishIfReady();
		},
		resume(index) {
			parked.delete(index);
			recovered.delete(index);
			resumed.add(index);
		},
		recover(index) {
			recovered.add(index);
			finishIfReady();
		},
	};
	if (runId) runWorktrees.set(runId, lifetime);
	return {
		recover: lifetime.recover,
		defer(indices) {
			if (indices.length === 0 && parked.size === 0 && resumed.size === 0) {
				end();
				return false;
			}
			expected = new Set(indices);
			finishIfReady();
			return true;
		},
		close: end,
	};
}

/** A child stopped resumably: its run's worktrees stay until it resumes and ends, or can no longer resume. */
export function parkRunWorktree(runId: string, index: number): void {
	runWorktrees.get(runId)?.park(index);
}

/** A parked child can no longer resume, or was not stopped after all. */
export function unparkRunWorktree(runId: string, index: number): void {
	runWorktrees.get(runId)?.unpark(index);
}

/** A stopped child is resuming: its run's worktrees stay until its new execution ends. */
export function resumeRunWorktree(runId: string, index: number): void {
	runWorktrees.get(runId)?.resume(index);
}

/** A resumed child's execution ended, or it never started. */
export function recoverRunWorktree(runId: string, index: number): void {
	runWorktrees.get(runId)?.recover(index);
}
