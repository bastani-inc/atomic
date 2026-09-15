import assert from "node:assert/strict";
import { once } from "node:events";
import { rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import {
	embeddedDbosSystemDatabaseUrl,
	embeddedPostgresTestHooks as hooks,
	resetEmbeddedDbosPostgresForTests,
	shutdownEmbeddedDbosPostgres,
} from "../../packages/workflows/src/durable/dbos-embedded-postgres.js";
import {
	availablePostgresPort,
	managedPostmaster,
	preferredPostgresPort,
	probePostgresIdentity,
	verifyPostgresIdentity,
} from "../../packages/workflows/src/durable/dbos-postgres-identity.js";
import {
	managedPostgresMetadata,
	publishPostgresServer,
} from "../../packages/workflows/src/durable/dbos-postgres-ownership.js";
import {
	makeDirectorySync,
	makeTempDirectory,
	readTextSync,
	removeTempDirectory,
	writeTextSync,
} from "../helpers/runtime.js";

const roots: string[] = [];
const listeners: Server[] = [];
afterEach(async () => {
	resetEmbeddedDbosPostgresForTests();
	vi.unstubAllEnvs();
	for (const listener of listeners.splice(0)) await new Promise<void>((resolve) => listener.close(() => resolve()));
	for (const root of roots.splice(0)) removeTempDirectory(root);
});
async function listener() {
	const server = createServer((socket) => {
		socket.on("error", () => {});
		socket.resume();
	});
	listeners.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	return { server, port: address.port };
}
function fixture() {
	const root = makeTempDirectory("atomic-pg-identity-");
	roots.push(root);
	const data = join(root, "v18");
	makeDirectorySync(join(data, "global"), { recursive: true, mode: 0o700 });
	writeTextSync(join(data, "PG_VERSION"), "18\n");
	writeTextSync(join(data, "global", "pg_control"), "AAAAAAAA");
	const metadata = managedPostgresMetadata(root, 18, true);
	const pidfile = (port: number, started = 1) =>
		writeTextSync(join(data, "postmaster.pid"), `${process.pid}\n${data}\n${started}\n${port}\n`);
	const row = (port: number) => ({
		data_dir: data,
		host: "127.0.0.1",
		port,
		started: "1",
		system_identifier: "4702111234474983745",
	});
	const options = {
		context: {
			baseDir: root,
			runAsOwner: async () => {
				throw new Error("must not initialize existing data");
			},
		},
		binaries: { pg_ctl: join(root, "bin", "pg_ctl"), initdb: "unused", postgres: "unused" },
		probeIdentity: async (port: number) => row(port),
	};
	return { root, data, metadata, pidfile, row, options };
}

// #3074: a stopped registered cluster must not start displaced data, even at the same directory inode.
test("changed PostgreSQL system identity fails before any restart", async () => {
	const f = fixture();
	f.pidfile(12345);
	publishPostgresServer(f.root, f.metadata, managedPostmaster(f.metadata)!);
	rmSync(join(f.data, "postmaster.pid"));
	writeTextSync(join(f.data, "global", "pg_control"), "BBBBBBBB");
	let starts = 0;
	hooks.setRetainedPostgresSpawner(() => {
		starts++;
		throw new Error("unexpected start");
	});
	await assert.rejects(hooks.ensureCluster(f.options), /system identity/);
	assert.equal(starts, 0);
});

// #3074: all network fixtures own ephemeral loopback listeners; no existing service is touched.
test("occupied preferred port is persisted atomically and rediscovered after reload", async () => {
	const foreign = await listener();
	vi.stubEnv("ATOMIC_POSTGRES_PORT", String(foreign.port));
	const f = fixture();
	const path = join(f.root, "v18.shared", "cluster.json");
	const inode = statSync(path).ino;
	let starts = 0,
		signals = 0;
	hooks.setRetainedPostgresSpawner((options) => {
		starts++;
		const port = Number(options.args[options.args.indexOf("-p") + 1]);
		assert.notEqual(port, foreign.port);
		assert.equal(managedPostgresMetadata(f.root, 18, false).server, undefined);
		f.pidfile(port);
		return {
			pid: process.pid,
			wait: async () => {
				throw new Error("Timed out waiting for the retained Postgres process to exit");
			},
			interruptAndWait: async () => {
				signals++;
				return { exited: true, signaled: true };
			},
			release() {},
		};
	});
	vi.resetModules();
	const reloaded = await import("../../packages/workflows/src/durable/dbos-embedded-postgres.js");
	reloaded.embeddedPostgresTestHooks.setRetainedPostgresSpawner(() => {
		throw new Error("competing starter");
	});
	await Promise.all([hooks.ensureCluster(f.options), reloaded.embeddedPostgresTestHooks.ensureCluster(f.options)]);
	const published = managedPostgresMetadata(f.root, 18, false);
	assert.ok(published.server);
	assert.notEqual(statSync(path).ino, inode);
	assert.equal(new URL(embeddedDbosSystemDatabaseUrl()).port, String(published.server.port));
	assert.equal(published.clusterId, f.metadata.clusterId);
	await shutdownEmbeddedDbosPostgres();
	await reloaded.shutdownEmbeddedDbosPostgres();
	resetEmbeddedDbosPostgresForTests();
	vi.stubEnv("ATOMIC_POSTGRES_PORT", "1");
	// Independent module generations contend through the real setup lock and rediscover the same port.
	await Promise.all([hooks.ensureCluster(f.options), reloaded.embeddedPostgresTestHooks.ensureCluster(f.options)]);
	assert.equal(reloaded.embeddedDbosSystemDatabaseUrl(), embeddedDbosSystemDatabaseUrl());
	await reloaded.shutdownEmbeddedDbosPostgres();
	assert.equal(starts, 1);
	assert.equal(signals, 0);
	assert.equal(foreign.server.listening, true);
	assert.equal(readTextSync(join(f.data, "PG_VERSION"), "utf8"), "18\n");
});

test("bind races have three elected attempts and never adopt a competitor", async () => {
	const f = fixture();
	let starts = 0;
	hooks.setRetainedPostgresSpawner(() => {
		starts++;
		throw new Error("address already in use");
	});
	await assert.rejects(hooks.ensureCluster({ ...f.options, isReachable: async () => true }), /address already in use/);
	assert.equal(starts, 3);
	assert.equal(managedPostgresMetadata(f.root, 18, false).server, undefined);
});

test("an exited bind-race child is cleaned before a verified alternate start", async () => {
	const f = fixture();
	let starts = 0,
		signals = 0;
	hooks.setRetainedPostgresSpawner((options) => {
		const failed = ++starts === 1;
		f.pidfile(Number(options.args[options.args.indexOf("-p") + 1]));
		return {
			pid: process.pid,
			wait: async () => {
				if (failed) return { exited: true, signaled: false };
				throw new Error("Timed out waiting for the retained Postgres process to exit");
			},
			interruptAndWait: async () => {
				signals++;
				return { exited: true, signaled: false };
			},
			release() {},
		};
	});
	await hooks.ensureCluster({ ...f.options, isReachable: async () => true });
	await shutdownEmbeddedDbosPostgres();
	assert.equal(starts, 2);
	assert.equal(signals, 1, "only the exact failed child is cleaned, not the ready server");
	assert.ok(managedPostgresMetadata(f.root, 18, false).server);
});

test("SQL identity rejects foreign data, port, address, start time and system identifier", async () => {
	const f = fixture();
	const port = await availablePostgresPort(0);
	f.pidfile(port);
	for (const change of [
		{ data_dir: f.root },
		{ port: port + 1 },
		{ host: "::1" },
		{ started: "2" },
		{ system_identifier: "2" },
	]) {
		await assert.rejects(
			verifyPostgresIdentity(f.metadata, port, process.pid, async () => ({ ...f.row(port), ...change })),
			/identity mismatch/,
		);
	}
	await assert.rejects(
		verifyPostgresIdentity(f.metadata, port, process.pid + 1, async () => f.row(port)),
		/identity mismatch/,
	);
	await assert.rejects(
		verifyPostgresIdentity(f.metadata, port, null, async () => f.row(port)),
		/identity mismatch/,
	);
	await assert.rejects(
		verifyPostgresIdentity(f.metadata, port, process.pid, async () => {
			f.pidfile(port, 2);
			return f.row(port);
		}),
		/identity mismatch/,
	);
});

test("a non-PostgreSQL listener cannot satisfy the bounded SQL probe", async () => {
	const foreign = await listener();
	const started = performance.now();
	assert.equal(await probePostgresIdentity(foreign.port), undefined);
	assert.ok(performance.now() - started < 5000, "the 1-second connection budget must bound a silent listener");
	assert.equal(foreign.server.listening, true);
});

test("unregistered existing data is never adopted or initialized", async () => {
	const f = fixture();
	removeTempDirectory(join(f.root, "v18.shared"));
	await assert.rejects(hooks.ensureCluster(f.options), /Refusing to adopt unregistered/);
	assert.equal(readTextSync(join(f.data, "PG_VERSION"), "utf8"), "18\n");
});

test("preferred port validation rejects ambiguous or out-of-range values", () => {
	for (const value of ["", "0", "65536", "1.5", "-1", " 5439", "abc"])
		assert.throws(() => preferredPostgresPort(value), /ATOMIC_POSTGRES_PORT/);
	assert.equal(preferredPostgresPort("15439"), 15439);
});
