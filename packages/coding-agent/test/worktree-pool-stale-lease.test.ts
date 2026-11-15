import assert from "node:assert/strict";
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { afterEach, beforeEach, describe, test } from "vitest";
import { bunExecutable } from "../../../test/helpers/runtime.js";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { SessionManager } from "../src/core/session-manager.js";
import {
	releaseSessionWorktrees,
	resumeSessionWorktree,
	SessionWorktreeSnapshotRecorder,
	type WorktreeSnapshotUnavailable,
} from "../src/core/session-worktree-snapshots.js";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.js";
import {
	admitPooledWorktree,
	confirmPooledWorktreeLease,
	discardPooledWorktree,
	evictIdleWorktrees,
	holdRestoredWorktree,
	LEASE_CLAIM_GRACE_MS,
	type PoolSlotRecord,
	pooledWorktreeHolder,
	pooledWorktreePath,
	recordPooledWorktreeState,
	releaseRestoredWorktree,
	repositoryIdOf,
	type SlotNumber,
} from "../src/core/worktree-snapshot/pool.js";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.js";
import type { WorktreeSnapshot } from "../src/core/worktree-snapshot/types.js";

useTemporaryAgentDir();

const settings = DEFAULT_WORKTREE_SNAPSHOT_SETTINGS;
/** A process loses its lease once it has not refreshed it for this long, as the pool's leases are set up. */
const LEASE_STALE_MS = 30_000;
/** Bun children load the snapshot modules before they hold or claim a slot. */
const CHILD_PROCESS_TIMEOUT_MS = 90_000;
const POOL_MODULE = fileURLToPath(new URL("../src/core/worktree-snapshot/pool.ts", import.meta.url));
const STORE_MODULE = fileURLToPath(new URL("../src/core/storage/session/sql-session-store.ts", import.meta.url));
const SQLITE_MODULE = fileURLToPath(new URL("../src/core/storage/node-sqlite.ts", import.meta.url));
const SETTINGS_MODULE = fileURLToPath(new URL("../src/core/worktree-snapshot/settings.ts", import.meta.url));

let sandbox: GitSandbox;
let store: SqlSessionStore;
let database: Awaited<ReturnType<typeof openNodeSqliteDatabase>>;
const opened: SessionManager[] = [];
const cleanups: (() => Promise<void> | void)[] = [];

beforeEach(async () => {
	sandbox = new GitSandbox();
	database = await openNodeSqliteDatabase(sandbox.path("sessions.sqlite"));
	store = await SqlSessionStore.open(database);
});
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()!();
	while (opened.length > 0) await releaseSessionWorktrees(opened.pop()!);
	await store.close();
	await database.close();
	sandbox.dispose();
});

const storeDir = () => sandbox.path("host");
const pool = () => ({ settings, storeDir: storeDir(), pool: { maxIdlePerRepository: 2 } });

async function recordedSnapshot(): Promise<{ snapshot: WorktreeSnapshot; clone: string }> {
	const { clone } = await sandbox.remoteWithClone();
	sandbox.write(join(clone, "file.txt"), "recorded\n");
	const capture = await captureWorktreeSnapshot(clone, { settings, blobs: store.snapshotBlobs });
	if (capture.status !== "captured") throw new Error(`capture ${capture.status}`);
	renameSync(clone, sandbox.path(`away-${Date.now()}`));
	return { snapshot: capture.snapshot, clone };
}

async function sessionOf(clone: string, snapshot: WorktreeSnapshot): Promise<SessionManager> {
	const manager = await SessionManager.create(store, clone);
	await manager.appendWorktreeSnapshot(clone, snapshot.id, snapshot);
	opened.push(manager);
	return manager;
}

const slot = (snapshot: WorktreeSnapshot, n: number) =>
	pooledWorktreePath(storeDir(), repositoryIdOf(snapshot.remotes), n as SlotNumber);
const poolDirectory = (snapshot: WorktreeSnapshot) => join(storeDir(), "pool", repositoryIdOf(snapshot.remotes));
const recordText = (snapshot: WorktreeSnapshot, n: number) =>
	readFileSync(join(poolDirectory(snapshot), `${n}.json`), "utf8");
