import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RetainedPostgres, RetainedPostgresSpawnOptions } from "@bastani/atomic-natives";
import { afterEach, test } from "vitest";
import {
	embeddedPostgresTestHooks,
	shutdownEmbeddedDbosPostgres,
} from "../../packages/workflows/src/durable/dbos-embedded-postgres.js";
import {
	cleanupAbandonedRuntimeStages,
	type EmbeddedPostgresRunContext,
	prepareBinariesForOwner,
} from "../../packages/workflows/src/durable/dbos-embedded-postgres-root.js";

class FakeLease implements RetainedPostgres {
	readonly pid = 4242;
	interruptCalls: number[] = [];
	waitCalls: number[] = [];
	releaseCalls = 0;
	interrupt: (timeoutMs: number) => Promise<{ exited: boolean; signaled: boolean }> = async () => ({
		exited: true,
		signaled: true,
	});

	interruptAndWait(timeoutMs: number): Promise<{ exited: boolean; signaled: boolean }> {
		this.interruptCalls.push(timeoutMs);
		return this.interrupt(timeoutMs);
	}

	async wait(timeoutMs: number): Promise<{ exited: boolean; signaled: boolean }> {
		this.waitCalls.push(timeoutMs);
		return { exited: true, signaled: false };
	}

	release(): void {
		this.releaseCalls += 1;
	}
}

function context(owner?: { uid: number; gid: number; name: string }): EmbeddedPostgresRunContext {
	return {
		baseDir: "/cluster-root",
		...(owner === undefined ? {} : { owner }),
		runAsOwner: async () => {
			throw new Error("direct Postgres start must not use the result-only command runner");
		},
	};
}

const TEST_SETUP_LOCK_STALE_MS = 40;
const TEST_SETUP_LOCK_HEARTBEAT_MS = 10;

afterEach(() => {
	embeddedPostgresTestHooks.setEnsureOperation(undefined);
	embeddedPostgresTestHooks.setRetainedPostgresSpawner(undefined);
	embeddedPostgresTestHooks.setActiveCluster(undefined);
});

test("Windows command-line fixture preserves Postgres paths and options as direct arguments", async () => {
	const lease = new FakeLease();
	let options: RetainedPostgresSpawnOptions | undefined;
	embeddedPostgresTestHooks.setRetainedPostgresSpawner((value) => {
		options = value;
		return lease;
	});

	const result = await embeddedPostgresTestHooks.startCluster(
		"C:\\Program Files\\Atomic PostgreSQL\\bin\\postgres.exe",
		"C:\\Users\\Atomic User\\postgres data\\v18",
		"C:\\Users\\Atomic User\\postgres data\\v18.log",
		context(),
	);

	assert.equal(result, lease);
	assert.deepEqual(options, {
		executable: "C:\\Program Files\\Atomic PostgreSQL\\bin\\postgres.exe",
		args: ["-D", "C:\\Users\\Atomic User\\postgres data\\v18", "-p", "5439", "-c", "listen_addresses=127.0.0.1"],
		cwd: "C:\\Users\\Atomic User\\postgres data\\v18",
		logFile: "C:\\Users\\Atomic User\\postgres data\\v18.log",
	});
});

test("Linux root ownership is passed to the direct native spawn", async () => {
	const lease = new FakeLease();
	let options: RetainedPostgresSpawnOptions | undefined;
	embeddedPostgresTestHooks.setRetainedPostgresSpawner((value) => {
		options = value;
		return lease;
	});

	await embeddedPostgresTestHooks.startCluster(
		"/runtime/bin/postgres",
		"/cluster/v18",
		"/cluster/v18.log",
		context({ uid: 70, gid: 71, name: "postgres" }),
	);

	assert.equal(options?.uid, 70);
	assert.equal(options?.gid, 71);
});

test("a reachable competing server after spawn failure is attached without ownership", async () => {
	embeddedPostgresTestHooks.setRetainedPostgresSpawner(() => {
		throw new Error("address already in use");
	});

	const lease = await embeddedPostgresTestHooks.startCluster(
		"postgres",
		"/data",
		"/postgres.log",
		context(),
		async () => true,
	);

	assert.equal(lease, undefined);
	await shutdownEmbeddedDbosPostgres();
});

