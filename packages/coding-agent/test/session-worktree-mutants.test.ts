import assert from "node:assert/strict";
import { chmodSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { afterEach, beforeEach, describe, test } from "vitest";
import { assertUnreadablePath, GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import type { FileEntry, SessionEntry, WorktreeSnapshotEntry } from "../src/core/session-manager.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	adoptInlineSnapshotBlobs,
	resumeSessionWorktree,
	SessionWorktreeSnapshotRecorder,
	type WorktreeSnapshotUnavailable,
} from "../src/core/session-worktree-snapshots.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.ts";
import type { SessionStore } from "../src/core/storage/session/types.ts";
import { snapshotBlobHashes } from "../src/core/worktree-snapshot/blob-store.ts";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.ts";
import { collectSnapshotGarbage } from "../src/core/worktree-snapshot/garbage.ts";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.ts";
import {
	isWorkspaceConfigError,
	isWorkspaceGitError,
	MemorySnapshotBlobStore,
	type SnapshotBlobStore,
	setWorktreeSnapshotGit,
	type WorktreeSnapshot,
	type WorktreeSnapshotSettings,
} from "../src/index.ts";

let sandbox: GitSandbox;
const cleanups: Array<() => Promise<void> | void> = [];
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	sandbox.dispose();
});

async function sqlStore(name = "sessions"): Promise<SqlSessionStore> {
	const database = await openNodeSqliteDatabase(sandbox.path(`${name}.sqlite`));
	const store = await SqlSessionStore.open(database);
	cleanups.push(async () => {
		await store.close();
		await database.close();
	});
	return store;
}

const snapshotEntries = (manager: SessionManager): WorktreeSnapshotEntry[] =>
	manager.getEntries().filter((entry): entry is WorktreeSnapshotEntry => entry.type === "worktree_snapshot");

/** A recorder over a persisted session whose own checkout is `cwd`, and the reasons it reports. */
async function recorderFor(
	cwd: string,
	options: { declaresWrites?: (name: string) => boolean; settings?: WorktreeSnapshotSettings } = {},
) {
	const manager = await SessionManager.create(await sqlStore(), cwd);
	const unavailable: WorktreeSnapshotUnavailable[] = [];
	const recorder = new SessionWorktreeSnapshotRecorder({
		sessionManager: manager,
		cwd: () => cwd,
		settings: () => options.settings ?? DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
		declaresWrites: options.declaresWrites ?? (() => false),
		onUnavailable: (reason) => unavailable.push(reason),
	});
	return { manager, recorder, unavailable };
}

const calling = (...calls: Array<[string, Record<string, string>]>) =>
	fauxAssistantMessage(
		calls.map(([name, args]) => fauxToolCall(name, args)),
		{ stopReason: "toolUse" },
	);

/** Counts the Git commands snapshot code runs from now until the test ends. */
function countGitCommands(): () => number {
	let count = 0;
	const executable = sandbox.executable;
	const previous = setWorktreeSnapshotGit(async () => {
		count++;
		return executable;
	});
	cleanups.push(() => {
		setWorktreeSnapshotGit(previous);
	});
	return () => count;
}

describe("turns the recorder itself declines", () => {
	test("a turn of an in-memory session records nothing, reports nothing and runs no Git command", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const manager = SessionManager.inMemory(clone);
		const unavailable: WorktreeSnapshotUnavailable[] = [];
		const recorder = new SessionWorktreeSnapshotRecorder({
			sessionManager: manager,
			cwd: () => clone,
			settings: () => DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
			declaresWrites: () => false,
			onUnavailable: (reason) => unavailable.push(reason),
		});
		const commands = countGitCommands();
		await recorder.recordTurn(calling(["write", { path: join(clone, "a.txt"), content: "a" }]));
		assert.equal(commands(), 0);
		assert.deepEqual(unavailable, []);
		assert.equal(snapshotEntries(manager).length, 0);
	});

	test("a turn of a persisted session with snapshots disabled runs no Git command", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const { manager, recorder, unavailable } = await recorderFor(clone, {
			settings: { ...DEFAULT_WORKTREE_SNAPSHOT_SETTINGS, enabled: false },
		});
		const commands = countGitCommands();
		await recorder.recordTurn(calling(["write", { path: join(clone, "a.txt"), content: "a" }]));
		assert.equal(commands(), 0);
		assert.deepEqual(unavailable, []);
		assert.equal(snapshotEntries(manager).length, 0);
	});
});

