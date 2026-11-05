import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { cpus, freemem, loadavg } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import type { ResourcePermit, ResourceProcessIdentity } from "@bastani/atomic";
import type { SqliteExecutor, SqliteRow } from "@bastani/atomic/storage";
import { type SqlPoolStorage, sqlPoolStorage } from "../durable/journal/internal.js";
import { SqlRunJournal } from "../durable/journal/sql-run-journal.js";
import type { RunJournal } from "../durable/journal/types.js";
import { WorkflowInfrastructureError } from "../shared/workflow-infrastructure-error.js";
import {
	WorkflowAdmissionConfigError,
	type WorkflowAdmissionMismatchReason,
	type WorkflowAdmissionSource,
} from "./admission-errors.js";
import {
	admissionBootIdentity,
	admissionHost,
	admissionProcessStopped,
	processGroupState,
	reapPause,
	signalProcessGroup,
} from "./admission-host.js";

const OWNER_LEASE_MS = 30_000;
/** How long an exited worker's orphaned process groups get to exit after SIGTERM, before SIGKILL. */
export const REAP_TERM_GRACE_MS = 5_000;
/** How long a SIGKILLed process group may take to disappear before its permits stay quarantined. */
export const REAP_KILL_GRACE_MS = 10_000;
/** Pause between probes of a process group being reaped. */
const REAP_POLL_MS = 50;
/** Released permits kept for inspection; older ones are pruned so the table cannot grow with run history. */
export const RELEASED_PERMIT_RETENTION = 256;
/** Most released permits one reconcile prunes, so catching up on a legacy history never holds the write lock long. */
export const RELEASED_PERMIT_PRUNE_BATCH = 1000;
const EXPIRED_REASON = "owner expired; cleanup unconfirmed";
const UNCONFIRMED_REASON = "cleanup unconfirmed";
/**
 * A process permit whose group survived the bounded reap: it stays granted, holding its capacity, until the group is
 * confirmed gone. Nothing but that confirmation (or a confirmed reboot) changes it.
 */
const QUARANTINED_REASON = "cleanup unconfirmed; permit quarantined";
const ANONYMOUS_REASON = "owner identity unavailable; cleanup unconfirmed";
/**
 * How long a process admission blocked only by quarantined permits waits for their groups to exit before it is refused:
 * as long again as the reap those groups survived gave them. Capacity held by live work is waited for as before.
 */
export const QUARANTINED_CAPACITY_WAIT_MS = REAP_TERM_GRACE_MS + REAP_KILL_GRACE_MS;

/** A limit that quarantined permits fill, and the process groups those permits are bound to. */
interface QuarantinedCapacity {
	/** The limit as configured, e.g. `admission.limits.process (1)`. */
	readonly limit: string;
	readonly groups: readonly number[];
}

/**
 * A process admission refused because, for {@link QUARANTINED_CAPACITY_WAIT_MS}, only quarantined permits held the
 * capacity it waited for. It is a retryable fault of the pool, not of the work that asked: a pooled child's attempt
 * ends on it and the child replays within its attempt limit.
 */
export class QuarantinedCapacityError extends WorkflowInfrastructureError {
	constructor(capacity: readonly QuarantinedCapacity[], waitedMs: number) {
		const limits = capacity.map(({ limit }) => limit).join(" and ");
		const groups = [...new Set(capacity.flatMap(({ groups }) => groups))].join(", ");
		super(
			"worker_cleanup_unconfirmed",
			`Local worker process cleanup unconfirmed; process permit refused after ${Math.round(waitedMs)} ms: ${limits} ${capacity.length === 1 ? "is" : "are"} held by quarantined permits of process groups ${groups} that survived SIGKILL`,
		);
	}
}

/** A waiter whose owner `reconcile` saw dead or with a lapsed lease. A live owner's waiter rejoins the queue (#4179). */
const FENCED_WAITER_REASON = "abandoned waiter fenced";
/**
 * How long after its owner's lease lapsed a fenced waiter's permit is kept out of history pruning, so a process that
 * stalled that long can still take it back. A waiter whose permit is gone is refused, never recreated: the permit may
 * have recorded a stop.
 */
const FENCED_WAITER_RETENTION_MS = 10 * 60_000;

/**
 * A waiting admission whose permit the pool released for good while it waited: its holder was stopped (worker exit,
 * host reboot), not refused by the work. A retryable fault of the pool: a pooled child's attempt ends on it and the
 * child replays within its attempt limit (#4179).
 */
export class AdmissionHolderStoppedError extends WorkflowInfrastructureError {
	constructor(reason: string | undefined) {
		super(
			"stale_work_lease",
			`Stale resource admission attempt: the admission holder was stopped${reason === undefined ? "" : ` (${reason})`}`,
		);
	}
}
const NOW_MS = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
/** How often an admission whose attempt lease is late asks again whether it was renewed. */
const LATE_ATTEMPT_POLL_MS = 100;
const LATE_ATTEMPT_REASON = "waiting for its attempt lease";
/**
 * While the host is past `stageStartMaxLoadPerCpu`, a root starts at most one pooled stage session this often, in the
 * order the stages asked: the load can then recover, and no stage waits forever on stages that hold their sessions.
 */
export const STAGE_START_SPACING_MS = 5_000;
const STAGE_START_PRESSURE_REASON = "paced for host load";