test("a spawn failure without a reachable competitor preserves the native error and log", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-postgres-spawn-error-"));
	const logFile = join(root, "postgres.log");
	writeFileSync(logFile, "native postmaster detail\n");
	embeddedPostgresTestHooks.setRetainedPostgresSpawner(() => {
		throw new Error("spawn denied");
	});
	try {
		await assert.rejects(
			embeddedPostgresTestHooks.startCluster("postgres", root, logFile, context(), async () => false),
			/spawn denied[\s\S]*native postmaster detail/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("readiness failure fast-shuts down and releases the retained startup lease", async () => {
	const lease = new FakeLease();
	const cluster = embeddedPostgresTestHooks.setActiveCluster(lease);

	await assert.rejects(
		embeddedPostgresTestHooks.waitForClusterReadiness(
			"/postgres.log",
			cluster,
			async () => false,
			1,
			async () => {},
		),
		/never accepted connections/,
	);

	assert.deepEqual(lease.interruptCalls, [60_000]);
	assert.equal(lease.releaseCalls, 1);
	await shutdownEmbeddedDbosPostgres();
	assert.deepEqual(lease.interruptCalls, [60_000], "rollback consumes successful ownership exactly once");
});

test("readiness rollback retains the exact lease when shutdown times out", async () => {
	const lease = new FakeLease();
	let attempts = 0;
	lease.interrupt = async () => {
		attempts += 1;
		if (attempts === 1) throw new Error("Timed out waiting for retained Postgres");
		return { exited: true, signaled: false };
	};
	const cluster = embeddedPostgresTestHooks.setActiveCluster(lease);

	await assert.rejects(
		embeddedPostgresTestHooks.waitForClusterReadiness(
			"/postgres.log",
			cluster,
			async () => false,
			1,
			async () => {},
		),
		(error: unknown) => {
			assert.ok(error instanceof AggregateError);
			assert.match(error.message, /startup failed.*retained process/i);
			return true;
		},
	);
	assert.equal(lease.releaseCalls, 0);

	await shutdownEmbeddedDbosPostgres();
	assert.equal(attempts, 2, "later shutdown retries the same retained lease");
	assert.equal(lease.releaseCalls, 1);
});

test("a failed startup cleanup lease cannot be replaced by an intervening ensure retry", async () => {
	const retainedLease = new FakeLease();
	const replacementLease = new FakeLease();
	let cleanupAttempts = 0;
	retainedLease.interrupt = async () => {
		cleanupAttempts += 1;
		if (cleanupAttempts === 1) throw new Error("rollback timed out");
		return { exited: true, signaled: false };
	};
	let ensureAttempts = 0;
	embeddedPostgresTestHooks.setEnsureOperation(async () => {
		ensureAttempts += 1;
		if (ensureAttempts === 1) {
			const cluster = embeddedPostgresTestHooks.setActiveCluster(retainedLease);
			await embeddedPostgresTestHooks.waitForClusterReadiness(
				"/postgres.log",
				cluster,
				async () => false,
				1,
				async () => {},
			);
			return;
		}
		embeddedPostgresTestHooks.setActiveCluster(replacementLease);
	});

	await assert.rejects(embeddedPostgresTestHooks.ensure(), AggregateError);
	await assert.rejects(embeddedPostgresTestHooks.ensure(), /retained Postgres cleanup/i);
	assert.equal(ensureAttempts, 1, "retry must not enter startup while the failed-cleanup lease is retained");

	await shutdownEmbeddedDbosPostgres();
	assert.equal(cleanupAttempts, 2, "later shutdown retries the original retained lease");
	assert.deepEqual(replacementLease.interruptCalls, []);
	assert.equal(replacementLease.releaseCalls, 0);
});

test("concurrent shutdown callers share one in-flight native stop", async () => {
	const lease = new FakeLease();
	let settle!: (value: { exited: boolean; signaled: boolean }) => void;
	lease.interrupt = () => new Promise((resolve) => (settle = resolve));
	embeddedPostgresTestHooks.setActiveCluster(lease);

	const first = shutdownEmbeddedDbosPostgres();
	const second = shutdownEmbeddedDbosPostgres();
	assert.equal(first, second);
	assert.deepEqual(lease.interruptCalls, [60_000]);
	settle({ exited: true, signaled: true });
	await Promise.all([first, second]);

	assert.equal(lease.releaseCalls, 1);
});

test("pidfile replacement cannot retarget native retained-process shutdown", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-postmaster-pidfile-race-"));
	const lease = new FakeLease();
	try {
		writeFileSync(join(root, "postmaster.pid"), "999999\n5439\n");
		embeddedPostgresTestHooks.setActiveCluster(lease);
		await shutdownEmbeddedDbosPostgres();
		assert.deepEqual(lease.interruptCalls, [60_000]);
		assert.equal(lease.pid, 4242, "shutdown remains tied to the opaque lease, not mutable pidfile content");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an already-exited retained process settles without a signal and is released", async () => {
	const lease = new FakeLease();
	lease.interrupt = async () => ({ exited: true, signaled: false });
	embeddedPostgresTestHooks.setActiveCluster(lease);

	await shutdownEmbeddedDbosPostgres();

	assert.deepEqual(lease.interruptCalls, [60_000]);
	assert.equal(lease.releaseCalls, 1);
});

test("a stale former lock owner cannot delete a replacement owner's lock", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-postgres-lock-owner-"));
	const lockDir = join(root, "setup-lock");
	let now = Date.now();
	let releaseFirst!: () => void;
	let releaseSecond!: () => void;
	let markSecondEntered!: () => void;
	const firstBlocker = new Promise<void>((resolve) => (releaseFirst = resolve));
	const secondBlocker = new Promise<void>((resolve) => (releaseSecond = resolve));
	const secondEntered = new Promise<void>((resolve) => (markSecondEntered = resolve));
	let formerOwnerHeartbeat!: () => boolean;
	try {
		const first = embeddedPostgresTestHooks.withSetupLock(lockDir, () => firstBlocker, {
			now: () => now,
			staleMs: TEST_SETUP_LOCK_STALE_MS,
			heartbeatMs: TEST_SETUP_LOCK_HEARTBEAT_MS,
			scheduleHeartbeat: (heartbeat) => {
				formerOwnerHeartbeat = heartbeat;
				return () => {};
			},
		});
		now += TEST_SETUP_LOCK_STALE_MS * 2;
		const second = embeddedPostgresTestHooks.withSetupLock(
			lockDir,
			async () => {
				markSecondEntered();
				await secondBlocker;
			},
			{
				now: () => now,
				staleMs: TEST_SETUP_LOCK_STALE_MS,
				heartbeatMs: TEST_SETUP_LOCK_HEARTBEAT_MS,
			},
		);
		await secondEntered;
		assert.equal(formerOwnerHeartbeat(), false, "the displaced owner observes that its lease was taken over");

		releaseFirst();
		await first;
		assert.equal(existsSync(lockDir), true, "the former owner's finally must leave the replacement lock intact");

		releaseSecond();
		await second;
		assert.equal(existsSync(lockDir), false);
	} finally {
		releaseFirst();
		releaseSecond();
		rmSync(root, { recursive: true, force: true });
	}
});

test("heartbeats keep live slow setup work beyond the stale threshold exclusively owned", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-postgres-lock-heartbeat-"));
	const lockDir = join(root, "setup-lock");
	let now = Date.now();
	let heartbeat!: () => boolean;
	let release!: () => void;
	let stopCalls = 0;
	let contenderEntered = false;
	const blocker = new Promise<void>((resolve) => (release = resolve));
	try {
		const owner = embeddedPostgresTestHooks.withSetupLock(lockDir, () => blocker, {
			now: () => now,
			staleMs: TEST_SETUP_LOCK_STALE_MS,
			heartbeatMs: TEST_SETUP_LOCK_HEARTBEAT_MS,
			scheduleHeartbeat: (callback, intervalMs) => {
				assert.equal(intervalMs, TEST_SETUP_LOCK_HEARTBEAT_MS);
				heartbeat = callback;
				return () => {
					stopCalls += 1;
				};
			},
		});

		now += TEST_SETUP_LOCK_STALE_MS * 3;
		assert.equal(heartbeat(), true);
		await assert.rejects(
			embeddedPostgresTestHooks.withSetupLock(
				lockDir,
				async () => {
					contenderEntered = true;
				},
				{
					now: () => now,
					staleMs: TEST_SETUP_LOCK_STALE_MS,
					attempts: 1,
					wait: async () => {},
				},
			),
			/Timed out waiting for another Atomic process/,
		);
		assert.equal(contenderEntered, false);

		release();
		await owner;
		assert.equal(stopCalls, 1, "successful setup stops its heartbeat timer");
	} finally {
		release();
		rmSync(root, { recursive: true, force: true });
	}
});

test("setup heartbeats atomically replace the owner marker in the same directory", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-postgres-lock-atomic-heartbeat-"));
	const lockDir = join(root, "setup-lock");
	let now = 1_000;
	let heartbeat!: () => boolean;
	let release!: () => void;
	const blocker = new Promise<void>((resolve) => (release = resolve));
	try {
		const owner = embeddedPostgresTestHooks.withSetupLock(lockDir, () => blocker, {
			now: () => now,
			scheduleHeartbeat: (callback) => {
				heartbeat = callback;
				return () => {};
			},
		});
		const markerName = readdirSync(lockDir).find((entry) => entry.startsWith(".owner-"));
		assert.ok(markerName);
		const markerPath = join(lockDir, markerName);
		const before = statSync(markerPath);
		const beforeContents = readFileSync(markerPath, "utf8");

		now += TEST_SETUP_LOCK_HEARTBEAT_MS;
		assert.equal(heartbeat(), true);
		const after = statSync(markerPath);
		assert.notEqual(after.ino, before.ino, "heartbeat publication replaces the record rather than overwriting it");
		assert.notEqual(readFileSync(markerPath, "utf8"), beforeContents);
		assert.deepEqual(readdirSync(lockDir), [markerName]);

		release();
		await owner;
	} finally {
		release();
		rmSync(root, { recursive: true, force: true });
	}
});

