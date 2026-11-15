import assert from "node:assert/strict";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { afterEach, beforeEach, describe, test } from "vitest";
import { withDebugLog } from "../../../test/helpers/debug-mode.js";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { SessionManager } from "../src/core/session-manager.ts";
import { SessionWorktreeSnapshotRecorder } from "../src/core/session-worktree-snapshots.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.ts";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.ts";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.ts";
import { type PreparedSessionResume, type PrepareSessionResumeOptions, prepareSessionResume } from "../src/index.js";
import { deleteSessionFromPicker } from "../src/main-session.ts";

useTemporaryAgentDir();

const settings = DEFAULT_WORKTREE_SNAPSHOT_SETTINGS;
let sandbox: GitSandbox;
const cleanups: Array<() => Promise<void> | void> = [];
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	sandbox.dispose();
});

async function sqlStore(): Promise<SqlSessionStore> {
	const database = await openNodeSqliteDatabase(sandbox.path("sessions.sqlite"));
	const store = await SqlSessionStore.open(database);
	cleanups.push(async () => {
		await store.close();
		await database.close();
	});
	return store;
}

const writeTurn = (path: string) =>
	fauxAssistantMessage([fauxToolCall("write", { path, content: "" })], { stopReason: "toolUse" });

function recorderFor(manager: SessionManager, cwd: string): SessionWorktreeSnapshotRecorder {
	return new SessionWorktreeSnapshotRecorder({
		sessionManager: manager,
		cwd: () => cwd,
		settings: () => settings,
		declaresWrites: () => false,
		onUnavailable: () => {},
	});
}

/** A session whose turn wrote `README.md` in a fresh clone, recorded the way a session records its turns. */
async function sessionThatEdited() {
	const { remote, clone } = await sandbox.remoteWithClone();
	const store = await sqlStore();
	const manager = await SessionManager.create(store, clone);
	await manager.appendMessage({ role: "user", content: "edit the readme", timestamp: Date.now() });
	const recorder = recorderFor(manager, clone);
	sandbox.write(join(clone, "README.md"), "the session's edit\n");
	await recorder.recordTurn(writeTurn(join(clone, "README.md")));
	return { remote, clone, store, manager, recorder };
}

function options(overrides: Partial<PrepareSessionResumeOptions> = {}): PrepareSessionResumeOptions {
	return {
		entryPoint: "cli",
		launchCwd: sandbox.root,
		settings,
		storeDir: sandbox.path("host"),
		blueprints: "skip",
		...overrides,
	};
}

function cwdOf(prepared: PreparedSessionResume): string | undefined {
	return prepared.status === "ready" ? prepared.sessionManager.getCwd() : undefined;
}

/** The refs under `namespace` of the repository at `cwd`, session snapshot refs by default, as `name commit` lines. */
async function atomicRefs(cwd: string, namespace = "refs/atomic/snapshots/"): Promise<string[]> {
	const listed = await sandbox.git(cwd, "for-each-ref", "--format=%(refname) %(objectname)", namespace);
	return listed === "" ? [] : listed.split("\n");
}

async function pruneUnreachable(cwd: string): Promise<void> {
	await sandbox.git(cwd, "gc", "--quiet", "--prune=now");
}

