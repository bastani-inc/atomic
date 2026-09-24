import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RetainedPostgres, RetainedPostgresSpawnOptions } from "@bastani/atomic-natives";
import { afterEach, test, vi } from "vitest";
import { embeddedPostgresTestHooks } from "../../packages/workflows/src/durable/dbos-embedded-postgres.js";
import { managedPostgresLaunchExecutable } from "../../packages/workflows/src/durable/dbos-postgres-identity.js";

const context = () => ({
	baseDir: "/unused",
	runAsOwner: async () => {
		throw new Error("not used");
	},
});
const lease = { pid: 1 } as RetainedPostgres;
const ring = [
	"-c",
	"logging_collector=on",
	"-c",
	"log_directory=log",
	"-c",
	"log_filename=postgresql-%a.log",
	"-c",
	"log_truncate_on_rotation=on",
	"-c",
	"log_rotation_age=1d",
	"-c",
	"log_rotation_size=0",
];
const unsafe = ["-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off"];

afterEach(() => embeddedPostgresTestHooks.setRetainedPostgresSpawner(undefined));

test("managed start enables the weekday collector ring without unsafe durability by default", async () => {
	let observed: RetainedPostgresSpawnOptions | undefined;
	embeddedPostgresTestHooks.setRetainedPostgresSpawner((options) => {
		observed = options;
		return lease;
	});
	await embeddedPostgresTestHooks.startCluster("postgres", "/", "/unused/v18.log", context());
	assert.deepEqual(observed?.args, ["-D", "/", "-p", "5439", "-c", "listen_addresses=127.0.0.1", ...ring]);
	assert.equal(observed?.logFile, "/unused/v18.log");
});

test("unsafe durability requires an opted-in data directory inside the real temporary directory", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "atomic-pg-logging-"));
	const args: string[][] = [];
	embeddedPostgresTestHooks.setRetainedPostgresSpawner((options) => {
		args.push(options.args);
		return lease;
	});
	try {
		await embeddedPostgresTestHooks.startCluster("postgres", dataDir, join(dataDir, "v18.log"), context());
		await embeddedPostgresTestHooks.startCluster("postgres", dataDir, join(dataDir, "v18.log"), context(), 5439, {
			unsafeDurability: true,
		});
		await embeddedPostgresTestHooks.startCluster("postgres", "/", "/unused/v18.log", context(), 5439, {
			unsafeDurability: true,
		});
		assert.deepEqual(args[0].slice(-ring.length), ring);
		assert.deepEqual(args[1].slice(-unsafe.length), unsafe);
		assert.deepEqual(args[2].slice(-ring.length), ring);
	} finally {
		rmSync(dataDir, { recursive: true, force: true });
	}
});

test("managed home data never receives unsafe durability even when TMPDIR is home", async () => {
	const home = mkdtempSync(join(tmpdir(), "atomic-pg-home-"));
	const dataDir = join(home, ".atomic", "postgres", "v18");
	mkdirSync(dataDir, { recursive: true });
	let observed: RetainedPostgresSpawnOptions | undefined;
	embeddedPostgresTestHooks.setRetainedPostgresSpawner((options) => {
		observed = options;
		return lease;
	});
	try {
		vi.stubEnv("HOME", home);
		vi.stubEnv("TMPDIR", home);
		await embeddedPostgresTestHooks.startCluster("postgres", dataDir, join(home, "v18.log"), context(), 5439, {
			unsafeDurability: true,
		});
		assert.deepEqual(observed?.args.slice(-ring.length), ring);
	} finally {
		vi.unstubAllEnvs();
		rmSync(home, { recursive: true, force: true });
	}
});

test("startup diagnostics bound each large log to its last 64 KiB", () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-pg-log-bound-"));
	try {
		const dataDir = join(root, "v18");
		mkdirSync(join(dataDir, "log"), { recursive: true });
		writeFileSync(join(dataDir, "current_logfiles"), "stderr log/postgresql-Mon.log\n");
		writeFileSync(join(root, "v18.log"), `${"x".repeat(1024 * 1024)}\nspawner end\n`);
		writeFileSync(join(dataDir, "log", "postgresql-Mon.log"), `${"y".repeat(1024 * 1024)}\ncollector end\n`);
		const tail = embeddedPostgresTestHooks.logTail(join(root, "v18.log"), dataDir);
		assert.match(tail, /spawner end/);
		assert.match(tail, /collector end/);
		assert.ok(tail.length <= 2 * 64 * 1024 + 100);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("startup diagnostics include both spawner and active collector output", () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-pg-logging-"));
	try {
		const dataDir = join(root, "v18");
		mkdirSync(join(dataDir, "log"), { recursive: true });
		writeFileSync(join(root, "v18.log"), "startup error\n");
		writeFileSync(join(dataDir, "current_logfiles"), "stderr log/postgresql-Mon.log\n");
		writeFileSync(join(dataDir, "log", "postgresql-Mon.log"), "collector error\n");
		const result = embeddedPostgresTestHooks.logTail(join(root, "v18.log"), dataDir);
		assert.match(result, /startup error/);
		assert.match(result, /collector error/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("startup diagnostics reject collector paths escaping the log directory, including symlinks", () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-pg-logging-"));
	try {
		const dataDir = join(root, "v18");
		mkdirSync(join(dataDir, "log"), { recursive: true });
		writeFileSync(join(root, "v18.log"), "startup error\n");
		writeFileSync(join(root, "secret.log"), "must not appear\n");
		writeFileSync(join(dataDir, "current_logfiles"), "stderr log/../../secret.log\n");
		assert.doesNotMatch(embeddedPostgresTestHooks.logTail(join(root, "v18.log"), dataDir), /must not appear/);
		symlinkSync(join(root, "secret.log"), join(dataDir, "log", "postgresql-Mon.log"));
		writeFileSync(join(dataDir, "current_logfiles"), "stderr log/postgresql-Mon.log\n");
		assert.doesNotMatch(embeddedPostgresTestHooks.logTail(join(root, "v18.log"), dataDir), /must not appear/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("managed runtime identity accepts only the weekday collector launch and its test-only durability suffix", () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-pg-logging-"));
	try {
		mkdirSync(join(root, "v18"));
		const dataDir = realpathSync(join(root, "v18"));
		const postgres = join(root, "bin", "postgres");
		const metadata = { version: 1 as const, clusterId: "test", dataDir, directoryIdentity: "test", major: 18 };
		const prefix = `${postgres} "-D" "${dataDir}" "-p" "5439" "-c" "listen_addresses=127.0.0.1"`;
		const suffix = (args: string[]) => args.reduce((text, arg) => `${text} "${arg}"`, "");
		for (const extra of [[], ring, [...ring, ...unsafe]]) {
			writeFileSync(join(dataDir, "postmaster.opts"), `${prefix}${suffix(extra)}\n`);
			assert.equal(managedPostgresLaunchExecutable(metadata, 5439), postgres);
		}
		writeFileSync(join(dataDir, "postmaster.opts"), `${prefix}${suffix([...ring, "-c", "fsync=off"])}\n`);
		assert.throws(() => managedPostgresLaunchExecutable(metadata, 5439), /launch options do not identify/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
