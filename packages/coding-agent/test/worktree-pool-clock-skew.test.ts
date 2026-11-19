import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test, vi } from "vitest";
import { bunExecutable } from "../../../test/helpers/runtime.js";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { renameWithRetry } from "../src/core/rename-retry.ts";
import { SessionManager } from "../src/core/session-manager.js";
import { releaseSessionWorktrees, resumeSessionWorktree } from "../src/core/session-worktree-snapshots.js";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.js";
import {
	LEASE_CLAIM_GRACE_MS,
	type PoolSlotRecord,
	pooledWorktreeHolder,
	pooledWorktreePath,
	repositoryIdOf,
	type SlotNumber,
} from "../src/core/worktree-snapshot/pool.js";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.js";
import { LEFTOVER_PROBE_AGE_MS, lockShared, sharedClockOffset } from "../src/core/worktree-snapshot/shared-clock.js";
import type { WorktreeSnapshot } from "../src/core/worktree-snapshot/types.js";

// This process plays a second host sharing the pool: its leases name another host than the children's, so a child's
// lease is judged by its refresh times alone, as a lease written on another machine is.
vi.mock("node:os", async (original) => {
	const os = await original<typeof import("node:os")>();
	const hostname = () => "clock-skew-reader-host";
	return { ...os, hostname, default: { ...os, hostname } };
});

useTemporaryAgentDir();

const settings = DEFAULT_WORKTREE_SNAPSHOT_SETTINGS;
/** A process loses its lease or lock once it has not refreshed it for this long. */
const STALE_MS = 30_000;
/** Pool leases are refreshed every 10 seconds: waiting this long sees the holder refresh its lease once. */
const LEASE_REFRESHED_MS = 12_000;
const BEHIND_MS = -3 * 60_000;
const AHEAD_MS = 3 * 24 * 60 * 60_000;
const TIMEOUT_MS = 120_000;
const POOL_MODULE = fileURLToPath(new URL("../src/core/worktree-snapshot/pool.ts", import.meta.url));
const CLOCK_MODULE = fileURLToPath(new URL("../src/core/worktree-snapshot/shared-clock.ts", import.meta.url));

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
	vi.restoreAllMocks();
	while (cleanups.length > 0) await cleanups.pop()!();
	while (opened.length > 0) await releaseSessionWorktrees(opened.pop()!);
	await store.close();
	await database.close();
	sandbox.dispose();
});

const storeDir = () => sandbox.path("host");
const pool = () => ({ settings, storeDir: storeDir(), pool: { maxIdlePerRepository: 2 } });
const slot = (snapshot: WorktreeSnapshot, n: number) =>
	pooledWorktreePath(storeDir(), repositoryIdOf(snapshot.remotes), n as SlotNumber);
const poolDirectory = (snapshot: WorktreeSnapshot) => join(storeDir(), "pool", repositoryIdOf(snapshot.remotes));
const recordOf = (snapshot: WorktreeSnapshot, n: number) =>
	JSON.parse(readFileSync(join(poolDirectory(snapshot), `${n}.json`), "utf8")) as PoolSlotRecord;
const ownerOf = (manager: SessionManager) => ({ kind: "session" as const, id: manager.getSessionId() });

/** Source that sets the clock of the process running it `skewMs` off the real one, as on a host whose clock is off. */
function skewedClock(skewMs: number): string {
	return `const RealDate = Date;
globalThis.Date = class extends RealDate {
	constructor(...args) {
		if (args.length === 0) super(RealDate.now() + ${skewMs});
		else super(...args);
	}
	static now() {
		return RealDate.now() + ${skewMs};
	}
};
`;
}

/** Sets this process's clock `skewMs` off the real one, as on a reading host whose clock is off too. */
function skewThisProcess(skewMs: number): void {
	const now = Date.now.bind(Date);
	vi.spyOn(Date, "now").mockImplementation(() => now() + skewMs);
}

