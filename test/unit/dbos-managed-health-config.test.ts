import assert from "node:assert/strict";
import { Client, Pool } from "pg";
import { afterEach, test, vi } from "vitest";
import { DbosDependencyError, dbosAdmissionContext } from "../../packages/workflows/src/durable/dbos-admission.js";
import { configureAdmissionDatabase } from "../../packages/workflows/src/durable/dbos-admission-config.js";
import { PostgresHealth } from "../../packages/workflows/src/durable/dbos-postgres-health.js";
import type { DbosConfiguration } from "../../packages/workflows/src/durable/dbos-sdk-handle.js";

const local = vi.hoisted(() => ({ health: undefined as PostgresHealth | undefined }));
vi.mock("../../packages/workflows/src/durable/dbos-managed-health.js", () => ({
	resolvedPostgresHealth: () => local.health,
}));
vi.mock("@dbos-inc/dbos-sdk/datasource", async (original) => ({
	...(await original<typeof import("@dbos-inc/dbos-sdk/datasource")>()),
	ensurePGDatabase: vi.fn(async () => ({ status: "already_exists", notes: [], message: "exists" })),
}));
const runWithoutLaunchLock = async (_url: string, launch: () => Promise<void>) => await launch();
const initialUrl = "postgresql://fixture:unused@127.0.0.1:1/isolated?sslmode=disable";
const config: DbosConfiguration = {
	name: "isolated-health-config",
	systemDatabaseUrl: initialUrl,
	executorID: "isolated",
	runAdminServer: false,
	logger: { info() {}, warn() {}, error() {}, debug() {} },
};
afterEach(async () => {
	await local.health?.stop();
	local.health = undefined;
	vi.restoreAllMocks();
	vi.useRealTimers();
});

// #3074: reconnect the SDK's existing pool reference, not a newly launched executor.
test("configured DBOS consumers follow recovered ports without relaunch or reconfiguration", async () => {
	let healthy = true,
		url = initialUrl,
		recoveries = 0;
	local.health = new PostgresHealth({
		probe: async () => (healthy ? { url, identity: url } : undefined),
		recover: async () => {
			recoveries++;
			healthy = true;
			url = initialUrl.replace(":1/", ":2/");
		},
	});
	const connect = vi
		.spyOn(Pool.prototype, "connect")
		.mockImplementation(async () => Object.assign(new Client(), { release: vi.fn() }));
	const sdk = { setConfig: vi.fn<(config: DbosConfiguration) => void>(), launch: vi.fn(async () => {}) };
	const database = configureAdmissionDatabase(sdk, config, runWithoutLaunchLock);
	const pool = sdk.setConfig.mock.calls[0][0].systemDatabasePool!;
	try {
		await database.launch();
		(await pool.connect()).release();
		healthy = false;
		(await pool.connect()).release();
		assert.equal(recoveries, 1);
		assert.equal(connect.mock.calls.length, 2);
		assert.equal(pool.options.connectionString, url);
		assert.equal(sdk.launch.mock.calls.length, 1);
		assert.equal(sdk.setConfig.mock.calls.length, 1);
	} finally {
		await pool.end();
	}
});

// #3072: shared recovery may finish after one admission's deadline; its borrow stays fenced.
test("cancelling admission during shared recovery cannot return a late usable client", async () => {
	let healthy = false;
	let release!: () => void;
	let entered!: () => void;
	const recovering = new Promise<void>((resolve) => {
		entered = resolve;
	});
	local.health = new PostgresHealth({
		probe: async () => (healthy ? { url: initialUrl, identity: "recovered" } : undefined),
		recover: async () => {
			entered();
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			healthy = true;
		},
	});
	const releaseClient = vi.fn();
	const borrowed = Object.assign(new Client(), { release: releaseClient });
	vi.spyOn(Pool.prototype, "connect").mockImplementation(async () => borrowed);
	const sdk = { setConfig: vi.fn<(config: DbosConfiguration) => void>(), launch: vi.fn(async () => {}) };
	configureAdmissionDatabase(sdk, config);
	const pool = sdk.setConfig.mock.calls[0][0].systemDatabasePool!;
	const controller = new AbortController();
	const pending = dbosAdmissionContext.run(controller.signal, () => pool.connect());
	await recovering;
	controller.abort(new DbosDependencyError());
	await assert.rejects(pending, DbosDependencyError);
	release();
	await local.health.check();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(releaseClient.mock.calls, [[true]]);
	await pool.end();
});

