import type { SessionEntry, WorktreeSnapshotEntry } from "../../session-manager-types.ts";
import type { WorktreeSnapshot } from "../../worktree-snapshot/types.ts";
import { SessionConflictError } from "./errors.js";
import type {
	OversizedSessionEntry,
	SessionHistoryItem,
	SessionHistoryPage,
	SessionHistoryReadOptions,
	SessionStore,
} from "./types.js";
import { SESSION_HISTORY_SCAN_ENTRIES, yieldSessionTurn } from "./types.js";

/**
 * A session read at one cut, as `SessionManager.captureArchive()` captures it: its stored pages, the chunks of an
 * entry too large for a page, and the entries the manager holds by sequence, which take the place of the stored ones.
 */
export interface SnapshotArchiveCut {
	readonly held?: ReadonlyMap<number, SessionEntry>;
	pages(options?: SessionHistoryReadOptions): AsyncGenerator<SessionHistoryPage, void>;
	chunks(ref: OversizedSessionEntry, signal?: AbortSignal): AsyncGenerator<Uint8Array, void>;
	/**
	 * Where the session's snapshot entries are at this cut, as the store's index of its history locates them, or
	 * undefined when the store keeps no such index or it does not cover the cut. Readers then read {@link pages}.
	 */
	snapshotIndex?(options?: SnapshotIndexOptions): Promise<SnapshotArchiveIndex | undefined>;
}

export interface SnapshotIndexOptions {
	/** Only the entries on the branch from this stored sequence to the root. */
	readonly branchLeafSeq?: number;
	readonly signal?: AbortSignal;
}

