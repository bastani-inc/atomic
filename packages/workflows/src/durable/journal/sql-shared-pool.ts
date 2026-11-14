import type { WorktreeSnapshot } from "@bastani/atomic";
import type { SqliteExecutor, SqliteRow } from "@bastani/atomic/storage";
import type { SerializedError } from "../../shared/error-codec.js";
import { StaleStageLeaseError } from "../../workers/placement-errors.js";
import type { WorkspaceBinding } from "../../workers/workspace-binding.js";
import { type SqlPoolStorage, sqlPoolStorage, sqlPoolWrites } from "./internal.js";
import type {
	SharedPoolFleet,
	SharedPoolFleetStatus,
	SharedPoolHost,
	SharedPoolHostReport,
	SharedPoolHostState,
	SharedPoolStats,
	WorkerHostGitSource,
} from "./shared-pool-types.js";
import {
	classifySharedStoreHealth,
	type SharedStoreWrites,
	sharedStoreHealth,
	withoutUrlCredentials,
} from "./shared-store-health.js";
import { fleetDrainsSchema } from "./sql-fleet.js";
import type { PoolWork, SqlPoolQueue } from "./sql-pool-queue.js";
import { type PooledStageInputKind, validateStageInput } from "./stage-input-kinds.js";
import { type Lease, RUN_EVENT_TYPES, type RunJournal } from "./types.js";
import { validateText } from "./values.js";

export type { SharedPoolFleet, SharedPoolHost, SharedPoolStats, WorkerHostGitSource } from "./shared-pool-types.js";
export type { PooledStageInputKind } from "./stage-input-kinds.js";

const STORE_NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";

/** A registered worker host counts as live this long after its last report. */
export const WORKER_HOST_TTL_MS = 15_000;

/** Columns of the host registry that hosts of older versions created it without (#4768). */
const HOST_STATUS_COLUMNS = {
	slots_busy: "INTEGER",
	draining: "INTEGER NOT NULL DEFAULT 0",
	degraded: "TEXT",
	provider_id: "TEXT",
} as const;

/** A stage input that answers a prompt the stage raised; its payload is the answer. */
export const STAGE_INPUT_PROMPT_ANSWER = "prompt-answer" as const satisfies PooledStageInputKind;

/** The work lease an attempt holds, which fences every write it makes for one of its stages. */
export type AttemptLease = Pick<PoolWork, "id" | "generation" | "worker" | "epoch">;

/** What a root publishes for the worker hosts that serve it. */
export interface SharedPoolConfig {
	readonly definitions: readonly { readonly path: string; readonly exportName: string; readonly digest: string }[];
	readonly admission?: object;
	readonly leaseMs: number;
	/** How often each worker's heartbeat renews its attempt's lease, as the root resolved it. */
	readonly heartbeatMs: number;
	readonly startupTimeoutMs: number;
	readonly stageStartMaxLoadPerCpu?: number;
	readonly maxWorkerRssBytes?: number;
	readonly claimWindowMs: number;
	/** Children raise `ctx.ui` prompts for the root to answer, on whichever host runs them. */
	readonly promptNodes?: boolean;
}

/** A root that runs its pool on the shared journal, with the root's current lease as the journal holds it. */
export interface SharedPoolRoot {
	readonly root: string;
	readonly config: SharedPoolConfig;
	readonly status: string;
	readonly lease: Lease;
	/** Whether the root renewed its lease within its pool's window, by the database clock. */
	readonly fresh: boolean;
	/** Whether the root's budget blocks further spending: hosts start no child and admit no session or command. */
	readonly budgetBlocked: boolean;
}

/** A stage input a worker took: the input itself and the stage lease it holds while it processes it. */
export interface StageInputLease {
	readonly root: string;
	readonly runId: string;
	readonly stageId: string;
	readonly seq: number;
	readonly token: number;
	readonly attempt: AttemptLease;
	readonly kind: PooledStageInputKind;
	readonly op: string;
	readonly payload: string;
	readonly expiresAt: number;
}

export interface StageInputAppend {
	readonly work: string;
	readonly runId: string;
	readonly stageId: string;
	readonly kind: PooledStageInputKind;
	/** Identifies the input within its stage: an input appended again with the same op is the same input. */
	readonly op: string;
	readonly payload: string;
}

/** Where one stage ran and on what repository state, as its attempt recorded it. */
export interface StageWorkspaceRecord {
	readonly runId: string;
	readonly stageId: string;
	readonly work: string;
	readonly generation: number;
	readonly host: string;
	readonly worktree: string;
	readonly binding: WorkspaceBinding | null;
	readonly recordedAt: number;
}

/** Activity a worker host relayed for one of its attempts. */
export interface RelayedActivity {
	readonly work: Pick<PoolWork, "id" | "generation" | "worker" | "epoch" | "renewedAt" | "expiresAt">;
	readonly runs: string;
	readonly version: number;
}

type StageLeaseRow = SqliteRow & {
	token: number;
	work: string | null;
	generation: number | null;
	worker: string | null;
	epoch: number | null;
	seq: number | null;
	expires_at: number;
};

/** The host a pooled worker id names: worker ids of a shared pool are `<host>/<id>`. */
export function workerHost(worker: string): string {
	return worker.slice(0, Math.max(0, worker.lastIndexOf("/")));
}