test("a torn-valid old marker cannot displace a live atomic heartbeat", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-postgres-lock-torn-valid-"));
	const lockDir = join(root, "setup-lock");
	let clock = { monotonicMs: 1_000, wallTimeMs: 1_000 };
	let heartbeat!: () => boolean;
	let release!: () => void;
	let contender: Promise<void> | undefined;
	let seamRan = false;
	const blocker = new Promise<void>((resolve) => (release = resolve));
	try {
		const owner = embeddedPostgresTestHooks.withSetupLock(lockDir, () => blocker, {
			clock: () => clock,
			scheduleHeartbeat: (callback) => {
				heartbeat = callback;
				return () => {};
			},
			beforeHeartbeatReplace: (temporaryMarkerPath) => {
				seamRan = true;
				assert.equal(existsSync(temporaryMarkerPath), true);
				const stableName = readdirSync(lockDir).find(
					(entry) => entry.startsWith(".owner-") && !entry.includes(".tmp-"),
				);
				assert.ok(stableName);
				const stablePath = join(lockDir, stableName);
				const oldRecord = JSON.parse(readFileSync(stablePath, "utf8")) as {
					token: string;
					pid: number;
					heartbeatMonotonicMs: number;
				};
				writeFileSync(stablePath, JSON.stringify({ ...oldRecord, heartbeatMonotonicMs: 0 }));
				contender = embeddedPostgresTestHooks.withSetupLock(lockDir, async () => {}, {
					clock: () => clock,
					staleMs: TEST_SETUP_LOCK_STALE_MS,
					attempts: 1,
					isProcessAlive: () => true,
					scheduleHeartbeat: () => () => {},
				});
			},
		});

		clock = { monotonicMs: 1_000 + TEST_SETUP_LOCK_STALE_MS * 2, wallTimeMs: 2_000 };
		assert.equal(heartbeat(), true);
		assert.equal(seamRan, true);
		assert.ok(contender);
		await assert.rejects(contender, /Timed out waiting for another Atomic process/);
		assert.equal(existsSync(lockDir), true, "the live owner remains selected");

		release();
		await owner;
	} finally {
		release();
		rmSync(root, { recursive: true, force: true });
	}
});

