/** Told how many entries the session a store is about to load holds, before the load reads any of them. */
export type HistoryLoadObserver = (entries: number) => void;

let observer: HistoryLoadObserver | undefined;

/**
 * Lets a host show that a long history is loading before the read blocks the process (#4660). One observer at a
 * time; the returned function removes it. A store that cannot tell its size beforehand does not call it.
 */
export function observeHistoryLoads(next: HistoryLoadObserver): () => void {
	observer = next;
	return () => {
		if (observer === next) observer = undefined;
	};
}

/** Tells the observer, if any. An observer that throws never fails the load it is about. */
export function announceHistoryLoad(entries: number): void {
	try {
		observer?.(entries);
	} catch {
		// A progress line is a courtesy: nothing it does may fail a load.
	}
}

export function hasHistoryLoadObserver(): boolean {
	return observer !== undefined;
}
