import type { SessionSnapshot, SessionStore } from "./types.js";

type Load = SessionStore["load"];
export type SnapshotObserver = (
	store: SessionStore,
	snapshot: SessionSnapshot,
	load: Load,
	row: object,
	key: "epoch" | "revision",
) => void;
// Storage does not depend on the task host or its async context. Only an authenticated native loader may report a read.
const nativeLoads = new WeakMap<Load, SnapshotObserver | null>();

export function registerArchiveLoad(load: Load): Load {
	nativeLoads.set(load, null);
	return load;
}

export function observeArchiveLoad(load: Load, observer: SnapshotObserver): boolean {
	const current = nativeLoads.get(load);
	if (current === null) nativeLoads.set(load, observer);
	return current === null || current === observer;
}

export function noteSnapshotGeneration(
	store: SessionStore,
	snapshot: SessionSnapshot,
	load: Load,
	row: object,
	key: "epoch" | "revision",
): SessionSnapshot {
	nativeLoads.get(load)?.(store, snapshot, load, row, key);
	return snapshot;
}