const recordOf = (snapshot: WorktreeSnapshot, n: number) => JSON.parse(recordText(snapshot, n)) as PoolSlotRecord;
const ownerOf = (manager: SessionManager) => ({ kind: "session" as const, id: manager.getSessionId() });

/** A host other than this one, as a lease names it: a holder there cannot be seen running from here. */
const OTHER_HOST = "ffffffffffff";

/**
 * Dates the lease lock of process `pid` on `snapshot`'s slot 0 back `ageMs`: when its holder last refreshed it. With
 * `elsewhere`, the lease names another host, as when the pool is on a disk several machines share.
 */
function ageLease(snapshot: WorktreeSnapshot, pid: number, ageMs: number, elsewhere = false): string {
	const lease = new RegExp(`^0\\.json\\.(?:[0-9a-f]{12}-)?(${pid}-[0-9a-f]{8}\\.lease\\.lock)$`);
	const name = readdirSync(poolDirectory(snapshot)).find((entry) => lease.test(entry));
	assert.ok(name, `process ${pid} leases slot 0`);
	let lock = join(poolDirectory(snapshot), name);
	if (elsewhere) {
		const moved = join(poolDirectory(snapshot), `0.json.${OTHER_HOST}-${lease.exec(name)![1]}`);
		renameSync(lock, moved);
		lock = moved;
	}
	const past = new Date(Date.now() - ageMs);
	utimesSync(lock, past, past);
	return lock;
}

type Child = ChildProcessByStdio<Writable, Readable, null>;

/** Runs `source` in a Bun child, answering one line per line it is sent, its first line once it is ready. */
async function runChild(name: string, source: string): Promise<{ child: Child; first: string; send: Send }> {
	const script = sandbox.path(name);
	writeFileSync(script, source);
	const child = spawn(bunExecutable(), [script], { stdio: ["pipe", "pipe", "inherit"] });
	const exited = new Promise((resolve) => child.once("exit", resolve));
	cleanups.push(async () => {
		// SIGKILL ends a stopped child too, and is the one signal here Windows knows.
		child.kill("SIGKILL");
		await exited;
	});
	const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
	const next = async () => {
		const line = await lines.next();
		if (line.done) throw new Error(`${name} exited`);
		return line.value;
	};
	const send: Send = async (command) => {
		child.stdin.write(`${command}\n`);
		return next();
	};
	return { child, first: await next(), send };
}

type Send = (command: string) => Promise<string>;

/**
 * Session `owner`'s process holding the slot at `root`: it writes to the slot, records a state in it and releases it on
 * request, as a session process does when it continues after a stall.
 */
function holderChild(root: string, owner: { kind: "session"; id: string }) {
	return runChild(
		"holder.ts",
		`import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { holdRestoredWorktree, recordPooledWorktreeState, releaseRestoredWorktree } from ${JSON.stringify(POOL_MODULE)};
const root = ${JSON.stringify(root)};
const lease = await holdRestoredWorktree(${JSON.stringify(storeDir())}, root, ${JSON.stringify(owner)});
process.stdout.write(lease ? "held\\n" : "refused\\n");
const state = { snapshotId: "s1-later", head: "1".repeat(40), tree: "2".repeat(40) };
for await (const line of createInterface({ input: process.stdin })) {
	let result = "";
	if (line === "write") writeFileSync(join(root, "file.txt"), "S1 edit\\n");
	else if (line === "record") result = String(await recordPooledWorktreeState(lease, state));
	else if (line === "release") result = String(await releaseRestoredWorktree(lease, state));
	process.stdout.write(\`\${line} \${result}\\n\`);
}
`,
	);
}

