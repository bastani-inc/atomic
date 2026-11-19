import type { SessionEntry } from "../../session-manager-types.ts";
import { copySessionBlobs } from "../../session-tool-output.js";
import { SessionConflictError } from "./errors.js";
import { JsonlSessionStore } from "./jsonl-session-store.js";
import type { ForkArchiveSource, SessionRecordHeader, SessionStore, SessionWriteResult } from "./types.js";

/** A new child copy, never an update or a rewrite of the parent's session. A compatibility
 * adapter without an archive writer still receives the format it understands, not receipt stubs. */
export async function createForkArchive(
	store: SessionStore,
	header: SessionRecordHeader,
	entries: readonly SessionEntry[],
	source: ForkArchiveSource,
	location?: string,
): Promise<SessionWriteResult> {
	if ((source.receipts.size || source.hashes.length) && store.createFork) {
		const created = await store.createFork(header, entries, source, location);
		if (created) {
			const remaining = created.remainingBlobs ?? source.hashes;
			if (remaining.length) await copySessionBlobs(source.store, source.sessionId, store, header.id, remaining);
			return created;
		}
	}
	let rows = entries;
	if (source.receipts.size) {
		const copy: SessionEntry[] = [];
		for (const entry of entries) {
			const ref = source.receipts.get(entry.id);
			if (!ref) {
				copy.push(entry);
				continue;
			}
			const read = await source.store.readRange!(ref.sessionId, ref.seq, ref.seq, ref.epoch);
			if (
				read.epoch !== ref.epoch ||
				read.startSeq !== ref.seq ||
				read.entries.length !== 1 ||
				read.entries[0]!.id !== entry.id
			)
				throw new SessionConflictError(ref.sessionId, ref.seq, read.lastSeq);
			copy.push(read.entries[0]!);
		}
		rows = copy;
	}
	const created = await (store instanceof JsonlSessionStore
		? store.create(header, rows, location)
		: store.create(header, rows));
	if (source.hashes.length) await copySessionBlobs(source.store, source.sessionId, store, header.id, source.hashes);
	return created;
}