/** The probe files of the filesystem's clock in `directory`. */
function probes(directory: string): string[] {
	return readdirSync(directory).filter((name) => name.startsWith(".clock-"));
}

/** Asserts that no probe file of the filesystem's clock was left in `directory`, beyond `leftBefore`. */
function assertNoProbes(directory: string, leftBefore: readonly string[] = []): void {
	assert.deepEqual(
		probes(directory).filter((name) => !leftBefore.includes(name)),
		[],
	);
}

/**
 * Asserts that no probe of the filesystem's clock was left in `directory` by a live process that holds `lock` and keeps
 * refreshing it, each refresh through probes there: a refresh still running when `directory` is read has its probe
 * there until it ends, so the probes found are looked for again once `lock` was refreshed since (#5605).
 */
async function assertNoProbesLeftByLiveHolder(directory: string, lock: string, budgetMs = STALE_MS): Promise<void> {
	const found = probes(directory);
	let refreshed = statSync(lock).mtimeMs;
	for (let refresh = 0; refresh < 2; refresh++) {
		const deadline = performance.now() + budgetMs;
		let stamp = refreshed;
		while (stamp === refreshed) {
			assert.ok(performance.now() < deadline, "holder did not refresh its lock");
			await sleep(50);
			stamp = statSync(lock).mtimeMs;
		}
		refreshed = stamp;
		const remaining = probes(directory).filter((name) => found.includes(name));
		if (remaining.length === 0) return;
		// One refresh may have left its final probe for cleanup during the following refresh.
		if (refresh === 1) assert.deepEqual(remaining, []);
	}
}

test("a live-holder check rejects a stopped holder even when no probes were found (#5635)", async () => {
	const directory = sandbox.path("stopped");
	mkdirSync(directory);
	const lock = join(directory, "holder.lock");
	mkdirSync(lock);
	await assert.rejects(assertNoProbesLeftByLiveHolder(directory, lock, 50), /holder did not refresh/);
});

test("a live-holder check distinguishes next-refresh cleanup from a permanent leak (#5635)", async () => {
	const directory = sandbox.path("refreshing");
	mkdirSync(directory);
	const lock = join(directory, "holder.lock");
	mkdirSync(lock);
	const probe = join(directory, ".clock-0123456789abcdef.probe");
	for (const leak of [true, false]) {
		writeFileSync(probe, "");
		const checking = assertNoProbesLeftByLiveHolder(directory, lock);
		const expected = leak ? assert.rejects(checking, /clock-0123456789abcdef/) : checking;
		// The next completed refresh still sees the file. The following refresh may have reclaimed it.
		backdate(lock, 2_000);
		const refresh = setInterval(() => {
			if (!leak && existsSync(probe)) unlinkSync(probe);
			backdate(lock, 2_000);
		}, 150);
		try {
			await expected;
		} finally {
			clearInterval(refresh);
		}
	}
});

/** Runs `source` in a Bun child, resolving once it prints its first line; `ask` sends it a line and resolves its answer. */
async function runChild(
	name: string,
	source: string,
): Promise<{ first: string; kill: () => Promise<void>; ask: (question: string) => Promise<string> }> {
	const script = sandbox.path(name);
	writeFileSync(script, source);
	const child = spawn(bunExecutable(), [script], { stdio: ["pipe", "pipe", "inherit"] });
	const exited = new Promise((resolve) => child.once("exit", resolve));
	const kill = async () => {
		child.kill("SIGKILL");
		await exited;
	};
	cleanups.push(kill);
	const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
	const line = await lines.next();
	if (line.done) throw new Error(`${name} exited`);
	const ask = async (question: string) => {
		child.stdin.write(`${question}\n`);
		const answer = await lines.next();
		if (answer.done) throw new Error(`${name} exited`);
		return answer.value;
	};
	return { first: line.value, kill, ask };
}