/** Session `owner`'s process claiming an idle slot for `snapshot`, which it holds until told to release it. */
function claimerChild(snapshot: WorktreeSnapshot, owner: { kind: "session"; id: string }) {
	return runChild(
		"claimer.ts",
		`import { createInterface } from "node:readline";
import { claimIdleWorktree, releaseRestoredWorktree } from ${JSON.stringify(POOL_MODULE)};
import { openNodeSqliteDatabase } from ${JSON.stringify(SQLITE_MODULE)};
import { SqlSessionStore } from ${JSON.stringify(STORE_MODULE)};
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from ${JSON.stringify(SETTINGS_MODULE)};
const database = await openNodeSqliteDatabase(${JSON.stringify(sandbox.path("sessions.sqlite"))});
const store = await SqlSessionStore.open(database);
const claim = await claimIdleWorktree(${JSON.stringify(snapshot)}, {
	storeDir: ${JSON.stringify(storeDir())},
	owner: ${JSON.stringify(owner)},
	settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
	blobs: store.snapshotBlobs,
});
process.stdout.write(\`\${claim.claimed ? claim.lease.path : claim.reason}\\n\`);
for await (const line of createInterface({ input: process.stdin })) {
	if (line === "release" && claim.claimed) await releaseRestoredWorktree(claim.lease);
	process.stdout.write(\`\${line}\\n\`);
}
`,
	);
}

/** Session S1, which restored `snapshot` into slot 0 and released it, so a process of S1 can hold it again. */
async function s1InIdleSlot(snapshot: WorktreeSnapshot, clone: string): Promise<SessionManager> {
	const s1 = await sessionOf(clone, snapshot);
	const result = await resumeSessionWorktree(s1, pool());
	assert.equal(result.status === "restored" && result.mappings[0]!.to, slot(snapshot, 0));
	await releaseSessionWorktrees(s1);
	return s1;
}

const posixSignals = process.platform === "win32";

