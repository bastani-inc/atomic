import {
	type SqliteExecutor,
	type SqliteRow,
	type SqliteValue,
	type StorageDialect,
	sqliteDialect,
	withJournalPayloads,
} from "@bastani/atomic/storage";
import { durableStageGroupKey } from "../stage-topology-validation.js";
import type { DurableCheckpoint, DurableStageCheckpoint } from "../types.js";
import { type JournalEntry, RUN_EVENT_TYPES } from "./types.js";

/** Every recorded checkpoint pool validation reads; UI checkpoints are never consulted. */
export type IndexedCheckpoint = Exclude<DurableCheckpoint, { kind: "ui" }>;

export interface IndexedEntry<T extends IndexedCheckpoint = IndexedCheckpoint> {
	readonly seq: number;
	/**
	 * The event key's UTF-8 bytes. Validation reads a root's checkpoints in the order SQLite returns
	 * `WHERE run_id = ? AND type = ?`, which walks the events' `UNIQUE(run_id, key)` index: binary key order.
	 */
	readonly order: Buffer;
	readonly checkpoint: T;
}

export type IndexedStage = IndexedEntry<DurableStageCheckpoint>;
type Stage = IndexedStage;

function push<T>(map: Map<string, T[]>, key: string | undefined, value: T): void {
	if (key === undefined) return;
	const list = map.get(key);
	if (list) list.push(value);
	else map.set(key, [value]);
}

/** One root's checkpoints, partitioned by every identity pool validation looks them up by. */
class Partitions {
	/** Stage and tool checkpoints by the run their topology names. */
	readonly byRun = new Map<string, IndexedEntry[]>();
	/** Boundary-start stage checkpoints by the child run they start. */
	readonly startsByChild = new Map<string, Stage[]>();
	/** Stage checkpoints by durable stage group (replay key, plus prompt occurrence). */
	readonly stagesByGroup = new Map<string, Stage[]>();
	/** Stage checkpoints by replay key. */
	readonly stagesByReplayKey = new Map<string, Stage[]>();
	/** Boundary stage checkpoints by stage id. */
	readonly boundariesByStageId = new Map<string, Stage[]>();
	/** Boundary stage checkpoints by the child run they belong to. */
	readonly boundariesByChild = new Map<string, Stage[]>();

	add(entry: IndexedEntry): void {
		const checkpoint = entry.checkpoint;
		push(this.byRun, checkpoint.topology?.run?.runId, entry);
		if (checkpoint.kind !== "stage") return;
		const stage = entry as Stage;
		push(this.stagesByGroup, durableStageGroupKey(checkpoint), stage);
		push(this.stagesByReplayKey, checkpoint.replayKey, stage);
		const boundary = checkpoint.topology?.boundary;
		if (!boundary) return;
		push(this.boundariesByStageId, checkpoint.topology?.stageId, stage);
		push(this.boundariesByChild, boundary.child?.runId, stage);
		if (boundary.event === "start") push(this.startsByChild, boundary.child?.runId, stage);
	}
}

export type PartitionName = Exclude<keyof Partitions, "add">;
type PartitionEntries<N extends PartitionName> = Partitions[N] extends Map<string, infer E> ? E : never;

/** A root's checkpoints committed up to `seq`, the root's latest event when they were read. */
interface RootCheckpoints {
	seq: number;
	key: string | null;
	at: number;
	readonly partitions: Partitions;
}

/** Binary key order, as SQLite's `UNIQUE(run_id, key)` index returns rows. */
export function inKeyOrder<T extends IndexedCheckpoint>(entries: Iterable<IndexedEntry<T>>): T[] {
	return [...new Set(entries)]
		.sort((left, right) => Buffer.compare(left.order, right.order) || left.seq - right.seq)
		.map((entry) => entry.checkpoint);
}

/**
 * The checkpoints a root had recorded when one transaction read them: the index's committed entries up to the
 * transaction's watermark, plus the rows the transaction read past it. Neither is visible to anyone else until the
 * transaction commits and {@link PoolCheckpointRead.commit} folds them in.
 */
