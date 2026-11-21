import type { SessionManager } from "./session-manager.ts";
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
		complete && manager.getHistoryEpoch() === query.epoch && writesEndWithWriter(manager.getSessionStore());
	// The lost engine wrote through a store of its own: its receipt says whether that store's writes ended with it.
	return { saved: [...saved], absent: certain ? query.ids.filter((id) => !saved.has(id)) : [] };
}
