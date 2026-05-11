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
   */
  register(entry: JobEntry): void;
  /** Remove a job from the tracker (called on settle). */
  unregister(runId: string): void;
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
    this._jobs.set(entry.runId, entry);
  }

  unregister(runId: string): void {
    this._jobs.delete(runId);
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
