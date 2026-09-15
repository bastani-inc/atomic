import assert from "node:assert/strict";
import { renameSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import {
	embeddedPostgresTestHooks as hooks,
	resetEmbeddedDbosPostgresForTests,
	shutdownEmbeddedDbosPostgres,
} from "../../packages/workflows/src/durable/dbos-embedded-postgres.js";
import {
	acquirePostgresConsumer,
	assertManagedPostmaster,
	inspectPostgresConsumers,
	managedPostgresMetadata,
	postgresOwnershipDirectory,
} from "../../packages/workflows/src/durable/dbos-postgres-ownership.js";
import {
	makeDirectorySync,
	makeTempDirectory,
	readTextSync,
	removeTempDirectory,
	spawnProcess,
	writeTextSync,
} from "../helpers/runtime.js";

const roots: string[] = [];
function fixture() {
	const root = makeTempDirectory("atomic-pg-ownership-");
	roots.push(root);
	const data = join(root, "v18");
	makeDirectorySync(data);
	writeTextSync(join(data, "PG_VERSION"), "18\n");
	writeTextSync(join(data, "postmaster.pid"), `${process.pid}\n${data}\n1\n5439\n`);
	return { root, data };
}
afterEach(() => {
	resetEmbeddedDbosPostgresForTests();
	for (const root of roots.splice(0)) removeTempDirectory(root);
});

// #3074: independent runtime consumers share data identity, not executable directories.
test("stable cluster metadata survives consumers from different runtime generations", () => {
	const { root } = fixture();
	const metadata = managedPostgresMetadata(root, 18, true);
	const first = acquirePostgresConsumer(root, metadata, "/versions/old/atomic");
	const second = acquirePostgresConsumer(root, managedPostgresMetadata(root, 18, false), "/versions/new/atomic");
	assert.equal(first.record.clusterId, second.record.clusterId);
	assert.notEqual(first.record.token, second.record.token);
	first.release();
	first.release();
	assert.deepEqual(inspectPostgresConsumers(root, metadata), [second.record]);
	second.release();
	assert.deepEqual(managedPostgresMetadata(root, 18, false), metadata);
});

test("replaced data and malformed or displaced ownership evidence fail closed", () => {
	const { root, data } = fixture();
	const metadata = managedPostgresMetadata(root, 18, true);
	const lease = acquirePostgresConsumer(root, metadata, "runtime");
	const path = join(postgresOwnershipDirectory(root, 18), `${lease.record.token}.consumer`);
	writeTextSync(path, "null");
	lease.release();
	assert.equal(readTextSync(path, "utf8"), "null");
	assert.throws(() => inspectPostgresConsumers(root, metadata), /Invalid.*consumer/);
	renameSync(data, `${data}.preserved`);
	makeDirectorySync(data);
	writeTextSync(join(data, "PG_VERSION"), "18\n");
	assert.throws(() => managedPostgresMetadata(root, 18, false), /identity mismatch/);
	assert.throws(() => managedPostgresMetadata(root, 18, true), /EEXIST/);
	assert.equal(readTextSync(join(`${data}.preserved`, "PG_VERSION"), "utf8"), "18\n");
});

test("stale-looking live or reused PIDs are retained, only proven dead consumers are reaped", () => {
	const { root } = fixture();
	const metadata = managedPostgresMetadata(root, 18, true);
	const lease = acquirePostgresConsumer(root, metadata, "old-runtime");
	assert.deepEqual(
		inspectPostgresConsumers(root, metadata, () => true),
		[lease.record],
	);
	assert.deepEqual(
		inspectPostgresConsumers(root, metadata, () => false),
		[],
	);
	lease.release();
});

test("consumer exit during inspection does not fail another consumer's attach", () => {
	const { root } = fixture();
	const metadata = managedPostgresMetadata(root, 18, true);
	const lease = acquirePostgresConsumer(root, metadata, "exiting-runtime");
	assert.deepEqual(
		inspectPostgresConsumers(root, metadata, () => {
			lease.release();
			return false;
		}),
		[],
	);
});

// Real child processes use only disposable ownership files, never a database or listener.
const CONSUMER_CHILD_TIMEOUT_MS = 10_000;
for (const abandon of [false, true]) {
	test(`starter exit preserves an independent consumer; child ${abandon ? "abandons" : "releases"} its lease`, async () => {
		const { root } = fixture();
		const metadata = managedPostgresMetadata(root, 18, true);
		const moduleUrl = new URL("../../packages/workflows/src/durable/dbos-postgres-ownership.ts", import.meta.url)
			.href;
		const child = spawnProcess(
			[
				process.execPath,
				"--input-type=module",
				"-e",
				`
			import { createJiti } from 'jiti';
			const api = await createJiti(import.meta.url).import(${JSON.stringify(moduleUrl)});
			const root = ${JSON.stringify(root)};
			const lease = api.acquirePostgresConsumer(root, api.managedPostgresMetadata(root, 18, false), 'other-runtime');
			process.stdin.resume();
			process.stdin.once('end', () => { if (!${abandon}) lease.release(); });
			process.stdout.write('ready');
		`,
			],
			{
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				timeout: CONSUMER_CHILD_TIMEOUT_MS,
				env: { ...process.env, HOME: root, USERPROFILE: root, DBOS_SYSTEM_DATABASE_URL: undefined },
			},
		);
		const stderr = new Response(child.stderr).text();
		try {
			const ready = await child.stdout!.getReader().read();
			assert.equal(new TextDecoder().decode(ready.value), "ready");
			const other = inspectPostgresConsumers(root, metadata);
			assert.equal(other.length, 1);
			assert.equal(other[0]?.pid, child.pid);
			let signals = 0;
			let releases = 0;
			const cluster = hooks.setActiveCluster({
				pid: process.pid,
				wait: async () => {
					throw new Error("Timed out waiting for the retained Postgres process to exit");
				},
				interruptAndWait: async () => {
					signals++;
					return { exited: true, signaled: true };
				},
				release: () => {
					releases++;
				},
			});
			await hooks.waitForClusterReadiness("unused.log", cluster, async () => true);
			await shutdownEmbeddedDbosPostgres();
			assert.equal(signals, 0);
			assert.equal(releases, 1);
			assert.deepEqual(inspectPostgresConsumers(root, metadata), other);
			child.stdin!.end();
			assert.equal(await child.exited, 0, await stderr);
			assert.deepEqual(inspectPostgresConsumers(root, metadata), []);
			assert.equal(managedPostgresMetadata(root, 18, false).clusterId, metadata.clusterId);
		} finally {
			child.stdin?.end();
			if (child.exitCode === null) child.kill();
			await child.exited;
		}
	});
}

test("managed attach registers a consumer and reattaches after orderly shutdown without reinitializing", async () => {
	const { root } = fixture();
	const options = {
		context: {
			baseDir: root,
			runAsOwner: async () => {
				throw new Error("must not initialize or start");
			},
		},
		isReachable: async () => true,
	};
	hooks.setEnsureOperation(() => hooks.ensureCluster(options));
	await hooks.ensure();
	const metadata = managedPostgresMetadata(root, 18, false);
	assert.equal(inspectPostgresConsumers(root, metadata).length, 1);
	await shutdownEmbeddedDbosPostgres();
	assert.equal(inspectPostgresConsumers(root, metadata).length, 0);
	await hooks.ensure();
	assert.equal(inspectPostgresConsumers(root, metadata).length, 1);
	await shutdownEmbeddedDbosPostgres();
});

test("local postmaster evidence rejects wrong data and port without signal authority", () => {
	const { root, data } = fixture();
	const metadata = managedPostgresMetadata(root, 18, true);
	assertManagedPostmaster(metadata, 5439);
	assert.throws(() => assertManagedPostmaster(metadata, 5438), /identity/);
	writeTextSync(join(data, "postmaster.pid"), `${process.pid}\n${root}\n1\n5439\n`);
	assert.throws(() => assertManagedPostmaster(metadata, 5439), /identity/);
});

test("missing managed data never triggers initdb over an existing identity", async () => {
	const { root, data } = fixture();
	managedPostgresMetadata(root, 18, true);
	renameSync(data, `${data}.preserved`);
	makeDirectorySync(data);
	let commands = 0;
	await assert.rejects(
		hooks.ensureCluster({
			context: {
				baseDir: root,
				runAsOwner: async () => {
					commands++;
					throw new Error("must not initialize");
				},
			},
			binaries: { pg_ctl: join(root, "bin", "pg_ctl"), initdb: "unused", postgres: "unused" },
			isReachable: async () => false,
		}),
		/missing PG_VERSION/,
	);
	assert.equal(commands, 0);
	assert.equal(readTextSync(join(`${data}.preserved`, "PG_VERSION"), "utf8"), "18\n");
});

test("shutdown during attachment waits for publication then releases the consumer", async () => {
	const { root } = fixture();
	let proceed!: () => void;
	const pending = new Promise<void>((resolve) => {
		proceed = resolve;
	});
	hooks.setEnsureOperation(() =>
		hooks.ensureCluster({
			context: {
				baseDir: root,
				runAsOwner: async () => {
					throw new Error("must not initialize");
				},
			},
			isReachable: async () => {
				await pending;
				return true;
			},
		}),
	);
	const start = hooks.ensure();
	const shutdown = shutdownEmbeddedDbosPostgres();
	proceed();
	await Promise.all([start, shutdown]);
	assert.deepEqual(inspectPostgresConsumers(root, managedPostgresMetadata(root, 18, false)), []);
});