describe("a pooled worktree whose holder stalled (#4830)", () => {
	test.skipIf(posixSignals)(
		"a holder on another host stalled past its lease loses the slot to a claim, never writes its record back, and restores fresh (#4830)",
		async () => {
			const { snapshot, clone } = await recordedSnapshot();
			const s1 = await s1InIdleSlot(snapshot, clone);
			const holder = await holderChild(slot(snapshot, 0), ownerOf(s1));
			assert.equal(holder.first, "held");
			// S1's process, on a host sharing the pool, stalls past the stale time and the grace period.
			holder.child.kill("SIGSTOP");
			ageLease(snapshot, holder.child.pid!, LEASE_STALE_MS + LEASE_CLAIM_GRACE_MS + 30_000, true);

			const s2 = await sessionOf(clone, snapshot);
			const restored = await resumeSessionWorktree(s2, pool());
			assert.equal(restored.status === "restored" && restored.mappings[0]!.to, slot(snapshot, 0));
			assert.deepEqual(recordOf(snapshot, 0).holder, ownerOf(s2));
			const claimed = recordText(snapshot, 0);

			// S1 continues: it edits the files, records a state and releases the slot, as its session closes.
			holder.child.kill("SIGCONT");
			await holder.send("write");
			const recorded = await holder.send("record");
			const released = await holder.send("release");

			assert.equal(recordText(snapshot, 0), claimed);
			assert.deepEqual([recorded, released], ["record false", "release false"]);
			assert.deepEqual(await pooledWorktreeHolder(storeDir(), slot(snapshot, 0)), {
				owner: ownerOf(s2),
				held: true,
			});
			// S1's next resume does not continue in S2's worktree: it restores its snapshot fresh.
			const again = await resumeSessionWorktree(s1, pool());
			assert.equal(again.status, "restored");
			assert.equal(again.status === "restored" && again.mappings[0]!.to, slot(snapshot, 1));
			assert.equal(readFileSync(join(slot(snapshot, 1), "file.txt"), "utf8"), "recorded\n");
		},
		CHILD_PROCESS_TIMEOUT_MS,
	);

	test.skipIf(posixSignals)(
		"a lease on another host that went stale within the grace period keeps its slot from a claim, and its holder releases it (#4830)",
		async () => {
			const { snapshot, clone } = await recordedSnapshot();
			const s1 = await s1InIdleSlot(snapshot, clone);
			const holder = await holderChild(slot(snapshot, 0), ownerOf(s1));
			assert.equal(holder.first, "held");
			holder.child.kill("SIGSTOP");
			const lease = ageLease(snapshot, holder.child.pid!, LEASE_STALE_MS + LEASE_CLAIM_GRACE_MS / 2, true);

			const s2 = await sessionOf(clone, snapshot);
			const restored = await resumeSessionWorktree(s2, pool());
			assert.equal(restored.status === "restored" && restored.mappings[0]!.to, slot(snapshot, 1));
			assert.deepEqual(recordOf(snapshot, 0).holder, ownerOf(s1));
			assert.equal(existsSync(lease), true);

			holder.child.kill("SIGCONT");
			assert.equal(await holder.send("release"), "release true");
			const record = recordOf(snapshot, 0);
			assert.deepEqual(record.holder, ownerOf(s1));
			assert.equal(record.lastState.snapshotId, "s1-later");
			assert.notEqual(record.releasedAt, null);
		},
		CHILD_PROCESS_TIMEOUT_MS,
	);

	test.skipIf(posixSignals)(
		"a holder on this host stalled past stale and grace keeps its slot while its process runs, and releases it (#4830)",
		async () => {
			const { snapshot, clone } = await recordedSnapshot();
			const s1 = await s1InIdleSlot(snapshot, clone);
			const holder = await holderChild(slot(snapshot, 0), ownerOf(s1));
			assert.equal(holder.first, "held");
			holder.child.kill("SIGSTOP");
			const lease = ageLease(snapshot, holder.child.pid!, LEASE_STALE_MS + LEASE_CLAIM_GRACE_MS + 30_000);

			const s2 = await sessionOf(clone, snapshot);
			const restored = await resumeSessionWorktree(s2, pool());
			assert.equal(restored.status === "restored" && restored.mappings[0]!.to, slot(snapshot, 1));
			assert.deepEqual(recordOf(snapshot, 0).holder, ownerOf(s1));
			assert.equal(existsSync(lease), true);
			assert.deepEqual(await pooledWorktreeHolder(storeDir(), slot(snapshot, 0)), {
				owner: ownerOf(s1),
				held: true,
			});

			holder.child.kill("SIGCONT");
			assert.equal(await holder.send("release"), "release true");
			assert.equal(recordOf(snapshot, 0).lastState.snapshotId, "s1-later");
		},
		CHILD_PROCESS_TIMEOUT_MS,
	);

	test(
		"a holder on this host that stopped keeps its slot through the grace period, then a claim takes it (#4830)",
		async () => {
			const { snapshot, clone } = await recordedSnapshot();
			const s1 = await s1InIdleSlot(snapshot, clone);
			const holder = await holderChild(slot(snapshot, 0), ownerOf(s1));
			assert.equal(holder.first, "held");
			const exited = new Promise((resolve) => holder.child.once("exit", resolve));
			holder.child.kill("SIGKILL");
			await exited;
			ageLease(snapshot, holder.child.pid!, LEASE_STALE_MS + LEASE_CLAIM_GRACE_MS / 2);

			const s2 = await sessionOf(clone, snapshot);
			const kept = await resumeSessionWorktree(s2, pool());
			assert.equal(kept.status === "restored" && kept.mappings[0]!.to, slot(snapshot, 1));
			assert.deepEqual(recordOf(snapshot, 0).holder, ownerOf(s1));

			const lease = ageLease(snapshot, holder.child.pid!, LEASE_STALE_MS + LEASE_CLAIM_GRACE_MS + 30_000);
			const s3 = await sessionOf(clone, snapshot);
			const claimed = await resumeSessionWorktree(s3, pool());
			assert.equal(claimed.status === "restored" && claimed.mappings[0]!.to, slot(snapshot, 0));
			assert.deepEqual(recordOf(snapshot, 0).holder, ownerOf(s3));
			assert.equal(existsSync(lease), false);
		},
		CHILD_PROCESS_TIMEOUT_MS,
	);

	test(
		"a session whose slot was claimed while it stalled records no snapshot of it, warns, and restores fresh (#4830)",
		async () => {
			const { snapshot, clone } = await recordedSnapshot();
			const s1 = await sessionOf(clone, snapshot);
			const result = await resumeSessionWorktree(s1, pool());
			const root = slot(snapshot, 0);
			assert.equal(result.status === "restored" && result.mappings[0]!.to, root);
			// This process stalled, as another host sees it: its lease was last refreshed past the stale time and the grace.
			ageLease(snapshot, process.pid, LEASE_STALE_MS + LEASE_CLAIM_GRACE_MS + 30_000, true);
			const s2 = { kind: "session" as const, id: "session-s2" };
			const claimer = await claimerChild(snapshot, s2);
			assert.equal(claimer.first, root);
			assert.equal(await claimer.send("release"), "release");
			const claimed = recordText(snapshot, 0);

			const unavailable: WorktreeSnapshotUnavailable[] = [];
			const recorder = new SessionWorktreeSnapshotRecorder({
				sessionManager: s1,
				cwd: () => root,
				settings: () => settings,
				declaresWrites: () => false,
				onUnavailable: (reason) => unavailable.push(reason),
			});
			sandbox.write(join(root, "file.txt"), "S1 edit\n");
			const entries = s1.getEntries().length;
			await recorder.recordTurn(
				fauxAssistantMessage([fauxToolCall("write", { path: join(root, "file.txt"), content: "S1 edit\n" })], {
					stopReason: "toolUse",
				}),
			);

			assert.equal(s1.getEntries().length, entries);
			assert.deepEqual(
				unavailable.map((reason) => [reason.code, reason.fields]),
				[["pooled-worktree-lost", { subject: root }]],
			);
			assert.match(unavailable[0]!.message, /no longer holds the pooled worktree/);
			// A later turn there is not recorded either, though the session no longer has a lease to check.
			await recorder.recordTurn(
				fauxAssistantMessage([fauxToolCall("write", { path: join(root, "file.txt"), content: "S1 edit\n" })], {
					stopReason: "toolUse",
				}),
			);
			assert.equal(s1.getEntries().length, entries);
			await recorder.releaseWorktrees();
			assert.equal(recordText(snapshot, 0), claimed);
			const again = await resumeSessionWorktree(s1, pool());
			assert.equal(again.status === "restored" && again.mappings[0]!.to, slot(snapshot, 1));
			assert.equal(readFileSync(join(root, "file.txt"), "utf8"), "S1 edit\n");
		},
		CHILD_PROCESS_TIMEOUT_MS,
	);

	test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"a session that cannot hold its own idle slot does not continue in it unleased, and restores fresh (#4830)",
		async () => {
			const { snapshot, clone } = await recordedSnapshot();
			const s1 = await s1InIdleSlot(snapshot, clone);
			assert.deepEqual(recordOf(snapshot, 0).holder, ownerOf(s1));
			chmodSync(poolDirectory(snapshot), 0o555);
			cleanups.push(() => chmodSync(poolDirectory(snapshot), 0o755));

			// Holding the slot waits out its record lock, which cannot be taken, then fails.
			const result = await resumeSessionWorktree(s1, pool());

			assert.equal(result.status, "restored");
			if (result.status !== "restored") return;
			const restored = result.mappings[0]!.to;
			assert.notEqual(restored, slot(snapshot, 0));
			assert.equal(readFileSync(join(restored, "file.txt"), "utf8"), "recorded\n");
		},
		CHILD_PROCESS_TIMEOUT_MS,
	);
});

