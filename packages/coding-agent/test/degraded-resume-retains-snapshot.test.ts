import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { renameReplacing } from "../src/core/rename-retry.js";
import type { WorktreeSnapshotEntry } from "../src/core/session-manager.js";
import { SessionManager } from "../src/core/session-manager.js";
import {
	DEGRADED_RESTORE_RETENTION_DAYS,
	degradedRestorePin,
	describeWorktreeRestoreStatus,
	discardDegradedRestore,
	formatDegradedWorkNotice,
	SessionWorktreeSnapshotRecorder,
} from "../src/core/session-worktree-snapshots.js";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import type { SessionStore } from "../src/core/storage/session/types.js";
import { type SqlSnapshotBlobStore, snapshotBlobHashes } from "../src/core/worktree-snapshot/blob-store.js";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.js";
import { carryOverDegradedWork } from "../src/core/worktree-snapshot/degraded-work.js";
import { collectSnapshotGarbage } from "../src/core/worktree-snapshot/garbage.js";
import { setWorktreeSnapshotGit } from "../src/core/worktree-snapshot/git.js";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.js";
import type { WorktreeSnapshot } from "../src/core/worktree-snapshot/types.js";
import { type PreparedSessionResume, type PrepareSessionResumeOptions, prepareSessionResume } from "../src/index.js";

useTemporaryAgentDir();

/** Collection deletes every unreferenced blob at once, so a released snapshot is gone after one collection. */
const settings = { ...DEFAULT_WORKTREE_SNAPSHOT_SETTINGS, graceSeconds: 0 };
let sandbox: GitSandbox;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	sandbox.dispose();
});

async function sqlStore(): Promise<SessionStore> {
	const database = await openNodeSqliteDatabase(sandbox.path("sessions.sqlite"));
	const store = await SqlSessionStore.open(database);
	cleanups.push(async () => {
		await store.close();
		await database.close();
	});
	return store;
}

function options(storeDir: string): PrepareSessionResumeOptions {
	return {
		entryPoint: "cli",
		launchCwd: sandbox.root,
		settings,
		storeDir: sandbox.path(storeDir),
		blueprint: { agentDir: sandbox.path("agent"), trusted: () => false },
	};
}

function ready(prepared: PreparedSessionResume): Extract<PreparedSessionResume, { status: "ready" }> {
	assert.equal(prepared.status, "ready");
	return prepared as Extract<PreparedSessionResume, { status: "ready" }>;
}

const bashTurn = () => fauxAssistantMessage([fauxToolCall("bash", { command: "ls" })], { stopReason: "toolUse" });

/** One agent turn that ran a file-writing tool, recorded the way a session records it. */
async function runTurn(manager: SessionManager, cwd: string): Promise<void> {
	const unavailable: unknown[] = [];
	const recorder = new SessionWorktreeSnapshotRecorder({
		sessionManager: manager,
		cwd: () => cwd,
		settings: () => settings,
		declaresWrites: () => false,
		onUnavailable: (reason) => unavailable.push(reason),
	});
	await recorder.recordTurn(bashTurn());
	assert.deepEqual(unavailable, []);
}

const snapshotEntries = (manager: SessionManager): WorktreeSnapshotEntry[] =>
	manager.getEntries().filter((entry): entry is WorktreeSnapshotEntry => entry.type === "worktree_snapshot");

/**
 * Machine A: a session whose snapshot S holds an unpushed commit that cannot be bundled, because it touches a file
 * snapshots never copy, and an uncommitted new file.
 */