export class PoolCheckpointView {
	constructor(
		private readonly base: RootCheckpoints | undefined,
		private readonly from: number,
		private readonly delta: Partitions,
	) {}
	entries<N extends PartitionName>(partition: N, key: string): PartitionEntries<N> {
		const committed = (this.base?.partitions[partition].get(key) ?? []).filter((entry) => entry.seq <= this.from);
		return [...committed, ...(this.delta[partition].get(key) ?? [])] as PartitionEntries<N>;
	}
}

/** What pool validation reads a root's recorded checkpoints through. */
export interface PoolCheckpointSource {
	read(tx: SqliteExecutor, events: string): Promise<PoolCheckpointView>;
}

/** One transaction's read of a root's checkpoints; {@link commit} it only once that transaction has committed. */
export class PoolCheckpointRead implements PoolCheckpointSource {
	private pending?: () => void;
	private prefetched?: PoolCheckpointPrefetch;
	constructor(
		private readonly index: PoolCheckpointIndex,
		private readonly root: string,
	) {}
	read(tx: SqliteExecutor, events: string): Promise<PoolCheckpointView> {
		const prefetched = this.prefetched;
		this.prefetched = undefined;
		return this.index.read(
			tx,
			events,
			this.root,
			(apply) => {
				this.pending = apply;
			},
			prefetched,
		);
	}
	/**
	 * Columns another query of the caller can select, so that the next {@link read} needs no request of its own: the
	 * root's latest event, the event at the index's watermark, and the checkpoints recorded since. Pass the row that
	 * query returned to {@link prefetch}.
	 */
	prefetchColumns(events: string): { readonly sql: string; readonly params: readonly SqliteValue[] } {
		return this.index.prefetchColumns(events, this.root);
	}
	prefetch(row: SqliteRow): void {
		// More checkpoints, or larger ones, than one row carries: the next read reads them itself.
		if (row.cp_added === null) {
			this.prefetched = undefined;
			return;
		}
		this.prefetched = {
			from: Number(row.cp_from),
			head: row.cp_head as string | null,
			mark: row.cp_mark as string | null,
			added: row.cp_added as string | null,
		};
	}
	/** Reads the root's checkpoints through a journal's own `read`, outside any transaction (see {@link PoolCheckpointIndex.readEntries}). */
	readEntries(stream: (fromSeq: number) => AsyncIterable<JournalEntry>): Promise<PoolCheckpointView> {
		return this.index.readEntries(this.root, stream, (apply) => {
			this.pending = apply;
		});
	}
	/** Fold what the transaction read into the index. Never call it for a transaction that rolled back. */
	commit(): void {
		this.pending?.();
		this.pending = undefined;
	}
}

/**
 * How many bytes of checkpoint payloads one page of {@link readCheckpointPages} asks for: well under what a database
 * server returns in one response (sqld refuses one past 10 MB).
 */
const CHECKPOINT_PAGE_BYTES = 2 * 1024 * 1024;

/**
 * The root's checkpoints after `from` up to `to`, in pages of about {@link CHECKPOINT_PAGE_BYTES}: a host that has
 * not read the root yet, as one that took over a child, reads them all, which in one response a server refuses
 * (#4768). Each page holds at least one checkpoint, however large.
 */
/** The event chunks table beside the events table `events`, as `runJournalTables` names both under one prefix. */
function eventChunksTable(events: string): string {
	return `${events.slice(0, -"events".length)}event_chunks`;
}

async function readCheckpointPages(
	tx: SqliteExecutor,
	events: string,
	root: string,
	from: number,
	to: number,
): Promise<(SqliteRow & { seq: number; key: string | null; payload: string })[]> {
	type Row = SqliteRow & { run_id: string; seq: number; key: string | null; payload: string; chunks: number };
	const rows: Row[] = [];
	for (let after = from; after < to; ) {
		// A checkpoint stored in chunks counts its stub here, and its chunks are read one statement each (#4965).
		const page = await tx.all<Row>(
			`SELECT run_id, seq, key, payload, chunks FROM (
				SELECT run_id, seq, key, payload, chunks, SUM(length(payload)) OVER (ORDER BY seq) - length(payload) AS before
				FROM ${events} WHERE run_id = ? AND seq > ? AND seq <= ? AND type = ?
			) WHERE before < ? ORDER BY seq`,
			root,
			after,
			to,
			RUN_EVENT_TYPES.checkpointRecorded,
			CHECKPOINT_PAGE_BYTES,
		);
		if (page.length === 0) break;
		rows.push(...(await withJournalPayloads(tx, eventChunksTable(events), page)));
		after = Number(page.at(-1)!.seq);
	}
	return rows;
}

