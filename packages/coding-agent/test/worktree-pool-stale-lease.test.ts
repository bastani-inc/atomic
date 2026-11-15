import assert from "node:assert/strict";
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
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
	LEASE_CLAIM_GRACE_MS,
	type PoolSlotRecord,
	pooledWorktreeHolder,
	pooledWorktreePath,
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

/** Dates the lease lock of process `pid` on `snapshot`'s slot 0 back `ageMs`: when its holder last refreshed it. */
function ageLease(snapshot: WorktreeSnapshot, pid: number, ageMs: number): string {
	const name = readdirSync(poolDirectory(snapshot)).find(
		(entry) => entry.startsWith(`0.json.${pid}-`) && entry.endsWith(".lease.lock"),
	);
	assert.ok(name, `process ${pid} leases slot 0`);
	const lock = join(poolDirectory(snapshot), name);
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
		"a holder stalled past its lease loses the slot to a claim, never writes its record back, and restores fresh (#4830)",
		async () => {
			const { snapshot, clone } = await recordedSnapshot();
			const s1 = await s1InIdleSlot(snapshot, clone);
			const holder = await holderChild(slot(snapshot, 0), ownerOf(s1));
			assert.equal(holder.first, "held");
			// S1's process stalls past the stale time and the grace period, and its lease is not refreshed meanwhile.
			holder.child.kill("SIGSTOP");
			ageLease(snapshot, holder.child.pid!, LEASE_STALE_MS + LEASE_CLAIM_GRACE_MS + 30_000);

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
		"a lease that went stale within the grace period keeps its slot from a claim, and its holder releases it (#4830)",
		async () => {
			const { snapshot, clone } = await recordedSnapshot();
			const s1 = await s1InIdleSlot(snapshot, clone);
			const holder = await holderChild(slot(snapshot, 0), ownerOf(s1));
			assert.equal(holder.first, "held");
			holder.child.kill("SIGSTOP");
			const lease = ageLease(snapshot, holder.child.pid!, LEASE_STALE_MS + LEASE_CLAIM_GRACE_MS / 2);

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

	test(
		"a session whose slot was claimed while it stalled records no snapshot of it, warns, and restores fresh (#4830)",
		async () => {
			const { snapshot, clone } = await recordedSnapshot();
			const s1 = await sessionOf(clone, snapshot);
			const result = await resumeSessionWorktree(s1, pool());
			const root = slot(snapshot, 0);
			assert.equal(result.status === "restored" && result.mappings[0]!.to, root);
			// This process stalled: its lease of slot 0 was last refreshed past the stale time and the grace period.
			ageLease(snapshot, process.pid, LEASE_STALE_MS + LEASE_CLAIM_GRACE_MS + 30_000);
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