/**
 * The shared-placement state of pools whose tables live in a journal every host opens (#4310): the roots' published
 * configuration, the worker host registry, activity relayed from other hosts, each stage's ordered inputs, stage lease
 * and workspace record, and the bindings whose restore each host backs off from (#4416). Every table derives from the
 * journal's own `runs` table name, so it is scoped by the journal's prefix, and none exists in a journal that never ran
 * a shared pool.
 */
export class SqlSharedPool {
	private readonly shared: string;
	private readonly hosts: string;
	private readonly activity: string;
	private readonly inputs: string;
	private readonly stageLeases: string;
	private readonly workspaces: string;
	private readonly backoffs: string;
	private readonly drains: string;
	private readonly work: string;
	private constructor(
		private readonly storage: SqlPoolStorage,
		private readonly queue: SqlPoolQueue,
		private readonly writes: SharedStoreWrites | undefined,
	) {
		const runs = storage.tables.runs;
		this.shared = `${runs}_pool_shared`;
		this.hosts = `${runs}_pool_hosts`;
		this.activity = `${runs}_pool_activity`;
		this.inputs = `${runs}_stage_inputs`;
		this.stageLeases = `${runs}_stage_leases`;
		this.workspaces = `${runs}_stage_workspaces`;
		this.backoffs = `${runs}_pool_restore_backoffs`;
		this.drains = `${runs}_fleet_drains`;
		this.work = `${runs}_work`;
	}

	/** Opens the shared-placement tables beside `queue`'s, creating them; the queue must be open on the same journal. */
	static async open(journal: RunJournal, queue: SqlPoolQueue): Promise<SqlSharedPool> {
		const storage = sqlPoolStorage(journal);
		if (!storage) throw new Error("Shared worker placement requires a SQL run journal");
		const pool = new SqlSharedPool(storage, queue, sqlPoolWrites(journal));
		const runs = storage.tables.runs;
		await storage.transaction(async (tx) => {
			await tx.exec(`
				CREATE TABLE IF NOT EXISTS ${pool.shared}(
					root TEXT PRIMARY KEY REFERENCES ${runs}_pool(root) ON DELETE CASCADE, config TEXT NOT NULL,
					epoch INTEGER NOT NULL, budget_blocked INTEGER NOT NULL DEFAULT 0
				);
				CREATE TABLE IF NOT EXISTS ${pool.hosts}(
					host TEXT PRIMARY KEY, labels TEXT NOT NULL, git TEXT NOT NULL, restore INTEGER NOT NULL,
					workers INTEGER NOT NULL, max_workers INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL,
					roots TEXT NOT NULL DEFAULT '[]', slots_busy INTEGER, draining INTEGER NOT NULL DEFAULT 0, degraded TEXT
				);
				CREATE TABLE IF NOT EXISTS ${pool.activity}(
					work TEXT PRIMARY KEY REFERENCES ${pool.work}(id) ON DELETE CASCADE, token TEXT NOT NULL,
					runs TEXT NOT NULL, version INTEGER NOT NULL
				);
				CREATE INDEX IF NOT EXISTS ${pool.activity}_version ON ${pool.activity}(version);
				CREATE TABLE IF NOT EXISTS ${pool.inputs}(
					root TEXT NOT NULL, run_id TEXT NOT NULL, stage_id TEXT NOT NULL, seq INTEGER NOT NULL,
					work TEXT NOT NULL REFERENCES ${pool.work}(id) ON DELETE CASCADE, kind TEXT NOT NULL, op TEXT NOT NULL,
					payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', receipt TEXT,
					created_at INTEGER NOT NULL, settled_at INTEGER,
					PRIMARY KEY(root, run_id, stage_id, seq), UNIQUE(root, run_id, stage_id, op)
				);
				CREATE INDEX IF NOT EXISTS ${pool.inputs}_pending ON ${pool.inputs}(work, state);
				CREATE TABLE IF NOT EXISTS ${pool.stageLeases}(
					root TEXT NOT NULL, run_id TEXT NOT NULL, stage_id TEXT NOT NULL, token INTEGER NOT NULL,
					work TEXT, generation INTEGER, worker TEXT, epoch INTEGER, seq INTEGER,
					expires_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(root, run_id, stage_id)
				);
				CREATE TABLE IF NOT EXISTS ${pool.workspaces}(
					root TEXT NOT NULL, run_id TEXT NOT NULL, stage_id TEXT NOT NULL,
					work TEXT NOT NULL REFERENCES ${pool.work}(id) ON DELETE CASCADE, generation INTEGER NOT NULL,
					host TEXT NOT NULL, worktree TEXT NOT NULL, binding TEXT, recorded_at INTEGER NOT NULL,
					PRIMARY KEY(root, run_id, stage_id)
				);
				CREATE TABLE IF NOT EXISTS ${pool.backoffs}(
					host TEXT NOT NULL, binding TEXT NOT NULL, until INTEGER NOT NULL, failure TEXT NOT NULL,
					recorded_at INTEGER NOT NULL, PRIMARY KEY(host, binding)
				);
				${fleetDrainsSchema(runs)};
			`);
			// A registry an older version created lacks the status and provider id columns; its hosts go on writing
			// without them.
			const present = new Set(
				(await tx.all<SqliteRow & { name: string }>("SELECT name FROM pragma_table_info(?)", pool.hosts)).map(
					(column) => column.name,
				),
			);
			for (const [column, type] of Object.entries(HOST_STATUS_COLUMNS))
				if (!present.has(column)) await tx.exec(`ALTER TABLE ${pool.hosts} ADD COLUMN ${column} ${type}`);
		});
		return pool;
	}