type OwnerRow = SqliteRow & { id: string; host: string; boot: string | null; pid: number; expires_at: number };
type Resource = "session" | "process";
type Limits = Partial<Record<Resource, number>>;
export interface AdmissionConfiguration {
	readonly limits?: Limits;
	readonly userLimits?: Limits;
	readonly userDatabase?: string;
	readonly host?: { readonly maxLoadPerCpu?: number; readonly minFreeMemoryBytes?: number };
}
export interface AdmissionOptions extends AdmissionConfiguration {
	readonly root: string;
	readonly holder: string;
	/**
	 * Load per CPU above which a pooled stage's own session starts are paced ({@link STAGE_START_SPACING_MS}), so an
	 * overloaded host is not given a burst of stage starts. Delegated sessions and processes are not stage starts.
	 * It is not part of the saved admission configuration, so a resumed root may run with another value.
	 */
	readonly stageStartMaxLoadPerCpu?: number;
	readonly attempt?: { readonly id: string; readonly generation: number; readonly epoch: number };
	readonly sampleHost?: () => { freeMemoryBytes?: number; load?: number };
	/**
	 * The root's saved `limits` and `host`, which every holder of the root admits against. `"check"` (the default)
	 * saves them if none are and refuses others; `"replace"` saves these, so a resumed root runs under its current
	 * limits (#4196), and only the root itself passes it, while it holds its lease; `"unchanged"` neither saves nor
	 * checks them, for a check made before the root is admitted.
	 */
	readonly rootLimits?: "check" | "replace" | "unchanged";
	/** Where the admission settings came from, for the error naming a refused `userLimits`; `"sdk"` when omitted. */
	readonly source?: WorkflowAdmissionSource;
}
type PermitRow = SqliteRow & {
	operation: string;
	root: string;
	holder: string;
	kind: Resource;
	state: string;
	reason: string | null;
	owner: string | null;
	attempt: string | null;
	process_identity: string | null;
};
/** A waiting or granted permit with its owner row, if the owner still has one. */
type LivePermitRow = SqliteRow & {
	operation: string;
	owner: string | null;
	kind: Resource;
	state: string;
	reason: string | null;
	process_identity: string | null;
	host: string | null;
	boot: string | null;
	pid: number | null;
	expired: number | null;
};

function processGroupStopped(encoded: string): boolean {
	const identity = JSON.parse(encoded) as ResourceProcessIdentity;
	return (
		identity.kind === "unix-process-group" &&
		Number.isSafeInteger(identity.id) &&
		identity.id > 0 &&
		admissionProcessStopped(-identity.id)
	);
}

/** `userLimits` count across the runs of one SQLite file, so `userDatabase` must be this journal's own file. */
async function assertUserDatabase(journal: RunJournal, runsTable: string, options: AdmissionOptions): Promise<void> {
	const source = options.source ?? "sdk";
	const refused = (reason: WorkflowAdmissionMismatchReason) =>
		new WorkflowAdmissionConfigError({
			code: "user-database-mismatch",
			source,
			reason,
			userDatabase: options.userDatabase,
			journalPath: journal instanceof SqlRunJournal ? journal.path : undefined,
		});
	if (!(journal instanceof SqlRunJournal) || runsTable !== "wf_runs" || journal.path === ":memory:")
		throw refused("unsupported-journal");
	if (!options.userDatabase) throw refused("missing");
	if ((await realpath(options.userDatabase).catch(() => undefined)) !== (await realpath(journal.path)))
		throw refused("other-file");
}

