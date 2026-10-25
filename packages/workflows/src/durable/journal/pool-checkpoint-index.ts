import type { SqliteExecutor, SqliteRow } from "@bastani/atomic/storage";
import { durableStageGroupKey } from "../stage-topology-validation.js";
import type { DurableCheckpoint, DurableStageCheckpoint } from "../types.js";
import { RUN_EVENT_TYPES } from "./types.js";

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

/** One transaction's read of a root's checkpoints; {@link commit} it only once that transaction has committed. */
export class PoolCheckpointRead {
	private pending?: () => void;
	constructor(
		private readonly index: PoolCheckpointIndex,
		private readonly root: string,
	) {}
	read(tx: SqliteExecutor, events: string): Promise<PoolCheckpointView> {
		return this.index.read(tx, events, this.root, (apply) => {
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
 * Per-root index of `CheckpointRecorded` events, so validating a pool mutation reads only the events recorded since
 * the previous validation instead of the root's whole history. Other connections may append checkpoints at any
 * time; each read catches up from the index's watermark inside the validating transaction. The index starts empty
 * and rebuilds lazily, and it rebuilds from the start when the event at its watermark is gone or replaced, which is
 * what deleting and recording a root again does.
 */
export class PoolCheckpointIndex {
	private readonly roots = new Map<string, RootCheckpoints>();

	begin(root: string): PoolCheckpointRead {
		return new PoolCheckpointRead(this, root);
	}

	async read(
		tx: SqliteExecutor,
		events: string,
		root: string,
		onCommit: (apply: () => void) => void,
	): Promise<PoolCheckpointView> {
		const current = this.roots.get(root);
		let base = current;
		const head = await tx.get<SqliteRow & { seq: number; key: string | null; at: number }>(
			`SELECT seq, key, at FROM ${events} WHERE run_id = ? ORDER BY seq DESC LIMIT 1`,
			root,
		);
		if (base && base.seq > 0) {
			const mark =
				head?.seq === base.seq
					? head
					: await tx.get(`SELECT key, at FROM ${events} WHERE run_id = ? AND seq = ?`, root, base.seq);
			if (!mark || mark.key !== base.key || Number(mark.at) !== base.at) base = undefined;
		}
		const from = base?.seq ?? 0;
		const to = head ? Number(head.seq) : 0;
		const delta = new Partitions();
		const added: IndexedEntry[] = [];
		if (to > from) {
			const rows = await tx.all<SqliteRow & { seq: number; key: string | null; payload: string }>(
				`SELECT seq, key, payload FROM ${events} WHERE run_id = ? AND seq > ? AND seq <= ? AND type = ? ORDER BY seq`,
				root,
				from,
				to,
				RUN_EVENT_TYPES.checkpointRecorded,
			);
			for (const row of rows) {
				const checkpoint = JSON.parse(String(row.payload)) as DurableCheckpoint;
				if (checkpoint.kind === "ui") continue;
				const entry = {
					seq: Number(row.seq),
					order: row.key === null ? Buffer.alloc(0) : Buffer.from(row.key, "utf8"),
					checkpoint,
				};
				delta.add(entry);
				added.push(entry);
			}
		}
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
			base.key = head?.key ?? null;
			base.at = Number(head?.at ?? 0);
		});
		return new PoolCheckpointView(base, from, delta);
	}
}
