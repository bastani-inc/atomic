import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { cpus, freemem, loadavg } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import type { ResourcePermit, ResourceProcessIdentity } from "@bastani/atomic";
import type { SqliteExecutor, SqliteRow } from "@bastani/atomic/storage";
import { type SqlPoolStorage, sqlPoolStorage } from "../durable/journal/internal.js";
import { SqlRunJournal } from "../durable/journal/sql-run-journal.js";
import type { RunJournal } from "../durable/journal/types.js";
import { admissionBootIdentity, admissionHost, admissionProcessStopped } from "./admission-host.js";

const OWNER_LEASE_MS = 30_000;
/** Released permits kept for inspection; older ones are pruned so the table cannot grow with run history. */
export const RELEASED_PERMIT_RETENTION = 256;
/** Most released permits one reconcile prunes, so catching up on a legacy history never holds the write lock long. */
const PRUNE_BATCH = 1000;
const EXPIRED_REASON = "owner expired; cleanup unconfirmed";
const UNCONFIRMED_REASON = "cleanup unconfirmed";
const ANONYMOUS_REASON = "owner identity unavailable; cleanup unconfirmed";
const NOW_MS = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";

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
	readonly attempt?: { readonly id: string; readonly generation: number; readonly epoch: number };
	readonly sampleHost?: () => { freeMemoryBytes?: number; load?: number };
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
		if (
			options.userLimits &&
			(!(journal instanceof SqlRunJournal) ||
				storage.tables.runs !== "wf_runs" ||
				journal.path === ":memory:" ||
				!options.userDatabase ||
				(await realpath(options.userDatabase).catch(() => undefined)) !== (await realpath(journal.path)))
		)
			throw new Error("User admission requires the canonical journal database");
		for (const limits of [options.limits, options.userLimits])
			for (const value of Object.values(limits ?? {}))
				if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid resource limit");
		for (const value of Object.values(options.host ?? {}))
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
			for (const [scope, limits] of [
				[`root:${options.root}`, options.limits],
				["user", options.userLimits],
			] as const) {
				if (!limits && (scope === "user" || !options.host)) continue;
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
	private hostReason(): string | undefined {
		const host = this.options.host;
		if (!host) return;
		const sample = this.options.sampleHost?.() ?? {
			freeMemoryBytes: freemem(),
			load: process.platform === "win32" ? undefined : loadavg()[0]! / cpus().length,
		};
		if (host.minFreeMemoryBytes !== undefined) {
			if (sample.freeMemoryBytes === undefined) return "host memory unsupported";
			if (sample.freeMemoryBytes < host.minFreeMemoryBytes) return "host memory";
		}
		if (host.maxLoadPerCpu !== undefined) {
			if (sample.load === undefined) return "host load unsupported";
			if (sample.load > host.maxLoadPerCpu) return "host load";
		}
	}
	private async assertCurrentAttempt(tx: SqliteExecutor): Promise<void> {
		const { root, attempt } = this.options;
		if (!attempt) return;
		const work = await tx.get(
			`SELECT 1 AS valid FROM ${this.storage.tables.runs}_work w JOIN ${this.storage.tables.leases} l ON l.run_id = w.root
			JOIN ${this.storage.tables.runs}_pool p ON p.root = w.root JOIN ${this.storage.tables.runs} r ON r.run_id = w.root
			WHERE w.id = ? AND w.root = ? AND w.generation = ? AND w.epoch = ? AND w.state = 'leased' AND r.status IN ('running', 'paused')
			AND w.expires_at >= CAST(unixepoch('subsec') * 1000 AS INTEGER)
			AND l.epoch = w.epoch AND l.renewed_at + p.timeout >= CAST(unixepoch('subsec') * 1000 AS INTEGER)`,
			attempt.id,
			root,
			attempt.generation,
			attempt.epoch,
		);
		if (!work) throw new Error("Stale resource admission attempt");
	}
	async validate(signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		await this.storage.transaction((tx) => this.assertCurrentAttempt(tx));
	}
	async acquire(
		kind: Resource,
		signal?: AbortSignal,
		request?: { readonly delegated?: boolean },
	): Promise<ResourcePermit> {
		signal?.throwIfAborted();
		const operation = randomUUID();
		const release = (reason = "resource cleanup confirmed") =>
			this.storage.transaction(async (tx) => {
				await tx.run(
					`UPDATE ${this.permits} SET state = 'released', reason = ? WHERE operation = ? AND state != 'released'`,
					reason,
					operation,
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
		try {
			for (;;) {
				signal?.throwIfAborted();
				if (performance.now() >= this.nextReconciliation) {
					await this.reconcile();
					this.nextReconciliation = performance.now() + 1000;
				}
				const hostReason = this.hostReason();
				const granted = await this.storage.transaction(async (tx) => {
					await tx.run(
						`UPDATE ${this.owners} SET expires_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) + ? WHERE id = ?`,
						OWNER_LEASE_MS,
						this.owner,
					);
					const { root } = this.options;
					await this.assertCurrentAttempt(tx);
					let reason = hostReason;
					const controls = `${this.storage.tables.runs}_pool_control`;
					if (await tx.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", controls)) {
						const control = await tx.get(`SELECT state FROM ${controls} WHERE root = ?`, root);
						if (control && control.state !== "running") reason ??= `root ${control.state}`;
					}
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
						const older = await tx.get(
							`SELECT 1 AS waiting FROM ${this.permits} WHERE kind = ? ${rootClause} AND state = 'waiting' AND ticket < (SELECT ticket FROM ${this.permits} WHERE operation = ?) LIMIT 1`,
							...args,
							operation,
						);
						if (Number(count?.count) >= limit || older) reason ??= `${scope} ${kind}`;
					}
					if (reason && request?.delegated)
						throw new Error(`Delegated session cannot be admitted without capacity headroom: ${reason}`);
					const updated = await tx.run(
						`UPDATE ${this.permits} SET state = ?, reason = ? WHERE operation = ? AND state = 'waiting'`,
						reason ? "waiting" : "granted",
						reason ?? null,
						operation,
					);
					if (updated.changes !== 1) throw new Error("Resource admission holder was stopped");
					return !reason;
				});
				if (granted) {
					signal?.throwIfAborted();
					return release;
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
				`SELECT 1 AS prunable FROM ${this.permits} WHERE +state = 'released' AND ticket <= ${this.prunableBefore} LIMIT 1`,
				RELEASED_PERMIT_RETENTION,
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
					`UPDATE ${this.permits} SET state = 'released', reason = 'abandoned waiter fenced' WHERE owner = ? AND state = 'waiting' AND (? OR EXISTS (SELECT 1 FROM ${this.owners} WHERE id = ? AND expires_at < ${NOW_MS}))`,
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
					await tx.run(
						`UPDATE ${this.permits} SET reason = ? WHERE owner = ? AND kind = 'process' AND state = 'granted' AND reason IS NOT ?`,
						UNCONFIRMED_REASON,
						owner.id,
						UNCONFIRMED_REASON,
					);
				} else {
					await tx.run(
						`UPDATE ${this.permits} SET reason = ? WHERE owner = ? AND state = 'granted' AND reason IS NOT ? AND EXISTS (SELECT 1 FROM ${this.owners} WHERE id = ? AND expires_at < ${NOW_MS})`,
						EXPIRED_REASON,
						owner.id,
						EXPIRED_REASON,
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
			// Released permits are terminal: nothing reads them but `inspect`, so only recent history is kept.
			await tx.run(
				`DELETE FROM ${this.permits} WHERE ticket IN (SELECT ticket FROM ${this.permits} WHERE +state = 'released'
				AND ticket <= ${this.prunableBefore} ORDER BY ticket LIMIT ?)`,
				RELEASED_PERMIT_RETENTION,
				PRUNE_BATCH,
			);
		});
	}
	/** The newest released ticket beyond the retained history, or NULL while there is nothing to prune. */
	private get prunableBefore(): string {
		return `(SELECT ticket FROM ${this.permits} WHERE state = 'released' ORDER BY ticket DESC LIMIT 1 OFFSET ?)`;
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
		if (stopped && (permit.kind === "session" || permit.reason !== UNCONFIRMED_REASON)) return true;
		if (!stopped && permit.expired && permit.reason !== EXPIRED_REASON) return true;
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
			return (
				await tx.run(
					`UPDATE ${this.permits} SET reason = 'cleanup unconfirmed' WHERE root = ? AND holder = ? AND kind = 'process' AND state = 'granted'`,
					this.options.root,
					holder,
				)
			).changes;
		});
	}
}
