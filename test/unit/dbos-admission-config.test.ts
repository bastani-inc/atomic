import assert from "node:assert/strict";
import { ensurePGDatabase } from "@dbos-inc/dbos-sdk/datasource";
import { Client } from "pg";
import { afterEach, beforeEach, test, vi } from "vitest";
import { configureAdmissionDatabase } from "../../packages/workflows/src/durable/dbos-admission-config.js";
import type { DbosConfiguration } from "../../packages/workflows/src/durable/dbos-sdk-handle.js";

vi.mock("@dbos-inc/dbos-sdk/datasource", async (importOriginal) => ({
	...(await importOriginal<typeof import("@dbos-inc/dbos-sdk/datasource")>()),
	ensurePGDatabase: vi.fn(async () => ({ status: "already_exists", notes: [], message: "exists" })),
}));
const sdk = { setConfig: vi.fn<(config: DbosConfiguration) => void>(), launch: vi.fn(async () => {}) };
const runWithoutLaunchLock = async (_url: string, launch: () => Promise<void>) => await launch();
const config: DbosConfiguration = {
	name: "atomic-workflows",
	runAdminServer: false,
	executorID: "isolated-config-test",
	logger: { info() {}, debug() {}, warn: vi.fn(), error() {} },
};
function configured() {
	const value = sdk.setConfig.mock.calls.at(-1)?.[0];
	assert.ok(value?.systemDatabasePool);
	return { ...value, systemDatabasePool: value.systemDatabasePool };
}

beforeEach(() => {
	for (const key of ["PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGCONNECT_TIMEOUT", "PGSSLMODE"])
		vi.stubEnv(key, undefined);
});
afterEach(async () => {
	for (const [value] of sdk.setConfig.mock.calls) {
		if (!value.systemDatabasePool?.ended) await value.systemDatabasePool?.end();
	}
	vi.restoreAllMocks();
	vi.clearAllMocks();
	vi.unstubAllEnvs();
});

// #3072: the injected admission pool must use DBOS's application-derived endpoint.
for (const [name, database] of [
	["atomic-workflows", "atomic_workflows_dbos_sys"],
	["Atomic Workflows-v2", "atomic_workflows_v2_dbos_sys"],
	["1-worker", "_1_worker_dbos_sys"],
] as const) {
	test(`default endpoint follows DBOS naming for ${name}`, () => {
		configureAdmissionDatabase(sdk, { ...config, name });
		assert.equal(
			configured().systemDatabaseUrl,
			`postgresql://postgres:dbos@localhost:5432/${database}?connect_timeout=10&sslmode=disable`,
		);
	});
}

// #3072: preserve DBOS's warning-and-launch behavior when verification fails.
test("failed database verification warns before launching the configured pool", async () => {
	vi.mocked(ensurePGDatabase).mockResolvedValueOnce({ status: "failed", notes: [], message: "unavailable" });
	const database = configureAdmissionDatabase(sdk, config, runWithoutLaunchLock);
	await database.launch();
	assert.equal(vi.mocked(config.logger.warn).mock.calls.length, 1);
	assert.equal(sdk.launch.mock.calls.length, 1);
});

// #3072: explicit external endpoints win; these pools never open a socket.
test("explicit endpoint overrides PG environment and provisions that same database", async () => {
	for (const [key, value] of Object.entries({
		PGHOST: "/var/run/postgresql",
		PGPORT: "15432",
		PGUSER: "ignored-user",
		PGPASSWORD: "ignored-password",
		PGDATABASE: "ignored-database",
		PGCONNECT_TIMEOUT: "7",
		PGSSLMODE: "require",
	}))
		vi.stubEnv(key, value);
	const systemDatabaseUrl = "postgresql://fixture:unused@127.0.0.1:1/explicit?connect_timeout=3&sslmode=disable";
	const database = configureAdmissionDatabase(sdk, { ...config, systemDatabaseUrl }, runWithoutLaunchLock);
	const initial = configured();
	assert.equal(initial.systemDatabaseUrl, systemDatabaseUrl);
	assert.equal(initial.systemDatabasePool.options.connectionString, systemDatabaseUrl);
	assert.equal(initial.systemDatabasePool.options.connectionTimeoutMillis, 3_000);
	const client = new Client(initial.systemDatabasePool.options);
	assert.equal(client.host, "127.0.0.1");
	assert.equal(client.port, 1);
	assert.equal(client.user, "fixture");
	assert.equal(client.password, "unused");
	assert.equal(client.database, "explicit");
	assert.equal(client.ssl, false);
	assert.equal(initial.systemDatabasePool.totalCount, 0);
	assert.equal(vi.mocked(ensurePGDatabase).mock.calls.length, 0, "configuration does not provision");
	await database.launch();
	assert.equal(vi.mocked(ensurePGDatabase).mock.calls[0]?.[0].urlToEnsure, systemDatabaseUrl);
	assert.equal(sdk.launch.mock.calls.length, 1);
	assert.equal(sdk.setConfig.mock.calls.length, 1, "an open pool must not be reconfigured after launch");
});