async function machineA() {
	const { clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n" });
	const pushed = await sandbox.git(clone, "rev-parse", "HEAD");
	sandbox.write(join(clone, ".env.example"), "TOKEN=placeholder\n");
	sandbox.write(join(clone, "feature.txt"), "unpushed feature\n");
	const unpushed = await sandbox.commitAll(clone, "unpushed commit touching a denied path");
	sandbox.write(join(clone, "work.txt"), "uncommitted work\n");
	const store = await sqlStore();
	const manager = await SessionManager.create(store, clone);
	await manager.appendMessage({ role: "user", content: "edit the files", timestamp: Date.now() });
	const capture = await captureWorktreeSnapshot(clone, { settings, blobs: store.snapshotBlobs });
	if (capture.status !== "captured") throw new Error(capture.status);
	assert.equal(capture.snapshot.bundle, null, "the unpushed commit touches a denied path and is not bundled");
	await manager.appendWorktreeSnapshot(clone, capture.snapshot.id, capture.snapshot);
	const elsewhere = sandbox.path("machine-a");
	renameReplacing(clone, elsewhere);
	return { manager, snapshot: capture.snapshot, pushed, unpushed, clone: elsewhere };
}

/**
 * Machine B: a degraded resume, then one turn that ran bash in the partly restored worktree, after `work` changed it,
 * then a collection.
 */
async function degradedTurnOnB(
	manager: SessionManager,
	snapshot: WorktreeSnapshot,
	pushed: string,
	work: (worktree: string) => void = () => {},
) {
	const onB = ready(await prepareSessionResume(manager, options("machine-b")));
	const b = onB.sessionManager.getWorktreeRootMappings().at(-1)!;
	assert.equal(b.degraded?.stage, "closest-commit");
	assert.equal(await sandbox.git(b.to, "rev-parse", "HEAD"), pushed);
	assert.equal(existsSync(join(b.to, "work.txt")), false);
	work(b.to);
	await runTurn(onB.sessionManager, b.to);
	const derived = snapshotEntries(onB.sessionManager).at(-1)!;
	assert.notEqual(derived.snapshotId, snapshot.id, "the turn recorded the partly restored worktree");
	await collectSnapshotGarbage(onB.sessionManager.getSessionStore().snapshotBlobs, { graceSeconds: 0 });
	return { onB, b };
}

describe("a degraded resume keeps the snapshot it could not restore fully (#4922)", () => {
	test("after a turn on the degraded machine and a collection, a later resume restores the pushed commit plus work.txt (#4922)", async () => {
		const a = await machineA();
		const { onB, b } = await degradedTurnOnB(a.manager, a.snapshot, a.pushed);

		await sandbox.git(a.clone, "push", "-q", "origin", "HEAD:main");
		rmSync(b.to, { recursive: true, force: true });
		const onC = ready(await prepareSessionResume(onB.sessionManager, options("machine-c")));

		const c = onC.sessionManager.getWorktreeRootMappings().at(-1)!;
		assert.equal(c.snapshotId, a.snapshot.id);
		assert.equal(c.degraded, undefined);
		assert.equal(c.degradedWork, undefined, "the partly restored worktree recorded no work of its own");
		assert.equal(await sandbox.git(c.to, "rev-parse", "HEAD"), a.unpushed);
		assert.equal(readFileSync(join(c.to, "work.txt"), "utf8"), "uncommitted work\n");
	});

	test("collection never deletes the snapshot's content while its degraded restore stands (#4922)", async () => {
		const a = await machineA();
		const { onB } = await degradedTurnOnB(a.manager, a.snapshot, a.pushed);
		await runTurn(onB.sessionManager, onB.sessionManager.getWorktreeRootMappings().at(-1)!.to);
		await collectSnapshotGarbage(onB.sessionManager.getSessionStore().snapshotBlobs, { graceSeconds: 0 });

		const stored = new Set(await onB.sessionManager.getSessionStore().snapshotBlobs!.listBlobHashes());
		for (const hash of snapshotBlobHashes(a.snapshot)) assert.ok(stored.has(hash), `blob ${hash} was collected`);
	});

	test("work done in the partly restored worktree is applied on top of the full restore, and recorded (#4922)", async () => {
		const a = await machineA();
		const { onB, b } = await degradedTurnOnB(a.manager, a.snapshot, a.pushed, (worktree) =>
			sandbox.write(join(worktree, "from-b.txt"), "done on machine B\n"),
		);

		await sandbox.git(a.clone, "push", "-q", "origin", "HEAD:main");
		rmSync(b.to, { recursive: true, force: true });
		const onC = ready(await prepareSessionResume(onB.sessionManager, options("machine-c")));

		const c = onC.sessionManager.getWorktreeRootMappings().at(-1)!;
		assert.equal(c.snapshotId, a.snapshot.id);
		assert.equal(c.degradedWork?.outcome, "applied");
		assert.deepEqual(c.degradedWork?.paths, ["from-b.txt"]);
		assert.equal(readFileSync(join(c.to, "work.txt"), "utf8"), "uncommitted work\n");
		assert.equal(readFileSync(join(c.to, "from-b.txt"), "utf8"), "done on machine B\n");
		assert.ok(
			onC.notices.some(
				(notice) => notice.type === "info" && notice.message.startsWith("Also applied the work done"),
			),
		);
		assert.ok(onC.notices.some((notice) => notice.message.includes("(from-b.txt)")));
		assert.ok(
			!onC.notices.some(
				(notice) => notice.message.includes("not recorded yet") || notice.message.includes("restored only partly"),
			),
			"recorded at once, the carried-over work needs no warning (#5009)",
		);
		const recorded = onC.sessionManager.getLatestWorktreeSnapshots().get(c.to)!;
		assert.notEqual(recorded.id, a.snapshot.id, "the merged worktree is recorded at once");
		const stored = new Set(await onC.sessionManager.getSessionStore().snapshotBlobs!.listBlobHashes());
		assert.ok(snapshotBlobHashes(recorded).every((hash) => stored.has(hash)));
		assert.equal(snapshotEntries(onC.sessionManager).at(-1)?.degradedFrom, undefined);
	});

	test("work that conflicts with the full restore is left out and kept as a commit (#4922)", async () => {
		const a = await machineA();
		const { onB, b } = await degradedTurnOnB(a.manager, a.snapshot, a.pushed, (worktree) =>
			sandbox.write(join(worktree, "work.txt"), "a different work.txt on machine B\n"),
		);

		await sandbox.git(a.clone, "push", "-q", "origin", "HEAD:main");
		rmSync(b.to, { recursive: true, force: true });
		const onC = ready(await prepareSessionResume(onB.sessionManager, options("machine-c")));

		const c = onC.sessionManager.getWorktreeRootMappings().at(-1)!;
		assert.equal(c.degradedWork?.outcome, "kept");
		assert.equal(readFileSync(join(c.to, "work.txt"), "utf8"), "uncommitted work\n");
		assert.equal(await sandbox.git(c.to, "rev-parse", c.degradedWork!.ref!), c.degradedWork!.commit);
		assert.equal(
			await sandbox.git(c.to, "show", `${c.degradedWork!.commit}:work.txt`),
			"a different work.txt on machine B",
		);
		assert.ok(c.degradedWork!.ref!.startsWith("refs/atomic/degraded-work/"));
		const warning = onC.notices.find(
			(notice) => notice.type === "warning" && notice.message.startsWith("Did not apply"),
		);
		assert.ok(warning?.message.includes(`git diff ${c.degradedWork!.base} ${c.degradedWork!.commit}`));
		assert.ok(warning?.message.includes(`Commit ${c.degradedWork!.commit!.slice(0, 12)} `));
	});

	test("a resume that still cannot reach the snapshot continues from the partly restored worktree's work, keeping the pin (#4922)", async () => {
		const a = await machineA();
		const { onB, b } = await degradedTurnOnB(a.manager, a.snapshot, a.pushed, (worktree) =>
			sandbox.write(join(worktree, "from-b.txt"), "done on machine B\n"),
		);
		const work = snapshotEntries(onB.sessionManager).at(-1)!;
		assert.equal(work.degradedFrom, a.snapshot.id);

		rmSync(b.to, { recursive: true, force: true });
		const onC = ready(await prepareSessionResume(onB.sessionManager, options("machine-c")));

		const c = onC.sessionManager.getWorktreeRootMappings().at(-1)!;
		assert.equal(c.snapshotId, work.snapshotId);
		assert.equal(c.degradedWork, undefined);
		assert.equal(readFileSync(join(c.to, "from-b.txt"), "utf8"), "done on machine B\n");
		assert.ok(onC.notices.every((notice) => !notice.message.includes("is no longer kept")));
		assert.equal(snapshotEntries(onC.sessionManager).at(-1)?.degradedFrom, a.snapshot.id);
		assert.ok(onC.notices.some((notice) => notice.message.includes("still cannot be restored here")));
		await collectSnapshotGarbage(onC.sessionManager.getSessionStore().snapshotBlobs, { graceSeconds: 0 });
		const stored = new Set(await onC.sessionManager.getSessionStore().snapshotBlobs!.listBlobHashes());
		for (const hash of snapshotBlobHashes(a.snapshot)) assert.ok(stored.has(hash), `blob ${hash} was collected`);

		// Once the commit is pushed, the next resume restores the snapshot with the work on top.
		await sandbox.git(a.clone, "push", "-q", "origin", "HEAD:main");
		rmSync(c.to, { recursive: true, force: true });
		const onD = ready(await prepareSessionResume(onC.sessionManager, options("machine-d")));
		const d = onD.sessionManager.getWorktreeRootMappings().at(-1)!;
		assert.equal(d.snapshotId, a.snapshot.id);
		assert.equal(readFileSync(join(d.to, "work.txt"), "utf8"), "uncommitted work\n");
		assert.equal(readFileSync(join(d.to, "from-b.txt"), "utf8"), "done on machine B\n");
	});

	test("discardDegradedRestore records the partly restored worktree and releases the snapshot (#4922)", async () => {
		const a = await machineA();
		const { onB, b } = await degradedTurnOnB(a.manager, a.snapshot, a.pushed);
		sandbox.write(join(b.to, "kept.txt"), "kept on machine B\n");

		assert.deepEqual(await discardDegradedRestore(onB.sessionManager, { settings, root: sandbox.path("other") }), []);
		assert.deepEqual(
			await discardDegradedRestore(onB.sessionManager, { settings: { ...settings, enabled: false } }),
			[],
		);
		assert.ok(describeWorktreeRestoreStatus(onB.sessionManager, b.to), "the partial restore is still reported");
		assert.deepEqual(await discardDegradedRestore(onB.sessionManager, { settings, root: b.to }), [b.to]);
		const discarded = snapshotEntries(onB.sessionManager).at(-1)!;
		assert.equal(discarded.degradedFrom, undefined);
		assert.equal(describeWorktreeRestoreStatus(onB.sessionManager, b.to), undefined);
		assert.ok(discarded.snapshot !== undefined, "the worktree's changed state is recorded");
		await collectSnapshotGarbage(onB.sessionManager.getSessionStore().snapshotBlobs, { graceSeconds: 0 });

		const stored = new Set(await onB.sessionManager.getSessionStore().snapshotBlobs!.listBlobHashes());
		assert.ok(snapshotBlobHashes(a.snapshot).every((hash) => !stored.has(hash)));
		assert.ok(snapshotBlobHashes(discarded.snapshot!).every((hash) => stored.has(hash)));
		await runTurn(onB.sessionManager, b.to);
		assert.equal(snapshotEntries(onB.sessionManager).at(-1)?.degradedFrom, undefined);
		assert.deepEqual(await discardDegradedRestore(onB.sessionManager, { settings }), []);
	});

	test(`the pin lapses ${DEGRADED_RESTORE_RETENTION_DAYS} days after the partial restore, with a notice, and collection releases the snapshot (#4922)`, async () => {
		const a = await machineA();
		const { onB, b } = await degradedTurnOnB(a.manager, a.snapshot, a.pushed);
		const blobs = onB.sessionManager.getSessionStore().snapshotBlobs as SqlSnapshotBlobStore;
		const { database } = blobs as unknown as {
			readonly database: { run(sql: string, ...params: unknown[]): Promise<unknown> };
		};

		// Collection counts the days on the database clock: a minute short of them keeps the snapshot.
		await database.run(
			"UPDATE snapshot_session_refs SET degraded_since = degraded_since - ? WHERE degraded_from IS NOT NULL",
			DEGRADED_RESTORE_RETENTION_DAYS * 24 * 60 * 60 - 60,
		);
		await collectSnapshotGarbage(blobs, { graceSeconds: 0 });
		const inside = new Set(await blobs.listBlobHashes());
		assert.ok(snapshotBlobHashes(a.snapshot).every((hash) => inside.has(hash)));
		await database.run(
			"UPDATE snapshot_session_refs SET degraded_since = degraded_since - ? WHERE degraded_from IS NOT NULL",
			61,
		);
		await collectSnapshotGarbage(blobs, { graceSeconds: 0 });
		const stored = new Set(await blobs.listBlobHashes());
		assert.ok(snapshotBlobHashes(a.snapshot).every((hash) => !stored.has(hash)));

		// Resume and capture count them on this machine's clock, from the partial restore.
		const pin = degradedRestorePin(onB.sessionManager, b.to)!;
		const work = snapshotEntries(onB.sessionManager).at(-1)!.snapshotId;
		vi.useFakeTimers({
			toFake: ["Date"],
			now: Date.parse(pin.since) + (DEGRADED_RESTORE_RETENTION_DAYS - 1) * 24 * 60 * 60 * 1000,
		});
		assert.equal(
			degradedRestorePin(onB.sessionManager, b.to)?.snapshotId,
			a.snapshot.id,
			"the pin stands a day short",
		);
		vi.useFakeTimers({
			toFake: ["Date"],
			now: Date.now() + (DEGRADED_RESTORE_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000,
		});
		cleanups.push(() => vi.useRealTimers());
		const again = ready(await prepareSessionResume(onB.sessionManager, options("machine-b")));
		const lapsed = again.notices.find((notice) => notice.message.includes("is no longer kept"));
		assert.equal(lapsed?.type, "warning");
		assert.ok(lapsed?.message.includes(pin.since.slice(0, 10)));
		assert.ok(lapsed?.message.includes(`from snapshot ${work.slice(0, 12)}`));
		assert.equal(degradedRestorePin(again.sessionManager, b.to), undefined);
		assert.equal(again.sessionManager.getCwd(), b.to);
		await runTurn(again.sessionManager, b.to);
		assert.equal(snapshotEntries(again.sessionManager).at(-1)?.degradedFrom, undefined);
	});

	test("a resume and collection with no partial restore record and keep what they did before (#4922)", async () => {
		const { clone } = await sandbox.remoteWithClone("plain", { "README.md": "hello\n" });
		sandbox.write(join(clone, "work.txt"), "uncommitted work\n");
		const store = await sqlStore();
		const manager = await SessionManager.create(store, clone);
		await runTurn(manager, clone);
		sandbox.write(join(clone, "work.txt"), "more work\n");
		await runTurn(manager, clone);
		const second = snapshotEntries(manager).at(-1)!;
		await collectSnapshotGarbage(store.snapshotBlobs, { graceSeconds: 0 });

		const stored = new Set(await store.snapshotBlobs!.listBlobHashes());
		assert.ok(snapshotBlobHashes(second.snapshot!).every((hash) => stored.has(hash)));
		renameReplacing(clone, sandbox.path("plain-elsewhere"));
		const resumed = ready(await prepareSessionResume(manager, options("machine-b")));
		const restored = resumed.sessionManager.getWorktreeRootMappings().at(-1)!;
		assert.equal(restored.snapshotId, second.snapshotId);
		assert.equal(restored.degradedWork, undefined);
		assert.equal(readFileSync(join(restored.to, "work.txt"), "utf8"), "more work\n");
		assert.ok(snapshotEntries(resumed.sessionManager).every((entry) => entry.degradedFrom === undefined));
	});

	test("a later resume on the degraded machine restores the snapshot fully once it can, when the worktree holds nothing new (#4922)", async () => {
		const a = await machineA();
		const { onB, b } = await degradedTurnOnB(a.manager, a.snapshot, a.pushed);

		await sandbox.git(a.clone, "push", "-q", "origin", "HEAD:main");
		const again = ready(await prepareSessionResume(onB.sessionManager, options("machine-b")));

		const restored = again.sessionManager.getWorktreeRootMappings().at(-1)!;
		assert.notEqual(restored.to, b.to);
		assert.equal(restored.snapshotId, a.snapshot.id);
		assert.equal(restored.degraded, undefined);
		assert.equal(readFileSync(join(restored.to, "work.txt"), "utf8"), "uncommitted work\n");
	});

	test("a resume that can restore nothing keeps the pin and the work done in the partly restored worktree (#4922)", async () => {
		const a = await machineA();
		const { onB, b } = await degradedTurnOnB(a.manager, a.snapshot, a.pushed, (worktree) =>
			sandbox.write(join(worktree, "from-b.txt"), "done on machine B\n"),
		);
		const work = snapshotEntries(onB.sessionManager).at(-1)!;
		rmSync(b.to, { recursive: true, force: true });
		renameReplacing(sandbox.path("repo.git"), sandbox.path("remote-gone"));

		const onC = ready(await prepareSessionResume(onB.sessionManager, options("machine-c")));

		const left = snapshotEntries(onC.sessionManager).at(-1)!;
		assert.ok(left.unrestored !== undefined, JSON.stringify(left));
		assert.equal(left.snapshotId, work.snapshotId);
		assert.equal(left.degradedFrom, a.snapshot.id);
		await collectSnapshotGarbage(onC.sessionManager.getSessionStore().snapshotBlobs, { graceSeconds: 0 });
		const stored = new Set(await onC.sessionManager.getSessionStore().snapshotBlobs!.listBlobHashes());
		for (const hash of [...snapshotBlobHashes(a.snapshot), ...snapshotBlobHashes(work.snapshot!)])
			assert.ok(stored.has(hash), `blob ${hash} was collected`);
	});

	test("a snapshot entry names in degradedFrom only another snapshot the session recorded (#4922)", async () => {
		const a = await machineA();
		const other = "0123456789abcdef0123456789abcdef";
		await assert.rejects(
			a.manager.appendWorktreeSnapshot(
				a.clone,
				a.snapshot.id,
				undefined,
				undefined,
				[],
				undefined,
				undefined,
				a.snapshot.id,
			),
			/degradedFrom/,
		);
		await assert.rejects(
			a.manager.appendWorktreeSnapshot(
				a.clone,
				a.snapshot.id,
				undefined,
				undefined,
				[],
				undefined,
				undefined,
				other,
			),
			/degradedFrom/,
		);
		const { onB } = await degradedTurnOnB(a.manager, a.snapshot, a.pushed);
		const reopened = await SessionManager.open(
			onB.sessionManager.getSessionStore(),
			onB.sessionManager.getSessionId(),
		);
		assert.equal(snapshotEntries(reopened).at(-1)?.degradedFrom, a.snapshot.id, "the pin is stored with the entry");
	});

	test("work that cannot be read on this machine is reported, and nothing is applied (#4922)", async () => {
		const a = await machineA();
		const { onB, b } = await degradedTurnOnB(a.manager, a.snapshot, a.pushed, (worktree) =>
			sandbox.write(join(worktree, "from-b.txt"), "done on machine B\n"),
		);
		const work = snapshotEntries(onB.sessionManager).at(-1)!.snapshot!;
		const blobs = onB.sessionManager.getSessionStore().snapshotBlobs as SqlSnapshotBlobStore;
		const unreadable = await carryOverDegradedWork({
			worktree: b.to,
			work: { ...work, chain: [{ ...work.chain[0]!, patch: "f".repeat(64) }] },
			base: "0".repeat(40),
			blobs,
			storeDir: sandbox.path("machine-b"),
		});
		assert.equal(unreadable.outcome, "unavailable");
		assert.deepEqual(unreadable.paths, []);
		assert.match(unreadable.reason ?? "", /./);
		const unknownBase = await carryOverDegradedWork({
			worktree: b.to,
			work,
			base: "0".repeat(40),
			blobs,
			storeDir: sandbox.path("machine-b"),
		});
		assert.deepEqual([unknownBase.outcome, unknownBase.paths], ["unavailable", []]);
		assert.match(unknownBase.reason ?? "", /is not here/);
		const noBase = await carryOverDegradedWork({ worktree: b.to, work, base: undefined, blobs });
		assert.deepEqual([noBase.outcome, noBase.paths], ["unavailable", []]);
		assert.match(noBase.reason ?? "", /no record of the partial restore/);
		assert.equal(readFileSync(join(b.to, "from-b.txt"), "utf8"), "done on machine B\n");
		const notice = formatDegradedWorkNotice(onB.sessionManager.getWorktreeRootMappings().at(-1)!, noBase);
		assert.match(notice, /^Could not read the work done in the partly restored worktree /);
		assert.ok(notice.includes("(the session holds no record of the partial restore)"));
	});

	test("a resume on the degraded machine continues in the worktree the session worked in, as it is (#4922)", async () => {
		const a = await machineA();
		const { onB, b } = await degradedTurnOnB(a.manager, a.snapshot, a.pushed, (worktree) =>
			sandbox.write(join(worktree, "from-b.txt"), "done on machine B\n"),
		);
		const mappings = onB.sessionManager.getWorktreeRootMappings().length;

		const again = ready(await prepareSessionResume(onB.sessionManager, options("machine-b")));

		assert.equal(again.sessionManager.getCwd(), b.to);
		assert.equal(again.sessionManager.getWorktreeRootMappings().length, mappings);
		assert.deepEqual(
			again.notices.filter((notice) => notice.type === "warning"),
			[],
		);
		assert.equal(readFileSync(join(b.to, "from-b.txt"), "utf8"), "done on machine B\n");
	});

	test("discardDegradedRestore reports a worktree it cannot record (#4922)", async () => {
		const a = await machineA();
		const { onB, b } = await degradedTurnOnB(a.manager, a.snapshot, a.pushed);
		rmSync(b.to, { recursive: true, force: true });
		await assert.rejects(discardDegradedRestore(onB.sessionManager, { settings }), /not-a-repository|repository/);
	});
});

/**
 * Runs `resume` with the first Git command after the restore entry that applied carried-over work failing, as a Git
 * error, a crash or Ctrl-C at that moment would leave the merged state unrecorded (#5009).
 */
async function withCarriedWorkCaptureFailing<T>(resume: () => Promise<T>): Promise<{ result: T; failed: boolean }> {
	const append = SessionManager.prototype.appendWorktreeSnapshot;
	let armed = false;
	let failed = false;
	const spy = vi.spyOn(SessionManager.prototype, "appendWorktreeSnapshot").mockImplementation(async function (
		this: SessionManager,
		...args
	) {
		const id = await append.apply(this, args);
		if (!failed && args[3]?.degradedWork?.outcome === "applied") armed = true;
		return id;
	});
	const git = sandbox.executable;
	const previous = setWorktreeSnapshotGit(async () => {
		if (!armed) return git;
		armed = false;
		failed = true;
		return { path: sandbox.path("no-git"), env: {} };
	});
	try {
		return { result: await resume(), failed };
	} finally {
		setWorktreeSnapshotGit(previous);
		spy.mockRestore();
	}
}

describe("the pin ends only once the carried-over work is recorded (#5009)", () => {
	test("a capture failing after the replay keeps the work: after a collection, another machine restores from-b.txt (#5009)", async () => {
		const a = await machineA();
		const { onB, b } = await degradedTurnOnB(a.manager, a.snapshot, a.pushed, (worktree) =>
			sandbox.write(join(worktree, "from-b.txt"), "done on machine B\n"),
		);
		await sandbox.git(a.clone, "push", "-q", "origin", "HEAD:main");
		rmSync(b.to, { recursive: true, force: true });

		const { result: onC, failed } = await withCarriedWorkCaptureFailing(async () =>
			ready(await prepareSessionResume(onB.sessionManager, options("machine-c"))),
		);
		assert.equal(failed, true, "the capture of the merged state failed");
		const c = onC.sessionManager.getWorktreeRootMappings().at(-1)!;
		assert.equal(c.degradedWork?.outcome, "applied");
		assert.equal(readFileSync(join(c.to, "from-b.txt"), "utf8"), "done on machine B\n");
		assert.ok(
			onC.notices.some((notice) => notice.type === "warning" && notice.message.includes("not recorded yet")),
			"the unrecorded carried-over work is reported",
		);

		await collectSnapshotGarbage(onC.sessionManager.getSessionStore().snapshotBlobs, { graceSeconds: 0 });
		rmSync(c.to, { recursive: true, force: true });
		const onD = ready(await prepareSessionResume(onC.sessionManager, options("machine-d")));

		const d = onD.sessionManager.getWorktreeRootMappings().at(-1)!;
		assert.equal(d.snapshotId, a.snapshot.id);
		assert.equal(d.degradedWork?.outcome, "applied");
		assert.equal(readFileSync(join(d.to, "work.txt"), "utf8"), "uncommitted work\n");
		assert.equal(readFileSync(join(d.to, "from-b.txt"), "utf8"), "done on machine B\n");
		assert.equal(snapshotEntries(onD.sessionManager).at(-1)?.degradedFrom, undefined, "now recorded, the pin ends");
		assert.equal(degradedRestorePin(onD.sessionManager, d.to), undefined);
	});

	test("after a failed capture, the next resume on the same machine records the merged worktree and ends the pin (#5009)", async () => {
		const a = await machineA();
		const { onB, b } = await degradedTurnOnB(a.manager, a.snapshot, a.pushed, (worktree) =>
			sandbox.write(join(worktree, "from-b.txt"), "done on machine B\n"),
		);
		await sandbox.git(a.clone, "push", "-q", "origin", "HEAD:main");
		rmSync(b.to, { recursive: true, force: true });
		const { result: onC } = await withCarriedWorkCaptureFailing(async () =>
			ready(await prepareSessionResume(onB.sessionManager, options("machine-c"))),
		);
		const c = onC.sessionManager.getWorktreeRootMappings().at(-1)!;
		assert.notEqual(degradedRestorePin(onC.sessionManager, c.to), undefined, "the pin stands until it is recorded");
		const mappings = onC.sessionManager.getWorktreeRootMappings().length;

		const again = ready(await prepareSessionResume(onC.sessionManager, options("machine-c")));

		assert.equal(again.sessionManager.getWorktreeRootMappings().length, mappings, "no new restore");
		assert.equal(degradedRestorePin(again.sessionManager, c.to), undefined);
		const recorded = again.sessionManager.getLatestWorktreeSnapshots().get(c.to)!;
		assert.notEqual(recorded.id, a.snapshot.id);
		await collectSnapshotGarbage(again.sessionManager.getSessionStore().snapshotBlobs, { graceSeconds: 0 });
		rmSync(c.to, { recursive: true, force: true });
		const onD = ready(await prepareSessionResume(again.sessionManager, options("machine-d")));
		const d = onD.sessionManager.getWorktreeRootMappings().at(-1)!;
		assert.equal(d.snapshotId, recorded.id);
		assert.equal(readFileSync(join(d.to, "from-b.txt"), "utf8"), "done on machine B\n");
	});

	test("after a failed capture, the next turn records the merged worktree and ends the pin (#5009)", async () => {
		const a = await machineA();
		const { onB, b } = await degradedTurnOnB(a.manager, a.snapshot, a.pushed, (worktree) =>
			sandbox.write(join(worktree, "from-b.txt"), "done on machine B\n"),
		);
		await sandbox.git(a.clone, "push", "-q", "origin", "HEAD:main");
		rmSync(b.to, { recursive: true, force: true });
		const { result: onC } = await withCarriedWorkCaptureFailing(async () =>
			ready(await prepareSessionResume(onB.sessionManager, options("machine-c"))),
		);
		const c = onC.sessionManager.getWorktreeRootMappings().at(-1)!;

		await runTurn(onC.sessionManager, c.to);

		assert.equal(snapshotEntries(onC.sessionManager).at(-1)?.degradedFrom, undefined);
		assert.equal(degradedRestorePin(onC.sessionManager, c.to), undefined);
	});

	test("conflicting carried-over work stays recoverable on another machine after a collection (#5009)", async () => {
		const a = await machineA();
		const { onB, b } = await degradedTurnOnB(a.manager, a.snapshot, a.pushed, (worktree) =>
			sandbox.write(join(worktree, "work.txt"), "a different work.txt on machine B\n"),
		);
		await sandbox.git(a.clone, "push", "-q", "origin", "HEAD:main");
		rmSync(b.to, { recursive: true, force: true });
		const onC = ready(await prepareSessionResume(onB.sessionManager, options("machine-c")));
		const c = onC.sessionManager.getWorktreeRootMappings().at(-1)!;
		assert.equal(c.degradedWork?.outcome, "kept");
		assert.ok(
			onC.notices.some((notice) => notice.message.includes("discardDegradedRestore")),
			"the notice says how long the kept work stays",
		);

		await collectSnapshotGarbage(onC.sessionManager.getSessionStore().snapshotBlobs, { graceSeconds: 0 });
		rmSync(c.to, { recursive: true, force: true });
		const onD = ready(await prepareSessionResume(onC.sessionManager, options("machine-d")));

		const d = onD.sessionManager.getWorktreeRootMappings().at(-1)!;
		assert.equal(readFileSync(join(d.to, "work.txt"), "utf8"), "uncommitted work\n");
		assert.equal(d.degradedWork?.outcome, "kept");
		assert.ok(!onD.notices.some((notice) => notice.message.includes("restored only partly")));
		assert.equal(
			await sandbox.git(d.to, "show", `${d.degradedWork!.ref!}:work.txt`),
			"a different work.txt on machine B",
		);
	});

	test("kept work stays across later turns until discardDegradedRestore releases it (#5009)", async () => {
		const a = await machineA();
		const { onB, b } = await degradedTurnOnB(a.manager, a.snapshot, a.pushed, (worktree) =>
			sandbox.write(join(worktree, "work.txt"), "a different work.txt on machine B\n"),
		);
		const work = onB.sessionManager.getLatestWorktreeSnapshots().get(b.to)!;
		await sandbox.git(a.clone, "push", "-q", "origin", "HEAD:main");
		rmSync(b.to, { recursive: true, force: true });
		const onC = ready(await prepareSessionResume(onB.sessionManager, options("machine-c")));
		const c = onC.sessionManager.getWorktreeRootMappings().at(-1)!;
		sandbox.write(join(c.to, "from-c.txt"), "done on machine C\n");
		await runTurn(onC.sessionManager, c.to);
		const blobs = onC.sessionManager.getSessionStore().snapshotBlobs as SqlSnapshotBlobStore;

		await collectSnapshotGarbage(blobs, { graceSeconds: 0 });
		const kept = new Set(await blobs.listBlobHashes());
		assert.ok(
			snapshotBlobHashes(work).every((hash) => kept.has(hash)),
			"the kept work's content stays",
		);
		const latest = onC.sessionManager.getLatestWorktreeSnapshots().get(c.to)!;
		rmSync(c.to, { recursive: true, force: true });
		// A machine that can restore nothing keeps naming the kept work.
		renameReplacing(sandbox.path("repo.git"), sandbox.path("remote-gone"));
		const onE = ready(await prepareSessionResume(onC.sessionManager, options("machine-e")));
		const left = snapshotEntries(onE.sessionManager).at(-1)!;
		assert.ok(left.unrestored !== undefined);
		assert.equal(left.degradedFrom, work.id);
		renameReplacing(sandbox.path("remote-gone"), sandbox.path("repo.git"));
		await collectSnapshotGarbage(blobs, { graceSeconds: 0 });
		const stillKept = new Set(await blobs.listBlobHashes());
		assert.ok(snapshotBlobHashes(work).every((hash) => stillKept.has(hash)));

		const onD = ready(await prepareSessionResume(onE.sessionManager, options("machine-d")));
		const d = onD.sessionManager.getWorktreeRootMappings().at(-1)!;
		assert.equal(d.snapshotId, latest.id, "the checkout continues from its latest snapshot");
		assert.equal(readFileSync(join(d.to, "from-c.txt"), "utf8"), "done on machine C\n");
		assert.equal(snapshotEntries(onD.sessionManager).at(-1)?.degradedFrom, work.id);
		assert.ok(!onD.notices.some((notice) => notice.message.includes("restored only partly")));

		assert.deepEqual(await discardDegradedRestore(onD.sessionManager, { settings }), [d.to]);
		await collectSnapshotGarbage(blobs, { graceSeconds: 0 });
		const released = new Set(await blobs.listBlobHashes());
		assert.ok(!snapshotBlobHashes(work).every((hash) => released.has(hash)), "discarding releases it");
	});
});
