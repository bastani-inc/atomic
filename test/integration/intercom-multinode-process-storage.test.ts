import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openNodeSqliteDatabase } from "@bastani/atomic/storage";
import { afterEach, test, vi } from "vitest";
import { setCliStorageSelection } from "../../packages/coding-agent/src/core/storage/process-selection.js";
import { getBrokerSpawnOptions, getJitiCliPath } from "../../packages/intercom/broker/spawn.js";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";

/**
 * #3790: a broker routes through the shared storage the Atomic process that spawned it selected (`--storage`,
 * `--storage-file`, `ATOMIC_STORAGE`), ahead of the agent directory's settings, as sessions and the journal do.
 */

/** Each case starts one real broker process and waits for its membership lease: that is its structural cost. */
const REAL_BROKER_TEST_TIMEOUT_MS = 60_000;
const LEASE_WAIT_MS = 20_000;
const repoRoot = resolve(import.meta.dirname, "../..");
const extensionDir = join(repoRoot, "packages/intercom");

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Start a broker with the spawn options an Atomic process uses, in an agent directory whose settings select a store. */
async function startBroker(): Promise<{ root: string }> {
	// Short root: a Unix socket path must fit in about 104 bytes.
	const root = mkdtempSync(join(tmpdir(), "icps-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ storage: { path: "settings.sqlite", prefix: "settings_" } }),
	);
	const fixture = new IntercomBrokerFixture(agentDir);
	cleanups.push(async () => {
		await fixture.cleanup();
		rmSync(root, { recursive: true, force: true });
	});
	const options = getBrokerSpawnOptions(extensionDir);
	const broker = spawn(process.execPath, [getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")], {
		...options,
		detached: false,
		stdio: "ignore",
		env: { ...options.env, ATOMIC_CODING_AGENT_DIR: agentDir },
	});
	fixture.trackBroker(broker);
	return { root };
}

/** The broker's membership lease shows it routes through the store at `path` with table prefix `prefix`. */
async function waitForBrokerLease(path: string, prefix: string): Promise<void> {
	await vi.waitFor(
		async () => {
			assert.ok(existsSync(path), `${path} does not exist yet`);
			const database = await openNodeSqliteDatabase(path);
			try {
				const table = `${prefix}intercom_leases`;
				const exists = await database.get(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
					table,
				);
				assert.ok(exists, `${table} does not exist yet`);
				const lease = await database.get(`SELECT holder_id FROM ${table} LIMIT 1`);
				assert.ok(lease, "no lease written yet");
			} finally {
				await database.close();
			}
		},
		{ timeout: LEASE_WAIT_MS, interval: 50 },
	);
}

function withStorageEnvironment(value: string | undefined): void {
	const original = process.env.ATOMIC_STORAGE;
	if (value === undefined) delete process.env.ATOMIC_STORAGE;
	else process.env.ATOMIC_STORAGE = value;
	cleanups.push(() => {
		if (original === undefined) delete process.env.ATOMIC_STORAGE;
		else process.env.ATOMIC_STORAGE = original;
	});
}

test(
	"a broker spawned by a process launched with ATOMIC_STORAGE routes through that store, not settings",
	async () => {
		withStorageEnvironment(JSON.stringify({ path: "process.sqlite", prefix: "process_" }));
		const { root } = await startBroker();
		await waitForBrokerLease(join(root, "process.sqlite"), "process_");
		assert.equal(existsSync(join(root, "settings.sqlite")), false);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a broker spawned by a process launched with --storage routes through that store, ahead of ATOMIC_STORAGE",
	async () => {
		withStorageEnvironment(JSON.stringify({ path: "environment.sqlite", prefix: "environment_" }));
		setCliStorageSelection({ flag: "--storage", value: JSON.stringify({ path: "cli.sqlite", prefix: "cli_" }) });
		cleanups.push(() => setCliStorageSelection(undefined));
		const { root } = await startBroker();
		await waitForBrokerLease(join(root, "cli.sqlite"), "cli_");
		assert.equal(existsSync(join(root, "environment.sqlite")), false);
		assert.equal(existsSync(join(root, "settings.sqlite")), false);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a broker spawned by a process without a storage selection keeps the settings store",
	async () => {
		withStorageEnvironment(undefined);
		const { root } = await startBroker();
		await waitForBrokerLease(join(root, "settings.sqlite"), "settings_");
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);