describe("which tool calls make a turn record", () => {
	test("a turn of only text records nothing, whatever the host says about tool names", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const { manager, recorder, unavailable } = await recorderFor(clone, { declaresWrites: () => true });
		const message = fauxAssistantMessage("no tools were called");
		assert.equal(recorder.callsFileWritingTool(message), false);
		await recorder.recordTurn(message);
		assert.deepEqual(snapshotEntries(manager), []);
		assert.deepEqual(unavailable, []);
	});

	test("a path that names a checkout's own directory is recorded as a file of the directory above it", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const other = await sandbox.remoteWithClone("other");
		const { manager, recorder, unavailable } = await recorderFor(clone);
		await recorder.recordTurn(calling(["write", { path: other.clone, content: "x" }]));
		assert.deepEqual(
			snapshotEntries(manager).map((entry) => entry.root),
			[clone],
		);
		assert.deepEqual(
			unavailable.map((reason) => [reason.code, reason.fields.subject]),
			[["not-a-repository", sandbox.root]],
		);
	});

	test("a path whose directories do not exist yet, or run through a file, is recorded in the nearest checkout that does", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const missing = await sandbox.remoteWithClone("missing");
		const viaFile = await sandbox.remoteWithClone("via-file");
		const belowFile = await sandbox.remoteWithClone("below-file");
		const { manager, recorder, unavailable } = await recorderFor(clone);
		await recorder.recordTurn(
			calling(
				["edit", { path: join(missing.clone, "no", "such", "dir", "file.txt") }],
				["edit", { path: join(viaFile.clone, "README.md", "file.txt") }],
				["edit", { path: join(belowFile.clone, "README.md", "sub", "file.txt") }],
			),
		);
		assert.deepEqual(unavailable, []);
		assert.deepEqual(
			snapshotEntries(manager)
				.map((entry) => entry.root)
				.sort(),
			[clone, missing.clone, viaFile.clone, belowFile.clone].sort(),
		);
	});
});

describe("failures a turn reports or lets through", () => {
	test.skipIf(process.platform === "win32")(
		"a directory the filesystem cannot resolve is reported once as unreadable-path, and the session's checkout is still captured",
		async () => {
			const { clone } = await sandbox.remoteWithClone();
			symlinkSync("loop", join(clone, "loop"));
			const { recorder, unavailable, manager } = await recorderFor(clone);
			await recorder.recordTurn(calling(["edit", { path: join(clone, "loop", "file.txt") }]));
			await recorder.recordTurn(calling(["edit", { path: join(clone, "loop", "other.txt") }]));
			assert.equal(unavailable.length, 1);
			assertUnreadablePath(unavailable[0], join(clone, "loop"), "ELOOP");
			assert.deepEqual(
				snapshotEntries(manager).map((entry) => entry.root),
				[clone, clone],
			);
		},
	);

	test.skipIf(process.platform === "win32")(
		"a Git that fails while the checkout is being located is reported as a typed reason once",
		async () => {
			const { clone } = await sandbox.remoteWithClone();
			const failing = sandbox.path("failing-git");
			writeFileSync(failing, "#!/bin/sh\nexit 3\n");
			chmodSync(failing, 0o755);
			const { recorder, unavailable } = await recorderFor(clone);
			const previous = setWorktreeSnapshotGit(async () => ({ path: failing, env: {} }));
			try {
				await recorder.recordTurn(calling(["write", { path: join(clone, "a.txt"), content: "a" }]));
				await recorder.recordTurn(calling(["write", { path: join(clone, "b.txt"), content: "b" }]));
			} finally {
				setWorktreeSnapshotGit(previous);
			}
			assert.equal(unavailable.length, 1);
			assert.ok(isWorkspaceGitError(unavailable[0]));
			assert.equal(unavailable[0].code, "git-failed");
		},
	);

	test("a capture that is rejected for its settings is reported as a typed reason once, and records nothing", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const invalid = { ...DEFAULT_WORKTREE_SNAPSHOT_SETTINGS, maxFileBytes: -1 };
		const { manager, recorder, unavailable } = await recorderFor(clone, { settings: invalid });
		await recorder.recordTurn(calling(["write", { path: join(clone, "a.txt"), content: "a" }]));
		await recorder.recordTurn(calling(["write", { path: join(clone, "b.txt"), content: "b" }]));
		assert.equal(unavailable.length, 1);
		const [reason] = unavailable;
		assert.ok(isWorkspaceConfigError(reason));
		assert.equal(reason.code, "invalid-setting");
		assert.equal(reason.fields.field, "settings.maxFileBytes");
		assert.deepEqual(snapshotEntries(manager), []);
	});
});