test("stale recovery removes a crash-remnant heartbeat temp record without blocking", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-postgres-lock-crash-temp-"));
	const lockDir = join(root, "setup-lock");
	let clock = { monotonicMs: 1_000, wallTimeMs: 1_000 };
	let release!: () => void;
	let ownerToken = "";
	const blocker = new Promise<void>((resolve) => (release = resolve));
	try {
		const formerOwner = embeddedPostgresTestHooks.withSetupLock(
			lockDir,
			async (setup) => {
				ownerToken = setup.runtimePublicationLease.ownerToken;
				const stableName = readdirSync(lockDir).find(
					(entry) => entry.startsWith(".owner-") && !entry.includes(".tmp-"),
				);
				assert.ok(stableName);
				writeFileSync(
					join(lockDir, `.owner-${ownerToken}.tmp-crash-remnant`),
					readFileSync(join(lockDir, stableName), "utf8"),
					{ flag: "wx", mode: 0o600 },
				);
				await blocker;
			},
			{ clock: () => clock, scheduleHeartbeat: () => () => {} },
		);

		clock = { monotonicMs: 1_000 + TEST_SETUP_LOCK_STALE_MS * 2, wallTimeMs: 2_000 };
		let contenderEntered = false;
		await embeddedPostgresTestHooks.withSetupLock(
			lockDir,
			async (setup) => {
				contenderEntered = true;
				assert.equal(setup.abandonedRuntimeStageOwnerTokens.has(ownerToken), true);
			},
			{
				clock: () => clock,
				staleMs: TEST_SETUP_LOCK_STALE_MS,
				attempts: 1,
				isProcessAlive: () => false,
				scheduleHeartbeat: () => () => {},
			},
		);
		assert.equal(contenderEntered, true);

		release();
		await formerOwner;
		assert.equal(existsSync(lockDir), false);
	} finally {
		release();
		rmSync(root, { recursive: true, force: true });
	}
});

