import { ChildCatalog } from "./child-catalog.js";
import { SessionConflictError } from "./errors.js";
import { historyChunks } from "./history-pages.js";
import { treeOutlinePages } from "./tree-outline.js";
import type { ArchivedChildCatalogEntry, SessionStore } from "./types.js";

/** Read only child observations: an unopened owner does not need a model window, raw messages, saved
 * launch arguments or results just to paint a collapsed card. A snapshot-only adapter supplies its snapshot once. */
export async function readSessionChildCatalog(
	store: SessionStore,
	id: string,
	options: { signal?: AbortSignal } = {},
): Promise<readonly ArchivedChildCatalogEntry[]> {
	const { signal } = options;
	signal?.throwIfAborted();
	const catalog = new ChildCatalog();
	if (!store.readEntrySizes || !store.readEntryChunk) {
		const snapshot = await store.load(id);
		signal?.throwIfAborted();
		for (let i = 0; i < snapshot.entries.length; i++) catalog.add(snapshot.entries[i]!, i + 1);
		catalog.publish();
		return catalog.rows();
	}
	const head = await store.readEntrySizes(id, 1, 0);
	for await (const page of treeOutlinePages(store, id, head.epoch, head.lastSeq, signal)) {
		const targets = page.filter((row) => row.childRecord);
		if (!targets.length) continue;
		const meta = await store.readEntrySizes(id, targets[0]!.seq, targets.at(-1)!.seq);
		if (meta.epoch !== head.epoch || meta.lastSeq < head.lastSeq)
			throw new SessionConflictError(id, head.lastSeq, meta.lastSeq);
		for (const target of targets) {
			const size = meta.sizes.find((s) => s.seq === target.seq);
			if (!size) throw new SessionConflictError(id, head.lastSeq, meta.lastSeq);
			signal?.throwIfAborted();
			const { chunkedChildHeading } = await import("./chunked-resume-projection.js");
			const e = await chunkedChildHeading(
				historyChunks(
					store,
					id,
					head.epoch,
					{ kind: "oversized", sessionId: id, seq: target.seq, epoch: head.epoch, bytes: size.bytes },
					{ signal },
				),
			);
			catalog.add(e, target.seq);
		}
	}
	catalog.publish();
	return catalog.rows();
}
