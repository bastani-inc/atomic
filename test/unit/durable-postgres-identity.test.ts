import assert from "node:assert/strict";
import { once } from "node:events";
import { chmodSync, mkdirSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { Client } from "pg";
import { afterEach, test, vi } from "vitest";
import {
	embeddedDbosSystemDatabaseUrl,
	embeddedPostgresHealth,
	embeddedPostgresTestHooks as hooks,
	resetEmbeddedDbosPostgresForTests,
	shutdownEmbeddedDbosPostgres,
} from "../../packages/workflows/src/durable/dbos-embedded-postgres.js";
import {
	availablePostgresPort,
	managedPostmaster,
	POSTGRES_IDENTITY_SQL,
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

test("SQL identity rejects foreign data, port, address, pidfile start time and system identifier with field diagnostics", async () => {
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
			(error: Error) => {
				assert.match(error.message, /identity mismatch/);
				assert.ok(error.message.includes(`sql.${Object.keys(change)[0]}: expected `), error.message);
				assert.match(error.message, /observed /);
				return true;
			},
		);
	}
	await assert.rejects(
		verifyPostgresIdentity(f.metadata, port, process.pid + 1, async () => f.row(port)),
		/process.pid: expected \d+, observed \d+/,
	);
	await assert.rejects(
		verifyPostgresIdentity(f.metadata, port, null, async () => f.row(port)),
		/process.pid: expected null, observed \d+/,
	);
	await assert.rejects(
		verifyPostgresIdentity(f.metadata, port, process.pid, async () => {
			f.pidfile(port, 2);
			return f.row(port);
		}),
		/process.after.started: expected 1, observed 2/,
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

function legacyCluster(f: ReturnType<typeof fixture>, opts: string) {
	removeTempDirectory(join(f.root, "v18.shared"));
	writeTextSync(join(f.data, "postmaster.opts"), opts);
}
const legacyLaunch = (data: string, port = 5439) =>
	`/opt/atomic natives/postgres-runtime/bin/postgres "-D" "${data}" "-p" "${port}" "-c" "listen_addresses=127.0.0.1"\n`;

test("adopts a legacy Atomic-provisioned cluster without reinitializing (#3235)", async () => {
	const f = fixture();
	legacyCluster(f, legacyLaunch(f.data));
	const port = await availablePostgresPort(0);
	f.pidfile(port);
	let starts = 0;
	hooks.setRetainedPostgresSpawner(() => {
		starts++;
		throw new Error("unexpected start");
	});
	await hooks.ensureCluster(f.options);
	assert.equal(starts, 0);
	assert.equal(readTextSync(join(f.data, "PG_VERSION"), "utf8"), "18\n");
	const adopted = managedPostgresMetadata(f.root, 18, false);
	assert.equal(statSync(adopted.dataDir).ino, statSync(f.data).ino);
	assert.equal(adopted.directoryIdentity, f.metadata.directoryIdentity);
	assert.ok(statSync(join(f.root, "v18.shared", "cluster.json")).isFile());
});

const GENUINE_OLD_ATOMIC_POSTMASTER_OPTS =
	'/Users/norinlavaee/.bun/install/global/node_modules/@bastani/atomic-natives-darwin-arm64/postgres-runtime/bin/postgres "-D" "/Users/norinlavaee/.atomic/postgres/v18" "-p" "5439" "-c" "listen_addresses=127.0.0.1"\n';

test("adopts a cluster whose postmaster.opts is verbatim old-Atomic output (#3235)", async () => {
	const f = fixture();
	legacyCluster(
		f,
		GENUINE_OLD_ATOMIC_POSTMASTER_OPTS.replace('"/Users/norinlavaee/.atomic/postgres/v18"', `"${f.data}"`),
	);
	const port = await availablePostgresPort(0);
	f.pidfile(port);
	let starts = 0;
	hooks.setRetainedPostgresSpawner(() => {
		starts++;
		throw new Error("unexpected start");
	});
	await hooks.ensureCluster(f.options);
	assert.equal(starts, 0);
	assert.equal(readTextSync(join(f.data, "PG_VERSION"), "utf8"), "18\n");
	assert.ok(statSync(join(f.root, "v18.shared", "cluster.json")).isFile());
});

test("unregistered data without Atomic's recorded loopback launch stays refused (#3235)", async () => {
	for (const opts of [
		undefined,
		legacyLaunch(join("/elsewhere", "v18")),
		legacyLaunch("v18"),
		`/opt/atomic/bin/postgres "-D" "DATA" "-p" "5439" "-c" "listen_addresses=*"\n`,
		`/opt/atomic/bin/postgres "-D" "DATA" "-p" "5439"\n`,
	]) {
		const f = fixture();
		legacyCluster(f, opts === undefined ? "" : opts.replace("DATA", f.data));
		if (opts === undefined) rmSync(join(f.data, "postmaster.opts"));
		await assert.rejects(hooks.ensureCluster(f.options), /Refusing to adopt unregistered/);
		assert.equal(readTextSync(join(f.data, "PG_VERSION"), "utf8"), "18\n");
	}
});

test("a different PostgreSQL major is never adopted as a legacy cluster (#3235)", async () => {
	const f = fixture();
	legacyCluster(f, legacyLaunch(f.data));
	writeTextSync(join(f.data, "PG_VERSION"), "17\n");
	await assert.rejects(hooks.ensureCluster(f.options), /Refusing to adopt unregistered/);
	assert.equal(readTextSync(join(f.data, "PG_VERSION"), "utf8"), "17\n");
});

test("recovery never adopts a legacy cluster that lost its ownership records (#3235)", async () => {
	const f = fixture();
	legacyCluster(f, legacyLaunch(f.data));
	await assert.rejects(hooks.ensureCluster({ ...f.options, recovery: f.metadata }), /Refusing to adopt unregistered/);
	assert.equal(readTextSync(join(f.data, "PG_VERSION"), "utf8"), "18\n");
});

test("unreadable or malformed legacy launch evidence is never adopted (#3235)", async () => {
	const dir = fixture();
	legacyCluster(dir, legacyLaunch(dir.data));
	rmSync(join(dir.data, "PG_VERSION"));
	mkdirSync(join(dir.data, "PG_VERSION"));
	await assert.rejects(hooks.ensureCluster(dir.options), /Refusing to adopt unregistered/);
	assert.ok(statSync(join(dir.data, "PG_VERSION")).isDirectory());
	assert.throws(() => statSync(join(dir.root, "v18.shared")), { code: "ENOENT" });
	if (process.platform === "win32" || process.getuid?.() === 0) return;
	const f = fixture();
	legacyCluster(f, legacyLaunch(f.data));
	chmodSync(join(f.data, "postmaster.opts"), 0o000);
	try {
		await assert.rejects(hooks.ensureCluster(f.options), /Refusing to adopt unregistered/);
		assert.equal(readTextSync(join(f.data, "PG_VERSION"), "utf8"), "18\n");
		assert.throws(() => statSync(join(f.root, "v18.shared")), { code: "ENOENT" });
	} finally {
		chmodSync(join(f.data, "postmaster.opts"), 0o600);
	}
});

test("preferred port validation rejects ambiguous or out-of-range values", () => {
	for (const value of ["", "0", "65536", "1.5", "-1", " 5439", "abc"])
		assert.throws(() => preferredPostgresPort(value), /ATOMIC_POSTGRES_PORT/);
	assert.equal(preferredPostgresPort("15439"), 15439);
});

// #3074: independent module owners contend through the filesystem recovery lock.
test("live consumers elect one recovery starter and retain cluster identity", async () => {
	const f = fixture();
	f.pidfile(await availablePostgresPort(0));
	await hooks.ensureCluster(f.options);
	vi.resetModules();
	const peer = await import("../../packages/workflows/src/durable/dbos-embedded-postgres.js");
	await peer.embeddedPostgresTestHooks.ensureCluster(f.options);
	const localHealth = embeddedPostgresHealth()!;
	const peerHealth = peer.embeddedPostgresHealth()!;
	await Promise.all([localHealth.check(), peerHealth.check()]);
	let starts = 0,
		signals = 0;
	const spawn = (options: import("@bastani/atomic-natives").RetainedPostgresSpawnOptions) => {
		starts++;
		f.pidfile(Number(options.args[options.args.indexOf("-p") + 1]));
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
	};
	hooks.setRetainedPostgresSpawner(spawn);
	peer.embeddedPostgresTestHooks.setRetainedPostgresSpawner(spawn);
	rmSync(join(f.data, "postmaster.pid"));
	try {
		const urls = await Promise.all([localHealth.check(), peerHealth.check()]);
		assert.equal(urls[0], urls[1]);
		assert.equal(starts, 1);
		assert.equal(signals, 0);
		assert.equal(managedPostgresMetadata(f.root, 18, false).clusterId, f.metadata.clusterId);
		assert.equal(readTextSync(join(f.data, "PG_VERSION"), "utf8"), "18\n");
	} finally {
		await peer.shutdownEmbeddedDbosPostgres();
	}
});

// #3074: shutdown during recovery must not strand the elected starter on a dead PID.
test("recovery starts once when the captured postmaster shuts down during its identity probe", async () => {
	const f = fixture();
	const port = await availablePostgresPort(0);
	f.pidfile(port);
	await hooks.ensureCluster(f.options);
	const before = managedPostgresMetadata(f.root, 18, false);
	let starts = 0;
	let signals = 0;
	hooks.setRetainedPostgresSpawner((options) => {
		starts++;
		f.pidfile(Number(options.args[options.args.indexOf("-p") + 1]));
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
	let shuttingDown = true;
	await hooks.ensureCluster({
		...f.options,
		recovery: before,
		probeIdentity: async (selectedPort) => {
			if (shuttingDown) {
				shuttingDown = false;
				rmSync(join(f.data, "postmaster.pid"));
				return undefined;
			}
			return f.row(selectedPort);
		},
	});
	assert.equal(starts, 1);
	assert.equal(signals, 0, "a published postmaster is never signaled by recovery");
	const after = managedPostgresMetadata(f.root, 18, false);
	assert.equal(after.clusterId, before.clusterId);
	assert.equal(after.directoryIdentity, before.directoryIdentity);
	assert.equal(after.server?.systemIdentifier, before.server?.systemIdentifier);
	assert.equal(after.server?.port, port);
});

// #3074: a failed SQL probe alone never authorizes a second server or a signal.
test("an unavailable but present postmaster stays on the attach path", async () => {
	const f = fixture();
	f.pidfile(await availablePostgresPort(0));
	await hooks.ensureCluster(f.options);
	let probes = 0;
	let starts = 0;
	hooks.setRetainedPostgresSpawner(() => {
		starts++;
		throw new Error("must not start beside a live postmaster");
	});
	await assert.rejects(
		hooks.ensureCluster({
			...f.options,
			probeIdentity: async () => {
				if (++probes === 1) return undefined;
				throw new Error("identity probe refused");
			},
		}),
		/identity probe refused/,
	);
	assert.equal(probes, 2);
	assert.equal(starts, 0);
});

test("live health refuses replaced ownership and never initializes missing data", async () => {
	const f = fixture();
	f.pidfile(await availablePostgresPort(0));
	await hooks.ensureCluster(f.options);
	const health = embeddedPostgresHealth()!;
	await health.check();
	let starts = 0;
	hooks.setRetainedPostgresSpawner(() => {
		starts++;
		throw new Error("must not start");
	});
	rmSync(join(f.data, "postmaster.pid"));
	rmSync(join(f.data, "PG_VERSION"));
	await assert.rejects(health.check(), /ENOENT/);
	assert.equal(starts, 0);
	assert.equal(readTextSync(join(f.root, "v18.shared", "cluster.json"), "utf8").includes(f.metadata.clusterId), true);
});

test("recovery revalidates its pinned cluster after waiting for the cross-process lock", async () => {
	const f = fixture();
	f.pidfile(await availablePostgresPort(0));
	await hooks.ensureCluster(f.options);
	const health = embeddedPostgresHealth()!;
	await health.check();
	let release!: () => void;
	let entered!: () => void;
	const locked = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const holder = hooks.withSetupLock(join(f.root, "v18.setup-lock"), async () => {
		entered();
		await new Promise<void>((resolve) => {
			release = resolve;
		});
	});
	await locked;
	let starts = 0;
	hooks.setRetainedPostgresSpawner(() => {
		starts++;
		throw new Error("must not start displaced cluster");
	});
	rmSync(join(f.data, "postmaster.pid"));
	const pending = assert.rejects(health.check(), /unavailable after bounded recovery/);
	await new Promise<void>((resolve) => setImmediate(resolve));
	const changed = { ...managedPostgresMetadata(f.root, 18, false), clusterId: crypto.randomUUID() };
	writeTextSync(join(f.root, "v18.shared", "cluster.json"), JSON.stringify(changed));
	release();
	await Promise.all([holder, pending]);
	assert.match(health.lastFailure?.message ?? "", /recovery identity changed/);
	assert.equal(starts, 0);
	assert.equal(managedPostgresMetadata(f.root, 18, false).clusterId, changed.clusterId);
});

// #3074: a prior healthy probe must not authorize a different socket on the same port.
test("borrowed connections prove their own SQL identity before caller queries", async () => {
	const f = fixture();
	const port = await availablePostgresPort(0);
	f.pidfile(port);
	await hooks.ensureCluster(f.options);
	const health = embeddedPostgresHealth()!;
	await health.check();
	const client = Object.assign(new Client(), { release() {} });
	const query = vi
		.spyOn(client, "query")
		.mockImplementation(async () => ({ rows: [{ ...f.row(port), system_identifier: "foreign" }] }));
	let invalidations = 0;
	health.subscribe(() => invalidations++);
	await assert.rejects(health.validate(client), /identity mismatch/);
	assert.equal(invalidations, 1);
	assert.equal(query.mock.calls.length, 1);
	assert.deepEqual(query.mock.calls[0], [{ text: POSTGRES_IDENTITY_SQL, query_timeout: 1000 }]);
});
