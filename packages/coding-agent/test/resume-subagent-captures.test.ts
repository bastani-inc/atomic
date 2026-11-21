/**
 * Resuming a session restores each checkout it works in from the newest capture of it among the session and its own
 * finished subagents, compared by when each was captured. Real Git checkouts, real worktree snapshots in a SQLite
 * session store; the subagents' sessions are internal sessions of that store, as the subagent tool creates them, and
 * the session's records name them as it records them.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { prepareSessionResume, sessionResumeOptions } from "../src/core/resume/session-resume.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.js";

useTemporaryAgentDir();

let sandbox: GitSandbox;
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
	sandbox = new GitSandbox();
	previousCapture = undefined;
});
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	sandbox.dispose();
});

async function project() {
	const { clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n" });
	const database = await openNodeSqliteDatabase(sandbox.path("sessions.sqlite"));
	const store = await SqlSessionStore.open(database);
	cleanups.push(async () => {
		await store.close();
		await database.close();
	});
	const parent = await SessionManager.create(store, clone);
	await parent.appendMessage({ role: "user", content: "coordinate", timestamp: Date.now() });
	return { clone, store, parent };
}

/** A turn's capture of `root` recorded in `manager`'s session, after every capture before it; resolves with its time. */
async function capture(manager: SessionManager, store: SqlSessionStore, root: string): Promise<string> {
	// Captures compared by time must not share one with the previous capture of the test.
	await waitPast(previousCapture);
	const previous = manager.getLatestWorktreeSnapshots().get(root);
	const captured = await captureWorktreeSnapshot(root, {
		blobs: store.snapshotBlobs,
		...(previous ? { previous } : {}),
	});
	assert.ok(captured.status === "captured" || captured.status === "unchanged", captured.status);
	await manager.appendWorktreeSnapshot(
		root,
		captured.snapshot.id,
		captured.status === "captured" ? captured.snapshot : undefined,
		undefined,
		[],
		undefined,
		1,
	);
	const at = manager.getBranch().findLast((entry) => entry.type === "worktree_snapshot")?.timestamp;
	assert.ok(at);
	previousCapture = at;
	return at;
}

let previousCapture: string | undefined;
async function waitPast(at: string | undefined): Promise<void> {
	if (at === undefined) return;
	await vi.waitFor(() => assert.ok(Date.now() > Date.parse(at)), { interval: 1 });
}

let launched = 0;
/** A subagent of `parent`, kept in its store, and the record the parent keeps of it once it finished. */
async function subagent(parent: SessionManager, store: SqlSessionStore, cwd: string) {
	const child = await SessionManager.create(store, cwd, { internal: true });
	const index = launched++;
	return {
		child,
		finished: (worktreeCapturedAt?: string, owner: SessionManager = parent) =>
			owner.appendCustomEntry("subagent-child", {
				version: 1,
				childId: `run:${index}`,
				runId: "run",
				index,
				agent: "helper",
				cwd,
				state: "terminal",
				terminalStatus: "ok",
				owner: { kind: "session", sessionId: parent.getSessionId() },
				childSessionId: child.getSessionId(),
				...(worktreeCapturedAt === undefined ? {} : { worktreeCapturedAt }),
			}),
	};
}

/** Resumes `parent` as a new process does, with its checkout `clone` moved away first when `elsewhere`. */
async function resume(store: SqlSessionStore, parent: SessionManager, clone: string, elsewhere: boolean) {
	if (elsewhere) renameSync(clone, `${clone}-moved-${launched}`);
	const reopened = await SessionManager.open(store, parent.getSessionId());
	const options = sessionResumeOptions(
		"cli",
		sandbox.root,
		sandbox.path("agent"),
		SettingsManager.inMemory(),
		() => true,
	);
	const prepared = await prepareSessionResume(reopened, { ...options, blueprints: "skip" });
	assert.equal(prepared.status, "ready");
	assert.ok(prepared.status === "ready");
	return prepared.sessionManager;
}