	/** Publishes the root's pool configuration for worker hosts, under the root's lease. */
	async publishConfig(lease: Lease, config: SharedPoolConfig, budgetBlocked = false): Promise<void> {
		const payload = JSON.stringify(config);
		await this.storage.transaction(async (tx) => {
			await this.queue.assertRootIn(tx, lease);
			await tx.run(
				`INSERT INTO ${this.shared}(root, config, epoch, budget_blocked) VALUES (?, ?, ?, ?) ON CONFLICT(root) DO UPDATE SET config = excluded.config, epoch = excluded.epoch, budget_blocked = excluded.budget_blocked`,
				lease.runId,
				payload,
				lease.epoch,
				budgetBlocked ? 1 : 0,
			);
		});
	}

	/** Records whether the root's budget blocks further spending, for the hosts that serve it (#4310). */
	async publishBudget(lease: Lease, blocked: boolean): Promise<void> {
		await this.storage.transaction(async (tx) => {
			await this.queue.assertRootIn(tx, lease);
			await tx.run(`UPDATE ${this.shared} SET budget_blocked = ? WHERE root = ?`, blocked ? 1 : 0, lease.runId);
		});
	}

	/**
	 * Every root whose current incarnation published its shared pool, with its run status and current lease: a root that
	 * resumed under a newer lease is listed again once it published its settings under that lease. Read without the
	 * write lock.
	 */
	async roots(): Promise<readonly SharedPoolRoot[]> {
		const runs = this.storage.tables.runs;
		const rows = await this.storage.read((executor) =>
			executor.all<
				SqliteRow & {
					root: string;
					config: string;
					status: string;
					holder_id: string;
					epoch: number;
					renewed_at: number;
					timeout: number;
					now: number;
					budget_blocked: number;
				}
			>(
				`SELECT s.root, s.config, s.budget_blocked, r.status, l.holder_id, l.epoch, l.renewed_at, p.timeout, ${STORE_NOW} AS now
				FROM ${this.shared} s JOIN ${runs} r ON r.run_id = s.root JOIN ${this.storage.tables.leases} l ON l.run_id = s.root
				JOIN ${runs}_pool p ON p.root = s.root WHERE s.epoch = l.epoch ORDER BY s.rowid`,
			),
		);
		return rows.map((row) => ({
			root: row.root,
			config: JSON.parse(row.config) as SharedPoolConfig,
			status: row.status,
			lease: { runId: row.root, holderId: row.holder_id, epoch: Number(row.epoch) },
			fresh: Number(row.now) - Number(row.renewed_at) <= Number(row.timeout),
			budgetBlocked: Number(row.budget_blocked) === 1,
		}));
	}

	/** Records a worker host's current state; a host that stops reporting ages out of {@link capableHostLive}. */
	async reportHost(host: SharedPoolHostReport): Promise<void> {
		validateText("key", host.host);
		await this.storage.transaction((tx) =>
			tx.run(
				`INSERT INTO ${this.hosts}(host, labels, git, restore, workers, max_workers, heartbeat_at, roots, slots_busy, draining, degraded, provider_id)
				VALUES (?, ?, ?, ?, ?, ?, ${STORE_NOW}, ?, ?, ?, ?, ?)
				ON CONFLICT(host) DO UPDATE SET labels = excluded.labels, git = excluded.git, restore = excluded.restore,
				workers = excluded.workers, max_workers = excluded.max_workers, heartbeat_at = excluded.heartbeat_at, roots = excluded.roots,
				slots_busy = excluded.slots_busy, draining = excluded.draining, degraded = excluded.degraded,
				provider_id = excluded.provider_id`,
				host.host,
				JSON.stringify(host.labels),
				host.git,
				host.restore ? 1 : 0,
				host.workers,
				host.maxWorkers,
				JSON.stringify(host.roots),
				host.busy ?? null,
				host.draining === true ? 1 : 0,
				host.degraded === undefined ? null : JSON.stringify(host.degraded),
				host.providerId ?? null,
			),
		);
	}

	/** Whether a fleet controller asked `host` to drain (#4768). */
	async drainRequested(host: string): Promise<boolean> {
		const row = await this.storage.read((executor) =>
			executor.get(`SELECT 1 AS asked FROM ${this.drains} WHERE host = ?`, host),
		);
		return row !== undefined;
	}

	/** Removes a stopped worker host from the registry, with the restore backoffs it recorded. */
	async forgetHost(host: string): Promise<void> {
		await this.storage.transaction(async (tx) => {
			await tx.run(`DELETE FROM ${this.hosts} WHERE host = ?`, host);
			await tx.run(`DELETE FROM ${this.backoffs} WHERE host = ?`, host);
		});
	}

	/** Every registered worker host. */
	registeredHosts(): Promise<readonly SharedPoolHost[]> {
		return registeredHosts(this.storage);
	}

	/**
	 * Whether a host serving `root` could restore the binding with affinity key `binding` now: it has a restore port and
	 * git, reported within `ttlMs`, is not draining (#4768), and does not back off from restoring that binding after its
	 * restores failed (#4416). A host that does not serve the root, such as one without its worker definitions, never
	 * claims its work.
	 */
	async capableHostLive(root: string, ttlMs: number, binding: string): Promise<boolean> {
		const row = await this.storage.read((executor) =>
			executor.get(
				`SELECT 1 AS live FROM ${this.hosts} h WHERE restore = 1 AND git != 'unavailable' AND draining = 0 AND heartbeat_at >= ${STORE_NOW} - ?
				AND EXISTS (SELECT 1 FROM json_each(roots) WHERE value = ?)
				AND NOT EXISTS (SELECT 1 FROM ${this.backoffs} b WHERE b.host = h.host AND b.binding = ? AND b.until > ${STORE_NOW})
				LIMIT 1`,
				ttlMs,
				root,
				binding,
			),
		);
		return row !== undefined;
	}