test("default endpoint preserves PG credentials, port, TLS and timeout", () => {
	for (const [key, value] of Object.entries({
		PGHOST: "fixture.invalid",
		PGPORT: "15432",
		PGUSER: "fixture",
		PGPASSWORD: "p@ss/word",
		PGCONNECT_TIMEOUT: "7",
		PGSSLMODE: "require",
	}))
		vi.stubEnv(key, value);
	configureAdmissionDatabase(sdk, config);
	assert.equal(
		configured().systemDatabaseUrl,
		"postgresql://fixture:p%40ss%2Fword@fixture.invalid:15432/atomic_workflows_dbos_sys?connect_timeout=7&sslmode=require",
	);
	assert.equal(configured().systemDatabasePool.options.connectionTimeoutMillis, 7_000);
});

// #3072 / #3076 discussion_r4029126308: preserve PGHOST and credentials in the admission pool.
// Constructing pg.Client parses the actual pool options without opening a connection.
for (const host of ["::1", "/var/run/postgresql"]) {
	test(`default endpoint preserves PostgreSQL host ${host} through the pg parser`, () => {
		for (const [key, value] of Object.entries({
			PGHOST: host,
			PGPORT: "15432",
			PGUSER: "fixture@user:/?#%",
			PGPASSWORD: "p@ss/word:#?%",
			PGCONNECT_TIMEOUT: "7",
			PGSSLMODE: "require",
		}))
			vi.stubEnv(key, value);
		configureAdmissionDatabase(sdk, config);
		const pool = configured().systemDatabasePool;
		// Do not let pg's environment fallback hide a missing serialized endpoint.
		for (const key of ["PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGCONNECT_TIMEOUT", "PGSSLMODE"])
			vi.stubEnv(key, undefined);
		const client = new Client(pool.options);
		assert.equal(client.host, host);
		assert.equal(client.port, 15432);
		assert.equal(client.user, "fixture@user:/?#%");
		assert.equal(client.password, "p@ss/word:#?%");
		assert.equal(client.database, "atomic_workflows_dbos_sys");
		assert.ok(client.ssl);
		assert.equal(pool.options.connectionTimeoutMillis, 7_000);
		assert.equal(pool.totalCount, 0);
		assert.equal(vi.mocked(ensurePGDatabase).mock.calls.length, 0);
		assert.equal(sdk.launch.mock.calls.length, 0);
	});
}

// #3072: failed-launch shutdown ends DBOS's custom pool. Retry replaces only that pool.
test("launch after shutdown replaces the ended pool and checks readiness on the replacement", async () => {
	const database = configureAdmissionDatabase(sdk, config, runWithoutLaunchLock);
	const initial = configured();
	const failure = new Error("isolated launch failure");
	sdk.launch.mockRejectedValueOnce(failure);
	await assert.rejects(database.launch(), (error) => error === failure);
	await initial.systemDatabasePool.end();
	await database.launch();
	const replacement = configured();
	assert.notEqual(replacement.systemDatabasePool, initial.systemDatabasePool);
	assert.equal(replacement.systemDatabaseUrl, initial.systemDatabaseUrl);
	assert.equal(replacement.executorID, config.executorID);
	assert.equal(sdk.setConfig.mock.calls.length, 2);
	assert.equal(vi.mocked(ensurePGDatabase).mock.calls.length, 2);
	const query = vi.spyOn(replacement.systemDatabasePool, "query").mockImplementation(async () => undefined);
	await database.checkReady();
	assert.deepEqual(query.mock.calls, [["SELECT 1"]]);
});

// #3072: configuring the admission fence must preserve the exact external endpoint without connecting.
test("explicit endpoint configures a custom admission pool without launching", () => {
	const systemDatabaseUrl = "postgresql://fixture:unused@127.0.0.1:1/explicit?connect_timeout=3&sslmode=disable";
	configureAdmissionDatabase(sdk, {
		name: "atomic-workflows",
		systemDatabaseUrl,
		runAdminServer: false,
		executorID: "isolated-config-test",
		logger: { info() {}, debug() {}, warn() {}, error() {} },
	});
	const config = sdk.setConfig.mock.calls.at(-1)?.[0];
	assert.ok(config?.systemDatabasePool);
	assert.equal(config.systemDatabaseUrl, systemDatabaseUrl);
	assert.equal(config.systemDatabasePool.options.connectionString, systemDatabaseUrl);
	assert.equal(config.systemDatabasePool.options.connectionTimeoutMillis, 3_000);
	assert.equal(sdk.launch.mock.calls.length, 0);
});

test("DBOS launch runs inside the database's launch lock after the database is ensured", async () => {
	const events: string[] = [];
	vi.mocked(ensurePGDatabase).mockImplementationOnce(async () => {
		events.push("ensure");
		return { status: "already_exists", notes: [], message: "exists" };
	});
	sdk.launch.mockImplementationOnce(async () => {
		events.push("launch");
	});
	const url = "postgresql://atomic:secret@db.example.com:5432/atomic_workflows";
	const database = configureAdmissionDatabase(sdk, { ...config, systemDatabaseUrl: url }, async (lockUrl, launch) => {
		events.push(`lock:${lockUrl}`);
		await launch();
		events.push("unlock");
	});

	await database.launch();

	assert.deepEqual(events, ["ensure", `lock:${url}`, "launch", "unlock"]);
});