/** Where a session's snapshot entries are at a cut, and how to read the stored entries there (#5554). */
export interface SnapshotArchiveIndex {
	/** The cut: no later entry is read. */
	readonly through: number;
	/**
	 * In ascending order, every stored entry through the cut, on the requested branch, that can be a snapshot entry: a
	 * superset, which a reader narrows by type.
	 */
	readonly seqs: readonly number[];
	/** The latest stored entry carrying each snapshot record, on any branch, by snapshot id; it can be past the cut. */
	readonly records: Readonly<Record<string, number>>;
	/**
	 * The stored entries at `seqs`, ascending, a page at a time: pages in ascending order, or with `backward` the last
	 * page first. Each page is chronological and holds at most `SESSION_HISTORY_PAGE_BYTES` bytes.
	 */
	read(
		seqs: readonly number[],
		options?: { readonly backward?: boolean; readonly signal?: AbortSignal },
	): AsyncGenerator<readonly SessionHistoryItem[], void>;
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

/**
 * The {@link SnapshotArchiveCut.snapshotIndex} of `store`'s session `sessionId` read at `through`, of generation `epoch`
 * (the store's own when undefined), or undefined when the store keeps no index of its snapshot entries. Its pages hold
 * up to {@link SESSION_HISTORY_SCAN_ENTRIES} entries, each read where the store's index places it.
 */
export function storeSnapshotIndex(
	store: SessionStore,
	sessionId: string,
	epoch: string | undefined,
	through: number,
): SnapshotArchiveCut["snapshotIndex"] {
	const { readSnapshotCut, readSelectedPage } = store;
	if (readSnapshotCut === undefined || readSelectedPage === undefined) return undefined;
	return async (options = {}) => {
		const { branchLeafSeq, signal } = options;
		signal?.throwIfAborted();
		const cut = await readSnapshotCut.call(
			store,
			sessionId,
			branchLeafSeq === undefined ? {} : { leafSeq: branchLeafSeq },
		);
		signal?.throwIfAborted();
		// Another generation, or a store holding less than the cut, is left to the pages, which reject it.
		if (cut === undefined || (epoch !== undefined && cut.epoch !== epoch) || cut.lastSeq < through) return undefined;
		const generation = cut.epoch;
		let end = cut.seqs.length;
		while (end > 0 && cut.seqs[end - 1]! > through) end--;
		return {
			through,
			seqs: end === cut.seqs.length ? cut.seqs : cut.seqs.slice(0, end),
			records: cut.records,
			async *read(seqs, { backward = false, signal } = {}) {
				for (let low = 0, high = seqs.length; low < high; ) {
					signal?.throwIfAborted();
					const window = backward
						? seqs.slice(Math.max(low, high - SESSION_HISTORY_SCAN_ENTRIES), high)
						: seqs.slice(low, Math.min(high, low + SESSION_HISTORY_SCAN_ENTRIES));
					const { items } = await readSelectedPage.call(store, sessionId, window, generation, {
						limit: SESSION_HISTORY_SCAN_ENTRIES,
						backward,
					});
					signal?.throwIfAborted();
					// The page is a run of the window from its start, or with `backward` from its end.
					const first = backward ? window.length - items.length : 0;
					if (items.length === 0 || items.some((item, position) => item.seq !== window[first + position]))
						throw new SessionConflictError(sessionId, through, items[0]?.seq ?? window[first]!);
					if (backward) high -= items.length;
					else low += items.length;
					yield items;
					if (low < high) await yieldSessionTurn();
				}
			},
		};
	};
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

/** The entry `item` holds or refers to, when it is a snapshot entry. */
async function snapshotEntryOf(
	cut: SnapshotArchiveCut,
	item: SessionHistoryItem,
	signal: AbortSignal | undefined,
): Promise<WorktreeSnapshotEntry | undefined> {
	const entry = "entry" in item ? item.entry : await oversizedSnapshotEntry(cut, item, signal);
	return entry?.type === "worktree_snapshot" ? entry : undefined;
}

/**
 * The snapshot entries at `index.seqs`, held or stored, a page at a time: only the stored entries the manager does not
 * hold are read, each where the index places it.
 */
async function* indexedSnapshotPages(
	cut: SnapshotArchiveCut,
	index: SnapshotArchiveIndex,
	backward: boolean,
	signal: AbortSignal | undefined,
): AsyncGenerator<readonly StoredWorktreeSnapshotEntry[], void> {
	const { seqs } = index;
	const held = cut.held;
	const stored = held === undefined ? seqs : seqs.filter((seq) => !held.has(seq));
	// The entries at seqs[from..to), the stored ones from `items`, in order.
	const pageOf = async (from: number, to: number, items: readonly SessionHistoryItem[]) => {
		const page: StoredWorktreeSnapshotEntry[] = [];
		let next = 0;
		for (let position = from; position < to; position++) {
			const seq = seqs[position]!;
			const local = held?.get(seq);
			const entry =
				local === undefined
					? await snapshotEntryOf(cut, items[next++]!, signal)
					: local.type === "worktree_snapshot"
						? local
						: undefined;
			if (entry !== undefined) page.push({ seq, entry });
		}
		return page;
	};
	// Positions in `seqs`: what is still to be visited is seqs[low..high).
	let low = 0;
	let high = seqs.length;
	for await (const items of index.read(stored, { backward, signal })) {
		let page: StoredWorktreeSnapshotEntry[];
		if (backward) {
			let from = high;
			while (from > low && seqs[from - 1]! >= items[0]!.seq) from--;
			page = await pageOf(from, high, items);
			high = from;
		} else {
			let to = low;
			while (to < high && seqs[to]! <= items.at(-1)!.seq) to++;
			page = await pageOf(low, to, items);
			low = to;
		}
		if (page.length > 0) yield page;
	}
	// What remains is held.
	const rest = await pageOf(low, high, []);
	if (rest.length > 0) yield rest;
}

/**
 * The `worktree_snapshot` entries of the session at `cut`, a page of the stored history at a time: nothing read is
 * kept once its page is consumed. A cut whose store keeps an index of them reads only those entries, in pages of up to
 * `SESSION_HISTORY_PAGE_BYTES` bytes. Rejects with the store's own error (`StorageUnavailableError` names the store's
 * adapter and location; `SessionNotFoundError` the session) when the history cannot be read.
 */
export async function* worktreeSnapshotPages(
	cut: SnapshotArchiveCut,
	options: WorktreeSnapshotPageOptions = {},
): AsyncGenerator<readonly StoredWorktreeSnapshotEntry[], void> {
	const { branchLeafSeq, direction, signal } = options;
	const index = await cut.snapshotIndex?.({
		...(branchLeafSeq === undefined ? {} : { branchLeafSeq }),
		...(signal === undefined ? {} : { signal }),
	});
	if (index !== undefined) {
		yield* indexedSnapshotPages(cut, index, direction === "backward", signal);
		return;
	}
	const read: SessionHistoryReadOptions = {
		...(branchLeafSeq === undefined ? {} : { branchLeafSeq }),
		...(direction === undefined ? {} : { direction }),
		...(signal === undefined ? {} : { signal }),
	};
	for await (const page of cut.pages(read)) {
		const items: StoredWorktreeSnapshotEntry[] = [];
		for (const item of page.items) {
			const local = cut.held?.get(item.seq);
			const entry = local === undefined ? await snapshotEntryOf(cut, item, signal) : local;
			if (entry?.type === "worktree_snapshot") items.push({ seq: item.seq, entry });
		}
		if (items.length > 0) yield items;
	}
}

/** Sets in `found` the record of each of `wanted` from the latest entry `pages`, read newest first, give it. */
async function latestRecords(
	pages: AsyncIterable<readonly StoredWorktreeSnapshotEntry[]>,
	wanted: ReadonlySet<string>,
	found: Map<string, { readonly seq: number; readonly snapshot: WorktreeSnapshot }>,
): Promise<void> {
	const missing = new Set(wanted);
	for await (const page of pages) {
		for (let index = page.length - 1; index >= 0; index--) {
			const { seq, entry } = page[index]!;
			if (entry.snapshot === undefined || !missing.has(entry.snapshotId)) continue;
			missing.delete(entry.snapshotId);
			if (seq > (found.get(entry.snapshotId)?.seq ?? 0))
				found.set(entry.snapshotId, { seq, snapshot: entry.snapshot });
		}
		if (missing.size === 0) break;
	}
}

/**
 * The record of each of `ids` the session holds, as the record map of its whole history gives it: from the latest
 * entry carrying it, on any branch, through the cut. A cut whose store keeps an index of snapshot records reads the
 * entry carrying each, and reads the store from its newest snapshot entry back only for a record entries past the cut
 * carry again; otherwise the store is read from its newest entry back, until every id is found. An id the session
 * never recorded is left out.
 */
export async function findWorktreeSnapshotRecords(
	cut: SnapshotArchiveCut,
	ids: Iterable<string>,
	options: { readonly signal?: AbortSignal } = {},
): Promise<Map<string, WorktreeSnapshot>> {
	const { signal } = options;
	const wanted = new Set(ids);
	const latest = new Map<string, { readonly seq: number; readonly snapshot: WorktreeSnapshot }>();
	if (wanted.size === 0) return new Map();
	const index = await cut.snapshotIndex?.(signal === undefined ? {} : { signal });
	if (index === undefined)
		await latestRecords(worktreeSnapshotPages(cut, { direction: "backward", signal }), wanted, latest);
	else {
		// Records the manager holds within the cut, which take the place of stored ones at their sequence.
		for (const [seq, entry] of cut.held ?? []) {
			if (seq > index.through || entry.type !== "worktree_snapshot" || entry.snapshot === undefined) continue;
			if (wanted.has(entry.snapshotId) && seq > (latest.get(entry.snapshotId)?.seq ?? 0))
				latest.set(entry.snapshotId, { seq, snapshot: entry.snapshot });
		}
		const carrying = new Map<number, string>();
		// Records an entry past the cut carries again, or whose entry the manager holds otherwise: read back from the cut.
		const earlier = new Set<string>();
		for (const id of wanted) {
			if (!Object.hasOwn(index.records, id)) continue;
			const seq = index.records[id]!;
			if (seq <= (latest.get(id)?.seq ?? 0)) continue;
			if (seq > index.through || cut.held?.has(seq) || carrying.has(seq)) earlier.add(id);
			else carrying.set(seq, id);
		}
		const seqs = [...carrying.keys()].sort((left, right) => left - right);
		for await (const items of index.read(seqs, signal === undefined ? {} : { signal }))
			for (const item of items) {
				const id = carrying.get(item.seq)!;
				const entry = await snapshotEntryOf(cut, item, signal);
				if (entry?.snapshotId === id && entry.snapshot !== undefined)
					latest.set(id, { seq: item.seq, snapshot: entry.snapshot });
				else earlier.add(id);
			}
		if (earlier.size > 0) await latestRecords(indexedSnapshotPages(cut, index, true, signal), earlier, latest);
	}
	// Newest first, as a read from the newest entry back finds them.
	return new Map(
		[...latest].sort(([, left], [, right]) => right.seq - left.seq).map(([id, { snapshot }]) => [id, snapshot]),
	);
}

/**
 * The patch and bundle content carried inline (base64, by SHA-256) by the session's snapshot entries for each of
 * `hashes`, as an imported session file carries it. The store is read from its newest snapshot entry back, until every
 * hash is found. A hash no entry carries is left out.
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
