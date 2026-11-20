import type { SessionHistoryPage, SessionHistoryReadOptions, SessionStore } from "./types.js";

export type HistoryPacketReader = (
	from: number,
	through: number,
	reverse: boolean,
) => Promise<SessionHistoryPage["items"]>;
type SnapshotPage = (
	sessionId: string,
	read: (epoch: string, lastSeq: number, packet: HistoryPacketReader) => Promise<SessionHistoryPage | undefined>,
) => Promise<SessionHistoryPage | undefined>;
export interface ReferenceCut {
	store: SessionStore;
	sessionId: string;
	epoch: string;
	through: number;
}
const watchers = new WeakMap<SessionHistoryReadOptions, (cut: ReferenceCut) => void>();
const metadataReads = new WeakSet<SessionHistoryReadOptions>();
export function referenceMetadataRead(options: SessionHistoryReadOptions): boolean {
	return metadataReads.has(options);
}
/** @internal Bind a reference-only lookup to the very snapshot underlying the first returned packet. The
 * public page itself has no route back to the store or manager. */
export function watchReferenceCut(
	options: SessionHistoryReadOptions,
	capture: (cut: ReferenceCut) => void,
	metadataOnly = false,
): void {
	watchers.set(options, capture);
	if (metadataOnly) metadataReads.add(options);
}
export function observeReferenceCut(
	options: SessionHistoryReadOptions,
	store: SessionStore,
	sessionId: string,
	epoch: string | undefined,
	through: number,
): void {
	const watch = watchers.get(options);
	if (epoch !== undefined && watch) {
		watchers.delete(options);
		watch({ store, sessionId, epoch, through });
	}
}
const snapshots = new WeakMap<SessionStore, SnapshotPage>();
/** @internal A store that can size and return a page in the same snapshot needn't open it three times. */
export function registerHistorySnapshot(store: SessionStore, snapshot: SnapshotPage): void {
	snapshots.set(store, snapshot);
}
export function historySnapshotFor(store: SessionStore): SnapshotPage | undefined {
	return snapshots.get(store);
}