describe("snapshot commits survive git gc (#4923)", () => {
	test("after git gc, a session resumed from its own checkout continues there, as the user left it (#4923)", async () => {
		const { clone, manager } = await sessionThatEdited();
		sandbox.write(join(clone, "README.md"), "edited by hand after the session\n");
		await pruneUnreachable(clone);

		const prepared = await prepareSessionResume(manager, options({ launchCwd: clone }));

		assert.equal(cwdOf(prepared), clone);
		assert.deepEqual(manager.getWorktreeRootMappings(), []);
		assert.equal(existsSync(sandbox.path("host", "worktrees")), false);
		assert.equal(readFileSync(join(clone, "README.md"), "utf8"), "edited by hand after the session\n");
	});

	test("each capture points the session's ref at its latest snapshot commit, and deleting the session removes it (#4923)", async () => {
		const { clone, store, manager, recorder } = await sessionThatEdited();
		const first = manager.getLatestWorktreeSnapshots().get(clone)!.snapshot;
		const refs = await atomicRefs(clone);
		assert.equal(refs.length, 1);
		assert.match(refs[0]!, new RegExp(`^refs/atomic/snapshots/${manager.getSessionId()}/[0-9a-f]{24} ${first}$`));

		sandbox.write(join(clone, "README.md"), "a second edit\n");
		await recorder.recordTurn(writeTurn(join(clone, "README.md")));
		const second = manager.getLatestWorktreeSnapshots().get(clone)!.snapshot;
		assert.notEqual(second, first);
		assert.deepEqual(await atomicRefs(clone), [`${refs[0]!.split(" ")[0]} ${second}`]);

		const other = await SessionManager.create(store, clone);
		await other.deleteSession(manager.getSessionId());
		assert.deepEqual(await atomicRefs(clone), []);
	});

	test("deleting a session from the resume picker removes its snapshot refs (#4923)", async () => {
		const { clone, store, manager } = await sessionThatEdited();
		assert.equal((await atomicRefs(clone)).length, 1);
		await deleteSessionFromPicker(store, manager.getSessionId());
		assert.deepEqual(await atomicRefs(clone), []);
	});

	test("a session that works in a worktree restored from its checkout releases the checkout's ref (#4923)", async () => {
		const { clone, manager } = await sessionThatEdited();
		renameSync(clone, sandbox.path("away"));
		const prepared = await prepareSessionResume(manager, options());
		renameSync(sandbox.path("away"), clone);
		const worktree = manager.getWorktreeRootMappings().at(-1)!.to;
		assert.equal(cwdOf(prepared), worktree);
		assert.equal((await atomicRefs(clone)).length, 1);
		const moved = prepared.status === "ready" ? prepared.sessionManager : manager;

		sandbox.write(join(worktree, "README.md"), "the session's work in the worktree\n");
		await recorderFor(moved, worktree).recordTurn(writeTurn(join(worktree, "README.md")));

		assert.deepEqual(await atomicRefs(clone), []);
		assert.deepEqual(
			(await atomicRefs(worktree)).map((ref) => ref.split(" ")[1]),
			[moved.getLatestWorktreeSnapshots().get(worktree)!.snapshot],
		);
	});

	test("working in one restored checkout releases only that checkout's ref, not a sibling's (#4923)", async () => {
		const { clone, manager, recorder } = await sessionThatEdited();
		const { clone: sibling } = await sandbox.remoteWithClone("sibling");
		sandbox.write(join(sibling, "README.md"), "the session's sibling edit\n");
		await recorder.recordTurn(writeTurn(join(sibling, "README.md")));
		assert.equal((await atomicRefs(sibling)).length, 1);
		renameSync(clone, sandbox.path("away"));
		renameSync(sibling, sandbox.path("sibling-away"));
		const prepared = await prepareSessionResume(manager, options());
		renameSync(sandbox.path("away"), clone);
		renameSync(sandbox.path("sibling-away"), sibling);
		const moved = prepared.status === "ready" ? prepared.sessionManager : manager;
		const worktree = moved.getWorktreeRootMappings().find((mapping) => mapping.from === clone)!.to;

		sandbox.write(join(worktree, "README.md"), "the session's work in the worktree\n");
		await recorderFor(moved, worktree).recordTurn(writeTurn(join(worktree, "README.md")));

		assert.deepEqual(await atomicRefs(clone), []);
		assert.equal((await atomicRefs(sibling)).length, 1);
	});

	test("deleting a session whose checkout is gone still deletes it, and the debug log says which ref stayed (#4923)", async () => {
		const { clone, store, manager } = await sessionThatEdited();
		renameSync(clone, sandbox.path("away"));
		await withDebugLog("ATOMIC_DEBUG", async (log) => {
			await (await SessionManager.create(store, sandbox.root)).deleteSession(manager.getSessionId());

			assert.equal(await store.readHeader(manager.getSessionId()), undefined);
			const failures = log.records().filter((record) => record.event === "snapshot-ref-release-failed");
			assert.deepEqual(
				failures.map((record) => [record.area, record.data.root]),
				[["storage", clone]],
			);
			assert.equal(typeof failures[0]!.data.message, "string");
		});
		assert.equal((await atomicRefs(sandbox.path("away"))).length, 1);
	});

	test("snapshot refs are never pushed by git push --all or --tags, nor carried in a snapshot's bundle (#4923)", async () => {
		const { remote, clone, store, manager, recorder } = await sessionThatEdited();
		sandbox.write(join(clone, "unpushed.txt"), "a local commit\n");
		await sandbox.commitAll(clone, "unpushed");
		await recorder.recordTurn(writeTurn(join(clone, "unpushed.txt")));
		assert.equal((await atomicRefs(clone)).length, 1);

		await sandbox.git(clone, "push", "-q", "origin", "--all");
		await sandbox.git(clone, "push", "-q", "origin", "--tags");

		assert.deepEqual(await atomicRefs(remote, "refs/atomic/"), []);
		const bundle = manager.getLatestWorktreeSnapshots().get(clone)!.bundle;
		assert.ok(bundle);
		const file = sandbox.path("snapshot.bundle");
		sandbox.write(file, (await store.snapshotBlobs!.getBlob(bundle.blob))!);
		assert.deepEqual(
			(await sandbox.git(clone, "bundle", "list-heads", file)).split("\n").map((line) => line.split(" ")[1]),
			["HEAD"],
		);
	});

	test("a session recorded before snapshot refs recognises its checkout after git gc once a turn records it again (#4923)", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const store = await sqlStore();
		const manager = await SessionManager.create(store, clone);
		await manager.appendMessage({ role: "user", content: "edit", timestamp: Date.now() });
		sandbox.write(join(clone, "README.md"), "recorded by an older Atomic\n");
		const older = await captureWorktreeSnapshot(clone, { settings, blobs: store.snapshotBlobs });
		if (older.status !== "captured") throw new Error(older.status);
		await manager.appendWorktreeSnapshot(clone, older.snapshot.id, older.snapshot);
		assert.deepEqual(await atomicRefs(clone), []);

		sandbox.write(join(clone, "README.md"), "the next turn's edit\n");
		await recorderFor(manager, clone).recordTurn(writeTurn(join(clone, "README.md")));
		assert.equal((await atomicRefs(clone)).length, 1);
		sandbox.write(join(clone, "README.md"), "edited by hand\n");
		await pruneUnreachable(clone);

		const prepared = await prepareSessionResume(manager, options({ launchCwd: clone }));
		assert.equal(cwdOf(prepared), clone);
		assert.equal(readFileSync(join(clone, "README.md"), "utf8"), "edited by hand\n");
	});

	test("a checkout keeping the session's ref is its own even when gc pruned the commit of the snapshot resumed (#4923)", async () => {
		const { clone, manager, recorder } = await sessionThatEdited();
		const earlier = manager.getLeafId()!;
		sandbox.write(join(clone, "README.md"), "a later edit on another branch\n");
		await recorder.recordTurn(writeTurn(join(clone, "README.md")));
		await manager.branch(earlier);
		sandbox.write(join(clone, "README.md"), "edited by hand\n");
		await pruneUnreachable(clone);
		assert.equal(
			await sandbox
				.git(clone, "cat-file", "-e", `${manager.getLatestWorktreeSnapshots().get(clone)!.snapshot}^{commit}`)
				.then(
					() => true,
					() => false,
				),
			false,
		);

		const prepared = await prepareSessionResume(manager, options({ launchCwd: clone }));

		assert.equal(cwdOf(prepared), clone);
		assert.equal(readFileSync(join(clone, "README.md"), "utf8"), "edited by hand\n");
	});

	test("a directory that is no longer a repository at the session's path is restored, not kept (#4923)", async () => {
		const { clone, manager } = await sessionThatEdited();
		rmSync(join(clone, ".git"), { recursive: true, force: true });
		sandbox.write(join(clone, "README.md"), "no longer a checkout\n");

		const prepared = await prepareSessionResume(manager, options());

		assert.notEqual(cwdOf(prepared), clone);
		assert.equal(readFileSync(join(cwdOf(prepared)!, "README.md"), "utf8"), "the session's edit\n");
	});

	test("an unchanged turn of an older session whose snapshot commit gc pruned records its snapshot and reports nothing (#4923)", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const store = await sqlStore();
		const manager = await SessionManager.create(store, clone);
		await manager.appendMessage({ role: "user", content: "edit", timestamp: Date.now() });
		sandbox.write(join(clone, "README.md"), "recorded by an older Atomic\n");
		const older = await captureWorktreeSnapshot(clone, { settings, blobs: store.snapshotBlobs });
		if (older.status !== "captured") throw new Error(older.status);
		await manager.appendWorktreeSnapshot(clone, older.snapshot.id, older.snapshot);
		await pruneUnreachable(clone);
		const reported: string[] = [];
		const recorder = new SessionWorktreeSnapshotRecorder({
			sessionManager: manager,
			cwd: () => clone,
			settings: () => settings,
			declaresWrites: () => false,
			onUnavailable: (reason) => reported.push(reason.code),
		});

		await recorder.recordTurn(writeTurn(join(clone, "README.md")));

		assert.deepEqual(reported, []);
		const entries = manager.getEntries().filter((entry) => entry.type === "worktree_snapshot");
		assert.equal(entries.length, 2);
		assert.deepEqual(await atomicRefs(clone), []);
	});

	test("another clone at the session's path, without its ref, is still restored after gc (#4923)", async () => {
		const { remote, clone, manager } = await sessionThatEdited();
		await sandbox.git(sandbox.root, "clone", "-q", remote, sandbox.path("elsewhere"));
		rmSync(clone, { recursive: true, force: true });
		renameSync(sandbox.path("elsewhere"), clone);
		sandbox.write(join(clone, "README.md"), "another clone's own change\n");

		const prepared = await prepareSessionResume(
			manager,
			options({ launchCwd: clone, chooseDirtyCheckout: async () => "restore" }),
		);

		assert.notEqual(cwdOf(prepared), clone);
		assert.equal(readFileSync(join(cwdOf(prepared)!, "README.md"), "utf8"), "the session's edit\n");
	});
});
