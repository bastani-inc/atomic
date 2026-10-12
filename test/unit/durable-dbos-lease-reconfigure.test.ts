import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { configureDbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import {
	acquireDbosLease,
	dbosLifecycleState,
	getReadyDbosBackend,
	resetDbosLifecycleForTests,
} from "../../packages/workflows/src/durable/dbos-lifecycle.js";
import { PostgresHealth } from "../../packages/workflows/src/durable/dbos-postgres-health.js";
import { getDbosProcessOwner } from "../../packages/workflows/src/durable/dbos-process-owner.js";
import { initializeDurableBackend, setDurableBackend } from "../../packages/workflows/src/durable/factory.js";

const sdk = vi.hoisted(() => ({
	initialized: false,
	launches: 0,
	shutdowns: 0,
	setConfigs: 0,
	registrations: 0,
	pools: [] as Array<{ end(): Promise<void> }>,
}));
vi.mock("@dbos-inc/dbos-sdk", () => ({
	DBOS: {
		setConfig: (config: { systemDatabasePool?: { end(): Promise<void> } }) => {
			if (sdk.initialized) throw new Error("Cannot call DBOS.setConfig after DBOS.launch");
			sdk.setConfigs++;
			if (config.systemDatabasePool !== undefined) sdk.pools.push(config.systemDatabasePool);
		},
		launch: async () => {
			sdk.initialized = true;
			sdk.launches++;
		},
		shutdown: async () => {
			sdk.initialized = false;
			sdk.shutdowns++;
		},
		registerWorkflow: (fn: () => Promise<void>) => {
			sdk.registrations++;
			return fn;
		},
		listWorkflows: async () => [],
	},
}));
vi.mock("@dbos-inc/dbos-sdk/datasource", async (importOriginal) => ({
	...(await importOriginal<typeof import("@dbos-inc/dbos-sdk/datasource")>()),
	ensurePGDatabase: async () => ({ status: "already_exists", notes: [], message: "exists" }),
}));
vi.mock("../../packages/workflows/src/durable/dbos-launch-lock.js", () => ({
	withDbosLaunchLock: async (_url: string, launch: () => Promise<void>) => await launch(),
}));

const MANAGED_URL = "postgresql://atomic:secret@127.0.0.1:1/atomic_workflows_dbos_sys?connect_timeout=1";
const ownerKey = Symbol.for("atomic-workflows/local-postgres-owner@1");
type ManagedHealthHook = (url?: string) => PostgresHealth | undefined;
const processBag = globalThis as typeof globalThis & Record<symbol, { health?: ManagedHealthHook } | undefined>;

let live: PostgresHealth | undefined;
let started = 0;
let previousHealth: ManagedHealthHook | undefined;

async function startManagedPostgres(): Promise<string> {
	started++;
	live = new PostgresHealth({
		probe: async () => ({ url: MANAGED_URL, identity: `cluster-${started}` }),
		url: () => MANAGED_URL,
		recover: async () => {},
	});
	return await live.check();
}

async function stopManagedPostgres(): Promise<void> {
	const stopping = live;
	live = undefined;
	await stopping?.stop();
}

beforeEach(() => {
	Object.assign(sdk, { initialized: false, launches: 0, shutdowns: 0, setConfigs: 0, registrations: 0, pools: [] });
	live = undefined;
	started = 0;
	setDurableBackend(undefined);
	const owner = processBag[ownerKey];
	assert.ok(owner, "local Postgres owner is installed by the lifecycle module");
	previousHealth = owner.health;
	owner.health = (url?: string) => (url === MANAGED_URL ? live : undefined);
});

afterEach(async () => {
	const owner = processBag[ownerKey];
	if (owner) owner.health = previousHealth;
	await live?.stop();
	await Promise.all(sdk.pools.map((pool) => pool.end().catch(() => {})));
	setDurableBackend(undefined);
	resetDbosLifecycleForTests();
});

function configureAgainstManagedPostgres(): void {
	resetDbosLifecycleForTests(
		async () => await configureDbosDurableBackend({ systemDatabaseUrl: await startManagedPostgres() }),
		async () => {},
		stopManagedPostgres,
	);
}

test("a session started after the last lease was released launches durably on a live managed Postgres (#3565)", async () => {
	configureAgainstManagedPostgres();
	const releaseFirst = acquireDbosLease();
	const first = await initializeDurableBackend();
	assert.equal(first.persistent, true);
	await releaseFirst();
	assert.equal(dbosLifecycleState(), "shut_down");
	assert.equal(live, undefined, "last release stops the managed Postgres health observer");

	const releaseSecond = acquireDbosLease();
	const warnings: string[] = [];
	const second = await initializeDurableBackend((warning) => warnings.push(warning));

	assert.deepEqual(warnings, []);
	assert.equal(second.persistent, true);
	assert.equal(dbosLifecycleState(), "ready");
	assert.equal(sdk.launches, 2);
	assert.equal(started, 2, "re-acquiring a lease re-resolves the managed Postgres");
	assert.equal(sdk.registrations, 4, "each session generation registers fresh workflow wrappers");
	await releaseSecond();
});

test("every session generation configures its admission database against the live health observer (#3565)", async () => {
	configureAgainstManagedPostgres();
	const executorIds = new Set<string | undefined>();
	for (let generation = 1; generation <= 3; generation++) {
		const release = acquireDbosLease();
		await getReadyDbosBackend();
		assert.equal(getDbosProcessOwner().databaseDiagnostics?.().provider, "managed");
		assert.equal(sdk.launches, generation);
		executorIds.add(getDbosProcessOwner().executorId);
		await release();
	}
	assert.equal(sdk.setConfigs, 3);
	assert.equal(executorIds.size, 3, "a closed ownership fence is never reused by the next generation");
});