async function recordedSession(store?: SessionStore) {
	const { clone } = await sandbox.remoteWithClone("repo", { "a.txt": "one\n" });
	writeFileSync(join(clone, "a.txt"), "recorded\n");
	const sessions = store ?? (await sqlStore());
	const manager = await SessionManager.create(sessions, clone);
	const capture = await captureWorktreeSnapshot(clone, { blobs: sessions.snapshotBlobs });
	assert.equal(capture.status, "captured");
	if (capture.status !== "captured") throw new Error("unreachable");
	await manager.appendWorktreeSnapshot(clone, capture.snapshot.id, capture.snapshot);
	return { clone, manager, snapshot: capture.snapshot, sessions };
}

describe("resuming a session whose snapshot cannot be restored", () => {
	test("a storage that rejects with something that is not an Error is passed on as it is, not wrapped as drift", async () => {
		const real = await sqlStore();
		const failingBlobs: SnapshotBlobStore = {
			putBlobs: (blobs) => real.snapshotBlobs!.putBlobs(blobs),
			getBlob: async () => {
				throw "blob storage went away";
			},
			refreshBlobs: (hashes) => real.snapshotBlobs!.refreshBlobs(hashes),
			listBlobHashes: () => real.snapshotBlobs!.listBlobHashes(),
		};
		const store = new Proxy(real, {
			get(target, property) {
				if (property === "snapshotBlobs") return failingBlobs;
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const { clone, manager } = await recordedSession(store);
		writeFileSync(join(clone, "a.txt"), "drifted\n");
		await assert.rejects(
			resumeSessionWorktree(manager, {
				settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
				storeDir: sandbox.path("host"),
			}),
			(error: unknown) => error === "blob storage went away",
		);
	});
});

describe("snapshots recorded in a session", () => {
	test("a recorded id whose record the session does not hold never hides the checkout's earlier snapshot", () => {
		const record = { id: "s1", root: "/work/a", tree: "t1", chain: [], omitted: [], filters: null, bundle: null };
		const at = (id: string, parentId: string | null) => ({ id, parentId, timestamp: "2026-01-01T00:00:00.000Z" });
		const entries: FileEntry[] = [
			{
				type: "worktree_snapshot",
				...at("e1", null),
				root: "/work/a",
				snapshotId: "s1",
				snapshot: record as unknown as WorktreeSnapshot,
			},
			{ type: "worktree_snapshot", ...at("e2", "e1"), root: "/work/a", snapshotId: "ghost" },
		];
		const manager = SessionManager.inMemory("/work", undefined, entries);
		const latest = manager.getLatestWorktreeSnapshots();
		assert.deepEqual([...latest.keys()], ["/work/a"]);
		assert.equal(latest.get("/work/a")?.id, "s1");
	});
});

describe("what retention keeps for sessions", () => {
	test("collection keeps the latest snapshot of internal workflow-stage sessions, which ordinary listings leave out (#4355)", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "a.txt": "one\n" });
		const store = await sqlStore();
		const stage = await SessionManager.create(store, clone, {
			internal: true,
			workflow: { runId: "run-1", stageId: "stage-1", stageName: "implement" },
		});
		writeFileSync(join(clone, "a.txt"), "stage\n");
		const capture = await captureWorktreeSnapshot(clone, { blobs: store.snapshotBlobs });
		assert.equal(capture.status, "captured");
		if (capture.status !== "captured") throw new Error("unreachable");
		await stage.appendWorktreeSnapshot(clone, capture.snapshot.id, capture.snapshot);

		const standard: string[] = [];
		for await (const summary of store.list({})) standard.push(summary.id);
		assert.deepEqual(standard, [], "the stage session is internal: ordinary listings leave it out");

		assert.deepEqual((await collectSnapshotGarbage(store.snapshotBlobs, { graceSeconds: 0 })).deleted, []);
		assert.deepEqual(await store.snapshotBlobs.listBlobHashes(), snapshotBlobHashes(capture.snapshot));
	});

	test("a snapshot recorded once and referenced again stays retained, and a reference without a record retains nothing", async () => {
		const sessions = await sqlStore();
		const { clone, manager, snapshot } = await recordedSession(sessions);
		await manager.appendWorktreeSnapshot(clone, snapshot.id);
		const ghost: WorktreeSnapshotEntry = {
			type: "worktree_snapshot",
			id: "ghost-entry",
			parentId: manager.getLeafId(),
			timestamp: new Date().toISOString(),
			root: sandbox.path("elsewhere"),
			snapshotId: "ghost",
		};
		const { lastSeq } = await sessions.load(manager.getSessionId());
		await sessions.append(manager.getSessionId(), [ghost as SessionEntry], { expectSeq: lastSeq });

		const orphan = { hash: "f".repeat(64), data: new Uint8Array([1]) };
		await sessions.snapshotBlobs.putBlobs([orphan]);
		assert.deepEqual((await collectSnapshotGarbage(sessions.snapshotBlobs, { graceSeconds: 0 })).deleted, [
			orphan.hash,
		]);
		assert.deepEqual(await sessions.snapshotBlobs.listBlobHashes(), snapshotBlobHashes(snapshot));
	});
});

