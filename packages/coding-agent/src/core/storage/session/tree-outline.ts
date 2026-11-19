import { yieldToEventLoop } from "../../../utils/event-loop.js";
import type { SessionEntry } from "../../session-manager-types.ts";
import { SessionConflictError } from "./errors.js";
import { historyChunks } from "./history-pages.js";
import { SESSION_HISTORY_PAGE_ENTRIES, type SessionStore, type SessionTreeOutlineEntry } from "./types.js";

/** The shape needed for the unfiltered tree; preview text is never part of a navigation record. */
export function treeOutlineEntry(seq: number, entry: SessionEntry): SessionTreeOutlineEntry {
	const { id, parentId, timestamp, type } = entry;
	const base = { seq, id, parentId, timestamp, type };
	if (type === "label") return { ...base, labelTarget: entry.targetId, label: entry.label?.slice(0, 128) };
	if (type === "custom" && entry.customType === "atomic.leaf") return { ...base, leafMove: true };
	if (type !== "message") return base;
	const msg = entry.message;
	const hidden =
		msg.role === "assistant" &&
		(!msg.stopReason || msg.stopReason === "stop" || msg.stopReason === "toolUse") &&
		!msg.content.some((block) => block?.type === "text" && block.text?.trim());
	return { ...base, role: msg.role, ...(hidden ? { hideAssistant: true } : {}) };
}

/** Snapshot adapters necessarily deliver whole objects; native stores project headers in SQL or stream the
 * structural fields from their bytes. Neither path adds an archive entry to a live manager. */
export async function* treeOutlinePages(
	store: SessionStore,
	id: string,
	epoch: string | undefined,
	through: number,
	signal?: AbortSignal,
): AsyncGenerator<readonly SessionTreeOutlineEntry[], void> {
	for (let from = 1; from <= through; from += SESSION_HISTORY_PAGE_ENTRIES) {
		signal?.throwIfAborted();
		const end = Math.min(through, from + SESSION_HISTORY_PAGE_ENTRIES - 1);
		let rows: readonly (SessionTreeOutlineEntry | { readonly seq: number; readonly streamed: true })[];
		if (store.readTreeOutline) rows = await store.readTreeOutline(id, from, end, epoch);
		else if (store.readEntrySizes && store.readEntryChunk)
			rows = Array.from({ length: end - from + 1 }, (_, i) => ({ seq: from + i, streamed: true as const }));
		else {
			const { snapshotOutline } = await import("./snapshot-history.js");
			rows = await snapshotOutline(store, id, from, end, epoch);
		}
		const page: SessionTreeOutlineEntry[] = [];
		let sizes: Awaited<ReturnType<NonNullable<SessionStore["readEntrySizes"]>>> | undefined;
		for (const row of rows) {
			signal?.throwIfAborted();
			if (!("streamed" in row)) {
				page.push(row);
				continue;
			}
			sizes ??= await store.readEntrySizes!(id, from, end);
			if ((epoch !== undefined && sizes.epoch !== epoch) || sizes.lastSeq < through)
				throw new SessionConflictError(id, through, sizes.lastSeq);
			const size = sizes.sizes.find((item) => item.seq === row.seq);
			if (!size) throw new SessionConflictError(id, through, sizes.lastSeq);
			const chunks = historyChunks(
				store,
				id,
				sizes.epoch,
				{ kind: "oversized", sessionId: id, seq: row.seq, epoch: sizes.epoch, bytes: size.bytes },
				{ signal },
			);
			page.push(await (await import("./chunked-resume-projection.js")).chunkedTreeOutline(row.seq, chunks));
		}
		signal?.throwIfAborted();
		yield page;
		if (end < through) await yieldToEventLoop();
	}
}