export class SqlResourceAdmission {
	private readonly permits: string;
	private readonly configuration: string;
	private readonly owners: string;
	private readonly owner = randomUUID();
	private nextReconciliation = 0;
	private constructor(
		private readonly storage: SqlPoolStorage,
		private readonly options: AdmissionOptions,
	) {
		this.permits = `${storage.tables.runs}_resource_permits`;
		this.configuration = `${storage.tables.runs}_resource_limits`;
		this.owners = `${storage.tables.runs}_resource_owners`;
	}
	static async open(journal: RunJournal, options: AdmissionOptions): Promise<SqlResourceAdmission> {
		const storage = sqlPoolStorage(journal);
		if (!storage) throw new Error("Resource admission requires a SQL journal");
		if (options.userLimits) await assertUserDatabase(journal, storage.tables.runs, options);
		for (const limits of [options.limits, options.userLimits])
			for (const value of Object.values(limits ?? {}))
				if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid resource limit");
		for (const value of [...Object.values(options.host ?? {}), options.stageStartMaxLoadPerCpu ?? 0])
			if (!Number.isFinite(value) || value < 0) throw new Error("Invalid host admission threshold");
		const admission = new SqlResourceAdmission(storage, {
			...structuredClone({ ...options, sampleHost: undefined }),
			sampleHost: options.sampleHost,
		});
		const boot = await admissionBootIdentity();
		await storage.transaction(async (tx) => {
			await tx.exec(`CREATE TABLE IF NOT EXISTS ${admission.configuration}(scope TEXT PRIMARY KEY, config TEXT NOT NULL);
				CREATE TABLE IF NOT EXISTS ${admission.permits}(ticket INTEGER PRIMARY KEY AUTOINCREMENT, operation TEXT UNIQUE NOT NULL,
				root TEXT NOT NULL, holder TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, reason TEXT, owner TEXT, attempt TEXT, process_identity TEXT);
				CREATE INDEX IF NOT EXISTS ${admission.permits}_active ON ${admission.permits}(kind, state, root);
				CREATE TABLE IF NOT EXISTS ${admission.owners}(id TEXT PRIMARY KEY, host TEXT NOT NULL, pid INTEGER NOT NULL, expires_at INTEGER NOT NULL, boot TEXT);`);
			const columns = await tx.all(`PRAGMA table_info(${admission.permits})`);
			for (const column of ["owner", "attempt", "process_identity"])
				if (!columns.some((entry) => entry.name === column))
					await tx.exec(`ALTER TABLE ${admission.permits} ADD COLUMN ${column} TEXT`);
			if (!columns.some((entry) => entry.name === "granted_at"))
				await tx.exec(`ALTER TABLE ${admission.permits} ADD COLUMN granted_at INTEGER`);
			// Reconciliation fences permits owner by owner and finds live permits by state. Without these indexes each
			// statement reads every permit ever issued, which held the shared journal's write lock for seconds (#3978).
			await tx.exec(`CREATE INDEX IF NOT EXISTS ${admission.permits}_owner ON ${admission.permits}(owner, state);
				CREATE INDEX IF NOT EXISTS ${admission.permits}_state ON ${admission.permits}(state)`);
			if (!(await tx.all(`PRAGMA table_info(${admission.owners})`)).some((entry) => entry.name === "boot"))
				await tx.exec(`ALTER TABLE ${admission.owners} ADD COLUMN boot TEXT`);
			await tx.run(
				`INSERT INTO ${admission.owners}(id, host, pid, expires_at, boot) VALUES (?, ?, ?, CAST(unixepoch('subsec') * 1000 AS INTEGER) + ?, ?)`,
				admission.owner,
				admissionHost,
				process.pid,
				OWNER_LEASE_MS,
				boot,
			);
			const rootLimits = options.rootLimits ?? "check";
			for (const [scope, limits] of [
				[`root:${options.root}`, options.limits],
				["user", options.userLimits],
			] as const) {
				const ofRoot = scope !== "user";
				if (ofRoot && rootLimits === "unchanged") continue;
				if (!limits && (scope === "user" || !options.host)) {
					// A root resumed without limits must not keep admitting against the ones it saved before.
					if (ofRoot && rootLimits === "replace")
						await tx.run(`DELETE FROM ${admission.configuration} WHERE scope = ?`, scope);
					continue;
				}
				const config = JSON.stringify({
					session: limits?.session ?? null,
					process: limits?.process ?? null,
					...(scope === "user"
						? {}
						: {
								host: {
									maxLoadPerCpu: options.host?.maxLoadPerCpu ?? null,
									minFreeMemoryBytes: options.host?.minFreeMemoryBytes ?? null,
								},
							}),
				});
				if (ofRoot && rootLimits === "replace") {
					await tx.run(`INSERT OR REPLACE INTO ${admission.configuration} VALUES (?, ?)`, scope, config);
					continue;
				}
				await tx.run(`INSERT OR IGNORE INTO ${admission.configuration} VALUES (?, ?)`, scope, config);
				if (
					(await tx.get(`SELECT config FROM ${admission.configuration} WHERE scope = ?`, scope))?.config !== config
				)
					throw new Error("Conflicting resource admission configuration");
			}
		});
		await admission.reconcile();
		return admission;
	}
	private sampleHost(): { freeMemoryBytes?: number; load?: number } {
		return (
			this.options.sampleHost?.() ?? {
				freeMemoryBytes: freemem(),
				load: process.platform === "win32" ? undefined : loadavg()[0]! / cpus().length,
			}
		);
	}
	/** Whether the host is loaded past `stageStartMaxLoadPerCpu`, so this pooled stage start is paced. */
	private stageStartPressure(kind: Resource, delegated: boolean | undefined): boolean {
		const threshold = this.options.stageStartMaxLoadPerCpu;
		if (kind !== "session" || delegated === true || threshold === undefined || threshold === 0) return false;
		const load = this.sampleHost().load;
		return load !== undefined && load > threshold;
	}
	private hostReason(): string | undefined {
		const host = this.options.host;
		if (!host) return;
		const sample = this.sampleHost();
		if (host.minFreeMemoryBytes !== undefined) {
			if (sample.freeMemoryBytes === undefined) return "host memory unsupported";
			if (sample.freeMemoryBytes < host.minFreeMemoryBytes) return "host memory";
		}
		if (host.maxLoadPerCpu !== undefined) {
			if (sample.load === undefined) return "host load unsupported";
			if (sample.load > host.maxLoadPerCpu) return "host load";
		}
	}
	/**
	 * Whether this admission's attempt still owns its work: `current`, `late` when it does but its work lease or the
	 * root's lease is past due, or `stale` when another attempt, epoch or root state replaced it. A late lease is
	 * renewed by the coordinator while its worker responds, however slowly a busy host lets it do so, and a worker that
	 * stops responding is stopped and its work replaced: so only `stale` refuses the attempt.
	 */
	private async attemptStanding(tx: SqliteExecutor): Promise<"current" | "late" | "stale"> {
		const { root, attempt } = this.options;
		if (!attempt) return "current";
		const work = await tx.get<SqliteRow & { late: number }>(
			`SELECT (w.expires_at < ${NOW_MS} OR l.renewed_at + p.timeout < ${NOW_MS}) AS late
			FROM ${this.storage.tables.runs}_work w JOIN ${this.storage.tables.leases} l ON l.run_id = w.root
			JOIN ${this.storage.tables.runs}_pool p ON p.root = w.root JOIN ${this.storage.tables.runs} r ON r.run_id = w.root
			WHERE w.id = ? AND w.root = ? AND w.generation = ? AND w.epoch = ? AND w.state = 'leased' AND r.status IN ('running', 'paused')
			AND l.epoch = w.epoch`,
			attempt.id,
			root,
			attempt.generation,
			attempt.epoch,
		);
		if (!work) return "stale";
		return Number(work.late) === 1 ? "late" : "current";
	}
	private async assertCurrentAttempt(tx: SqliteExecutor): Promise<boolean> {
		const standing = await this.attemptStanding(tx);
		if (standing === "stale") throw new Error("Stale resource admission attempt");
		return standing === "current";
	}
	/** Resolves once the attempt is current, waiting out a late lease; rejects once it is stale. */
	async validate(signal?: AbortSignal): Promise<void> {
		for (;;) {
			signal?.throwIfAborted();
			if (await this.storage.transaction((tx) => this.assertCurrentAttempt(tx))) return;
			await delay(LATE_ATTEMPT_POLL_MS, undefined, { signal });
		}
	}
	async acquire(
		kind: Resource,
		signal?: AbortSignal,
		request?: { readonly delegated?: boolean },
	): Promise<ResourcePermit> {
		signal?.throwIfAborted();
		const operation = randomUUID();
		// A waiter fenced for a lapsed owner lease is released already but still recoverable, and pruning keeps it while its
		// owner renews (#4179): ending this admission records why, so it becomes ordinary history.
		const release = (reason = "resource cleanup confirmed") =>
			this.storage.transaction(async (tx) => {
				await tx.run(
					`UPDATE ${this.permits} SET state = 'released', reason = ? WHERE operation = ? AND (state != 'released' OR reason = ?)`,
					reason,
					operation,
					FENCED_WAITER_REASON,
				);
			});
		release.bindProcess = async (identity: ResourceProcessIdentity) => {
			if (
				kind !== "process" ||
				identity.kind !== "unix-process-group" ||
				!Number.isSafeInteger(identity.id) ||
				identity.id <= 0
			)
				throw new Error("Invalid resource process identity");
			const encoded = JSON.stringify({ kind: identity.kind, id: identity.id });
			await this.storage.transaction(async (tx) => {
				const updated = await tx.run(
					`UPDATE ${this.permits} SET process_identity = ? WHERE operation = ? AND state = 'granted' AND (process_identity IS NULL OR process_identity = ?)`,
					encoded,
					operation,
					encoded,
				);
				if (updated.changes !== 1) throw new Error("Resource process permit is no longer held");
			});
		};
		/**
		 * Keeps this waiter queued. `reconcile` fences a waiter whose owner lease lapsed, which a live process that stalls
		 * under load can let happen. A waiter holds no capacity, so this live one (its owner lease was just renewed)
		 * rejoins the queue in the same transaction it may be granted in (#4179). A permit released for any other reason,
		 * or gone from history, stays released, and the admission is refused as a fault of the pool.
		 */
		const keepWaiting = async (tx: SqliteExecutor): Promise<void> => {
			const permit = await tx.get(`SELECT state, reason FROM ${this.permits} WHERE operation = ?`, operation);
			if (permit?.state === "released" && permit.reason === FENCED_WAITER_REASON)
				await tx.run(`UPDATE ${this.permits} SET state = 'waiting', reason = NULL WHERE operation = ?`, operation);
			else if (permit === undefined) throw new AdmissionHolderStoppedError("permit no longer recorded");
			else if (permit.state !== "waiting")
				throw new AdmissionHolderStoppedError(permit.reason === null ? undefined : String(permit.reason));
		};
		await this.storage.transaction(async (tx) => {
			await tx.run(
				`UPDATE ${this.owners} SET expires_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) + ? WHERE id = ?`,
				OWNER_LEASE_MS,
				this.owner,
			);
			await tx.run(
				`INSERT INTO ${this.permits}(operation, root, holder, kind, state, owner, attempt) VALUES (?, ?, ?, ?, 'waiting', ?, ?)`,
				operation,
				this.options.root,
				this.options.holder,
				kind,
				this.owner,
				this.options.attempt
					? JSON.stringify({
							id: this.options.attempt.id,
							generation: this.options.attempt.generation,
							epoch: this.options.attempt.epoch,
						})
					: null,
			);
		});
		// Since when this admission has been blocked only by capacity that quarantined permits hold.
		let quarantinedSince: number | undefined;
		try {
			for (;;) {
				signal?.throwIfAborted();
				if (performance.now() >= this.nextReconciliation) {
					await this.reconcile();
					this.nextReconciliation = performance.now() + 1000;
				}
				const hostReason = this.hostReason();
				const pressure = this.stageStartPressure(kind, request?.delegated);
				let quarantined = undefined as QuarantinedCapacity[] | undefined;
				const granted = await this.storage.transaction(async (tx) => {
					quarantined = undefined;
					await tx.run(
						`UPDATE ${this.owners} SET expires_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) + ? WHERE id = ?`,
						OWNER_LEASE_MS,
						this.owner,
					);
					await keepWaiting(tx);
					const { root } = this.options;
					// A late attempt lease is waited out, delegated or not; only a replaced attempt is refused.
					if (!(await this.assertCurrentAttempt(tx))) {
						const waiting = await tx.run(
							`UPDATE ${this.permits} SET reason = ? WHERE operation = ? AND state = 'waiting'`,
							LATE_ATTEMPT_REASON,
							operation,
						);
						if (waiting.changes !== 1) throw new AdmissionHolderStoppedError(undefined);
						return false;
					}
					let reason = hostReason;
					// Paced, in order: one stage start per spacing, the earliest waiting one first.
					if (
						pressure &&
						((await tx.get(
							`SELECT 1 AS recent FROM ${this.permits} WHERE root = ? AND kind = 'session' AND granted_at >= ${NOW_MS} - ? LIMIT 1`,
							root,
							STAGE_START_SPACING_MS,
						)) ||
							(await tx.get(
								`SELECT 1 AS older FROM ${this.permits} WHERE root = ? AND kind = 'session' AND state = 'waiting' AND reason = ? AND ticket < (SELECT ticket FROM ${this.permits} WHERE operation = ?) LIMIT 1`,
								root,
								STAGE_START_PRESSURE_REASON,
								operation,
							)))
					)
						reason ??= STAGE_START_PRESSURE_REASON;
					const controls = `${this.storage.tables.runs}_pool_control`;
					if (await tx.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", controls)) {
						const control = await tx.get(`SELECT state FROM ${controls} WHERE root = ?`, root);
						if (control && control.state !== "running") reason ??= `root ${control.state}`;
					}
					// Limits whose capacity, held by quarantined permits, is all that keeps this admission waiting.
					const held: QuarantinedCapacity[] = [];
					let blockedOtherwise = reason !== undefined;
					for (const scope of [`root:${root}`, "user"]) {
						const row = await tx.get(`SELECT config FROM ${this.configuration} WHERE scope = ?`, scope);
						const limit = row ? (JSON.parse(String(row.config)) as Limits)[kind] : undefined;
						if (!limit) continue;
						const rootClause = scope === "user" ? "" : "AND root = ?";
						const args = scope === "user" ? [kind] : [kind, root];
						const count = await tx.get(
							`SELECT COUNT(*) AS count FROM ${this.permits} WHERE kind = ? ${rootClause} AND state = 'granted'`,
							...args,
						);
						// A stage start waiting only for its pacing slot holds no claim on capacity others may use meanwhile.
						const older = await tx.get(
							`SELECT 1 AS waiting FROM ${this.permits} WHERE kind = ? ${rootClause} AND state = 'waiting' AND reason IS NOT ? AND ticket < (SELECT ticket FROM ${this.permits} WHERE operation = ?) LIMIT 1`,
							...args,
							STAGE_START_PRESSURE_REASON,
							operation,
						);
						const used = Number(count?.count);
						if (used < limit && !older) continue;
						reason ??= `${scope} ${kind}`;
						// The limit is full only because of permits whose process groups survived their reap: they keep
						// their capacity, but this admission waits for it only so long (below).
						const quarantinedPermits =
							kind === "process" && used >= limit
								? await tx.all<SqliteRow & { process_identity: string | null }>(
										`SELECT process_identity FROM ${this.permits} WHERE kind = ? ${rootClause} AND state = 'granted' AND reason = ?`,
										...args,
										QUARANTINED_REASON,
									)
								: [];
						if (quarantinedPermits.length > 0 && used - quarantinedPermits.length < limit)
							held.push({
								limit: `${scope === "user" ? "admission.userLimits" : "admission.limits"}.${kind} (${limit})`,
								groups: quarantinedPermits.flatMap(({ process_identity }) =>
									process_identity === null
										? []
										: [(JSON.parse(process_identity) as ResourceProcessIdentity).id],
								),
							});
						else blockedOtherwise = true;
					}
					if (!blockedOtherwise && held.length > 0) quarantined = held;
					if (reason && request?.delegated)
						throw new Error(`Delegated session cannot be admitted without capacity headroom: ${reason}`);
					// Only a stage's own session start is recorded for pacing: subagents and processes are not stage starts.
					const stageStart = kind === "session" && request?.delegated !== true;
					const updated = await tx.run(
						`UPDATE ${this.permits} SET state = ?, reason = ?, granted_at = CASE WHEN ? IS NULL AND ? THEN ${NOW_MS} ELSE NULL END WHERE operation = ? AND state = 'waiting'`,
						reason ? "waiting" : "granted",
						reason ?? null,
						reason ?? null,
						stageStart ? 1 : 0,
						operation,
					);
					if (updated.changes !== 1) throw new AdmissionHolderStoppedError(undefined);
					return !reason;
				});
				if (granted) {
					signal?.throwIfAborted();
					return release;
				}
				// Capacity held by live work is waited for however long it takes. Capacity held only by quarantined
				// permits may never come back, and the attempt waiting for it keeps renewing its lease: so it is waited
				// for only so long, then refused as a retryable fault of the pool, which ends a pooled child's attempt.
				if (quarantined === undefined) quarantinedSince = undefined;
				else {
					const now = performance.now();
					quarantinedSince ??= now;
					if (now - quarantinedSince >= QUARANTINED_CAPACITY_WAIT_MS)
						throw new QuarantinedCapacityError(quarantined, now - quarantinedSince);
				}
				await delay(50 + Math.floor(Math.random() * 25), undefined, { signal });
			}
		} catch (error) {
			await release("launch cancelled or refused");
			signal?.throwIfAborted();
			throw error;
		}
	}
	/**
	 * Fences permits whose owner died, rebooted away or expired, and prunes old released permits. Every pooled worker
	 * runs this before it admits a command, so it first reads the live permits without the shared write lock and takes
	 * that lock only when something would change; each statement is indexed so its cost tracks live permits, not history.
	 */
	async reconcile(): Promise<void> {
		const boot = await admissionBootIdentity();
		const fences = new Map<string, { rebooted: boolean; stopped: boolean }>();
		const fence = (owner: { id: string; host: string; boot: string | null; pid: number }) => {
			let known = fences.get(owner.id);
			if (!known) {
				const rebooted = owner.host === admissionHost && !!boot && !!owner.boot && boot !== owner.boot;
				const stopped = rebooted || (owner.host === admissionHost && admissionProcessStopped(owner.pid));
				known = { rebooted, stopped };
				fences.set(owner.id, known);
			}
			return known;
		};
		const pending = await this.storage.read(async (db) => {
			const live = await db.all<LivePermitRow>(
				`SELECT p.operation, p.owner, p.kind, p.state, p.reason, p.process_identity, o.host, o.boot, o.pid,
				o.expires_at < ${NOW_MS} AS expired FROM ${this.permits} p LEFT JOIN ${this.owners} o ON o.id = p.owner
				WHERE p.state IN ('waiting', 'granted')`,
			);
			if (live.some((permit) => this.needsFencing(permit, fence))) return true;
			return !!(await db.get(
				`SELECT 1 AS prunable FROM ${this.permits} r WHERE ${this.prunable} LIMIT 1`,
				RELEASED_PERMIT_RETENTION,
				FENCED_WAITER_REASON,
				FENCED_WAITER_RETENTION_MS,
			));
		});
		if (!pending) return;
		fences.clear();
		await this.storage.transaction(async (tx) => {
			const owners = await tx.all<OwnerRow>(
				`SELECT o.* FROM ${this.owners} o WHERE o.id IN (SELECT owner FROM ${this.permits} WHERE state IN ('waiting', 'granted'))`,
			);
			for (const owner of owners) {
				const { rebooted, stopped } = fence(owner);
				await tx.run(
					`UPDATE ${this.permits} SET state = 'released', reason = ? WHERE owner = ? AND state = 'waiting' AND (? OR EXISTS (SELECT 1 FROM ${this.owners} WHERE id = ? AND expires_at < ${NOW_MS}))`,
					FENCED_WAITER_REASON,
					owner.id,
					stopped ? 1 : 0,
					owner.id,
				);
				if (rebooted) {
					await tx.run(
						`UPDATE ${this.permits} SET state = 'released', reason = 'host reboot confirmed' WHERE owner = ? AND state = 'granted'`,
						owner.id,
					);
				} else if (stopped) {
					await tx.run(
						`UPDATE ${this.permits} SET state = 'released', reason = 'owner death confirmed' WHERE owner = ? AND kind = 'session' AND state = 'granted'`,
						owner.id,
					);
					// A quarantined permit keeps its own reason: admissions waiting on its capacity tell it apart by it.
					await tx.run(
						`UPDATE ${this.permits} SET reason = ? WHERE owner = ? AND kind = 'process' AND state = 'granted' AND reason IS NOT ? AND reason IS NOT ?`,
						UNCONFIRMED_REASON,
						owner.id,
						UNCONFIRMED_REASON,
						QUARANTINED_REASON,
					);
				} else {
					await tx.run(
						`UPDATE ${this.permits} SET reason = ? WHERE owner = ? AND state = 'granted' AND reason IS NOT ? AND reason IS NOT ? AND EXISTS (SELECT 1 FROM ${this.owners} WHERE id = ? AND expires_at < ${NOW_MS})`,
						EXPIRED_REASON,
						owner.id,
						EXPIRED_REASON,
						QUARANTINED_REASON,
						owner.id,
					);
				}
				if (owner.host === admissionHost && process.platform !== "win32") {
					const processes = await tx.all<PermitRow>(
						`SELECT * FROM ${this.permits} WHERE owner = ? AND state = 'granted' AND kind = 'process' AND process_identity IS NOT NULL`,
						owner.id,
					);
					for (const permit of processes)
						if (processGroupStopped(permit.process_identity!))
							await tx.run(
								`UPDATE ${this.permits} SET state = 'released', reason = 'process group cleanup confirmed' WHERE operation = ? AND state = 'granted'`,
								permit.operation,
							);
				}
			}
			await tx.run(
				`UPDATE ${this.permits} SET state = 'released', reason = 'legacy waiter fenced' WHERE owner IS NULL AND state = 'waiting'`,
			);
			await tx.run(
				`UPDATE ${this.permits} SET reason = ? WHERE owner IS NULL AND state = 'granted' AND reason IS NOT ?`,
				ANONYMOUS_REASON,
				ANONYMOUS_REASON,
			);
			// Released permits are terminal: nothing reads them but `inspect`, so only recent history is kept. A waiter
			// fenced for a lapsed owner lease is kept while its owner may still be alive to take it back (#4179).
			await tx.run(
				`DELETE FROM ${this.permits} WHERE ticket IN (SELECT ticket FROM ${this.permits} r WHERE ${this.prunable}
				ORDER BY ticket LIMIT ?)`,
				RELEASED_PERMIT_RETENTION,
				FENCED_WAITER_REASON,
				FENCED_WAITER_RETENTION_MS,
				RELEASED_PERMIT_PRUNE_BATCH,
			);
		});
	}
	/** The newest released ticket beyond the retained history, or NULL while there is nothing to prune. */
	private get prunableBefore(): string {
		return `(SELECT ticket FROM ${this.permits} WHERE state = 'released' ORDER BY ticket DESC LIMIT 1 OFFSET ?)`;
	}
	/**
	 * Released permits `reconcile` may delete, as a condition on alias `r`; binds the retention, the fenced-waiter reason
	 * and its retention. A fenced waiter whose owner renewed its lease within that retention may still rejoin the queue.
	 */
	private get prunable(): string {
		return `+r.state = 'released' AND r.ticket <= ${this.prunableBefore} AND (r.reason IS NOT ? OR NOT EXISTS
			(SELECT 1 FROM ${this.owners} o WHERE o.id = r.owner AND o.expires_at >= ${NOW_MS} - ?))`;
	}
	/** Whether the write pass of `reconcile` would change this live permit; mirrors its statements one for one. */
	private needsFencing(
		permit: LivePermitRow,
		fence: (owner: { id: string; host: string; boot: string | null; pid: number }) => {
			rebooted: boolean;
			stopped: boolean;
		},
	): boolean {
		if (permit.owner === null) return permit.state === "waiting" || permit.reason !== ANONYMOUS_REASON;
		// A permit whose owner row is gone is never fenced: only owners can be confirmed dead.
		if (permit.host === null || permit.pid === null) return false;
		const { rebooted, stopped } = fence({ id: permit.owner, host: permit.host, boot: permit.boot, pid: permit.pid });
		if (rebooted) return true;
		if (permit.state === "waiting") return stopped || !!permit.expired;
		const quarantined = permit.reason === QUARANTINED_REASON;
		if (stopped && (permit.kind === "session" || (permit.reason !== UNCONFIRMED_REASON && !quarantined))) return true;
		if (!stopped && permit.expired && permit.reason !== EXPIRED_REASON && !quarantined) return true;
		return (
			permit.kind === "process" &&
			permit.host === admissionHost &&
			process.platform !== "win32" &&
			permit.process_identity !== null &&
			processGroupStopped(permit.process_identity)
		);
	}
	async inspect(): Promise<PermitRow[]> {
		return this.storage.transaction((tx) => tx.all<PermitRow>(`SELECT * FROM ${this.permits} ORDER BY ticket`));
	}
	async releaseStoppedSessions(holder: string): Promise<number> {
		await this.reconcile();
		return this.storage.transaction(async (tx) => {
			await tx.run(
				`UPDATE ${this.permits} SET state = 'released', reason = 'worker exit confirmed' WHERE root = ? AND holder = ? AND state IN ('waiting', 'granted') AND (kind = 'session' OR state = 'waiting')`,
				this.options.root,
				holder,
			);
			// The reconcile above may have fenced this holder's waiters for a lapsed owner lease, which a live waiter
			// would take back (#4179): record the stop on them too, so they stay released.
			await tx.run(
				`UPDATE ${this.permits} SET reason = 'worker exit confirmed' WHERE root = ? AND holder = ? AND state = 'released' AND reason = ?`,
				this.options.root,
				holder,
				FENCED_WAITER_REASON,
			);
			// A quarantined permit keeps its reason; it is still counted, since its cleanup is still unconfirmed.
			await tx.run(
				`UPDATE ${this.permits} SET reason = ? WHERE root = ? AND holder = ? AND kind = 'process' AND state = 'granted' AND reason IS NOT ?`,
				UNCONFIRMED_REASON,
				this.options.root,
				holder,
				QUARANTINED_REASON,
			);
			const held = await tx.get(
				`SELECT COUNT(*) AS count FROM ${this.permits} WHERE root = ? AND holder = ? AND kind = 'process' AND state = 'granted'`,
				this.options.root,
				holder,
			);
			return Number(held?.count);
		});
	}
	/**
	 * Reaps the process groups that an exited holder's granted process permits are bound to on this host: SIGTERM,
	 * then SIGKILL after {@link REAP_TERM_GRACE_MS}, then at most {@link REAP_KILL_GRACE_MS} more. A group that is gone,
	 * or holds only zombies (which hold no resources), has its permit released. Returns the groups still alive when the
	 * bound expires; their permits stay granted and are marked quarantined. Permits without a process identity cannot
	 * be reaped and stay quarantined; they are not reported. Call it only for a holder whose process has exited.
	 */
	async reapStoppedProcesses(holder: string): Promise<readonly number[]> {
		return (await settleProcessGroups(this.storage, this.options.root, { holder }, true)).survivors;
	}
}