/**
 * The most checkpoints a process keeps of its own commits past the index's watermark (see
 * {@link PoolCheckpointIndex.recordOwn}).
 */
const OWN_MAX = 64;

/** The root's latest event, as JSON a read selects. */
const headObject = (dialect: StorageDialect) =>
	dialect.jsonObject([
		["seq", "seq"],
		["key", "key"],
		["at", "at"],
	]);
/** The event at the index's watermark, as JSON a read selects. */
const markObject = (dialect: StorageDialect) =>
	dialect.jsonObject([
		["key", "key"],
		["at", "at"],
	]);

/** The most checkpoints, and bytes of their payloads, a commit's read carries for the checkpoint index. */
const PREFETCH_MAX_CHECKPOINTS = 64;
const PREFETCH_MAX_BYTES = 256 * 1024;

/** What {@link PoolCheckpointIndex.prefetchColumns} selected, as one row's columns. */
interface PoolCheckpointPrefetch {
	/** The watermark the columns were selected from. */
	readonly from: number;
	readonly head: string | null;
	readonly mark: string | null;
	/** `[seq, key, payload]` of each checkpoint after `from`, in order, as a JSON array. */
	readonly added: string | null;
}

/**
 * Per-root index of `CheckpointRecorded` events, so validating a pool mutation reads only the events recorded since
 * the previous validation instead of the root's whole history. Other connections may append checkpoints at any
 * time; each read catches up from the index's watermark inside the validating transaction. The index starts empty
 * and rebuilds lazily, and it rebuilds from the start when the event at its watermark is gone or replaced, which is
 * what deleting and recording a root again does.
 */
export class PoolCheckpointIndex {
	private readonly roots = new Map<string, RootCheckpoints>();
	/** Checkpoints this process committed for each root past the index's watermark, until a read folds them in. */
	private readonly own = new Map<string, IndexedEntry[]>();

	/** `dialect`: the journal database's, whose SQL the index's reads use. */
	constructor(private readonly dialect: StorageDialect = sqliteDialect) {}

	/**
	 * Notes a checkpoint this process committed as the root's event `seq` under `key`. Past {@link OWN_MAX} of them the
	 * root has no view without a read ({@link known}), and the read that plans the next commit folds them in: a process
	 * that commits for many workers of one root never reads otherwise, and kept every checkpoint it committed (#4768).
	 */
	recordOwn(root: string, seq: number, key: string, checkpoint: DurableCheckpoint): void {
		if (checkpoint.kind === "ui") return;
		const base = this.roots.get(root);
		if (base === undefined || seq <= base.seq) return;
		const entries = this.own.get(root) ?? [];
		if (entries.length >= OWN_MAX) return;
		entries.push({ seq, order: Buffer.from(key, "utf8"), checkpoint });
		this.own.set(root, entries);
	}

	/**
	 * The root's checkpoints as this process knows them without a read: the index's up to its watermark (`from`), plus
	 * those it committed itself since (`own`, by sequence). Undefined while the index holds none of the root's. What
	 * others recorded past `from` is missing: a writer that validates against this view fences on there being none in
	 * the scope it validates.
	 */
	known(
		root: string,
	): { readonly source: PoolCheckpointSource; readonly from: number; readonly own: readonly number[] } | undefined {
		const base = this.roots.get(root);
		if (base === undefined || base.seq === 0) return undefined;
		const own = (this.own.get(root) ?? []).filter((entry) => entry.seq > base.seq);
		if (own.length >= OWN_MAX) return undefined;
		const delta = new Partitions();
		for (const entry of own) delta.add(entry);
		const view = new PoolCheckpointView(base, base.seq, delta);
		return { source: { read: async () => view }, from: base.seq, own: own.map((entry) => entry.seq) };
	}

	begin(root: string): PoolCheckpointRead {
		return new PoolCheckpointRead(this, root);
	}

