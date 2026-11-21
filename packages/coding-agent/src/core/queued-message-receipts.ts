import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionManager } from "./session-manager.ts";
import { bindSessionFile, JsonlSessionStore } from "./storage/session/jsonl-session-store.js";
import { readSessionRange } from "./storage/session/session-resume.ts";
import type { SessionStore } from "./storage/session/types.js";

/** Which queued messages, saved with their receipt ids, a session's store holds (see `findQueuedMessages`). */
export interface QueuedMessagesFound {
	/** Found saved. */
	readonly saved: string[];
	/** Provably never saved. */
	readonly absent: string[];
}

/**
 * Whether what `store` holds once the process writing it has exited is final: its writes are made by that process to a
 * local file, so none can still land afterwards. A store reached over a connection (a database server) can still
 * commit a write sent before its writer died.
 */
export function writesEndWithWriter(store: SessionStore): boolean {
	const { adapter, location } = store.descriptor;
	return adapter === "jsonl" || (adapter === "node-sqlite" && location !== ":memory:");
}

/**
 * Which of the queued messages with receipt `ids` the session `manager` opened holds. Each was taken after the store
 * held its first `after` entries (of generation `epoch`), so it can only be saved after them, on any branch: every entry
 * stored after them is read, in the order they were stored. A message found is saved. One not found is absent only when
 * every one of those entries was read, the store is still of that generation, and its writes end with the engine that
 * was lost, which has exited; otherwise it is neither, so its sender does not know.
 */
export async function findQueuedMessages(
	manager: SessionManager,
	query: { readonly ids: readonly string[]; readonly after: number; readonly epoch?: string },
): Promise<QueuedMessagesFound> {
	const wanted = new Set(query.ids);
	const saved = new Set<string>();
	let complete = false;
	try {
		const watermark = await manager.forEachStoredEntry(query.after + 1, (entry) => {
			if (entry.type === "message" && entry.queuedMessageId !== undefined && wanted.has(entry.queuedMessageId))
				saved.add(entry.queuedMessageId);
		});
		complete = watermark >= query.after;
	} catch {
		// What a read that failed did not reach proves nothing; what it found is still found.
	}
	const certain =
		complete &&
		query.epoch !== undefined &&
		manager.getHistoryEpoch() === query.epoch &&
		writesEndWithWriter(manager.getSessionStore());
	// The lost engine wrote through a store of its own: its receipt says whether that store's writes ended with it.
	return { saved: [...saved], absent: certain ? query.ids.filter((id) => !saved.has(id)) : [] };
}

/** How many entries one read of a session nothing here has open takes. */
const STORE_SCAN_PAGE_ENTRIES = 512;

/**
 * As {@link findQueuedMessages}, for a session of `store` that nothing in this process has open, such as a subagent's:
 * the entries stored after the receipts' anchor are read from the store at once, in the order they were stored, and must
 * be all of them, of the generation the receipts name.
 */
export async function findQueuedMessagesInStore(
	store: SessionStore,
	sessionId: string,
	query: { readonly ids: readonly string[]; readonly after: number; readonly epoch?: string },
): Promise<QueuedMessagesFound> {
	const wanted = new Set(query.ids);
	const saved = new Set<string>();
	let complete = false;
	try {
		// Page by page, so a long session is read only as far as needed, and not at all once every message is found.
		for (let start = query.after + 1; saved.size < wanted.size; start += STORE_SCAN_PAGE_ENTRIES) {
			const end = start + STORE_SCAN_PAGE_ENTRIES - 1;
			const range = await readSessionRange(store, sessionId, start, end, query.epoch);
			if (query.epoch === undefined || range.epoch !== query.epoch || range.lastSeq < query.after) break;
			for (const entry of range.entries)
				if (entry.type === "message" && entry.queuedMessageId !== undefined && wanted.has(entry.queuedMessageId))
					saved.add(entry.queuedMessageId);
			const expected = Math.max(0, Math.min(end, range.lastSeq) - start + 1);
			if (range.entries.length !== expected) break;
			if (end >= range.lastSeq) {
				complete = true;
				break;
			}
		}
	} catch {
		// A session that cannot be read, or is of another generation, proves nothing missing.
	}
	const certain = complete && writesEndWithWriter(store);
	return { saved: [...saved], absent: certain ? query.ids.filter((id) => !saved.has(id)) : [] };
}

/**
 * As {@link findQueuedMessagesInStore}, for a session kept in its own session file, as a subagent's is: the file is read
 * where it is, and only when it is the session `sessionId` names.
 */
export async function findQueuedMessagesInFile(
	sessionFile: string,
	sessionId: string,
	query: { readonly ids: readonly string[]; readonly after: number; readonly epoch?: string },
): Promise<QueuedMessagesFound> {
	let store: JsonlSessionStore | undefined;
	try {
		// Only a file that is there is read: opening its store must not make its folder again.
		if (!(await stat(sessionFile)).isFile()) return { saved: [], absent: [] };
		store = await JsonlSessionStore.open(dirname(sessionFile), { exactDirectory: true, scanExisting: false });
		if ((await store.readHeaderFile(sessionFile)).id !== sessionId) return { saved: [], absent: [] };
		store[bindSessionFile](sessionId, sessionFile);
		return await findQueuedMessagesInStore(store, sessionId, query);
	} catch {
		// A file that cannot be read proves nothing.
		return { saved: [], absent: [] };
	} finally {
		await store?.close().catch(() => {});
	}
}
