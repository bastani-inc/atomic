import assert from "node:assert/strict";
import { Client, Pool } from "pg";
import { test } from "vitest";
import { DbosOwnerFence } from "../../packages/workflows/src/durable/dbos-owner-fence.js";
import { type ManagedResult, RealPostgresHome, reserveListener } from "../helpers/real-postgres.js";
import { sleep } from "../helpers/runtime.js";

const REAL_OWNER_SQL_FENCING_TIMEOUT_MS = 180_000;
const SQL_STATE_WAIT_TIMEOUT_MS = 10_000;

test(
	"protected SQL sessions retain ownership after guard and lifetime connections die, then refuse stale queries (#3419)",
	async () => {
		const home = new RealPostgresHome();
		const listener = await reserveListener();
		let ownerPool: Pool | undefined;
		let sqlPool: Pool | undefined;
		let observerPool: Pool | undefined;
		let source: DbosOwnerFence | undefined;
		let observer: DbosOwnerFence | undefined;
		let control: Client | undefined;
		let settledWrite: Promise<{ error?: Error }> | undefined;
		const workflowId = crypto.randomUUID();
		const blockIdentity = `3419-sql-block:${workflowId}`;
		try {
			const provisioner = home.client(listener.port);
			const { url } = await provisioner.request<ManagedResult>("ensure");
			const endpoint = new URL(url);
			endpoint.pathname = "/postgres";
			const connectionString = endpoint.href;
			ownerPool = new Pool({ connectionString });
			sqlPool = new Pool({ connectionString });
			observerPool = new Pool({ connectionString });
			const ownedPool = ownerPool;
			const inspectingPool = observerPool;
			const executorId = `atomic-db-${crypto.randomUUID()}`;
			source = new DbosOwnerFence(
				() => ownedPool,
				executorId,
				() => ownedPool.end(),
			);
			observer = new DbosOwnerFence(
				() => inspectingPool,
				`atomic-db-${crypto.randomUUID()}`,
				() => inspectingPool.end(),
			);
			const protectedSql = source.protectPool(sqlPool);
			control = new Client({ connectionString });
			await control.connect();
			await control.query("SELECT pg_advisory_lock(hashtext($1)::bigint)", [blockIdentity]);
			let staleQueryError: Error | undefined;
			settledWrite = source
				.write(workflowId, async () => {
					const client = await protectedSql.connect();
					try {
						await client.query("SELECT pg_advisory_lock(hashtext($1)::bigint)", [blockIdentity]);
						try {
							await client.query("SELECT 1");
						} catch (error) {
							assert.ok(error instanceof Error);
							staleQueryError = error;
						}
					} finally {
						client.release();
					}
				})
				.then(
					() => ({}),
					(error: Error) => ({ error }),
				);
			const deadline = Date.now() + SQL_STATE_WAIT_TIMEOUT_MS;
			for (;;) {
				const pending = await control.query<{ pending: boolean }>(
					"SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock') AS pending",
					[`atomic-sql:${workflowId}`],
				);
				if (pending.rows[0].pending) break;
				assert.ok(Date.now() < deadline, "source SQL never reached its held database lock");
				await sleep(20);
			}
			const terminated = await control.query<{ terminated: boolean }>(
				"SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE application_name = ANY($1)",
				[[`atomic-owner:${executorId}`, `atomic-guard:${workflowId}`]],
			);
			assert.equal(terminated.rows.length, 2);
			assert.ok(terminated.rows.every((row) => row.terminated));
			assert.equal(
				await observer.liveness(executorId),
				"alive",
				"the actual pending SQL connection must still exclude takeover",
			);
			let claimed = false;
			assert.equal(
				await observer.recover(executorId, async () => {
					claimed = true;
					return true;
				}),
				undefined,
			);
			assert.equal(claimed, false);
			await control.query("SELECT pg_advisory_unlock(hashtext($1)::bigint)", [blockIdentity]);
			assert.ok((await settledWrite).error, "the lost guard must not report a successful write generation");
			assert.match(staleQueryError?.message ?? "", /ownership connection was lost/);
			const releaseDeadline = Date.now() + SQL_STATE_WAIT_TIMEOUT_MS;
			while ((await observer.liveness(executorId)) !== "dead") {
				assert.ok(Date.now() < releaseDeadline, "actual SQL connection never released its ownership lock");
				await sleep(20);
			}
			assert.equal(await observer.recover(executorId, async () => true), true);
			await assert.rejects(
				source.write(workflowId, async () => {}),
				/ownership connection was lost/,
			);
		} finally {
			try {
				await control?.query("SELECT pg_advisory_unlock(hashtext($1)::bigint)", [blockIdentity]);
				await settledWrite;
				await Promise.all([source?.close(), observer?.close(), sqlPool?.end()]);
				await control?.end();
			} finally {
				try {
					await home.cleanup();
				} finally {
					await listener.close();
				}
			}
		}
	},
	REAL_OWNER_SQL_FENCING_TIMEOUT_MS,
);

test(
	"copied executor UUIDs cannot register overlapping database owners (#3419)",
	async () => {
		const home = new RealPostgresHome();
		const listener = await reserveListener();
		let original: DbosOwnerFence | undefined;
		let clone: DbosOwnerFence | undefined;
		try {
			const provisioner = home.client(listener.port);
			const { url } = await provisioner.request<ManagedResult>("ensure");
			const endpoint = new URL(url);
			endpoint.pathname = "/postgres";
			const originalPool = new Pool({ connectionString: endpoint.href });
			const clonedPool = new Pool({ connectionString: endpoint.href });
			const executorId = `atomic-db-${crypto.randomUUID()}`;
			original = new DbosOwnerFence(
				() => originalPool,
				executorId,
				() => originalPool.end(),
			);
			clone = new DbosOwnerFence(
				() => clonedPool,
				executorId,
				() => clonedPool.end(),
			);
			const workflowId = crypto.randomUUID();
			await original.write(workflowId, async () => {});
			let cloneExecuted = false;
			await assert.rejects(
				clone.write(workflowId, async () => {
					cloneExecuted = true;
				}),
				/ownership/,
			);
			assert.equal(cloneExecuted, false);
			assert.equal(await original.liveness(executorId), "alive");
			let originalExecuted = false;
			await original.write(workflowId, async () => {
				originalExecuted = true;
			});
			assert.equal(originalExecuted, true, "duplicate identity registration must not invalidate the original");
			await original.close();
			await assert.rejects(
				clone.write(workflowId, async () => {
					cloneExecuted = true;
				}),
				/ownership/,
			);
			assert.equal(cloneExecuted, false, "a rejected clone generation must never reacquire authority");
		} finally {
			try {
				await Promise.all([original?.close(), clone?.close()]);
			} finally {
				try {
					await home.cleanup();
				} finally {
					await listener.close();
				}
			}
		}
	},
	REAL_OWNER_SQL_FENCING_TIMEOUT_MS,
);
