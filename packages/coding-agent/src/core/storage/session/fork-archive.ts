import type { SessionEntry } from "../../session-manager-types.ts";
import { assertSessionBlobStore, copySessionBlobs, sessionBlobHashes } from "../../session-tool-output.ts";
import { SessionConflictError } from "./errors.js";
import { JsonlSessionStore } from "./jsonl-session-store.js";
import type {
	ForkArchiveSource,
	SessionForkSeed,
	SessionRecordHeader,
	SessionStore,
	SessionWriteResult,
} from "./types.js";

/** A new child copy, never an update or a rewrite of the parent's session. A compatibility
 * adapter without an archive writer still receives the format it understands, not receipt stubs. */
export async function createForkArchive(
	store: SessionStore,
	header: SessionRecordHeader,
	entries: SessionForkSeed,
	source: ForkArchiveSource,
	location?: string,
): Promise<SessionWriteResult> {
	if (("read" in entries || source.receipts.size || source.hashes.length) && store.createFork) {
		const created = await store.createFork(header, entries, source, location);
		if (created) {
			const remaining = created.remainingBlobs ?? source.hashes;
			if (remaining.length) await copySessionBlobs(source.store, source.sessionId, store, header.id, remaining);
			return created;
		}
	}
	let rows: readonly SessionEntry[];
	if ("read" in entries) {
		// A custom create-only adapter owns the legacy array contract. Never install its compatibility
		// buffer on the live manager. First-party stores consume this same feed inside their publication scope.
		const held: SessionEntry[] = [],
			ids = new Set<string>();
		for await (const row of entries.read(source.store, async (id) => ids.has(id))) {
			let entry = row.entry;
			if (row.reference) {
				const ref = row.reference;
				const r = await source.store.readRange!(ref.sessionId, ref.seq, ref.seq, ref.epoch);
				if (r.epoch !== ref.epoch || r.entries[0]?.id !== entry.id)
					throw new SessionConflictError(ref.sessionId, ref.seq, r.lastSeq);
				entry = { ...r.entries[0], ...row.edits };
			}
			held.push(entry);
			ids.add(entry.id);
		}
		rows = held;
	} else rows = entries;
	if (source.receipts.size) {
		const copy: SessionEntry[] = [];
		for (const entry of rows) {
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
	const hashes = "read" in entries ? sessionBlobHashes(source.store, rows) : source.hashes;
	assertSessionBlobStore(store, header.id, hashes.length);
	const created = await (store instanceof JsonlSessionStore
		? store.create(header, rows, location)
		: store.create(header, rows));
	if (hashes.length) await copySessionBlobs(source.store, source.sessionId, store, header.id, hashes);
	return created;
}
