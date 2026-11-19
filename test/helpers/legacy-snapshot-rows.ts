/** Raw 0.9.x rows for the snapshot index's compatibility tests. There is deliberately no workflow runtime here. */
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.ts";
import { SqlSnapshotBlobStore } from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.ts";
import { seedLegacyStore } from "./legacy-store-0990.js";

export interface LegacyRunKey {
	readonly runId: string;
	readonly epoch: number;
}
export interface LegacyEvent {
	readonly type: string;
	readonly payload: Record<string, unknown>;
}

/** A legacy writer beside the session store. Only the columns observed by the retained snapshot index are relevant. */
export class LegacySnapshotRows {
	private constructor(
		readonly database: SqliteDatabase,
		readonly prefix: string,
		readonly snapshotBlobs: SqlSnapshotBlobStore,
	) {}

	static async open(
		database: SqliteDatabase,
		options: { readonly prefix?: string } = {},
	): Promise<LegacySnapshotRows> {
		const prefix = options.prefix ?? "";
		await seedLegacyStore(database, { prefix, contents: "run-schema" });
		return new LegacySnapshotRows(database, prefix, await SqlSnapshotBlobStore.open(database, prefix));
	}

	async start(runId: string, status = "running"): Promise<LegacyRunKey> {
		const header = { runId, name: "synthetic", cwd: "/repo", createdAt: 1, status };
		await this.database.run(
			`INSERT INTO ${this.prefix}wf_runs(run_id,name,cwd,created_at,status,header_json) VALUES (?,?,?,?,?,?)`,
			runId,
			header.name,
			header.cwd,
			header.createdAt,
			status,
			JSON.stringify(header),
		);
		return { runId, epoch: 1 };
	}

	async append(key: LegacyRunKey, event: LegacyEvent): Promise<void> {
		const events = `${this.prefix}wf_events`;
		await this.database.run(
			`INSERT INTO ${events}(run_id,seq,epoch,key,type,payload,at) SELECT ?, COALESCE(MAX(seq),0)+1, ?, NULL, ?, ?, 1 FROM ${events} WHERE run_id=?`,
			key.runId,
			key.epoch,
			event.type,
			JSON.stringify(event.payload),
			key.runId,
		);
	}

	async deleteRun(id: string): Promise<void> {
		await this.database.run(`DELETE FROM ${this.prefix}wf_events WHERE run_id=?`, id);
		await this.database.run(`DELETE FROM ${this.prefix}wf_runs WHERE run_id=?`, id);
	}

	async listRuns(): Promise<readonly { runId: string; status: string }[]> {
		return this.database.all<{ runId: string; status: string }>(
			`SELECT run_id AS runId, status FROM ${this.prefix}wf_runs`,
		);
	}

	async *read(id: string): AsyncIterable<{ event: LegacyEvent }> {
		for (const row of await this.database.all<{ type: string; payload: string }>(
			`SELECT type,payload FROM ${this.prefix}wf_events WHERE run_id=? ORDER BY seq`,
			id,
		)) {
			yield { event: { type: row.type, payload: JSON.parse(row.payload) } };
		}
	}
}