	/**
	 * Records that `host` waits `waitMs` before it restores the binding with affinity key `binding` again, and the
	 * failure it waits after (#4416). Until then it is no capable host for that binding.
	 */
	async recordRestoreBackoff(host: string, binding: string, waitMs: number, failure: SerializedError): Promise<void> {
		validateText("key", host);
		await this.storage.transaction((tx) =>
			tx.run(
				`INSERT INTO ${this.backoffs}(host, binding, until, failure, recorded_at) VALUES (?, ?, ${STORE_NOW} + ?, ?, ${STORE_NOW})
				ON CONFLICT(host, binding) DO UPDATE SET until = excluded.until, failure = excluded.failure, recorded_at = excluded.recorded_at`,
				host,
				binding,
				waitMs,
				JSON.stringify(failure),
			),
		);
	}

	/** Records that `host` restored the binding with affinity key `binding`: it no longer backs off from it. */
	async clearRestoreBackoff(host: string, binding: string): Promise<void> {
		await this.storage.transaction((tx) =>
			tx.run(`DELETE FROM ${this.backoffs} WHERE host = ? AND binding = ?`, host, binding),
		);
	}

	/** The restore failure a host recorded last for the binding with affinity key `binding`, if any did (#4416). */
	async restoreFailure(binding: string): Promise<SerializedError | undefined> {
		const row = await this.storage.read((executor) =>
			executor.get<SqliteRow & { failure: string }>(
				`SELECT failure FROM ${this.backoffs} WHERE binding = ? ORDER BY recorded_at DESC, rowid DESC LIMIT 1`,
				binding,
			),
		);
		return row === undefined ? undefined : (JSON.parse(String(row.failure)) as SerializedError);
	}

	/**
	 * The worktree snapshots recorded anywhere in this journal whose tree and head are `binding`'s, oldest first (#4416):
	 * those of every run's checkpoints, whichever run recorded them. One read of the journal's checkpoint events.
	 */
	async recordedSnapshots(binding: Pick<WorkspaceBinding, "head" | "tree">): Promise<readonly WorktreeSnapshot[]> {
		const rows = await this.storage.read((executor) =>
			executor.all<SqliteRow & { payload: string }>(
				`SELECT payload FROM ${this.storage.tables.events} WHERE type = ? AND instr(payload, ?) > 0 ORDER BY rowid`,
				RUN_EVENT_TYPES.checkpointRecorded,
				binding.tree,
			),
		);
		return rows.flatMap(
			(row) =>
				(
					JSON.parse(String(row.payload)) as { readonly worktreeSnapshots?: readonly WorktreeSnapshot[] }
				).worktreeSnapshots?.filter(
					(snapshot) => snapshot.tree === binding.tree && snapshot.head === binding.head,
				) ?? [],
		);
	}

	/**
	 * Relays the latest activity of attempts a worker host runs, for the root to show and answer. An entry whose attempt
	 * no longer holds its work is dropped: only a current attempt's runs reach the root.
	 */
	async relayActivity(
		lease: Lease,
		entries: readonly { readonly work: RelayedActivity["work"]; readonly runs: string }[],
	): Promise<void> {
		if (entries.length === 0) return;
		await this.storage.transaction(async (tx) => {
			await this.queue.assertRootIn(tx, lease);
			let version = Number(
				(await tx.get(`SELECT COALESCE(MAX(version), 0) AS version FROM ${this.activity}`))!.version,
			);
			for (const entry of entries) {
				const held = await tx.get(
					`SELECT 1 AS held FROM ${this.work} WHERE id = ? AND root = ? AND state = 'leased' AND generation = ? AND worker = ? AND epoch = ?`,
					entry.work.id,
					lease.runId,
					entry.work.generation,
					entry.work.worker,
					entry.work.epoch,
				);
				if (held === undefined) continue;
				await tx.run(
					`INSERT INTO ${this.activity}(work, token, runs, version) VALUES (?, ?, ?, ?)
					ON CONFLICT(work) DO UPDATE SET token = excluded.token, runs = excluded.runs, version = excluded.version`,
					entry.work.id,
					JSON.stringify(entry.work),
					entry.runs,
					++version,
				);
			}
		});
	}

	/** Activity relayed for `root`'s work after `version`, oldest first. Read without the write lock. */
	async activityAfter(root: string, version: number): Promise<readonly RelayedActivity[]> {
		const rows = await this.storage.read((executor) =>
			executor.all<SqliteRow & { token: string; runs: string; version: number }>(
				`SELECT a.token, a.runs, a.version FROM ${this.activity} a JOIN ${this.work} w ON w.id = a.work
				WHERE w.root = ? AND a.version > ? ORDER BY a.version`,
				root,
				version,
			),
		);
		return rows.map((row) => ({
			work: JSON.parse(row.token) as RelayedActivity["work"],
			runs: row.runs,
			version: Number(row.version),
		}));
	}

