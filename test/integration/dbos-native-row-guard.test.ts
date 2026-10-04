import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { Pool, type PoolClient } from "pg";
import { test } from "vitest";
import { encodeMetadata } from "../../packages/workflows/src/durable/dbos-metadata.js";
import { type DbosRowAuthority, installDbosRowGuard } from "../../packages/workflows/src/durable/dbos-row-guard.js";
import { type ManagedResult, RealPostgresHome, reserveListener } from "../helpers/real-postgres.js";

const REAL_NATIVE_ROW_GUARD_TIMEOUT_MS = 180_000;

test(
	"native database writes cannot change enrolled Atomic rows while unrelated SDK steps persist (#3419)",
	async () => {
		const home = new RealPostgresHome();
		const listener = await reserveListener();
		let pool: Pool | undefined;
		let control: Pool | undefined;
		let launched = false;
		try {
			const { url } = await home.client(listener.port).request<ManagedResult>("ensure");
			const endpoint = new URL(url);
			endpoint.pathname = "/postgres";
			pool = new Pool({ connectionString: endpoint.href, connectionTimeoutMillis: 3_000, statement_timeout: 5_000 });
			control = new Pool({
				connectionString: endpoint.href,
				connectionTimeoutMillis: 3_000,
				statement_timeout: 5_000,
			});
			const authority = new AsyncLocalStorage<DbosRowAuthority>();
			const connect = pool.connect.bind(pool);
			const acquire = async () => {
				const client = await connect();
				try {
					await installDbosRowGuard(client);
					await client.query("SELECT set_config('atomic.row_authority', $1, false)", [
						JSON.stringify(authority.getStore() ?? null),
					]);
					const release = client.release.bind(client);
					client.release = () => release(true);
					return client;
				} catch (error) {
					client.release(true);
					throw error;
				}
			};
			function guardedConnect(): Promise<PoolClient>;
			function guardedConnect(
				callback: (error: Error | undefined, client: PoolClient | undefined, done: () => void) => void,
			): void;
			function guardedConnect(
				callback?: (error: Error | undefined, client: PoolClient | undefined, done: () => void) => void,
			): Promise<PoolClient> | undefined {
				if (callback === undefined) return acquire();
				void acquire().then(
					(client) => callback(undefined, client, client.release),
					(error: Error) => callback(error, undefined, () => {}),
				);
				return undefined;
			}
			pool.connect = guardedConnect;
			const rootId = crypto.randomUUID();
			const owner = `atomic-db-${crypto.randomUUID()}`;
			const root = DBOS.registerWorkflow(async () => "root", { name: "atomicWorkflowHandle" });
			const metadata = encodeMetadata({
				workflowId: rootId,
				name: "guarded",
				inputs: {},
				status: "running",
				ownerExecutorId: owner,
				createdAt: 1,
				updatedAt: 10,
				completedCheckpoints: 0,
				pendingPrompts: 0,
				promptReservationEpoch: "epoch",
			});
			const checkpoint = DBOS.registerWorkflow(async () => metadata, { name: "atomicWorkflowCheckpoint" });
			const unrelated = DBOS.registerWorkflow(async () => DBOS.runStep(async () => "unrelated step"), {
				name: "unrelatedWorkflow",
			});
			DBOS.setConfig({
				name: "rowguard3419",
				systemDatabasePool: pool,
				systemDatabaseUrl: endpoint.href,
				runAdminServer: false,
				executorID: crypto.randomUUID(),
			});
			await DBOS.launch();
			launched = true;
			await (await DBOS.startWorkflow(root, { workflowID: rootId })()).getResult();
			await authority.run({ root: rootId, actor: owner, enroll: true }, async () => {
				await (
					await DBOS.startWorkflow(checkpoint, {
						workflowID: `${rootId}:checkpoint:__atomic_metadata:10:initial`,
					})()
				).getResult();
			});
			const before = await control.query(
				"SELECT status, output FROM dbos.workflow_status WHERE workflow_uuid = $1",
				[rootId],
			);
			const changed = await control.query(
				"UPDATE dbos.workflow_status SET status = 'CANCELLED' WHERE workflow_uuid = $1",
				[rootId],
			);
			assert.equal(changed.rowCount, 0, "outside-context native writes must not modify an enrolled root");
			assert.deepEqual(
				(await control.query("SELECT status, output FROM dbos.workflow_status WHERE workflow_uuid = $1", [rootId]))
					.rows,
				before.rows,
			);
			const operation = await control.query(
				"INSERT INTO dbos.operation_outputs(workflow_uuid,function_id,function_name,output) VALUES($1,0,'stale','stale')",
				[rootId],
			);
			assert.equal(operation.rowCount, 0);
			assert.equal(
				await (await DBOS.startWorkflow(unrelated, { workflowID: crypto.randomUUID() })()).getResult(),
				"unrelated step",
			);
			assert.equal(
				(
					await control.query(
						"SELECT count(*)::int AS count FROM dbos.operation_outputs WHERE function_name <> 'stale'",
					)
				).rows[0].count,
				1,
			);
			assert.equal(
				await (await DBOS.startWorkflow(unrelated, { workflowID: `${rootId}:checkpoint:unrelated` })()).getResult(),
				"unrelated step",
			);
			assert.equal(
				(
					await control.query("UPDATE dbos.workflow_status SET name='unrelatedWorkflow' WHERE workflow_uuid=$1", [
						rootId,
					])
				).rowCount,
				0,
			);
			const initialId = `${rootId}:checkpoint:__atomic_metadata:10:initial`;
			const snapshot = (
				await control.query(
					"SELECT owner,generation,terminal,claim FROM dbos.atomic_owner_generation WHERE root=$1",
					[rootId],
				)
			).rows;
			assert.equal(
				(
					await control.query("UPDATE dbos.workflow_status SET workflow_uuid=$2 WHERE workflow_uuid=$1", [
						rootId,
						crypto.randomUUID(),
					])
				).rowCount,
				0,
			);
			const scoped = await control.connect();
			const body = (actor: string, status: "running" | "blocked" | "completed", transitionClaimId?: string) =>
				JSON.stringify(
					encodeMetadata({
						workflowId: rootId,
						name: "guarded",
						inputs: {},
						status,
						ownerExecutorId: actor,
						createdAt: 1,
						updatedAt: 10,
						completedCheckpoints: 0,
						pendingPrompts: 0,
						promptReservationEpoch: "epoch",
						...(transitionClaimId === undefined ? {} : { transitionClaimId }),
					}),
				);
			try {
				await scoped.query("SELECT set_config('atomic.row_authority',$1,false)", [
					JSON.stringify({ root: rootId, actor: owner, owner, generation: 10 }),
				]);
				const ignored = await scoped.query(
					"INSERT INTO dbos.workflow_status(workflow_uuid,name,status,output) VALUES($1,'atomicWorkflowCheckpoint','SUCCESS',$2) ON CONFLICT DO NOTHING",
					[initialId, body(owner, "completed")],
				);
				assert.equal(ignored.rowCount, 0);
				assert.deepEqual(
					(
						await control.query(
							"SELECT owner,generation,terminal,claim FROM dbos.atomic_owner_generation WHERE root=$1",
							[rootId],
						)
					).rows,
					snapshot,
					"ignored metadata cannot advance its ownership projection",
				);
				await scoped.query("BEGIN");
				await scoped.query(
					"INSERT INTO dbos.workflow_status(workflow_uuid,name,status,output) VALUES($1,'atomicWorkflowCheckpoint','SUCCESS',$2)",
					[`${rootId}:checkpoint:__atomic_metadata:11:rollback`, body(owner, "blocked")],
				);
				assert.equal(
					(
						await scoped.query(
							"SELECT generation::int AS generation FROM dbos.atomic_owner_generation WHERE root=$1",
							[rootId],
						)
					).rows[0].generation,
					11,
				);
				await scoped.query("ROLLBACK");
				assert.deepEqual(
					(
						await control.query(
							"SELECT owner,generation,terminal,claim FROM dbos.atomic_owner_generation WHERE root=$1",
							[rootId],
						)
					).rows,
					snapshot,
				);
				assert.equal(
					(
						await control.query("SELECT 1 FROM dbos.workflow_status WHERE workflow_uuid=$1", [
							`${rootId}:checkpoint:__atomic_metadata:11:rollback`,
						])
					).rowCount,
					0,
				);
			} finally {
				await scoped.query("ROLLBACK");
				scoped.release(true);
			}
			const contenders = await Promise.all([control.connect(), control.connect()]);
			const actors = [`atomic-db-${crypto.randomUUID()}`, `atomic-db-${crypto.randomUUID()}`];
			const tokens = [crypto.randomUUID(), crypto.randomUUID()];
			try {
				await Promise.all(
					contenders.map((client, index) =>
						client.query("SELECT set_config('atomic.row_authority',$1,false)", [
							JSON.stringify({
								root: rootId,
								actor: actors[index],
								owner,
								generation: 10,
								claim: tokens[index],
								checkpoint: `${rootId}:checkpoint:__atomic_metadata:11:claim`,
							}),
						]),
					),
				);
				for (const client of contenders)
					await assert.rejects(
						client.query("UPDATE dbos.workflow_status SET status='CANCELLED' WHERE workflow_uuid=$1", [rootId]),
						/ownership generation changed/,
					);
				const raced = await Promise.allSettled(
					contenders.map((client, index) =>
						client.query(
							"INSERT INTO dbos.workflow_status(workflow_uuid,name,status,output) VALUES($1,'atomicWorkflowCheckpoint','SUCCESS',$2) ON CONFLICT DO NOTHING",
							[`${rootId}:checkpoint:__atomic_metadata:11:claim`, body(actors[index], "blocked", tokens[index])],
						),
					),
				);
				assert.equal(raced.filter((result) => result.status === "fulfilled").length, 1);
				assert.equal(raced.filter((result) => result.status === "rejected").length, 1);
				const loser = raced.findIndex((result) => result.status === "rejected");
				await assert.rejects(
					contenders[loser].query("UPDATE dbos.workflow_status SET status='CANCELLED' WHERE workflow_uuid=$1", [
						rootId,
					]),
					/ownership generation changed/,
				);
			} finally {
				for (const client of contenders) client.release(true);
			}
		} finally {
			try {
				if (launched) await DBOS.shutdown({ deregister: true });
				await Promise.all([pool?.ended ? undefined : pool?.end(), control?.end()]);
			} finally {
				try {
					await home.cleanup();
				} finally {
					await listener.close();
				}
			}
		}
	},
	REAL_NATIVE_ROW_GUARD_TIMEOUT_MS,
);
