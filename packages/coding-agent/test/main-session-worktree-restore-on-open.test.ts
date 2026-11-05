import assert from "node:assert/strict";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { assertUnreadablePath, GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { parseArgs } from "../src/cli/args.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { openSessionInWorktree, sessionRestoresOnOpen } from "../src/core/session-worktree-snapshots.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.ts";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.ts";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.ts";
import { createSessionManager } from "../src/main-session.ts";

const prompts = vi.hoisted(() => ({ asked: [] as string[] }));
vi.mock("node:readline", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:readline")>();
	return {
		...actual,
		createInterface: () => ({
			question: (question: string, answer: (value: string) => void) => {
				prompts.asked.push(question);
				answer("y");
			},
			close() {},
		}),
	};
});

let sandbox: GitSandbox;
let store: SqlSessionStore;
let database: Awaited<ReturnType<typeof openNodeSqliteDatabase>>;
beforeEach(async () => {
	sandbox = new GitSandbox();
	prompts.asked.length = 0;
	database = await openNodeSqliteDatabase(sandbox.path("sessions.sqlite"));
	store = await SqlSessionStore.open(database);
});
afterEach(async () => {
	await store.close();
	await database.close();
	sandbox.dispose();
});

/** A session that recorded an untracked file and an unpushed commit in `clone`, and a second clone elsewhere. */
async function recordedElsewhere() {
	const { remote, clone } = await sandbox.remoteWithClone();
	sandbox.write(join(clone, "committed.txt"), "unpushed\n");
	const head = await sandbox.commitAll(clone, "unpushed work");
	writeFileSync(join(clone, "recorded.txt"), "recorded\n");
	const manager = await SessionManager.create(store, clone);
	const capture = await captureWorktreeSnapshot(clone, { blobs: store.snapshotBlobs });
	if (capture.status !== "captured") throw new Error("expected a snapshot");
	await manager.appendWorktreeSnapshot(clone, capture.snapshot.id, capture.snapshot);
	const other = sandbox.path("other-clone");
	await sandbox.git(sandbox.root, "clone", "-q", remote, other);
	return { clone, other, head, sessionId: manager.getSessionId() };
}

const openBySessionId = (sessionId: string, cwd: string) =>
	createSessionManager(parseArgs(["--session", sessionId]), cwd, undefined, SettingsManager.inMemory(), store);

describe("--session <id> from another checkout (#4245)", () => {
	test("a session whose checkout is gone from this host opens without a fork prompt and continues in its restore", async () => {
		const { clone, other, head, sessionId } = await recordedElsewhere();
		rmSync(clone, { recursive: true, force: true });
		const opened = await openBySessionId(sessionId, other);
		assert.deepEqual(prompts.asked, []);
		assert.equal(opened.getSessionId(), sessionId);
		const resumed = await openSessionInWorktree(opened, {
			settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
			storeDir: sandbox.path("host"),
		});
		const [mapping] = resumed.sessionManager.getWorktreeRootMappings();
		assert.ok(mapping);
		assert.equal(mapping.from, clone);
		assert.equal(resumed.sessionManager.getCwd(), mapping.to);
		assert.equal(readFileSync(join(mapping.to, "recorded.txt"), "utf8"), "recorded\n");
		assert.equal(await sandbox.git(mapping.to, "rev-parse", "HEAD"), head);
	});

	test("a session whose checkout still exists on this host is offered as a fork into the current directory", async () => {
		const { other, sessionId } = await recordedElsewhere();
		const forked = await openBySessionId(sessionId, other);
		assert.deepEqual(prompts.asked, ["Fork this session into current directory? [y/N] "]);
		assert.notEqual(forked.getSessionId(), sessionId);
		assert.equal(forked.getCwd(), other);
	});
});

describe("whether opening a session restores its checkout here (#4245)", () => {
	test("only a missing working directory inside a recorded checkout qualifies", async () => {
		const { clone, sessionId } = await recordedElsewhere();
		assert.equal(await sessionRestoresOnOpen(store, sessionId), false, "the checkout exists here");
		rmSync(clone, { recursive: true, force: true });
		assert.equal(await sessionRestoresOnOpen(store, sessionId), true);

		const plain = await SessionManager.create(store, sandbox.path("gone"));
		await plain.appendSessionInfo("no snapshots");
		assert.equal(await sessionRestoresOnOpen(store, plain.getSessionId()), false, "nothing to restore");

		const { clone: nested } = await sandbox.remoteWithClone("nested");
		const parent = await SessionManager.create(store, sandbox.path("missing-parent"));
		const capture = await captureWorktreeSnapshot(nested, { blobs: store.snapshotBlobs });
		if (capture.status !== "captured") throw new Error("expected a snapshot");
		await parent.appendWorktreeSnapshot(nested, capture.snapshot.id, capture.snapshot);
		assert.equal(
			await sessionRestoresOnOpen(store, parent.getSessionId()),
			false,
			"the cwd is outside every checkout",
		);

		const empty = await SessionManager.create(store, sandbox.path("never-used"));
		assert.equal(await sessionRestoresOnOpen(store, empty.getSessionId()), false, "a session with no entries");
	});

	test("a working directory below what is now a file still needs restoring", async () => {
		const { clone } = await sandbox.remoteWithClone("files", { "src/a.txt": "a\n" });
		const manager = await SessionManager.create(store, join(clone, "src"));
		const capture = await captureWorktreeSnapshot(clone, { blobs: store.snapshotBlobs });
		if (capture.status !== "captured") throw new Error("expected a snapshot");
		await manager.appendWorktreeSnapshot(clone, capture.snapshot.id, capture.snapshot);
		rmSync(clone, { recursive: true, force: true });
		writeFileSync(clone, "a file where the checkout was\n");
		assert.equal(await sessionRestoresOnOpen(store, manager.getSessionId()), true);
	});

	test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"a working directory that cannot be checked fails as an unreadable path",
		async () => {
			const { clone, sessionId } = await recordedElsewhere();
			const parent = dirname(clone);
			chmodSync(parent, 0o000);
			try {
				await assert.rejects(sessionRestoresOnOpen(store, sessionId), (error: unknown) => {
					assertUnreadablePath(error, clone, "EACCES");
					return true;
				});
			} finally {
				chmodSync(parent, 0o755);
			}
		},
	);
});