function content(cwd: string, file: string): string | undefined {
	const path = join(cwd, file);
	return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

test("a checkout the session never captured comes back as its subagent last captured it", async () => {
	const { clone, store, parent } = await project();
	const { child, finished } = await subagent(parent, store, clone);
	sandbox.write(join(clone, "work.txt"), "child\n");
	await finished(await capture(child, store, clone));

	const resumed = await resume(store, parent, clone, true);
	assert.equal(content(resumed.getCwd(), "work.txt"), "child\n");
});

test("the session's own capture after its subagent's keeps the checkout as the session left it, even when it wrote the same content back", async () => {
	const { clone, store, parent } = await project();
	sandbox.write(join(clone, "work.txt"), "parent\n");
	await capture(parent, store, clone);
	const { child, finished } = await subagent(parent, store, clone);
	sandbox.write(join(clone, "work.txt"), "child\n");
	const childAt = await capture(child, store, clone);
	sandbox.write(join(clone, "work.txt"), "parent\n");
	await capture(parent, store, clone);
	await finished(childAt);

	const resumed = await resume(store, parent, clone, true);
	assert.equal(content(resumed.getCwd(), "work.txt"), "parent\n");
});

test("of two subagents that captured the same checkout, the later capture is restored", async () => {
	const { clone, store, parent } = await project();
	sandbox.write(join(clone, "work.txt"), "parent\n");
	await capture(parent, store, clone);
	const first = await subagent(parent, store, clone);
	const second = await subagent(parent, store, clone);
	sandbox.write(join(clone, "work.txt"), "first\n");
	const firstAt = await capture(first.child, store, clone);
	sandbox.write(join(clone, "work.txt"), "second\n");
	const secondAt = await capture(second.child, store, clone);
	// The later subagent finished first: the order records arrive in does not decide.
	await second.finished(secondAt);
	await first.finished(firstAt);

	const resumed = await resume(store, parent, clone, true);
	assert.equal(content(resumed.getCwd(), "work.txt"), "second\n");
});

test("a later subagent capture found on a later resume replaces one an earlier resume restored", async () => {
	const { clone, store, parent } = await project();
	const first = await subagent(parent, store, clone);
	const second = await subagent(parent, store, clone);
	sandbox.write(join(clone, "work.txt"), "first\n");
	const firstAt = await capture(first.child, store, clone);
	sandbox.write(join(clone, "work.txt"), "second\n");
	const secondAt = await capture(second.child, store, clone);
	await first.finished(firstAt);

	// The first resume knows only the first subagent's capture; the second resume knows both.
	const once = await resume(store, parent, clone, false);
	assert.equal(once.getLatestWorktreeSnapshots().size, 1);
	await second.finished(secondAt, once);
	const resumed = await resume(store, parent, clone, true);
	assert.equal(content(resumed.getCwd(), "work.txt"), "second\n");
});

test("a capture an earlier resume took stays the checkout's latest after its subagent's session is gone", async () => {
	const { clone, store, parent } = await project();
	const first = await subagent(parent, store, clone);
	const second = await subagent(parent, store, clone);
	sandbox.write(join(clone, "work.txt"), "first\n");
	await first.finished(await capture(first.child, store, clone));
	sandbox.write(join(clone, "work.txt"), "second\n");
	await second.finished(await capture(second.child, store, clone));

	await resume(store, parent, clone, false);
	await store.delete(second.child.getSessionId());
	const resumed = await resume(store, parent, clone, true);
	assert.equal(content(resumed.getCwd(), "work.txt"), "second\n");
});

test("a subagent recorded on a branch the session left is not taken", async () => {
	const { clone, store, parent } = await project();
	const before = parent.getLeafId();
	assert.ok(before);
	const { child, finished } = await subagent(parent, store, clone);
	sandbox.write(join(clone, "work.txt"), "child\n");
	await finished(await capture(child, store, clone));
	await parent.branch(before);
	await parent.appendMessage({ role: "user", content: "another way", timestamp: Date.now() });

	const resumed = await resume(store, parent, clone, false);
	assert.equal(resumed.getLatestWorktreeSnapshots().size, 0);
});

test("a subagent's named worktree stays its own: the session's resume does not take it", async () => {
	const { clone, store, parent } = await project();
	const worktree = sandbox.path("named");
	await sandbox.git(clone, "worktree", "add", "-q", "-b", "named", worktree);
	const { child, finished } = await subagent(parent, store, worktree);
	sandbox.write(join(worktree, "work.txt"), "named\n");
	await finished(await capture(child, store, worktree));

	const resumed = await resume(store, parent, clone, false);
	assert.equal(resumed.getLatestWorktreeSnapshots().size, 0);
	assert.equal(content(clone, "work.txt"), undefined);
});

test("a subagent whose session is gone leaves the resume as the session's own", async () => {
	const { clone, store, parent } = await project();
	sandbox.write(join(clone, "work.txt"), "parent\n");
	await capture(parent, store, clone);
	const { child, finished } = await subagent(parent, store, clone);
	sandbox.write(join(clone, "work.txt"), "child\n");
	await finished(await capture(child, store, clone));
	await store.delete(child.getSessionId());

	const resumed = await resume(store, parent, clone, true);
	assert.equal(content(resumed.getCwd(), "work.txt"), "parent\n");
});

test("a resume reads no subagent session when no finished subagent captured anything, and takes a capture once", async () => {
	const { clone, store, parent } = await project();
	const idle = await subagent(parent, store, clone);
	await idle.finished();
	const opened = vi.spyOn(SessionManager.prototype, "openSessionById");
	try {
		await resume(store, parent, clone, false);
		assert.equal(opened.mock.calls.length, 0, "no subagent session is opened");
	} finally {
		opened.mockRestore();
	}

	const { child, finished } = await subagent(parent, store, clone);
	sandbox.write(join(clone, "work.txt"), "child\n");
	await finished(await capture(child, store, clone));
	const once = await resume(store, parent, clone, false);
	const entries = (await store.load(parent.getSessionId())).entries.length;
	const twice = await resume(store, parent, clone, false);
	assert.equal((await store.load(parent.getSessionId())).entries.length, entries, "a second resume adds nothing");
	assert.deepEqual([...twice.getLatestWorktreeSnapshots().keys()], [...once.getLatestWorktreeSnapshots().keys()]);
});