	/**
	 * See {@link PoolCheckpointRead.prefetchColumns}. The checkpoints come along only while they are few and small
	 * ({@link PREFETCH_MAX_CHECKPOINTS}, {@link PREFETCH_MAX_BYTES}) and none is stored in chunks (#4965);
	 * otherwise `cp_added` is NULL. A queue that has not
	 * read the root yet, as on a host that just took over a child, would otherwise ask for every checkpoint of the root
	 * in one value, past what the database returns in one (#4768).
	 *
	 * Only the checkpoints within {@link PREFETCH_MAX_BYTES} go into the array: the database builds an aggregate from
	 * every row, even one the `CASE` around it discards. Built from all of them, the 64 checkpoints of 256 KiB a queue
	 * commits before it reads again made one value past the 5,000,000 bytes a libSQL server holds, and the commit after
	 * them failed.
	 */
	prefetchColumns(events: string, root: string): { readonly sql: string; readonly params: readonly SqliteValue[] } {
		const dialect = this.dialect;
		const from = this.roots.get(root)?.seq ?? 0;
		const added = `SELECT seq, key, payload, chunks FROM ${events} WHERE run_id = ? AND seq > ? AND type = ? ORDER BY seq LIMIT ${PREFETCH_MAX_CHECKPOINTS + 1}`;
		// Each checkpoint with the length of its payload and of those before it.
		const sized = `SELECT added.*, SUM(length(payload)) OVER (ORDER BY seq) AS through FROM (${added}) AS added ORDER BY seq`;
		const entry = `CASE WHEN through <= ${PREFETCH_MAX_BYTES} THEN ${dialect.jsonArray(["seq", "key", "payload"])} END`;
		return {
			sql: `CAST(? AS ${dialect.types.int}) AS cp_from,
			(SELECT ${headObject(dialect)} FROM ${events} WHERE run_id = ? ORDER BY seq DESC LIMIT 1) AS cp_head,
			(SELECT ${markObject(dialect)} FROM ${events} WHERE run_id = ? AND seq = ?) AS cp_mark,
			(SELECT CASE WHEN COUNT(*) <= ${PREFETCH_MAX_CHECKPOINTS} AND COALESCE(MAX(through), 0) <= ${PREFETCH_MAX_BYTES} AND COALESCE(MAX(chunks), 0) = 0
				THEN ${dialect.jsonGroupArray(entry, "seq")} END FROM (${sized}) AS sized) AS cp_added`,
			params: [from, root, root, from, root, from, RUN_EVENT_TYPES.checkpointRecorded],
		};
	}

	async read(
		tx: SqliteExecutor,
		events: string,
		root: string,
		onCommit: (apply: () => void) => void,
		prefetched?: PoolCheckpointPrefetch,
	): Promise<PoolCheckpointView> {
		const current = this.roots.get(root);
		let base = current;
		// Columns another query selected count only while the watermark they were selected from is still the index's.
		const usable = prefetched !== undefined && prefetched.from === (base?.seq ?? 0) ? prefetched : undefined;
		// The root's latest event and the one at the index's watermark, in one read: a remote database answers each
		// read as a request of its own.
		const marks =
			usable ??
			(await tx.get<SqliteRow & { head: string | null; mark: string | null }>(
				`SELECT (SELECT ${headObject(this.dialect)} FROM ${events} WHERE run_id = ? ORDER BY seq DESC LIMIT 1) AS head,
			(SELECT ${markObject(this.dialect)} FROM ${events} WHERE run_id = ? AND seq = ?) AS mark`,
				root,
				root,
				base?.seq ?? 0,
			));
		const head =
			marks?.head == null ? undefined : (JSON.parse(marks.head) as { seq: number; key: string | null; at: number });
		if (base && base.seq > 0) {
			const mark = marks?.mark == null ? undefined : (JSON.parse(marks.mark) as { key: string | null; at: number });
			if (!mark || mark.key !== base.key || Number(mark.at) !== base.at) base = undefined;
		}
		const from = base?.seq ?? 0;
		const to = head ? Number(head.seq) : 0;
		const added: IndexedEntry[] = [];
		if (to > from) {
			// The prefetched checkpoints serve when they start at this read's watermark, which a reset to 0 moves.
			const rows =
				usable !== undefined && usable.from === from
					? (JSON.parse(usable.added ?? "[]") as [number, string | null, string][])
							.filter(([seq]) => seq <= to)
							.map(([seq, key, payload]) => ({ seq, key, payload }))
					: await readCheckpointPages(tx, events, root, from, to);
			for (const row of rows) {
				const checkpoint = JSON.parse(String(row.payload)) as DurableCheckpoint;
				if (checkpoint.kind === "ui") continue;
				added.push({
					seq: Number(row.seq),
					order: row.key === null ? Buffer.alloc(0) : Buffer.from(row.key, "utf8"),
					checkpoint,
				});
			}
		}
		return this.view(root, current, base, from, to, head, added, onCommit);
	}