describe("adopting the blobs an exported session carries", () => {
	test("entries that carry no blobs come back as the very same objects", async () => {
		const { clone, snapshot, sessions } = await recordedSession();
		const patch = snapshot.chain[0]?.patch;
		assert.ok(patch);
		const data = await sessions.snapshotBlobs?.getBlob(patch);
		assert.ok(data);
		const at = (id: string, parentId: string | null) => ({ id, parentId, timestamp: "2026-01-01T00:00:00.000Z" });
		const carrying: SessionEntry = {
			type: "worktree_snapshot",
			...at("e1", null),
			root: clone,
			snapshotId: snapshot.id,
			snapshot,
			blobs: { [patch]: Buffer.from(data).toString("base64") },
		};
		const bare: SessionEntry = { type: "worktree_snapshot", ...at("e2", "e1"), root: clone, snapshotId: snapshot.id };
		const message: SessionEntry = {
			type: "message",
			...at("e3", "e2"),
			message: { role: "user", content: "hello", timestamp: 1 },
		};
		const store = new MemorySnapshotBlobStore();
		const adopted = await adoptInlineSnapshotBlobs([carrying, bare, message], store);
		assert.equal(adopted[1], bare);
		assert.equal(adopted[2], message);
		assert.equal(Object.hasOwn(adopted[0] as object, "blobs"), false);
		assert.deepEqual(await store.listBlobHashes(), [patch]);
	});
});
