/**
 * JobTracker — in-memory registry of live background run promises and
 * their AbortControllers.
 *
 * Source of truth for run snapshots/status remains the store.
 * JobTracker only holds the live Promise and AbortController so callers
 * can await completion or cancel without going through the store.
 *
 * cross-ref: spec detached-runner §job-tracker
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JobEntry {
	readonly runId: string;
	readonly controller: AbortController;
	/** Settles when the background run resolves or rejects. */
	readonly promise: Promise<void>;
}

export interface JobTracker {
	/**
	 * Register a background job. `promise` must be the background run promise
	 * (already void-cast; all rejections must be handled before registering).
	 *
	 * Registering over a still-active entry is a programming error: it would
	 * silently double-dispatch one run id. Detach the stale entry first.
	 */
	register(entry: JobEntry): void;
	/**
	 * Remove a job from the tracker (called on settle).
	 *
	 * When `expected` is supplied the entry is removed only if it is still the
	 * tracked one, so a stale executor settling late cannot evict the
	 * replacement that now owns this run id. Returns true when it removed.
	 */
	unregister(runId: string, expected?: JobEntry): boolean;
	/**
	 * Detach an abandoned entry from active-job lookup without cancelling or
	 * awaiting its promise.
	 *
	 * A quit that abandoned a callback leaves that executor alive but no longer
	 * authoritative: resume must be free to relaunch under the same run id.
	 */
	detach(runId: string, expected?: JobEntry): JobEntry | undefined;
	/** True if a live job exists for this runId. */
	has(runId: string): boolean;
	/** Return entry or undefined. */
	get(runId: string): JobEntry | undefined;
	/** All currently tracked runIds. */
	runIds(): string[];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class JobTrackerImpl implements JobTracker {
	private readonly _jobs = new Map<string, JobEntry>();

	register(entry: JobEntry): void {
		const existing = this._jobs.get(entry.runId);
		if (existing !== undefined && existing !== entry) {
			throw new Error(
				`atomic-workflows: a background job is already registered for run ${entry.runId}; detach the abandoned job before relaunching it`,
			);
		}
		this._jobs.set(entry.runId, entry);
	}

	unregister(runId: string, expected?: JobEntry): boolean {
		const existing = this._jobs.get(runId);
		if (existing === undefined) return false;
		if (expected !== undefined && existing !== expected) return false;
		this._jobs.delete(runId);
		return true;
	}

	detach(runId: string, expected?: JobEntry): JobEntry | undefined {
		const existing = this._jobs.get(runId);
		if (existing === undefined) return undefined;
		if (expected !== undefined && existing !== expected) return undefined;
		this._jobs.delete(runId);
		return existing;
	}

	has(runId: string): boolean {
		return this._jobs.has(runId);
	}

	get(runId: string): JobEntry | undefined {
		return this._jobs.get(runId);
	}

	runIds(): string[] {
		return Array.from(this._jobs.keys());
	}
}

// ---------------------------------------------------------------------------
// Factory + singleton
// ---------------------------------------------------------------------------

/**
 * Create an isolated JobTracker instance (useful for testing).
 */
export function createJobTracker(): JobTracker {
	return new JobTrackerImpl();
}

/**
 * Singleton tracker for the default runtime.
 */
export const jobTracker: JobTracker = createJobTracker();