describe("checks of a pooled worktree's lease (#4830)", () => {
	const x = { kind: "session" as const, id: "session-x" };
	const y = { kind: "session" as const, id: "session-y" };
	const state = { snapshotId: "z9", head: "9".repeat(40), tree: "8".repeat(40) };
	const remotes = ["https://example.com/lease.git"];
	const repository = repositoryIdOf(remotes);
	const admit = () =>
		admitPooledWorktree(
			{
				storeDir: storeDir(),
				remotes,
				lastState: { snapshotId: "a1", head: "1".repeat(40), tree: "2".repeat(40) },
				envHash: "env",
			},
			x,
		);
	const file = () => join(storeDir(), "pool", repository, "0.json");
	const leases = () =>
		readdirSync(join(storeDir(), "pool", repository)).filter((name) => name.endsWith(".lease.lock"));
	/** Writes slot 0's record as another process would, changing `fields`. */
	const rewrite = (fields: Partial<PoolSlotRecord>) =>
		writeFileSync(
			file(),
			JSON.stringify({ ...(JSON.parse(readFileSync(file(), "utf8")) as PoolSlotRecord), ...fields }),
		);
	/** A lease lock of slot 0 as process `pid` on this host would hold it, last refreshed `ageMs` ago. */
	const leaseOf = (pid: number, ageMs: number) => {
		const host = createHash("sha256").update(hostname()).digest("hex").slice(0, 12);
		const lock = join(storeDir(), "pool", repository, `0.json.${host}-${pid}-0badcafe.lease.lock`);
		mkdirSync(lock);
		const past = new Date(Date.now() - ageMs);
		utimesSync(lock, past, past);
		return lock;
	};

	test("a hold whose slot another holder took writes nothing, ends its lease and no longer holds it (#4830)", async () => {
		const lease = await admit();
		rewrite({ holder: y, tenancy: "taken-by-y" });
		const taken = readFileSync(file(), "utf8");

		assert.equal(await recordPooledWorktreeState(lease, state), false);
		assert.equal(await confirmPooledWorktreeLease(lease), false);
		assert.equal(await releaseRestoredWorktree(lease, state), false);
		assert.equal(await holdRestoredWorktree(storeDir(), lease.path, x), undefined);
		await discardPooledWorktree(lease);

		assert.equal(readFileSync(file(), "utf8"), taken);
		assert.deepEqual(leases(), []);
		assert.deepEqual(await pooledWorktreeHolder(storeDir(), lease.path), { owner: y, held: false });
	});

	test("a release that finds its slot taken by the same owner's new take resolves false and writes nothing (#4830)", async () => {
		const lease = await admit();
		rewrite({ tenancy: "a-later-take" });
		const taken = readFileSync(file(), "utf8");
		assert.equal(await releaseRestoredWorktree(lease, state), false);
		assert.equal(readFileSync(file(), "utf8"), taken);
	});

	test("a second hold released after the slot was lost resolves false, and a released lease confirms nothing (#4830)", async () => {
		const first = await admit();
		const second = await holdRestoredWorktree(storeDir(), first.path, x);
		assert.ok(second);
		assert.equal(await confirmPooledWorktreeLease(second), true);
		assert.equal(await releaseRestoredWorktree(second), true);
		assert.equal(await confirmPooledWorktreeLease(second), false);
		rewrite({ holder: y });
		assert.equal(await confirmPooledWorktreeLease(first), false);
		assert.equal(await releaseRestoredWorktree(first), false);
	});

	test("a hold whose record is gone is lost, and a record that cannot be read keeps the hold (#4830)", async () => {
		const lease = await admit();
		writeFileSync(file(), "{ not json");
		assert.equal(await confirmPooledWorktreeLease(lease), true);
		await assert.rejects(recordPooledWorktreeState(lease, state));
		rmSync(file());
		assert.equal(await confirmPooledWorktreeLease(lease), false);
		assert.equal(await releaseRestoredWorktree(lease, state), false);
		assert.equal(existsSync(file()), false);
	});

	test("a record with a tenancy that is not a string names no owner (#4830)", async () => {
		const lease = await admit();
		await releaseRestoredWorktree(lease);
		rewrite({ tenancy: 7 as unknown as string });
		assert.deepEqual(await pooledWorktreeHolder(storeDir(), lease.path), { owner: null, held: false });
	});

	test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"a lease of a process on this host that cannot be signalled keeps the slot, however stale (#4830)",
		async () => {
			const lease = await admit();
			await releaseRestoredWorktree(lease);
			const lock = leaseOf(1, LEASE_STALE_MS + LEASE_CLAIM_GRACE_MS + 30_000);
			assert.deepEqual(await pooledWorktreeHolder(storeDir(), lease.path), { owner: x, held: true });
			assert.deepEqual(await evictIdleWorktrees(storeDir(), repository, { maxIdle: 0, settings }), []);
			assert.equal(existsSync(lock), true);
		},
	);

	test("a stale lease within the grace period is not held, yet stays and keeps the slot from eviction (#4830)", async () => {
		const lease = await admit();
		await releaseRestoredWorktree(lease);
		// A process id no live process has: its lease is judged by age alone.
		const lock = leaseOf(2 ** 22 + 7, LEASE_STALE_MS + LEASE_CLAIM_GRACE_MS / 2);
		assert.deepEqual(await pooledWorktreeHolder(storeDir(), lease.path), { owner: x, held: false });
		assert.equal(existsSync(lock), true);
		assert.deepEqual(await evictIdleWorktrees(storeDir(), repository, { maxIdle: 0, settings }), []);
		assert.equal(existsSync(file()), true);
		utimesSync(lock, new Date(0), new Date(0));
		assert.deepEqual(await evictIdleWorktrees(storeDir(), repository, { maxIdle: 0, settings }), [lease.path]);
		assert.equal(existsSync(lock), false);
	});

	test(
		"a session whose lease was removed while it still owns its slot takes it again and keeps recording there (#4830)",
		async () => {
			const { snapshot, clone } = await recordedSnapshot();
			const s1 = await sessionOf(clone, snapshot);
			const result = await resumeSessionWorktree(s1, pool());
			const root = slot(snapshot, 0);
			assert.equal(result.status === "restored" && result.mappings[0]!.to, root);
			const unavailable: WorktreeSnapshotUnavailable[] = [];
			const recorder = new SessionWorktreeSnapshotRecorder({
				sessionManager: s1,
				cwd: () => root,
				settings: () => settings,
				declaresWrites: () => false,
				onUnavailable: (reason) => unavailable.push(reason),
			});
			const turn = (content: string) => {
				sandbox.write(join(root, "file.txt"), content);
				return recorder.recordTurn(
					fauxAssistantMessage([fauxToolCall("write", { path: join(root, "file.txt"), content })], {
						stopReason: "toolUse",
					}),
				);
			};
			const entries = s1.getEntries().length;
			await turn("first\n");
			assert.equal(s1.getEntries().length, entries + 1);

			// Another process removed this one's lease; the lease's next refresh, within 10 seconds, notices.
			const lock = ageLease(snapshot, process.pid, 0);
			rmSync(lock, { recursive: true });
			await sleep(11_000);
			await turn("second\n");

			assert.deepEqual(unavailable, []);
			assert.equal(s1.getEntries().length, entries + 2);
			assert.equal(existsSync(lock), true);
			const again = await resumeSessionWorktree(s1, pool());
			assert.equal(again.status, "verified");
		},
		CHILD_PROCESS_TIMEOUT_MS,
	);

	test(
		"a session whose slot was claimed while it stalled restores fresh on its next resume, without a turn first (#4830)",
		async () => {
			const { snapshot, clone } = await recordedSnapshot();
			const s1 = await sessionOf(clone, snapshot);
			const result = await resumeSessionWorktree(s1, pool());
			assert.equal(result.status === "restored" && result.mappings[0]!.to, slot(snapshot, 0));
			ageLease(snapshot, process.pid, LEASE_STALE_MS + LEASE_CLAIM_GRACE_MS + 30_000, true);
			const claimer = await claimerChild(snapshot, { kind: "session", id: "session-s2" });
			assert.equal(claimer.first, slot(snapshot, 0));
			const claimed = recordText(snapshot, 0);

			// S2 still works in the slot when S1 resumes.
			const again = await resumeSessionWorktree(s1, pool());
			assert.equal(again.status === "restored" && again.mappings[0]!.to, slot(snapshot, 1));
			await releaseSessionWorktrees(s1);
			assert.equal(recordText(snapshot, 0), claimed);
		},
		CHILD_PROCESS_TIMEOUT_MS,
	);
});