test("setup lock stale recovery follows host monotonic time across wall-clock rollback", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-postgres-lock-rollback-"));
	const lockDir = join(root, "setup-lock");
	let clock = { monotonicMs: 1_000, wallTimeMs: 50_000 };
	let releaseFirst!: () => void;
	const firstBlocker = new Promise<void>((resolve) => (releaseFirst = resolve));
	try {
		const first = embeddedPostgresTestHooks.withSetupLock(lockDir, () => firstBlocker, {
			clock: () => clock,
			scheduleHeartbeat: () => () => {},
		});

		clock = { monotonicMs: 1_000 + TEST_SETUP_LOCK_STALE_MS * 2, wallTimeMs: 1_000 };
		let contenderEntered = false;
		await embeddedPostgresTestHooks.withSetupLock(
			lockDir,
			async () => {
				contenderEntered = true;
			},
			{
				clock: () => clock,
				staleMs: TEST_SETUP_LOCK_STALE_MS,
				attempts: 1,
				scheduleHeartbeat: () => () => {},
			},
		);
		assert.equal(contenderEntered, true);
		releaseFirst();
		await first;
	} finally {
		releaseFirst();
		rmSync(root, { recursive: true, force: true });
	}
});
test("setup lock stale recovery treats lower host uptime as reboot evidence", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-postgres-lock-reboot-"));
	const lockDir = join(root, "setup-lock");
	let clock = { monotonicMs: 500_000, wallTimeMs: 500_000 };
	let releaseFirst!: () => void;
	const firstBlocker = new Promise<void>((resolve) => (releaseFirst = resolve));
	try {
		const first = embeddedPostgresTestHooks.withSetupLock(lockDir, () => firstBlocker, {
			clock: () => clock,
			scheduleHeartbeat: () => () => {},
		});

		clock = { monotonicMs: 100, wallTimeMs: 500_100 };
		let contenderEntered = false;
		await embeddedPostgresTestHooks.withSetupLock(
			lockDir,
			async () => {
				contenderEntered = true;
			},
			{
				clock: () => clock,
				staleMs: TEST_SETUP_LOCK_STALE_MS,
				attempts: 1,
				scheduleHeartbeat: () => () => {},
			},
		);
		assert.equal(contenderEntered, true);
		releaseFirst();
		await first;
	} finally {
		releaseFirst();
		rmSync(root, { recursive: true, force: true });
	}
});

test("setup lock reboot recovery does not confuse a dead low-uptime owner with the new boot", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-postgres-lock-reboot-wrap-"));
	const lockDir = join(root, "setup-lock");
	let clock = { monotonicMs: 10, wallTimeMs: 1_000 };
	let releaseFirst!: () => void;
	const firstBlocker = new Promise<void>((resolve) => (releaseFirst = resolve));
	try {
		const first = embeddedPostgresTestHooks.withSetupLock(lockDir, () => firstBlocker, {
			clock: () => clock,
			scheduleHeartbeat: () => () => {},
		});

		clock = { monotonicMs: 20, wallTimeMs: 2_000 };
		let contenderEntered = false;
		await embeddedPostgresTestHooks.withSetupLock(
			lockDir,
			async () => {
				contenderEntered = true;
			},
			{
				clock: () => clock,
				staleMs: TEST_SETUP_LOCK_STALE_MS,
				attempts: 1,
				isProcessAlive: () => false,
				scheduleHeartbeat: () => () => {},
			},
		);
		assert.equal(contenderEntered, true);
		releaseFirst();
		await first;
	} finally {
		releaseFirst();
		rmSync(root, { recursive: true, force: true });
	}
});

