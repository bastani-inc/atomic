import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { cpus, freemem, loadavg } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import type { SqliteRow } from "@bastani/atomic/storage";
import { type SqlPoolStorage, sqlPoolStorage } from "../durable/journal/internal.js";
import { SqlRunJournal } from "../durable/journal/sql-run-journal.js";
import type { RunJournal } from "../durable/journal/types.js";

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
};

export class SqlResourceAdmission {
	private readonly permits: string;
	private readonly configuration: string;
	private constructor(
		private readonly storage: SqlPoolStorage,
		private readonly options: AdmissionOptions,
	) {
		this.permits = `${storage.tables.runs}_resource_permits`;
		this.configuration = `${storage.tables.runs}_resource_limits`;
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
		await storage.transaction(async (tx) => {
			await tx.exec(`CREATE TABLE IF NOT EXISTS ${admission.configuration}(scope TEXT PRIMARY KEY, config TEXT NOT NULL);
				CREATE TABLE IF NOT EXISTS ${admission.permits}(ticket INTEGER PRIMARY KEY AUTOINCREMENT, operation TEXT UNIQUE NOT NULL,
				root TEXT NOT NULL, holder TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, reason TEXT);
				CREATE INDEX IF NOT EXISTS ${admission.permits}_active ON ${admission.permits}(kind, state, root);`);
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
	async acquire(kind: Resource, signal?: AbortSignal): Promise<() => Promise<void>> {
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
		await this.storage.transaction(async (tx) => {
			await tx.run(
				`INSERT INTO ${this.permits}(operation, root, holder, kind, state) VALUES (?, ?, ?, ?, 'waiting')`,
				operation,
				this.options.root,
				this.options.holder,
				kind,
			);
		});
		try {
			for (;;) {
				signal?.throwIfAborted();
				const hostReason = this.hostReason();
				const granted = await this.storage.transaction(async (tx) => {
					const { root, attempt } = this.options;
					if (attempt) {
						const work = await tx.get(
							`SELECT 1 AS valid FROM ${this.storage.tables.runs}_work w JOIN ${this.storage.tables.leases} l ON l.run_id = w.root
							JOIN ${this.storage.tables.runs}_pool p ON p.root = w.root JOIN ${this.storage.tables.runs} r ON r.run_id = w.root
							WHERE w.id = ? AND w.root = ? AND w.generation = ? AND w.epoch = ? AND w.state = 'leased' AND r.status = 'running'
							AND w.expires_at >= CAST(unixepoch('subsec') * 1000 AS INTEGER)
							AND l.epoch = w.epoch AND l.renewed_at + p.timeout >= CAST(unixepoch('subsec') * 1000 AS INTEGER)`,
							attempt.id,
							root,
							attempt.generation,
							attempt.epoch,
						);
						if (!work) throw new Error("Stale resource admission attempt");
					}
					let reason = hostReason;
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
	async inspect(): Promise<PermitRow[]> {
		return this.storage.transaction((tx) => tx.all<PermitRow>(`SELECT * FROM ${this.permits} ORDER BY ticket`));
	}
	async releaseStoppedSessions(holder: string): Promise<number> {
		return this.storage.transaction(async (tx) => {
			await tx.run(
				`UPDATE ${this.permits} SET state = 'released', reason = 'worker exit confirmed' WHERE root = ? AND holder = ? AND (kind = 'session' OR state = 'waiting')`,
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