// Real pg-pool bookkeeping; replace only the socket boundary.
class SocketlessClient extends Client {
	destroyed = false;
	override connect(): Promise<Client>;
	override connect(callback: (error: Error | null, client: Client) => void): void;
	override connect(callback?: (error: Error | null, client: Client) => void): Promise<Client> | undefined {
		if (callback) queueMicrotask(() => callback(null, this));
		else return Promise.resolve(this);
	}
	override end(): Promise<void>;
	override end(callback: () => void): void;
	override end(callback?: () => void): Promise<void> | undefined {
		this.destroyed = true;
		if (callback) queueMicrotask(callback);
		else return Promise.resolve();
	}
	override query: Client["query"] = (() => {
		assert.equal(this.destroyed, false, "healthy checkout must remain usable");
		return Promise.resolve({ command: "SELECT", rowCount: 1, oid: 0, fields: [], rows: [{ value: 1 }] });
	}) as Client["query"];
}

// #3074 R1: managed health must not evict transactions/LISTEN clients on capacity pressure.
test.each(["acquisition", "timer"])("managed %s health preserves checkouts on 53300", async (trigger) => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const refusal = Object.assign(new Error("sorry, too many clients already"), { code: "53300" });
	let pressure = false;
	const probe = vi.fn(async () => {
		if (pressure) throw refusal;
		return { url: initialUrl, identity: "same-server" };
	});
	const recover = vi.fn(async () => {
		throw new Error("capacity refusal must not restart PostgreSQL");
	});
	local.health = new PostgresHealth({ probe, recover });
	const physicalPools = new Set<Pool>();
	const nativeConnect = Pool.prototype.connect;
	vi.spyOn(Pool.prototype, "connect").mockImplementation(function (this: Pool) {
		physicalPools.add(this);
		Object.assign(this, { Client: SocketlessClient });
		return Reflect.apply(nativeConnect, this, []);
	} as Pool["connect"]);
	const end = vi.spyOn(Pool.prototype, "end");
	const sdk = { setConfig: vi.fn<(config: DbosConfiguration) => void>(), launch: vi.fn(async () => {}) };
	const database = configureAdmissionDatabase(sdk, config, runWithoutLaunchLock);
	const pool = sdk.setConfig.mock.calls[0][0].systemDatabasePool!;
	const consumerError = vi.fn();
	pool.on("error", consumerError);
	const held = await pool.connect();
	held.on("error", consumerError);
	try {
		await database.launch();
		pressure = true;
		const probesBeforeFailure = probe.mock.calls.length;
		if (trigger === "timer") await vi.advanceTimersByTimeAsync(5_000);
		else await assert.rejects(pool.connect(), (error) => error === refusal);
		assert.equal(probe.mock.calls.length, probesBeforeFailure + 1);
		assert.equal(local.health.lastFailure, refusal);
		assert.equal(end.mock.calls.length, 0, "capacity refusal must not retire the physical pool");
		assert.equal(consumerError.mock.calls.length, 0);
		assert.equal(pool.totalCount, 1);
		assert.deepEqual((await held.query("SELECT 1 AS value")).rows, [{ value: 1 }]);
		pressure = false;
		const probesBefore = probe.mock.calls.length;
		if (trigger === "timer") await vi.advanceTimersByTimeAsync(5_000);
		else assert.equal(await local.health.check(), initialUrl);
		assert.equal(probe.mock.calls.length, probesBefore + 1);
		assert.equal(local.health.lastFailure, refusal, "successful checks retain the latest failure for doctor");
		held.release();
		const next = await pool.connect();
		try {
			assert.equal(next, held, "existing connection remains reusable");
			assert.equal(physicalPools.size, 1, "health refusal must not rotate pools");
			assert.equal(recover.mock.calls.length, 0);
			assert.equal(sdk.launch.mock.calls.length, 1);
			assert.equal(sdk.setConfig.mock.calls.length, 1);
		} finally {
			next.release();
		}
	} finally {
		held.release();
		await pool.end();
	}
});
