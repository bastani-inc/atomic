import type { SessionHistoryPage, SessionStore } from "./types.js";

export type HistoryPacketReader = (
	from: number,
	through: number,
	reverse: boolean,
) => Promise<SessionHistoryPage["items"]>;
type SnapshotPage = (
	sessionId: string,
	read: (epoch: string, lastSeq: number, packet: HistoryPacketReader) => Promise<SessionHistoryPage | undefined>,
) => Promise<SessionHistoryPage | undefined>;
const snapshots = new WeakMap<SessionStore, SnapshotPage>();
/** @internal A store that can size and return a page in the same snapshot needn't open it three times. */
export function registerHistorySnapshot(store: SessionStore, snapshot: SnapshotPage): void {
	snapshots.set(store, snapshot);
}
export function historySnapshotFor(store: SessionStore): SnapshotPage | undefined {
	return snapshots.get(store);
}
