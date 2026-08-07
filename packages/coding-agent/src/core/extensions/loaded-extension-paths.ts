/**
 * The file-backed extension paths loaded in the current resource-loader cycle.
 *
 * A builtin inline extension sometimes has to stand down for a file extension
 * that does the same job — the Herdr reporter defers to a file-based
 * `herdr-agent-state` integration. Disk existence cannot answer that question:
 * a path can exist and still be disabled, shadowed, or fail to load. This
 * records what actually loaded, so a factory reads its own cycle's answer.
 *
 * The state is per cycle rather than per process. Loading yields to the event
 * loop between inline factories, and one process can run more than one loader —
 * in-process subagent sessions do exactly that. A single module-scope array let
 * a second cycle overwrite the first's answer mid-load, which could leave a pane
 * with two reporters or none. `AsyncLocalStorage` scopes the answer to the load
 * that produced it, so overlapping cycles cannot read each other's.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** The mutable answer for one load cycle. */
interface LoadedFileExtensionPathCycle {
	paths: readonly string[];
}

const cycleStorage = new AsyncLocalStorage<LoadedFileExtensionPathCycle>();

/**
 * The answer for callers outside any cycle.
 *
 * Direct callers — tests, and any host that records paths without going through
 * a loader entry point — still need somewhere to read and write.
 */
const fallbackCycle: LoadedFileExtensionPathCycle = { paths: [] };

function activeCycle(): LoadedFileExtensionPathCycle {
	return cycleStorage.getStore() ?? fallbackCycle;
}

/**
 * Run `load` inside a load cycle, reusing an enclosing one if there is one.
 *
 * Reuse matters: the pre-trust and post-trust loads of a single reload are
 * nested, and they must share one handle so a file extension discovered after
 * the inline factories ran is still visible to a factory that checks later.
 */
export function withLoadedFileExtensionPathCycle<T>(load: () => Promise<T>): Promise<T> {
	if (cycleStorage.getStore()) return load();
	return cycleStorage.run({ paths: [] }, load);
}

/** Record the file extensions loaded this cycle. Called before inline factories run. */
export function setLoadedFileExtensionPaths(paths: readonly string[]): void {
	const snapshot = [...paths];
	activeCycle().paths = snapshot;
	// Kept in step so a reader outside the cycle still sees the latest answer,
	// which is what the direct-call and test paths rely on.
	fallbackCycle.paths = snapshot;
}

/** The file extensions loaded in the current cycle. */
export function getLoadedFileExtensionPaths(): readonly string[] {
	return activeCycle().paths;
}

/**
 * The handle for the cycle in progress, captured so it can be re-read later.
 *
 * An inline factory that defers part of its decision — the Herdr reporter
 * re-checks stand-down at activation — must consult the cycle it was loaded by,
 * not whichever cycle happens to be current when the check runs.
 */
export function captureLoadedFileExtensionPathCycle(): LoadedFileExtensionPathCycle {
	return activeCycle();
}

/** Read a captured cycle's paths. */
export function loadedFileExtensionPathsOf(cycle: LoadedFileExtensionPathCycle): readonly string[] {
	return cycle.paths;
}

export type { LoadedFileExtensionPathCycle };