/** A process of another host whose clock is `skewMs` off, holding the pooled worktree at `root` for `owner`. */
function holderChild(skewMs: number, root: string, owner: { kind: "session"; id: string }) {
	return runChild(
		"holder.ts",
		`${skewedClock(skewMs)}
const { holdRestoredWorktree } = await import(${JSON.stringify(POOL_MODULE)});
const lease = await holdRestoredWorktree(${JSON.stringify(storeDir())}, ${JSON.stringify(root)}, ${JSON.stringify(owner)});
process.stdout.write(lease ? "held\\n" : "refused\\n");
process.stdin.resume();
`,
	);
}

/**
 * A process of another host whose clock is `skewMs` off, holding a lock of `path` refreshed every second. Asked
 * anything, it answers whether it still holds the lock.
 */
function lockerChild(skewMs: number, path: string) {
	return runChild(
		"locker.ts",
		`${skewedClock(skewMs)}
import { createInterface } from "node:readline";
const { lockShared } = await import(${JSON.stringify(CLOCK_MODULE)});
let compromised = false;
await lockShared(${JSON.stringify(path)}, {
	realpath: false,
	stale: ${STALE_MS},
	update: 1_000,
	onCompromised: () => {
		compromised = true;
	},
});
process.stdout.write("locked\\n");
for await (const _ of createInterface({ input: process.stdin })) process.stdout.write(compromised ? "lost\\n" : "held\\n");
`,
	);
}

/** A slot 0 that session S1 restored into and released, with a session S2 resuming the same snapshot. */
async function releasedSlot(): Promise<{ snapshot: WorktreeSnapshot; s1: SessionManager; s2: SessionManager }> {
	const { clone } = await sandbox.remoteWithClone();
	sandbox.write(join(clone, "file.txt"), "recorded\n");
	const capture = await captureWorktreeSnapshot(clone, { settings, blobs: store.snapshotBlobs });
	if (capture.status !== "captured") throw new Error(`capture ${capture.status}`);
	const snapshot = capture.snapshot;
	await renameWithRetry(clone, sandbox.path(`away-${Date.now()}`));
	const session = async () => {
		const manager = await SessionManager.create(store, clone);
		await manager.appendWorktreeSnapshot(clone, snapshot.id, snapshot);
		opened.push(manager);
		return manager;
	};
	const s1 = await session();
	const restored = await resumeSessionWorktree(s1, pool());
	assert.equal(restored.status === "restored" && restored.mappings[0]!.to, slot(snapshot, 0));
	await releaseSessionWorktrees(s1);
	return { snapshot, s1, s2: await session() };
}

/** Dates `path` back `ms` from when it was last refreshed, as if that much time passed since. */
function backdate(path: string, ms: number): void {
	const then = new Date(statSync(path).mtimeMs - ms);
	utimesSync(path, then, then);
}

const leaseOf = (snapshot: WorktreeSnapshot) => {
	const name = readdirSync(poolDirectory(snapshot)).find((entry) => /^0\.json\..*\.lease\.lock$/.test(entry));
	assert.ok(name, "slot 0 is leased");
	return join(poolDirectory(snapshot), name);
};

test(
	"a live holder on another host whose clock is 3 minutes behind keeps its slot (#5050)",
	async () => {
		const { snapshot, s1, s2 } = await releasedSlot();
		const { first } = await holderChild(BEHIND_MS, slot(snapshot, 0), ownerOf(s1));
		assert.equal(first, "held");
		await sleep(LEASE_REFRESHED_MS);
		skewThisProcess(2 * 60_000);

		assert.deepEqual(await pooledWorktreeHolder(storeDir(), slot(snapshot, 0)), {
			owner: ownerOf(s1),
			held: true,
		});
		const resumed = await resumeSessionWorktree(s2, pool());
		assert.equal(resumed.status === "restored" && resumed.mappings[0]!.to, slot(snapshot, 1));
		assert.deepEqual(recordOf(snapshot, 0).holder, ownerOf(s1));
		await assertNoProbesLeftByLiveHolder(poolDirectory(snapshot), leaseOf(snapshot));
	},
	TIMEOUT_MS,
);