	/**
	 * The same index over a journal that is not a SQL database in this transaction's reach, such as an adapter's
	 * remote one: the root's events are read through the journal's own `read`, from the index's watermark on.
	 */
	async readEntries(
		root: string,
		stream: (fromSeq: number) => AsyncIterable<JournalEntry>,
		onCommit: (apply: () => void) => void,
	): Promise<PoolCheckpointView> {
		const current = this.roots.get(root);
		let base = current;
		for (;;) {
			// The watermark as it is now, taken once: another commit's read folds into this same index while this one
			// waits on the journal, and moves the live watermark under it. Verifying against the moved one would
			// mistake an event it has not checked for the one it has, and its rows would be counted twice.
			const mark = base !== undefined && base.seq > 0 ? { seq: base.seq, key: base.key, at: base.at } : undefined;
			let verified = mark === undefined;
			let mismatch = false;
			let head: { seq: number; key: string | null; at: number } | undefined;
			const added: IndexedEntry[] = [];
			for await (const entry of stream(mark === undefined ? 1 : mark.seq)) {
				if (mark !== undefined && entry.seq === mark.seq) {
					if ((entry.key ?? null) !== mark.key || entry.at !== mark.at) {
						mismatch = true;
						break;
					}
					verified = true;
					head = { seq: entry.seq, key: entry.key ?? null, at: entry.at };
					continue;
				}
				head = { seq: entry.seq, key: entry.key ?? null, at: entry.at };
				if (entry.event.type !== RUN_EVENT_TYPES.checkpointRecorded) continue;
				const checkpoint = entry.event.payload as unknown as DurableCheckpoint;
				if (checkpoint.kind === "ui") continue;
				added.push({
					seq: entry.seq,
					order: entry.key === undefined ? Buffer.alloc(0) : Buffer.from(entry.key, "utf8"),
					checkpoint,
				});
			}
			// A watermark the journal no longer has, or has replaced, means the root was deleted and recorded again.
			if (mark !== undefined && (mismatch || !verified)) {
				base = undefined;
				continue;
			}
			return this.view(root, current, base, mark?.seq ?? 0, head?.seq ?? 0, head, added, onCommit);
		}
	}

	private view(
		root: string,
		current: RootCheckpoints | undefined,
		base: RootCheckpoints | undefined,
		from: number,
		to: number,
		head: { key: string | null; at: number | string } | undefined,
		added: readonly IndexedEntry[],
		onCommit: (apply: () => void) => void,
	): PoolCheckpointView {
		const delta = new Partitions();
		for (const entry of added) delta.add(entry);
		onCommit(() => {
			const latest = this.roots.get(root);
			if (!base) {
				if (latest !== current) return;
				const fresh: RootCheckpoints = {
					seq: to,
					key: head?.key ?? null,
					at: Number(head?.at ?? 0),
					partitions: delta,
				};
				this.roots.set(root, fresh);
				return;
			}
			if (latest !== base || to <= base.seq) return;
			for (const entry of added) if (entry.seq > base.seq) base.partitions.add(entry);
			base.seq = to;
			const own = this.own.get(root)?.filter((entry) => entry.seq > to);
			if (own?.length) this.own.set(root, own);
			else this.own.delete(root);
			base.key = head?.key ?? null;
			base.at = Number(head?.at ?? 0);
		});
		return new PoolCheckpointView(base, from, delta);
	}
}
