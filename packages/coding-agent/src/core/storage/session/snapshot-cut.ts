import { Hash } from "fast-sha256";
import { SessionConflictError } from "./errors.js";
import {
	type OversizedSessionEntry,
	SESSION_HISTORY_CHUNK_BYTES,
	SESSION_HISTORY_PAGE_BYTES,
	SESSION_HISTORY_PAGE_ENTRIES,
	type SessionHistoryItem,
	type SessionSnapshot,
	type SessionStore,
} from "./types.js";

/** Snapshot-only adapters need not version replacements. Pin their observed prefix for reads only;
 * never send a fabricated epoch in a write. */
export function snapshotStamp(snapshot: SessionSnapshot, through = snapshot.lastSeq): string {
	if (snapshot.epoch !== undefined) return snapshot.epoch;
	const enc = new TextEncoder(),
		hash = new Hash().update(enc.encode(JSON.stringify(snapshot.header))),
		sep = Uint8Array.of(10);
	for (let i = 0; i < through; i++) hash.update(sep).update(enc.encode(JSON.stringify(snapshot.entries[i])));
	return `snapshot/${through}/${Buffer.from(hash.digest()).toString("base64url")}`;
}
export function assertSnapshotCut(snapshot: SessionSnapshot, expected: string | undefined, through: number) {
	const count =
		expected !== undefined && snapshot.epoch === undefined
			? Number(/^snapshot\/(\d+)\//.exec(expected)?.[1])
			: through;
	if (
		snapshot.lastSeq < through ||
		(expected !== undefined &&
			(!Number.isSafeInteger(count) || count > snapshot.lastSeq || snapshotStamp(snapshot, count) !== expected))
	)
		throw new SessionConflictError(snapshot.header.id, through, snapshot.lastSeq);
}
export async function snapshotHead(store: SessionStore, id: string) {
	const s = await store.load(id);
	return { header: s.header, epoch: snapshotStamp(s), lastSeq: s.lastSeq };
}
export async function snapshotPage(
	store: SessionStore,
	id: string,
	from: number,
	to: number,
	reverse: boolean,
	through: number,
	expected?: string,
) {
	const snapshot = await store.load(id);
	assertSnapshotCut(snapshot, expected, through);
	const epoch = snapshotStamp(snapshot, through),
		items: SessionHistoryItem[] = [];
	let total = 0;
	for (
		let seq = reverse ? to : from;
		seq >= from && seq <= to && items.length < SESSION_HISTORY_PAGE_ENTRIES;
		seq += reverse ? -1 : 1
	) {
		const entry = snapshot.entries[seq - 1]!,
			bytes = Buffer.byteLength(JSON.stringify(entry));
		if (bytes > SESSION_HISTORY_PAGE_BYTES && !items.length) {
			items.push({ kind: "oversized", sessionId: id, seq, epoch, bytes });
			break;
		}
		if (total + bytes > SESSION_HISTORY_PAGE_BYTES) break;
		total += bytes;
		items.push({ seq, entry });
	}
	if (reverse) items.reverse();
	return { epoch, items };
}
export async function snapshotChunk(store: SessionStore, ref: OversizedSessionEntry, offset: number) {
	const s = await store.load(ref.sessionId);
	assertSnapshotCut(s, ref.epoch, ref.seq);
	const bytes = Buffer.from(JSON.stringify(s.entries[ref.seq - 1]));
	if (bytes.length !== ref.bytes) throw new SessionConflictError(ref.sessionId, ref.seq, s.lastSeq);
	return Uint8Array.from(bytes.subarray(offset, offset + SESSION_HISTORY_CHUNK_BYTES));
}