test(
	"a crashed holder on another host whose clock is days ahead loses its slot once its lease is stale past the grace (#5050)",
	async () => {
		const { snapshot, s1, s2 } = await releasedSlot();
		const { kill, first } = await holderChild(AHEAD_MS, slot(snapshot, 0), ownerOf(s1));
		assert.equal(first, "held");
		await sleep(LEASE_REFRESHED_MS);
		await kill();
		// A holder killed during one of its lease refreshes leaves that refresh's probe.
		const leftByHolder = probes(poolDirectory(snapshot));
		skewThisProcess(-2 * 60_000);

		// Right after the crash, the lease keeps the slot through its grace period.
		assert.equal((await pooledWorktreeHolder(storeDir(), slot(snapshot, 0))).held, true);
		backdate(leaseOf(snapshot), STALE_MS + LEASE_CLAIM_GRACE_MS + 1_000);
		const resumed = await resumeSessionWorktree(s2, pool());
		assert.equal(resumed.status === "restored" && resumed.mappings[0]!.to, slot(snapshot, 0));
		assert.deepEqual(recordOf(snapshot, 0).holder, ownerOf(s2));
		assertNoProbes(poolDirectory(snapshot), leftByHolder);
	},
	TIMEOUT_MS,
);

test(
	"a record or repository lock held on a host whose clock is 3 minutes behind is not taken as stale (#5050)",
	async () => {
		const path = sandbox.path("locked.json");
		writeFileSync(path, "{}");
		const { ask, first } = await lockerChild(BEHIND_MS, path);
		assert.equal(first, "locked");
		await sleep(2_500);
		skewThisProcess(2 * 60_000);

		await assert.rejects(lockShared(path, { realpath: false, stale: STALE_MS }), { code: "ELOCKED" });
		// Its holder refreshed it twice meanwhile, each time finding the lock as it left it.
		assert.equal(await ask("status"), "held");
		await assertNoProbesLeftByLiveHolder(sandbox.path("."), `${path}.lock`);
	},
	TIMEOUT_MS,
);

test(
	"a record or repository lock whose crashed holder's clock runs days ahead turns stale after the stale time (#5050)",
	async () => {
		const path = sandbox.path("locked.json");
		writeFileSync(path, "{}");
		const { kill, first } = await lockerChild(AHEAD_MS, path);
		assert.equal(first, "locked");
		await sleep(2_500);
		await kill();
		// The holder refreshes its lock every second, each time through a probe: killed during one, it leaves it.
		const leftByHolder = probes(sandbox.path("."));
		skewThisProcess(-2 * 60_000);

		await assert.rejects(lockShared(path, { realpath: false, stale: STALE_MS }), { code: "ELOCKED" });
		backdate(`${path}.lock`, STALE_MS + 1_000);
		const unlock = await lockShared(path, { realpath: false, stale: STALE_MS });
		await unlock();
		assertNoProbes(sandbox.path("."), leftByHolder);
	},
	TIMEOUT_MS,
);

test("a clock probe a process left when it stopped mid-probe is removed once it is old; a recent one is kept (#5050)", async () => {
	const directory = sandbox.path("probes");
	mkdirSync(directory);
	const left = join(directory, ".clock-0123456789abcdef.probe");
	const recent = join(directory, ".clock-fedcba9876543210.probe");
	const notAProbe = join(directory, ".clock-notes.txt");
	for (const path of [left, recent, notAProbe]) writeFileSync(path, "");
	backdate(left, LEFTOVER_PROBE_AGE_MS + 60_000);
	backdate(notAProbe, LEFTOVER_PROBE_AGE_MS + 60_000);

	await sharedClockOffset(directory);

	assert.deepEqual(probes(directory).sort(), [".clock-fedcba9876543210.probe", ".clock-notes.txt"]);
	assert.equal(existsSync(recent), true);
});