/** Whose process permits {@link unconfirmedProcessGroups} checks: one work attempt, or one worker. */
export type ProcessPermitScope =
	| { readonly attempt: { readonly id: string; readonly generation: number } }
	| { readonly holder: string };

/** Bound process groups of granted permits: those on this host still alive, and those that cannot be probed. */
export interface ProcessGroupSettlement {
	/** Groups on this host still alive (after the bounded reap, when reaping). */
	readonly survivors: readonly number[];
	/** Groups on another host, or with an identity this host cannot probe; never signalled or confirmed here. */
	readonly unprobeable: readonly number[];
}

async function settleProcessGroups(
	storage: SqlPoolStorage,
	root: string,
	scope: ProcessPermitScope,
	reap: boolean,
): Promise<ProcessGroupSettlement> {
	const permits = `${storage.tables.runs}_resource_permits`;
	const owners = `${storage.tables.runs}_resource_owners`;
	// Read without the shared write lock; take it only to release permits of groups confirmed gone (#3978).
	const rows = await storage.read(async (db) => {
		if (!(await db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", permits))) return [];
		const filter =
			"attempt" in scope
				? {
						clause: "json_extract(p.attempt, '$.id') = ? AND json_extract(p.attempt, '$.generation') = ?",
						args: [scope.attempt.id, scope.attempt.generation],
					}
				: { clause: "p.holder = ?", args: [scope.holder] };
		return db.all<SqliteRow & { operation: string; process_identity: string; host: string | null }>(
			`SELECT p.operation, p.process_identity, o.host FROM ${permits} p LEFT JOIN ${owners} o ON o.id = p.owner WHERE p.root = ? AND p.kind = 'process' AND p.state = 'granted' AND p.process_identity IS NOT NULL AND ${filter.clause}`,
			root,
			...filter.args,
		);
	});
	const groups = new Map<number, string[]>();
	const unprobeable: number[] = [];
	for (const row of rows) {
		const identity = JSON.parse(row.process_identity) as ResourceProcessIdentity;
		if (
			row.host === admissionHost &&
			process.platform !== "win32" &&
			identity.kind === "unix-process-group" &&
			Number.isSafeInteger(identity.id) &&
			identity.id > 0
		)
			groups.set(identity.id, [...(groups.get(identity.id) ?? []), row.operation]);
		else if (!unprobeable.includes(identity.id)) unprobeable.push(identity.id);
	}
	const alive = () => [...groups.keys()].filter((group) => processGroupState(group) === "alive");
	const settle = async (grace: number) => {
		let remaining = alive();
		for (let waited = 0; remaining.length > 0 && waited < grace; waited += REAP_POLL_MS) {
			await reapPause(REAP_POLL_MS);
			remaining = alive();
		}
		return remaining;
	};
	let survivors = alive();
	if (reap && survivors.length > 0) {
		for (const group of survivors) signalProcessGroup(group, "SIGTERM");
		survivors = await settle(REAP_TERM_GRACE_MS);
		for (const group of survivors) signalProcessGroup(group, "SIGKILL");
		survivors = await settle(REAP_KILL_GRACE_MS);
	}
	const confirmed = [...groups].flatMap(([group, operations]) => (survivors.includes(group) ? [] : operations));
	// Groups that outlived the bounded reap keep their permits granted, marked quarantined: admissions blocked only by
	// their capacity then wait for it only so long (QUARANTINED_CAPACITY_WAIT_MS).
	const quarantined = reap ? survivors.flatMap((group) => groups.get(group) ?? []) : [];
	if (confirmed.length > 0 || quarantined.length > 0)
		await storage.transaction(async (tx) => {
			for (const operation of confirmed)
				await tx.run(
					`UPDATE ${permits} SET state = 'released', reason = 'process group cleanup confirmed' WHERE operation = ? AND state = 'granted'`,
					operation,
				);
			for (const operation of quarantined)
				await tx.run(
					`UPDATE ${permits} SET reason = ? WHERE operation = ? AND state = 'granted'`,
					QUARANTINED_REASON,
					operation,
				);
		});
	return { survivors, unprobeable };
}

/**
 * The process groups of a root's granted, bound process permits in `scope` that are not confirmed gone. It reads
 * the journal, so it holds in any process and after any restart. A group on this host that is gone, or holds only
 * zombies, has its permit released and is not reported. A group on another host cannot be probed and is reported.
 * Permits never bound to a process group are not reported: there is no group to probe.
 */
export async function unconfirmedProcessGroups(
	journal: RunJournal,
	root: string,
	scope: ProcessPermitScope,
): Promise<readonly number[]> {
	const storage = sqlPoolStorage(journal);
	if (!storage) return [];
	const { survivors, unprobeable } = await settleProcessGroups(storage, root, scope, false);
	return [...survivors, ...unprobeable.filter((group) => !survivors.includes(group))];
}

/**
 * Reaps the process groups on this host of a root's granted, bound process permits in `scope`, with the same bounded
 * SIGTERM, then SIGKILL, sequence as {@link SqlResourceAdmission.reapStoppedProcesses}. Groups confirmed gone have
 * their permits released. Groups on another host cannot be signalled or probed; they are reported as `unprobeable`.
 */
export async function reapProcessGroups(
	journal: RunJournal,
	root: string,
	scope: ProcessPermitScope,
): Promise<ProcessGroupSettlement> {
	const storage = sqlPoolStorage(journal);
	if (!storage) return { survivors: [], unprobeable: [] };
	return settleProcessGroups(storage, root, scope, true);
}
