/**
 * CancellationRegistry — tracks active run AbortControllers and children.
 *
 * Responsibilities:
 *   - register(runId, controller)        — attach primary controller for a run
 *   - registerChild(runId, controller)   — attach a subordinate controller
 *   - abort(runId, reason)               — abort primary + all children, returns true if found
 *   - abortAll(reason)                   — abort every registered run, returns count aborted
 *   - unregister(runId)                  — remove run from registry (after run ends)
 *   - isAborted(runId)                   — true if run's primary controller was aborted
 *
 * Does NOT kill processes; only signals abort to registered controllers.
 * cross-ref: spec §8.1 Phase D (kill-runtime-wiring downstream)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActiveRunEntry {
  readonly controller: AbortController;
  readonly children: AbortController[];
}

export interface CancellationRegistry {
  register(runId: string, controller: AbortController): void;
  registerChild(runId: string, controller: AbortController): void;
  abort(runId: string, reason?: unknown): boolean;
  abortAll(reason?: unknown): number;
  unregister(runId: string): void;
  isAborted(runId: string): boolean;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class CancellationRegistryImpl implements CancellationRegistry {
  private readonly _runs = new Map<string, ActiveRunEntry>();

  register(runId: string, controller: AbortController): void {
    // If already registered, replace (unregister old entry first without aborting)
    const existing = this._runs.get(runId);
    if (existing) {
      // Preserve children when re-registering same runId
      this._runs.set(runId, { controller, children: existing.children });
    } else {
      this._runs.set(runId, { controller, children: [] });
    }
  }

  registerChild(runId: string, controller: AbortController): void {
    const entry = this._runs.get(runId);
    if (!entry) {
      // No primary controller yet — create a placeholder entry with no primary
      // so children can still be tracked. Callers should call register() first.
      // Strict: throw to surface misuse.
      throw new Error(`CancellationRegistry: cannot registerChild for unknown runId "${runId}". Call register() first.`);
    }
    entry.children.push(controller);
  }

  abort(runId: string, reason?: unknown): boolean {
    const entry = this._runs.get(runId);
    if (!entry) return false;

    // Abort children first, then primary
    for (const child of entry.children) {
      if (!child.signal.aborted) {
        child.abort(reason);
      }
    }
    if (!entry.controller.signal.aborted) {
      entry.controller.abort(reason);
    }
    return true;
  }

  abortAll(reason?: unknown): number {
    let count = 0;
    for (const runId of this._runs.keys()) {
      if (this.abort(runId, reason)) count++;
    }
    return count;
  }

  unregister(runId: string): void {
    this._runs.delete(runId);
  }

  isAborted(runId: string): boolean {
    const entry = this._runs.get(runId);
    if (!entry) return false;
    return entry.controller.signal.aborted;
  }
}

// ---------------------------------------------------------------------------
// Factory + singleton
// ---------------------------------------------------------------------------

/**
 * Create an isolated CancellationRegistry instance (useful for testing).
 */
export function createCancellationRegistry(): CancellationRegistry {
  return new CancellationRegistryImpl();
}

/**
 * Singleton registry for the default runtime. Consumers needing isolation
 * should call createCancellationRegistry() instead.
 */
export const cancellationRegistry: CancellationRegistry = createCancellationRegistry();
