import { createLabelEntry } from "../../session-manager-entries.ts";
import { SessionEntryError } from "../../session-manager-errors.js";
import { historyPages, readSessionHistoryChunks } from "./history-pages.js";
import type { SessionForkRow, SessionForkStream, SessionHistoryItem, SessionStore } from "./types.js";

async function forkRow(reader: SessionStore, item: SessionHistoryItem): Promise<SessionForkRow> {
	if ("entry" in item) return { entry: item.entry };
	const { forkSeedFields } = await import("./chunked-resume-projection.js");
	return { ...(await forkSeedFields(() => readSessionHistoryChunks(reader, item))), reference: item };
}

/** The SDK/CLI same-store clone keeps the original append log, including abandoned branches,
 * raw labels and recorded leaf moves. Unlike an interactive /fork it never edits structural links. */
export function completeSessionForkStream(id: string, epoch: string | undefined, through: number): SessionForkStream {
	return {
		kind: "complete-session",
		async *read(reader, _hasWritten, inlineSnapshot) {
			for await (const { items } of historyPages(reader, id, epoch, through, {}))
				for (const item of items) {
					if ("kind" in item && inlineSnapshot) {
						const entry = await inlineSnapshot(item);
						if (entry) {
							yield { entry, reference: item, inlineSnapshot: true };
							continue;
						}
					}
					yield await forkRow(reader, item);
				}
		},
	};
}

/** A human /fork is an archive of the complete selected path. Keep original IDs and chronological
 * order, remove historical label operations and append each copied target's latest label as main did. */
export function humanForkStream(
	id: string,
	epoch: string | undefined,
	through: number,
	leaf: number,
	leafId: string,
	labels: ReadonlyMap<string, string>,
	labelTimes: ReadonlyMap<string, string>,
): SessionForkStream {
	return {
		async *read(reader, hasWritten, inlineSnapshot) {
			const pages = (fromSeq: number, toSeq: number) =>
				historyPages(reader, id, epoch, through, { branchLeafSeq: leaf, fromSeq, toSeq });
			let previous: string | null = null,
				found = false;
			for await (const page of pages(1, leaf))
				for (const item of page.items) {
					const snapshot = "kind" in item ? await inlineSnapshot?.(item) : undefined;
					const row: SessionForkRow =
						snapshot && "kind" in item
							? { entry: snapshot, reference: item, inlineSnapshot: true }
							: await forkRow(reader, item);
					const entry = row.entry;
					if (item.seq === leaf && entry.id === leafId) found = true;
					if (entry.type === "label") continue;
					const edits: Record<string, string | null> = {};
					if (entry.parentId !== previous) edits.parentId = previous;
					if (
						entry.type === "compaction" &&
						entry.firstKeptEntryId &&
						!(await hasWritten(entry.firstKeptEntryId))
					) {
						const start = await reader.findEntrySeq?.(id, entry.firstKeptEntryId);
						if (start !== undefined && start < item.seq) {
							let target = false;
							search: for await (const earlier of pages(start, item.seq))
								for (const x of earlier.items) {
									const e = (await forkRow(reader, x)).entry;
									if (!target) {
										if (x.seq !== start || e.type !== "label" || e.id !== entry.firstKeptEntryId)
											break search;
										target = true;
									} else if (e.type !== "label") {
										edits.firstKeptEntryId = e.id;
										break search;
									}
								}
						}
					}
					previous = entry.id;
					yield Object.keys(edits).length ? { ...row, entry: { ...entry, ...edits }, edits } : row;
				}
			if (!found) throw new SessionEntryError(leafId, "missing");
			for (const [target, label] of labels) {
				if (!(await hasWritten(target))) continue;
				let e = createLabelEntry(target, label, new Set(), previous, labelTimes.get(target));
				while (await hasWritten(e.id))
					e = createLabelEntry(target, label, new Set(), previous, labelTimes.get(target));
				previous = e.id;
				yield { entry: e };
			}
		},
	};
}