test("setup lock heartbeat stops on failure", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-postgres-lock-heartbeat-failure-"));
	let stopCalls = 0;
	try {
		await assert.rejects(
			embeddedPostgresTestHooks.withSetupLock(
				join(root, "setup-lock"),
				async () => {
					throw new Error("setup failed");
				},
				{
					scheduleHeartbeat: () => () => {
						stopCalls += 1;
					},
				},
			),
			/setup failed/,
		);
		assert.equal(stopCalls, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
test("a stale takeover never deletes a scheduler-delayed live publisher stage", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-postgres-live-stage-"));
	const packageNative = join(root, "pkg", "native");
	const runtimeDir = join(root, "cluster", "pg-runtime");
	const lockDir = join(root, "cluster", "setup-lock");
	let clock = { monotonicMs: 1_000, wallTimeMs: 1_000 };
	let takeoverRan = false;
	let stageSurvivedTakeover = false;
	try {
		mkdirSync(join(root, "cluster"), { recursive: true });
		mkdirSync(join(packageNative, "bin"), { recursive: true });
		for (const binary of ["initdb", "pg_ctl", "postgres"]) {
			writeFileSync(join(packageNative, "bin", binary), `source ${binary}\n`, { mode: 0o755 });
		}
		for (let index = 0; index < 40; index += 1) writeFileSync(join(packageNative, `entry-${index}`), String(index));
		const ownerContext: EmbeddedPostgresRunContext = {
			baseDir: join(root, "cluster"),
			owner: { uid: 65534, gid: 65534, name: "nobody" },
			runAsOwner: async () => ({ exitCode: 126, stdout: "", stderr: "permission denied" }),
		};
		const rootRunner = async () => ({ exitCode: 0, stdout: "", stderr: "" });

		const publisher = embeddedPostgresTestHooks.withSetupLock(
			lockDir,
			async (setup) => {
				await prepareBinariesForOwner(
					{
						pg_ctl: join(packageNative, "bin", "pg_ctl"),
						initdb: join(packageNative, "bin", "initdb"),
						postgres: join(packageNative, "bin", "postgres"),
					},
					ownerContext,
					rootRunner,
					{
						publicationLease: setup.runtimePublicationLease,
						yieldToEventLoop: async () => {
							const stage = existsSync(runtimeDir)
								? readdirSync(runtimeDir).find((entry) => entry.startsWith(".native-staged-"))
								: undefined;
							if (stage === undefined || takeoverRan) return;
							takeoverRan = true;
							clock = { monotonicMs: 1_000 + TEST_SETUP_LOCK_STALE_MS * 2, wallTimeMs: 2_000 };
							await embeddedPostgresTestHooks.withSetupLock(
								lockDir,
								async (contender) => {
									await cleanupAbandonedRuntimeStages(
										ownerContext.baseDir,
										contender.abandonedRuntimeStageOwnerTokens,
									);
									stageSurvivedTakeover = existsSync(join(runtimeDir, stage));
								},
								{
									clock: () => clock,
									staleMs: TEST_SETUP_LOCK_STALE_MS,
									attempts: 1,
									isProcessAlive: () => true,
									scheduleHeartbeat: () => () => {},
								},
							);
						},
					},
				);
			},
			{
				clock: () => clock,
				staleMs: TEST_SETUP_LOCK_STALE_MS,
				scheduleHeartbeat: () => () => {},
			},
		);

		await assert.rejects(publisher, /lost its setup lease/);
		assert.equal(takeoverRan, true);
		assert.equal(stageSurvivedTakeover, true, "stale heartbeat does not prove that a live stage is abandoned");
		assert.equal(
			readdirSync(runtimeDir).some((entry) => entry.startsWith(".native-staged-")),
			false,
			"the displaced publisher cleans its own stage after observing ownership loss",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("unexpected lock entries are recovered only after their observed state is stale", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-postgres-lock-unexpected-"));
	const lockPath = join(root, "setup-lock");
	const now = Date.now();
	try {
		writeFileSync(lockPath, "unexpected lock file");
		utimesSync(lockPath, (now - 100) / 1000, (now - 100) / 1000);
		let entered = false;
		await embeddedPostgresTestHooks.withSetupLock(
			lockPath,
			async () => {
				entered = true;
			},
			{
				now: () => now,
				staleMs: TEST_SETUP_LOCK_STALE_MS,
				scheduleHeartbeat: () => () => {},
			},
		);
		assert.equal(entered, true);
		assert.equal(existsSync(lockPath), false);

		mkdirSync(lockPath);
		writeFileSync(join(lockPath, "malformed-owner"), "unexpected");
		utimesSync(lockPath, now / 1000, now / 1000);
		utimesSync(join(lockPath, "malformed-owner"), now / 1000, now / 1000);
		await assert.rejects(
			embeddedPostgresTestHooks.withSetupLock(lockPath, async () => {}, {
				now: () => now,
				staleMs: TEST_SETUP_LOCK_STALE_MS,
				attempts: 1,
				wait: async () => {},
			}),
			/Timed out waiting for another Atomic process/,
		);
		assert.equal(readFileSync(join(lockPath, "malformed-owner"), "utf8"), "unexpected");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a takeover cleans only stages bound to a displaced owner proven dead", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-postgres-stage-cleanup-"));
	const runtimeDir = join(root, "pg-runtime");
	const stage = join(runtimeDir, ".native-staged-crashed-owner");
	const liveStage = join(runtimeDir, ".native-staged-live-owner");
	const legacyUntaggedStage = join(runtimeDir, ".native-staged-legacy-untagged");
	const generation = join(runtimeDir, "native-content-identity-owner");
	const retired = join(runtimeDir, ".native-retired-legacy-owner");
	const legacySelected = join(runtimeDir, "native");
	const lockDir = join(root, "setup-lock");
	let clock = { monotonicMs: 1_000, wallTimeMs: 1_000 };
	let releaseFirst!: () => void;
	const firstBlocker = new Promise<void>((resolve) => (releaseFirst = resolve));
	try {
		for (const path of [liveStage, legacyUntaggedStage, generation, retired, legacySelected]) {
			mkdirSync(path, { recursive: true });
			writeFileSync(join(path, "evidence"), path);
		}
		writeFileSync(join(liveStage, ".atomic-stage-owner"), "still-live-owner");

		const first = embeddedPostgresTestHooks.withSetupLock(
			lockDir,
			async (setup) => {
				mkdirSync(stage, { recursive: true });
				writeFileSync(join(stage, ".atomic-stage-owner"), setup.runtimePublicationLease.ownerToken);
				await firstBlocker;
			},
			{ clock: () => clock, scheduleHeartbeat: () => () => {} },
		);

		clock = { monotonicMs: 1_000 + TEST_SETUP_LOCK_STALE_MS * 2, wallTimeMs: 2_000 };
		await embeddedPostgresTestHooks.withSetupLock(
			lockDir,
			async (setup) => cleanupAbandonedRuntimeStages(root, setup.abandonedRuntimeStageOwnerTokens),
			{
				clock: () => clock,
				staleMs: TEST_SETUP_LOCK_STALE_MS,
				attempts: 1,
				isProcessAlive: () => false,
				scheduleHeartbeat: () => () => {},
			},
		);

		assert.equal(existsSync(stage), false, "dead ownership proof permits its unpublished scratch cleanup");
		assert.equal(existsSync(liveStage), true, "an unrelated owner-tagged stage is retained");
		assert.equal(existsSync(legacyUntaggedStage), true, "untagged migration evidence is not guessed at");
		assert.equal(existsSync(generation), true, "an immutable generation can still be executing");
		assert.equal(existsSync(retired), true, "finite legacy retired evidence can still be executing");
		assert.equal(existsSync(legacySelected), true, "the pre-generation selected path can still be executing");
		releaseFirst();
		await first;
	} finally {
		releaseFirst();
		rmSync(root, { recursive: true, force: true });
	}
});

test("a rejected ensure attempt clears its memo so a later caller retries", async () => {
	let attempts = 0;
	embeddedPostgresTestHooks.setEnsureOperation(async () => {
		attempts += 1;
		if (attempts === 1) throw new Error("setup failed");
	});

	await assert.rejects(embeddedPostgresTestHooks.ensure(), /setup failed/);
	await embeddedPostgresTestHooks.ensure();

	assert.equal(attempts, 2);
});
