import { durableHash } from "../durable-hash.js";
import type { DurableCheckpoint } from "../types.js";
import type { SqlPoolStorage } from "./internal.js";
import {
	type AppendOutcome,
	type JournalEntry,
	type Lease,
	RUN_EVENT_TYPES,
	type RunEvent,
	type RunJournal,
	RunNotFoundError,
	StaleLeaseError,
} from "./types.js";
import { serializeJson } from "./values.js";

/** How long a pool process trusts its copy of the root's run status and lease before reading the journal again. */
const MIRROR_FRESH_MS = 2_000;

/**
 * A root's durable journal that lives outside the database holding the pool's tables, such as a libSQL database or
 * any other run-journal adapter, as the pool sees it.
 *
 * The pool's work queue, leases, usage, admission permits and pooled-stage sessions stay in a local SQLite database
 * (the coordination database), because every worker is a child process of one coordinator on one machine. Its queue
 * decides who may act from the root's run status and lease, which a journal in another database cannot join in a
 * transaction. This class keeps a copy of both in the coordination database (the run row and the lease row the queue
 * reads), refreshed from the durable journal, and writes the root's checkpoint events through the journal's own,
 * idempotent `append`. The queue orders those two writes so that a crash between them is recovered (see
 * `SqlPoolQueue.commit`).
 */
export class PoolRemoteJournal {
	private mirrored: { readonly lease: Lease; readonly at: number } | undefined;
	private mirroring: Promise<void> | undefined;

	constructor(
		readonly journal: RunJournal,
		private readonly storage: SqlPoolStorage,
	) {}

	/**
	 * Makes the coordination database's run and lease rows for the root equal the durable journal's: its status, and
	 * who holds its lease, at which epoch, last renewed how long ago on the journal's own clock. Throws
	 * {@link StaleLeaseError}, after writing the rows, when `lease` is not the one the journal holds: the pool's queue
	 * then refuses everything the old holder asks.
	 */
	async mirror(lease: Lease): Promise<void> {
		const root = lease.runId;
		const [run, state] = await Promise.all([this.journal.getRun(root), this.journal.leaseState(root)]);
		if (run === undefined) throw new RunNotFoundError(root);
		const { runs, leases } = this.storage.tables;
		await this.storage.transaction(async (tx) => {
			await tx.run(
				`INSERT INTO ${runs}(run_id, name, cwd, created_at, status, header_json) VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT(run_id) DO UPDATE SET status = excluded.status`,
				root,
				run.name,
				run.cwd,
				run.createdAt,
				run.status,
				serializeJson({ runId: root, name: run.name, cwd: run.cwd, createdAt: run.createdAt, status: run.status }),
			);
			if (state === undefined) await tx.run(`DELETE FROM ${leases} WHERE run_id = ?`, root);
			else
				await tx.run(
					`INSERT INTO ${leases}(run_id, holder_id, epoch, renewed_at) VALUES (?, ?, ?, CAST(unixepoch('subsec') * 1000 AS INTEGER) - ?)
					ON CONFLICT(run_id) DO UPDATE SET holder_id = excluded.holder_id, epoch = excluded.epoch, renewed_at = excluded.renewed_at`,
					root,
					state.holderId,
					state.epoch,
					Math.max(0, state.ageMs),
				);
		});
		if (state === undefined || state.holderId !== lease.holderId || state.epoch !== lease.epoch)
			throw new StaleLeaseError(root, lease.epoch, state?.epoch ?? 0);
		this.mirrored = { lease, at: performance.now() };
	}

	/**
	 * {@link mirror}, unless it ran within `maxAgeMs` for this lease. Calls in flight together share one read. A journal
	 * that cannot be reached is not an error here: the last mirror stays, and the lease it shows lapses on its own if
	 * the outage outlasts the coordinator's lease window. A lease the journal has handed to someone else is.
	 */
	async fresh(lease: Lease, maxAgeMs = MIRROR_FRESH_MS): Promise<void> {
		const known = this.mirrored;
		if (
			known !== undefined &&
			known.lease.holderId === lease.holderId &&
			known.lease.epoch === lease.epoch &&
			performance.now() - known.at < maxAgeMs
		)
			return;
		this.mirroring ??= this.mirror(lease).finally(() => {
			this.mirroring = undefined;
		});
		try {
			await this.mirroring;
		} catch (error) {
			if (error instanceof StaleLeaseError || error instanceof RunNotFoundError) throw error;
		}
	}

	/** The journal's event recorded under `key`, if any. */
	entry(root: string, key: string): Promise<JournalEntry | undefined> {
		return this.journal.readKey(root, key);
	}

	/** Records a checkpoint under its event key. A key already recorded keeps its first event and answers `exists`. */
	append(lease: Lease, key: string, checkpoint: DurableCheckpoint): Promise<AppendOutcome> {
		const event = { type: RUN_EVENT_TYPES.checkpointRecorded, payload: checkpoint } as unknown as RunEvent;
		return this.journal.append(lease, event, { key });
	}

	/** The root's events from `fromSeq`, as the journal returns them. */
	events(root: string): (fromSeq: number) => AsyncIterable<JournalEntry> {
		return (fromSeq) => this.journal.read(root, fromSeq);
	}
}

/** Whether two checkpoints, as values, are identical. */
export function isSameCheckpointValue(stored: unknown, next: unknown): boolean {
	const hash = (value: unknown) => durableHash(value as Parameters<typeof durableHash>[0]);
	return hash(stored) === hash(next);
}

/**
 * Whether a checkpoint already recorded is the one being recorded again, so re-recording it keeps the first write.
 * Only its times may differ: a later attempt that replays a cached stage re-records it stamped with that replay's
 * time (#3996). Any other difference is a different checkpoint and conflicts. The comparison is of the values, not of
 * their text, because a journal in another database may return the payload with its keys in another order.
 */
export function isRecordedCheckpointValue(stored: unknown, next: DurableCheckpoint): boolean {
	const recorded = stored as DurableCheckpoint & { readonly completedAt?: number; readonly startedAt?: number };
	if (isSameCheckpointValue(recorded, next)) return true;
	const { completedAt, startedAt } = recorded;
	if (typeof completedAt !== "number") return false;
	const later = next as DurableCheckpoint & { readonly completedAt: number; readonly startedAt?: number };
	if ((startedAt === undefined) !== (later.startedAt === undefined)) return false;
	return isSameCheckpointValue({ ...later, completedAt, ...(startedAt === undefined ? {} : { startedAt }) }, recorded);
}