	/**
	 * Appends an input to one stage's ordered group, under the root's lease. The same op appended again is the same
	 * input, and keeps its place. Returns the input's sequence number in its stage. An input whose kind or payload a
	 * stage cannot take is refused with {@link StageInputInvalidError} before anything is written.
	 */
	async appendStageInput(lease: Lease, input: StageInputAppend): Promise<number> {
		validateStageInput(input);
		for (const value of [input.work, input.runId, input.stageId, input.kind, input.op]) validateText("key", value);
		return this.storage.transaction(async (tx) => {
			const now = await this.queue.assertRootIn(tx, lease);
			const existing = await tx.get(
				`SELECT seq FROM ${this.inputs} WHERE root = ? AND run_id = ? AND stage_id = ? AND op = ?`,
				lease.runId,
				input.runId,
				input.stageId,
				input.op,
			);
			if (existing !== undefined) return Number(existing.seq);
			const last = await tx.get(
				`SELECT COALESCE(MAX(seq), 0) AS seq FROM ${this.inputs} WHERE root = ? AND run_id = ? AND stage_id = ?`,
				lease.runId,
				input.runId,
				input.stageId,
			);
			const seq = Number(last!.seq) + 1;
			await tx.run(
				`INSERT INTO ${this.inputs}(root, run_id, stage_id, seq, work, kind, op, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				lease.runId,
				input.runId,
				input.stageId,
				seq,
				input.work,
				input.kind,
				input.op,
				input.payload,
				now,
			);
			return seq;
		});
	}

	/** The stages of the work items `works` with an input waiting, each once. Read without the write lock. */
	async stagesWithInputs(
		root: string,
		works: readonly string[],
	): Promise<readonly { work: string; runId: string; stageId: string }[]> {
		return this.storage.read((executor) =>
			executor.all<SqliteRow & { work: string; runId: string; stageId: string }>(
				`SELECT DISTINCT work, run_id AS runId, stage_id AS stageId FROM ${this.inputs} WHERE root = ? AND state = 'pending' AND work IN (SELECT value FROM json_each(?)) ORDER BY run_id, stage_id`,
				root,
				JSON.stringify(works),
			),
		);
	}

	/**
	 * Takes the next input of one stage for the attempt `attempt`, which must hold the stage's work: the lowest pending
	 * input, under a stage lease of `durationMs`. A stage has at most one input in flight: while another holder's lease
	 * on it is live, nothing is taken. The holder of the live lease taking again gets the input it holds. A lease that
	 * expired is taken over, and its input is taken again by whichever attempt asks next.
	 */
	async takeStageInput(
		lease: Lease,
		attempt: AttemptLease,
		stage: { readonly runId: string; readonly stageId: string },
		durationMs: number,
		/** Kinds the stage defers for now (#4391): its lowest pending input of another kind is taken instead. */
		deferred: readonly PooledStageInputKind[] = [],
	): Promise<StageInputLease | undefined> {
		if (!Number.isSafeInteger(durationMs) || durationMs <= 0)
			throw new Error("Stage lease duration must be a positive safe integer");
		return this.storage.transaction(async (tx) => {
			const now = await this.queue.attemptStanding(tx, lease, attempt);
			if (now === undefined)
				throw new StaleStageLeaseError("attempt-replaced", { root: lease.runId, ...stage, seq: null });
			const held = await this.stageLease(tx, lease.runId, stage.runId, stage.stageId);
			// An idle stage's lease row has expired by construction: settling an input resets it.
			if (held !== undefined && Number(held.expires_at) >= now) {
				if (!sameAttempt(held, attempt)) return undefined;
				return this.inFlight(tx, lease.runId, stage, held);
			}
			const next = await tx.get<
				SqliteRow & { seq: number; kind: PooledStageInputKind; op: string; payload: string }
			>(
				`SELECT seq, kind, op, payload FROM ${this.inputs} WHERE root = ? AND run_id = ? AND stage_id = ? AND work = ? AND state = 'pending'
				AND kind NOT IN (SELECT value FROM json_each(?)) ORDER BY seq LIMIT 1`,
				lease.runId,
				stage.runId,
				stage.stageId,
				attempt.id,
				JSON.stringify(deferred),
			);
			if (next === undefined) return undefined;
			const token = Number(held?.token ?? 0) + 1;
			const expiresAt = now + durationMs;
			await tx.run(
				`INSERT INTO ${this.stageLeases}(root, run_id, stage_id, token, work, generation, worker, epoch, seq, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(root, run_id, stage_id) DO UPDATE SET token = excluded.token, work = excluded.work, generation = excluded.generation,
				worker = excluded.worker, epoch = excluded.epoch, seq = excluded.seq, expires_at = excluded.expires_at`,
				lease.runId,
				stage.runId,
				stage.stageId,
				token,
				attempt.id,
				attempt.generation,
				attempt.worker,
				attempt.epoch,
				Number(next.seq),
				expiresAt,
			);
			return {
				root: lease.runId,
				runId: stage.runId,
				stageId: stage.stageId,
				seq: Number(next.seq),
				token,
				attempt: { id: attempt.id, generation: attempt.generation, worker: attempt.worker, epoch: attempt.epoch },
				kind: next.kind,
				op: next.op,
				payload: next.payload,
				expiresAt,
			};
		});
	}

	/**
	 * Settles the input `taken` holds: it is processed, with `receipt` recording how, and the stage is idle again for
	 * its next input. Refused with {@link StaleStageLeaseError} when the attempt or the stage lease was replaced.
	 */
	async ackStageInput(lease: Lease, taken: StageInputLease, receipt: string): Promise<void> {
		await this.settle(lease, taken, async (tx, now) => {
			await tx.run(
				`UPDATE ${this.inputs} SET state = 'done', receipt = ?, settled_at = ? WHERE root = ? AND run_id = ? AND stage_id = ? AND seq = ? AND state = 'pending'`,
				receipt,
				now,
				taken.root,
				taken.runId,
				taken.stageId,
				taken.seq,
			);
			await this.idle(tx, taken);
		});
	}

	/** Gives the input `taken` holds back unprocessed: it stays the stage's next input. */
	async releaseStageInput(lease: Lease, taken: StageInputLease): Promise<void> {
		await this.settle(lease, taken, (tx) => this.idle(tx, taken));
	}

	/** Extends the stage lease `taken` holds while its input is processed. */
	async renewStageInput(lease: Lease, taken: StageInputLease, durationMs: number): Promise<StageInputLease> {
		let expiresAt = taken.expiresAt;
		await this.settle(lease, taken, async (tx, now) => {
			expiresAt = Math.max(taken.expiresAt, now + durationMs);
			await tx.run(
				`UPDATE ${this.stageLeases} SET expires_at = ? WHERE root = ? AND run_id = ? AND stage_id = ?`,
				expiresAt,
				taken.root,
				taken.runId,
				taken.stageId,
			);
		});
		return { ...taken, expiresAt };
	}

	/** Every input of one stage, in order, with its state; for inspection and tests. */
	async stageInputs(
		root: string,
		runId: string,
		stageId: string,
	): Promise<readonly { seq: number; op: string; kind: string; state: string; receipt: string | null }[]> {
		return this.storage.read((executor) =>
			executor.all<SqliteRow & { seq: number; op: string; kind: string; state: string; receipt: string | null }>(
				`SELECT seq, op, kind, state, receipt FROM ${this.inputs} WHERE root = ? AND run_id = ? AND stage_id = ? ORDER BY seq`,
				root,
				runId,
				stageId,
			),
		);
	}

	/**
	 * One input of a stage: whether it is processed, its receipt, and whether a live stage lease holds it now (a host
	 * took it and has not settled it). Undefined when the stage has no input `seq`. Read without the write lock.
	 */
	async stageInput(
		root: string,
		runId: string,
		stageId: string,
		seq: number,
	): Promise<{ readonly done: boolean; readonly receipt: string | null; readonly held: boolean } | undefined> {
		const row = await this.storage.read((executor) =>
			executor.get<SqliteRow & { state: string; receipt: string | null; held: number }>(
				`SELECT i.state, i.receipt, EXISTS (SELECT 1 FROM ${this.stageLeases} l WHERE l.root = i.root AND l.run_id = i.run_id
				AND l.stage_id = i.stage_id AND l.seq = i.seq AND l.expires_at >= ${STORE_NOW}) AS held
				FROM ${this.inputs} i WHERE i.root = ? AND i.run_id = ? AND i.stage_id = ? AND i.seq = ?`,
				root,
				runId,
				stageId,
				seq,
			),
		);
		if (row === undefined) return undefined;
		return { done: row.state === "done", receipt: row.receipt, held: Number(row.held) === 1 };
	}

	/** Records where one stage of the attempt ran and on what binding, under the attempt's work lease. */
	async recordStageWorkspace(
		lease: Lease,
		attempt: AttemptLease,
		record: {
			readonly runId: string;
			readonly stageId: string;
			readonly host: string;
			readonly worktree: string;
			readonly binding: WorkspaceBinding | null;
		},
	): Promise<void> {
		await this.storage.transaction(async (tx) => {
			const now = await this.queue.assertAttemptIn(tx, lease, attempt);
			await tx.run(
				`INSERT INTO ${this.workspaces}(root, run_id, stage_id, work, generation, host, worktree, binding, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(root, run_id, stage_id) DO UPDATE SET work = excluded.work, generation = excluded.generation, host = excluded.host,
				worktree = excluded.worktree, binding = excluded.binding, recorded_at = excluded.recorded_at`,
				lease.runId,
				record.runId,
				record.stageId,
				attempt.id,
				attempt.generation,
				record.host,
				record.worktree,
				record.binding === null ? null : JSON.stringify(record.binding),
				now,
			);
		});
	}

	/** Every stage workspace record of `root`. */
	async stageWorkspaces(root: string): Promise<readonly StageWorkspaceRecord[]> {
		const rows = await this.storage.read((executor) =>
			executor.all<
				SqliteRow & {
					run_id: string;
					stage_id: string;
					work: string;
					generation: number;
					host: string;
					worktree: string;
					binding: string | null;
					recorded_at: number;
				}
			>(`SELECT * FROM ${this.workspaces} WHERE root = ? ORDER BY recorded_at, run_id, stage_id`, root),
		);
		return rows.map((row) => ({
			runId: row.run_id,
			stageId: row.stage_id,
			work: row.work,
			generation: Number(row.generation),
			host: row.host,
			worktree: row.worktree,
			binding: row.binding === null ? null : (JSON.parse(row.binding) as WorkspaceBinding),
			recordedAt: Number(row.recorded_at),
		}));
	}

	/** Queue depth, per-host workers and lease ages of `root`'s shared pool. Read without the write lock. */
	stats(root: string): Promise<SharedPoolStats> {
		return poolStats(this.storage, root, () => fleetStatus(this.storage, this.writes));
	}

	private stageLease(tx: SqliteExecutor, root: string, runId: string, stageId: string) {
		return tx.get<StageLeaseRow>(
			`SELECT * FROM ${this.stageLeases} WHERE root = ? AND run_id = ? AND stage_id = ?`,
			root,
			runId,
			stageId,
		);
	}

	private async inFlight(
		tx: SqliteExecutor,
		root: string,
		stage: { readonly runId: string; readonly stageId: string },
		held: StageLeaseRow,
	): Promise<StageInputLease | undefined> {
		const input = (await tx.get<SqliteRow & { kind: PooledStageInputKind; op: string; payload: string }>(
			`SELECT kind, op, payload FROM ${this.inputs} WHERE root = ? AND run_id = ? AND stage_id = ? AND seq = ? AND state = 'pending'`,
			root,
			stage.runId,
			stage.stageId,
			held.seq,
		))!;
		return {
			root,
			runId: stage.runId,
			stageId: stage.stageId,
			seq: Number(held.seq),
			token: Number(held.token),
			attempt: {
				id: held.work!,
				generation: Number(held.generation),
				worker: held.worker,
				epoch: Number(held.epoch),
			},
			kind: input.kind,
			op: input.op,
			payload: input.payload,
			expiresAt: Number(held.expires_at),
		};
	}

	/** Runs `body` only while `taken` still holds its stage: its attempt holds the work, and the lease is its own. */
	private async settle(
		lease: Lease,
		taken: StageInputLease,
		body: (tx: SqliteExecutor, now: number) => Promise<void>,
	): Promise<void> {
		await this.storage.transaction(async (tx) => {
			const now = await this.queue.attemptStanding(tx, lease, taken.attempt);
			if (now === undefined) throw new StaleStageLeaseError("attempt-replaced", taken);
			const held = await this.stageLease(tx, taken.root, taken.runId, taken.stageId);
			if (held === undefined || Number(held.token) !== taken.token || Number(held.seq) !== taken.seq)
				throw new StaleStageLeaseError("stage-lease-replaced", taken);
			await body(tx, now);
		});
	}

	private async idle(tx: SqliteExecutor, taken: StageInputLease): Promise<void> {
		await tx.run(
			`UPDATE ${this.stageLeases} SET seq = NULL, expires_at = 0 WHERE root = ? AND run_id = ? AND stage_id = ? AND token = ?`,
			taken.root,
			taken.runId,
			taken.stageId,
			taken.token,
		);
	}
}

/**
 * Whether the stage lease `held` belongs to `attempt`. Only its generation needs comparing: a stage belongs to one work
 * item, and each claim of that work gives its attempt a new generation, with one worker and epoch.
 */
function sameAttempt(held: StageLeaseRow, attempt: AttemptLease): boolean {
	return Number(held.generation) === attempt.generation;
}

/** How a host that reported `row` reads in fleet status. */
function hostState(row: {
	readonly heartbeatAgoMs: number;
	readonly degraded?: object;
	readonly draining?: boolean;
	readonly busy?: number;
}): SharedPoolHostState {
	if (row.heartbeatAgoMs > WORKER_HOST_TTL_MS) return "stale";
	if (row.degraded !== undefined) return "degraded";
	if (row.draining === true) return "draining";
	if (row.busy === undefined) return "live";
	return row.busy > 0 ? "busy" : "idle";
}

/**
 * Every registered worker host of the pools in `storage`'s journal. A registry an older version created has no status
 * columns until a host of this version opens it, and hosts of older versions leave them empty.
 */
async function registeredHosts(storage: SqlPoolStorage): Promise<readonly SharedPoolHost[]> {
	const rows = await storage.read((executor) =>
		executor.all<
			SqliteRow & {
				host: string;
				labels: string;
				git: WorkerHostGitSource;
				restore: number;
				workers: number;
				max_workers: number;
				roots: string;
				provider_id?: string | null;
				ago: number;
				slots_busy?: number | null;
				draining?: number;
				degraded?: string | null;
			}
		>(`SELECT *, ${STORE_NOW} - heartbeat_at AS ago FROM ${storage.tables.runs}_pool_hosts ORDER BY host`),
	);
	return rows.map((row) => {
		const degraded =
			row.degraded === undefined || row.degraded === null
				? undefined
				: (JSON.parse(row.degraded) as NonNullable<SharedPoolHost["degraded"]>);
		const reported = {
			heartbeatAgoMs: Number(row.ago),
			...(row.slots_busy === undefined || row.slots_busy === null ? {} : { busy: Number(row.slots_busy) }),
			...(Number(row.draining ?? 0) === 1 ? { draining: true } : {}),
			...(degraded === undefined
				? {}
				: {
						degraded: {
							failures: Number(degraded.failures),
							error: { name: degraded.error.name, message: withoutUrlCredentials(degraded.error.message) },
						},
					}),
		};
		return {
			host: row.host,
			labels: JSON.parse(row.labels) as Record<string, string>,
			git: row.git,
			restore: Number(row.restore) === 1,
			workers: Number(row.workers),
			maxWorkers: Number(row.max_workers),
			roots: JSON.parse(row.roots) as string[],
			...(row.provider_id === undefined || row.provider_id === null ? {} : { providerId: row.provider_id }),
			...reported,
			state: hostState(reported),
		};
	});
}

/**
 * The shared store's health, from this process's writes to it (#4768), and the queue of every running or paused shared
 * root.
 */
async function fleetStatus(
	storage: SqlPoolStorage,
	writes: SharedStoreWrites | undefined,
): Promise<SharedPoolFleetStatus> {
	const runs = storage.tables.runs;
	// An aggregate without GROUP BY gives one row, also when no root matches.
	const row = (await storage.read((executor) =>
		executor.get<SqliteRow & { roots: number; ready: number; leased: number; hosts: number }>(
			`SELECT COUNT(DISTINCT s.root) AS roots,
			COALESCE(SUM(w.state = 'ready'), 0) AS ready, COALESCE(SUM(w.state = 'leased'), 0) AS leased,
			(SELECT COUNT(*) FROM ${runs}_pool_hosts) AS hosts
			FROM ${runs}_pool_shared s JOIN ${runs} r ON r.run_id = s.root LEFT JOIN ${runs}_work w ON w.root = s.root
			WHERE r.status IN ('running', 'paused')`,
		),
	))!;
	return {
		store: classifySharedStoreHealth({
			...(writes === undefined ? {} : { writes }),
			hostsRegistered: Number(row.hosts) > 0,
		}),
		queue: { roots: Number(row.roots), ready: Number(row.ready), leased: Number(row.leased) },
	};
}

/** Queue depth, per-host workers and lease ages of `root`'s shared pool in `storage`'s journal. */
async function poolStats(
	storage: SqlPoolStorage,
	root: string,
	fleet: () => Promise<SharedPoolFleetStatus>,
): Promise<SharedPoolStats> {
	const [counts, leases, pending, hosts, fleetNow] = await Promise.all([
		storage.read((executor) =>
			executor.all<SqliteRow & { state: string; count: number }>(
				`SELECT state, COUNT(*) AS count FROM ${storage.tables.runs}_work WHERE root = ? GROUP BY state`,
				root,
			),
		),
		storage.read((executor) =>
			executor.all<
				SqliteRow & {
					id: string;
					child: string;
					worker: string;
					generation: number;
					renewed: number;
					expires: number;
				}
			>(
				`SELECT id, json_extract(descriptor, '$.childRunId') AS child, worker, generation,
				${STORE_NOW} - renewed_at AS renewed, expires_at - ${STORE_NOW} AS expires
				FROM ${storage.tables.runs}_work WHERE root = ? AND state = 'leased' ORDER BY ready_at, rowid`,
				root,
			),
		),
		storage.read((executor) =>
			executor.get(
				`SELECT COUNT(*) AS count FROM ${storage.tables.runs}_stage_inputs WHERE root = ? AND state = 'pending'`,
				root,
			),
		),
		registeredHosts(storage),
		fleet(),
	]);
	const count = (state: string) => Number(counts.find((row) => row.state === state)?.count ?? 0);
	const leaseList = leases.map((row) => ({
		work: row.id,
		childRunId: String(row.child),
		worker: row.worker,
		host: workerHost(row.worker),
		generation: Number(row.generation),
		renewedAgoMs: Number(row.renewed),
		expiresInMs: Number(row.expires),
	}));
	return {
		root,
		ready: count("ready"),
		leased: count("leased"),
		completed: count("completed"),
		failed: count("failed"),
		pendingStageInputs: Number(pending!.count),
		hosts: hosts.map((host) => ({
			...host,
			leased: leaseList.filter((entry) => entry.host === host.host).length,
		})),
		leases: leaseList,
		fleet: fleetNow,
	};
}

/**
 * `root`'s shared pool stats, read without the write lock and without creating anything: undefined when the journal is
 * not a SQL journal or never ran a shared pool.
 */
export async function readSharedPoolStats(journal: RunJournal, root: string): Promise<SharedPoolStats | undefined> {
	const storage = sqlPoolStorage(journal);
	if (storage === undefined) return undefined;
	const shared = await storage.read((executor) =>
		executor.get(
			"SELECT 1 AS held FROM sqlite_master WHERE type = 'table' AND name = ?",
			`${storage.tables.runs}_stage_inputs`,
		),
	);
	return shared === undefined
		? undefined
		: poolStats(storage, root, () => fleetStatus(storage, sqlPoolWrites(journal)));
}

/**
 * The worker hosts and shared roots of `journal`, read without the write lock and without creating anything: empty
 * when the journal never ran a shared pool, undefined when it is not a SQL journal (#4768).
 */
export async function readSharedPoolFleet(journal: RunJournal): Promise<SharedPoolFleet | undefined> {
	const storage = sqlPoolStorage(journal);
	if (storage === undefined) return undefined;
	const runs = storage.tables.runs;
	const shared = await storage.read((executor) =>
		executor.get("SELECT 1 AS held FROM sqlite_master WHERE type = 'table' AND name = ?", `${runs}_pool_shared`),
	);
	if (shared === undefined)
		return { hosts: [], roots: [], fleet: { store: sharedStoreHealth(), queue: { roots: 0, ready: 0, leased: 0 } } };
	const active = await storage.read((executor) =>
		executor.all<SqliteRow & { root: string }>(
			`SELECT s.root FROM ${runs}_pool_shared s JOIN ${runs} r ON r.run_id = s.root
			WHERE r.status IN ('running', 'paused') ORDER BY s.rowid`,
		),
	);
	const fleet = await fleetStatus(storage, sqlPoolWrites(journal));
	return {
		hosts: await registeredHosts(storage),
		roots: await Promise.all(active.map((row) => poolStats(storage, row.root, async () => fleet))),
		fleet,
	};
}
