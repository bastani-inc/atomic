import type { SessionEntry, WorktreeSnapshotEntry } from "../../session-manager-types.ts";
import type { WorktreeSnapshot } from "../../worktree-snapshot/types.ts";
import type { OversizedSessionEntry, SessionHistoryPage, SessionHistoryReadOptions } from "./types.js";

/**
 * A session read at one cut, as `SessionManager.captureArchive()` captures it: its stored pages, the chunks of an
 * entry too large for a page, and the entries the manager holds by sequence, which take the place of the stored ones.
 */
export interface SnapshotArchiveCut {
	readonly held?: ReadonlyMap<number, SessionEntry>;
	pages(options?: SessionHistoryReadOptions): AsyncGenerator<SessionHistoryPage, void>;
	chunks(ref: OversizedSessionEntry, signal?: AbortSignal): AsyncGenerator<Uint8Array, void>;
}

/** A stored `worktree_snapshot` entry and its sequence number. Callers must not change the entry. */
export interface StoredWorktreeSnapshotEntry {
	readonly seq: number;
	readonly entry: WorktreeSnapshotEntry;
}

export interface WorktreeSnapshotPageOptions {
	/** Only the entries on the branch from this stored sequence to the root. */
	readonly branchLeafSeq?: number;
	/** Order in which pages are visited. The entries within each page always remain chronological. */
	readonly direction?: "forward" | "backward";
	readonly signal?: AbortSignal;
}

/** The whole entry behind `reference`, when it is a snapshot entry; its type is read first, without its body. */
async function oversizedSnapshotEntry(
	cut: SnapshotArchiveCut,
	reference: OversizedSessionEntry,
	signal: AbortSignal | undefined,
): Promise<SessionEntry | undefined> {
	const { chunkedBranchState } = await import("./chunked-resume-projection.js");
	const { type } = await chunkedBranchState(() => cut.chunks(reference, signal));
	if (type !== "worktree_snapshot") return undefined;
	const decoder = new TextDecoder();
	let json = "";
	for await (const chunk of cut.chunks(reference, signal)) json += decoder.decode(chunk, { stream: true });
	return JSON.parse(json + decoder.decode()) as SessionEntry;
}

/**
 * The `worktree_snapshot` entries of the session at `cut`, a page of the stored history at a time: nothing read is
 * kept once its page is consumed. Rejects with the store's own error (`StorageUnavailableError` names the store's
 * adapter and location; `SessionNotFoundError` the session) when the history cannot be read.
 */
export async function* worktreeSnapshotPages(
	cut: SnapshotArchiveCut,
	options: WorktreeSnapshotPageOptions = {},
): AsyncGenerator<readonly StoredWorktreeSnapshotEntry[], void> {
	const { branchLeafSeq, direction, signal } = options;
	const read: SessionHistoryReadOptions = {
		...(branchLeafSeq === undefined ? {} : { branchLeafSeq }),
		...(direction === undefined ? {} : { direction }),
		...(signal === undefined ? {} : { signal }),
	};
	for await (const page of cut.pages(read)) {
		const items: StoredWorktreeSnapshotEntry[] = [];
		for (const item of page.items) {
			const entry =
				cut.held?.get(item.seq) ?? ("entry" in item ? item.entry : await oversizedSnapshotEntry(cut, item, signal));
			if (entry?.type === "worktree_snapshot") items.push({ seq: item.seq, entry });
		}
		if (items.length > 0) yield items;
	}
}

/**
 * The record of each of `ids` the session holds, as the record map of its whole history gives it: from the latest
 * entry carrying it, on any branch. The store is read from its newest entry back, until every id is found. An id
 * the session never recorded is left out.
 */
export async function findWorktreeSnapshotRecords(
	cut: SnapshotArchiveCut,
	ids: Iterable<string>,
	options: { readonly signal?: AbortSignal } = {},
): Promise<Map<string, WorktreeSnapshot>> {
	const wanted = new Set(ids);
	const found = new Map<string, WorktreeSnapshot>();
	if (wanted.size === 0) return found;
	for await (const page of worktreeSnapshotPages(cut, { direction: "backward", signal: options.signal })) {
		for (let index = page.length - 1; index >= 0; index--) {
			const { entry } = page[index]!;
			if (entry.snapshot !== undefined && wanted.has(entry.snapshotId) && !found.has(entry.snapshotId))
				found.set(entry.snapshotId, entry.snapshot);
		}
		if (found.size === wanted.size) break;
	}
	return found;
}

/**
 * The patch and bundle content carried inline (base64, by SHA-256) by the session's snapshot entries for each of
 * `hashes`, as an imported session file carries it. The store is read from its newest entry back, until every hash
 * is found. A hash no entry carries is left out.
 */
export async function findInlineSnapshotBlobs(
	cut: SnapshotArchiveCut,
	hashes: Iterable<string>,
	options: { readonly signal?: AbortSignal } = {},
): Promise<Map<string, string>> {
	const wanted = new Set(hashes);
	const found = new Map<string, string>();
	if (wanted.size === 0) return found;
	for await (const page of worktreeSnapshotPages(cut, { direction: "backward", signal: options.signal })) {
		for (let index = page.length - 1; index >= 0; index--) {
			for (const [hash, base64] of Object.entries(page[index]!.entry.blobs ?? {}))
				if (wanted.has(hash) && !found.has(hash)) found.set(hash, base64);
		}
		if (found.size === wanted.size) break;
	}
	return found;
}
