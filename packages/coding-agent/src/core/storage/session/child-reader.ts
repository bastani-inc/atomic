import { ChildCatalog } from "./child-catalog.js";
import { SessionConflictError } from "./errors.js";
import { historyChunks, historyPages } from "./history-pages.js";
import { readSessionRange } from "./session-resume.js";
import { treeOutlinePages } from "./tree-outline.js";
import {
	type ArchivedChildCatalogEntry,
	SESSION_HISTORY_PAGE_ENTRIES,
	type SessionHistoryItem,
	type SessionResume,
	type SessionStore,
	type SessionStoredEntry,
} from "./types.js";

async function* headings(
	store: SessionStore,
	id: string,
	epoch: string,
	through: number,
	seqs: readonly number[],
	signal?: AbortSignal,
) {
	for (let at = 0; at < seqs.length; ) {
		signal?.throwIfAborted();
		let items: readonly SessionHistoryItem[];
		if (store.readSelectedPage)
			items = (await store.readSelectedPage(id, seqs.slice(at, at + SESSION_HISTORY_PAGE_ENTRIES), epoch)).items;
		else {
			let end = at + 1;
			while (end < seqs.length && end - at < SESSION_HISTORY_PAGE_ENTRIES && seqs[end] === seqs[end - 1]! + 1) end++;
			const p = await historyPages(store, id, epoch, through, {
				fromSeq: seqs[at],
				toSeq: seqs[end - 1],
				signal,
			}).next();
			items = p.done ? [] : p.value.items;
		}
		if (!items.length) throw new SessionConflictError(id, through, seqs[at]!);
		for (const item of items) {
			signal?.throwIfAborted();
			if (item.seq !== seqs[at++]) throw new SessionConflictError(id, through, item.seq);
			const entry =
				"entry" in item
					? ChildCatalog.headingOnly(item.entry)
					: await (await import("./chunked-resume-projection.js")).chunkedChildHeading(
							historyChunks(store, id, epoch, item, { signal }),
						);
			yield { seq: item.seq, entry };
		}
	}
}

/** A bounded native resume returns only addresses for historical child state. Ordinary pages are projected
 * before the next page is read; even a giant completed child's launch never enters the live window. */
export async function resolveDeferredChildren(store: SessionStore, resume: SessionResume) {
	const refs = resume.deferredChildren;
	if (!refs) return resume;
	const { id } = resume.header,
		{ epoch, lastSeq } = resume;
	const metadata: (SessionStoredEntry & { readonly onBranch: boolean })[] = [];
	let at = 0;
	for await (const h of headings(
		store,
		id,
		epoch,
		lastSeq,
		refs.positions.map((p) => p.seq),
	))
		metadata.push({ ...h, onBranch: refs.positions[at++]!.onBranch });
	const catalog = new ChildCatalog(),
		retired = catalog.retire(metadata, resume.branch);
	catalog.applyAliases(refs.aliases);
	const state = [...resume.state];
	for (const [i, row] of metadata.entries())
		if (!retired.has(row.entry.id)) {
			const source = await readSessionRange(store, id, row.seq, row.seq, epoch);
			if (source.lastSeq < lastSeq || source.epoch !== epoch || source.entries[0]?.id !== row.entry.id)
				throw new SessionConflictError(id, lastSeq, source.lastSeq);
			state.push({ seq: row.seq, entry: source.entries[0], onBranch: refs.positions[i]!.onBranch });
		}
	return { ...resume, state: state.sort((a, b) => a.seq - b.seq), deferredChildren: undefined, childArchive: catalog };
}

/** A collapsed card reads only the unopened owner's child observations, not its conversation window. */
export async function readSessionChildCatalog(
	store: SessionStore,
	id: string,
	options: { signal?: AbortSignal } = {},
): Promise<readonly ArchivedChildCatalogEntry[]> {
	const { signal } = options;
	signal?.throwIfAborted();
	const catalog = new ChildCatalog();
	if (store.readChildCatalogCut) {
		const cut = await store.readChildCatalogCut(id);
		for await (const { entry, seq } of headings(store, id, cut.epoch, cut.lastSeq, cut.seqs, signal))
			catalog.add(entry, seq);
		catalog.applyAliases(cut.aliases);
		return catalog.rows();
	}
	if (!store.readEntrySizes || !store.readEntryChunk) {
		const s = await store.load(id);
		signal?.throwIfAborted();
		for (let i = 0; i < s.entries.length; i++) catalog.add(s.entries[i]!, i + 1);
		catalog.publish();
		return catalog.rows();
	}
	const cut = await store.readEntrySizes(id, 1, 0);
	for await (const page of treeOutlinePages(store, id, cut.epoch, cut.lastSeq, signal)) {
		const seqs = page.filter((row) => row.childRecord).map((row) => row.seq);
		for await (const { entry, seq } of headings(store, id, cut.epoch, cut.lastSeq, seqs, signal))
			catalog.add(entry, seq);
	}
	catalog.publish();
	return catalog.rows();
}
