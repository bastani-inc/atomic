import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox, loseSnapshotBlobs } from "../../../test/helpers/worktree-snapshot.js";
import type { WorktreeSnapshotEntry } from "../src/core/session-manager.js";
import { SessionManager } from "../src/core/session-manager.js";
import { describeWorktreeRestoreStatus, worktreeRestoreNotices } from "../src/core/session-worktree-snapshots.js";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import type { SessionStore } from "../src/core/storage/session/types.js";
import type { SqlSnapshotBlobStore } from "../src/core/worktree-snapshot/blob-store.js";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.js";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.js";
import type { WorktreeSnapshot } from "../src/core/worktree-snapshot/types.js";
import {
	isWorkspaceRestoreError,
	type PreparedSessionResume,
	type PrepareSessionResumeOptions,
	prepareSessionResume,
	setWorktreeSnapshotGit,
} from "../src/index.js";

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

async function sqlStore(name: string): Promise<SessionStore> {
	const database = await openNodeSqliteDatabase(sandbox.path(`${name}.sqlite`));
	const store = await SqlSessionStore.open(database);
	cleanups.push(async () => {
		await store.close();
		await database.close();
	});
	return store;
}

/** A session on "machine A" whose last turn recorded a snapshot of `root`. */
async function recordSession(root: string): Promise<{ manager: SessionManager; snapshot: WorktreeSnapshot }> {
	const store = await sqlStore("sessions");
	const manager = await SessionManager.create(store, root);
	await manager.appendMessage({ role: "user", content: "edit the files", timestamp: Date.now() });
	const capture = await captureWorktreeSnapshot(root, { settings, blobs: store.snapshotBlobs });
	assert.equal(capture.status, "captured");
	if (capture.status !== "captured") throw new Error("unreachable");
	await manager.appendWorktreeSnapshot(root, capture.snapshot.id, capture.snapshot);
	return { manager, snapshot: capture.snapshot };
}

/** A clone whose `main` is pushed, with an unpushed commit and an uncommitted edit on top. */
async function editedClone() {
	const { remote, clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n" });
	const pushed = await sandbox.git(clone, "rev-parse", "HEAD");
	sandbox.write(join(clone, "committed.txt"), "unpushed\n");
	const head = await sandbox.commitAll(clone, "unpushed commit");
	sandbox.write(join(clone, "README.md"), "edited\n");
	return { remote, clone, pushed, head };
}

function options(overrides: Partial<PrepareSessionResumeOptions> = {}): PrepareSessionResumeOptions {
	return {
		entryPoint: "cli",
		launchCwd: sandbox.root,
		settings,
		storeDir: sandbox.path("host"),
		blueprint: { agentDir: sandbox.path("agent"), trusted: () => false },
		...overrides,
	};
}

function ready(prepared: PreparedSessionResume): Extract<PreparedSessionResume, { status: "ready" }> {
	assert.equal(prepared.status, "ready");
	return prepared as Extract<PreparedSessionResume, { status: "ready" }>;
}

describe("a resume whose snapshot cannot be fully restored still opens the session (#4733)", () => {
	test("a missing bundle restores the closest pushed commit, with one notice naming what is missing (#4733)", async () => {
		const { clone, pushed, head } = await editedClone();
		const { manager, snapshot } = await recordSession(clone);
		await loseSnapshotBlobs(manager.getSessionStore().snapshotBlobs as SqlSnapshotBlobStore, [snapshot.bundle!.blob]);
		renameSync(clone, sandbox.path("machine-a-gone"));

		const prepared = ready(await prepareSessionResume(manager, options()));

		const restored = prepared.sessionManager.getWorktreeRootMappings().at(-1)!;
		assert.equal(prepared.sessionManager.getCwd(), restored.to);
		assert.equal(await sandbox.git(restored.to, "rev-parse", "HEAD"), pushed);
		assert.equal(readFileSync(join(restored.to, "README.md"), "utf8"), "hello\n");
		assert.equal(existsSync(join(restored.to, "committed.txt")), false);
		assert.equal(prepared.notices.length, 1, JSON.stringify(prepared.notices));
		const [notice] = prepared.notices;
		assert.ok(notice!.message.includes(pushed.slice(0, 12)), notice!.message);
		assert.ok(notice!.message.includes(head.slice(0, 12)), notice!.message);
		assert.doesNotMatch(notice!.message, /fail/i);
		assert.equal(restored.degraded?.stage, "closest-commit");
		assert.equal(restored.degraded?.head, pushed);
	});

	test("a missing change set restores the recorded commit with the change sets before it, each whole (#4733)", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n", "src.txt": "one\n" });
		const head = await sandbox.git(clone, "rev-parse", "HEAD");
		sandbox.write(join(clone, "README.md"), "first edit\n");
		const { manager, snapshot: first } = await recordSession(clone);
		sandbox.write(join(clone, "src.txt"), "two\n");
		sandbox.write(join(clone, "notes.txt"), "second edit\n");
		const blobs = manager.getSessionStore().snapshotBlobs as SqlSnapshotBlobStore;
		const second = await captureWorktreeSnapshot(clone, { settings, blobs, previous: first });
		assert.equal(second.status, "captured");
		if (second.status !== "captured") return;
		assert.equal(second.snapshot.chain.length, 2);
		await manager.appendWorktreeSnapshot(clone, second.snapshot.id, second.snapshot);
		await loseSnapshotBlobs(blobs, [second.snapshot.chain[1]!.patch!]);
		renameSync(clone, sandbox.path("machine-a-gone"));

		const prepared = ready(await prepareSessionResume(manager, options()));

		const restored = prepared.sessionManager.getWorktreeRootMappings().at(-1)!;
		assert.equal(await sandbox.git(restored.to, "rev-parse", "HEAD"), head);
		assert.equal(readFileSync(join(restored.to, "README.md"), "utf8"), "first edit\n");
		assert.equal(
			readFileSync(join(restored.to, "src.txt"), "utf8"),
			"one\n",
			"the missing change set is left out whole",
		);
		assert.equal(existsSync(join(restored.to, "notes.txt")), false);
		assert.equal(restored.degraded?.stage, "partial-changes");
		assert.deepEqual(restored.degraded?.missingLinks, [1]);
		assert.equal(prepared.notices.length, 1, JSON.stringify(prepared.notices));
		assert.match(prepared.notices[0]!.message, /1 of the 2 change sets/);
		assert.match(prepared.notices[0]!.message, /change set 1/);
		assert.doesNotMatch(prepared.notices[0]!.message, /fail/i);
	});

	test("a later capture in a partly restored worktree records what it holds, never the original tree (#4733)", async () => {
		const { clone } = await editedClone();
		const { manager, snapshot } = await recordSession(clone);
		const blobs = manager.getSessionStore().snapshotBlobs as SqlSnapshotBlobStore;
		await loseSnapshotBlobs(blobs, [snapshot.bundle!.blob]);
		renameSync(clone, sandbox.path("machine-a-gone"));
		const prepared = ready(await prepareSessionResume(manager, options()));
		const restored = prepared.sessionManager.getWorktreeRootMappings().at(-1)!;

		const capture = await captureWorktreeSnapshot(restored.to, {
			settings,
			blobs,
			previous: prepared.sessionManager.getLatestWorktreeSnapshots().get(restored.to),
		});

		assert.equal(capture.status, "captured");
		if (capture.status !== "captured") return;
		assert.equal(capture.snapshot.tree, restored.degraded?.tree);
		assert.notEqual(capture.snapshot.tree, snapshot.tree);
		assert.equal(capture.snapshot.head, restored.degraded?.head);
	});

	test("/session snapshot and the /resume notices show the degraded restore once (#4733)", async () => {
		const { clone } = await editedClone();
		const { manager, snapshot } = await recordSession(clone);
		await loseSnapshotBlobs(manager.getSessionStore().snapshotBlobs as SqlSnapshotBlobStore, [snapshot.bundle!.blob]);
		renameSync(clone, sandbox.path("machine-a-gone"));
		const since = new Date().toISOString();
		const prepared = ready(await prepareSessionResume(manager, options()));
		const restored = prepared.sessionManager.getWorktreeRootMappings().at(-1)!;

		const notices = worktreeRestoreNotices(prepared.sessionManager, since);
		assert.deepEqual(notices, prepared.notices);
		assert.equal(describeWorktreeRestoreStatus(prepared.sessionManager, restored.to), notices[0]!.message);
	});

	test("a checkout whose snapshot record is missing is left out with a notice, and the others are restored (#4733)", async () => {
		const { clone } = await editedClone();
		const { manager } = await recordSession(clone);
		const other = await sandbox.remoteWithClone("other", { "README.md": "other\n" });
		const ghost: WorktreeSnapshotEntry = {
			type: "worktree_snapshot",
			id: "ghost-entry",
			parentId: manager.getLeafId(),
			timestamp: new Date().toISOString(),
			root: other.clone,
			snapshotId: "0123456789abcdef0123456789abcdef",
		};
		const store = manager.getSessionStore();
		const { lastSeq } = await store.load(manager.getSessionId());
		await store.append(manager.getSessionId(), [ghost], { expectSeq: lastSeq });
		const reopened = await SessionManager.open(store, manager.getSessionId());
		renameSync(clone, sandbox.path("machine-a-gone"));

		const prepared = ready(await prepareSessionResume(reopened, options()));

		const restored = prepared.sessionManager.getWorktreeRootMappings();
		assert.deepEqual(
			restored.map((mapping) => mapping.from),
			[clone],
		);
		const warnings = prepared.notices.filter((notice) => notice.type === "warning");
		assert.equal(warnings.length, 1, JSON.stringify(prepared.notices));
		assert.match(warnings[0]!.message, /holds no record of its snapshot 0123456789ab/);
		assert.ok(warnings[0]!.message.includes(other.clone));
	});

	for (const remote of ["https://user:token@example.invalid/repo.git", "ext::sh -c touch% /tmp/pwned"]) {
		test(`a snapshot record naming ${remote.startsWith("ext") ? "a remote helper" : "a credentialed remote"} refuses the resume (#4733)`, async () => {
			const { clone } = await editedClone();
			const { manager, snapshot } = await recordSession(clone);
			const unsafe = { ...snapshot, remotes: [remote] };
			await manager.appendWorktreeSnapshot(clone, unsafe.id, unsafe);
			renameSync(clone, sandbox.path("machine-a-gone"));
			await assert.rejects(prepareSessionResume(manager, options()), (error: unknown) => {
				assert.ok(isWorkspaceRestoreError(error), String(error));
				assert.deepEqual([error.code, error.reason], ["invalid-snapshot", "unsafe-remote"]);
				return true;
			});
			assert.deepEqual(manager.getWorktreeRootMappings(), []);
			assert.equal(existsSync(sandbox.path("host", "worktrees")), false);
		});
	}

	test("a healthy three-machine resume chain shows no degraded notice (#4733)", async () => {
		const { remote, clone } = await sandbox.remoteWithClone("chain", { "README.md": "hello\n" });
		sandbox.write(join(clone, ".env.example"), "TOKEN=placeholder\n");
		await sandbox.commitAll(clone, "pushed example environment");
		await sandbox.git(clone, "push", "-q", "origin", "HEAD:main");
		sandbox.write(join(clone, "README.md"), "edited on machine A\n");
		const { manager } = await recordSession(clone);
		renameSync(clone, sandbox.path("machine-a-gone"));

		const onB = ready(await prepareSessionResume(manager, options({ storeDir: sandbox.path("machine-b") })));
		const b = onB.sessionManager.getWorktreeRootMappings().at(-1)!;
		assert.equal(b.degraded, undefined);
		sandbox.write(join(b.to, "src.txt"), "machine B\n");
		const unpushed = await sandbox.commitAll(b.to, "work on machine B");
		const blobs = onB.sessionManager.getSessionStore().snapshotBlobs!;
		const captured = await captureWorktreeSnapshot(b.to, { settings, blobs });
		assert.equal(captured.status, "captured");
		if (captured.status !== "captured") return;
		assert.deepEqual(captured.snapshot.remotes, [remote]);
		assert.deepEqual(captured.snapshot.bundle?.commits, [unpushed]);
		await onB.sessionManager.appendWorktreeSnapshot(b.to, captured.snapshot.id, captured.snapshot);
		rmSync(b.to, { recursive: true, force: true });

		const onC = ready(
			await prepareSessionResume(onB.sessionManager, options({ storeDir: sandbox.path("machine-c") })),
		);
		const c = onC.sessionManager.getWorktreeRootMappings().at(-1)!;
		assert.equal(c.degraded, undefined);
		assert.equal(await sandbox.git(c.to, "rev-parse", "HEAD"), unpushed);
		for (const prepared of [onB, onC]) {
			assert.deepEqual(
				prepared.notices.filter((notice) => notice.type === "warning"),
				[],
			);
		}
	});

	test("the next resume retries the snapshot of a partly restored worktree the session has not worked in (#4733)", async () => {
		const { clone, head } = await editedClone();
		const { manager, snapshot } = await recordSession(clone);
		const blobs = manager.getSessionStore().snapshotBlobs as SqlSnapshotBlobStore;
		const bundle = (await blobs.getBlob(snapshot.bundle!.blob))!;
		await loseSnapshotBlobs(blobs, [snapshot.bundle!.blob]);
		renameSync(clone, sandbox.path("machine-a-gone"));
		const first = ready(await prepareSessionResume(manager, options()));
		assert.equal(first.sessionManager.getWorktreeRootMappings().at(-1)?.degraded?.stage, "closest-commit");

		await blobs.putBlobs([{ hash: snapshot.bundle!.blob, data: bundle }]);
		const again = ready(await prepareSessionResume(first.sessionManager, options()));

		const restored = again.sessionManager.getWorktreeRootMappings().at(-1)!;
		assert.equal(restored.degraded, undefined);
		assert.equal(again.sessionManager.getCwd(), restored.to);
		assert.equal(await sandbox.git(restored.to, "rev-parse", "HEAD"), head);
		assert.equal(readFileSync(join(restored.to, "README.md"), "utf8"), "edited\n");
	});

	test("a session whose only snapshot record is missing opens in the launch directory with one notice (#4733)", async () => {
		const store = await sqlStore("sessions");
		const gone = sandbox.path("gone");
		const manager = await SessionManager.create(store, gone);
		await manager.appendMessage({ role: "user", content: "edit", timestamp: Date.now() });
		const ghost: WorktreeSnapshotEntry = {
			type: "worktree_snapshot",
			id: "ghost-entry",
			parentId: manager.getLeafId(),
			timestamp: new Date().toISOString(),
			root: gone,
			snapshotId: "0123456789abcdef0123456789abcdef",
		};
		const { lastSeq } = await store.load(manager.getSessionId());
		await store.append(manager.getSessionId(), [ghost], { expectSeq: lastSeq });
		const reopened = await SessionManager.open(store, manager.getSessionId());

		const prepared = ready(await prepareSessionResume(reopened, options()));

		assert.equal(prepared.sessionManager.getCwd(), sandbox.root);
		assert.equal(prepared.notices.length, 1, JSON.stringify(prepared.notices));
		assert.match(prepared.notices[0]!.message, /holds no record of its snapshot 0123456789ab/);
	});

	test("a branch name Git accepts, such as feature/c++, gives its own tip, not the default branch's (#4733)", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n" });
		await sandbox.git(clone, "checkout", "-q", "-b", "feature/c++");
		sandbox.write(join(clone, "feature.txt"), "on the feature branch\n");
		const tip = await sandbox.commitAll(clone, "pushed feature work");
		await sandbox.git(clone, "push", "-q", "origin", "HEAD:refs/heads/feature/c++");
		sandbox.write(join(clone, "local.txt"), "unpushed\n");
		await sandbox.commitAll(clone, "unpushed feature work");
		const { manager, snapshot } = await recordSession(clone);
		assert.equal(snapshot.branch, "feature/c++");
		await loseSnapshotBlobs(manager.getSessionStore().snapshotBlobs as SqlSnapshotBlobStore, [snapshot.bundle!.blob]);
		renameSync(clone, sandbox.path("machine-a-gone"));

		const prepared = ready(await prepareSessionResume(manager, options()));

		const restored = prepared.sessionManager.getWorktreeRootMappings().at(-1)!;
		assert.equal(restored.degraded?.basis, "branch-tip");
		assert.equal(await sandbox.git(restored.to, "rev-parse", "HEAD"), tip);
		assert.equal(readFileSync(join(restored.to, "feature.txt"), "utf8"), "on the feature branch\n");
	});

	test("a partly restored worktree edited by hand stays the session's checkout on the next resume (#4733)", async () => {
		const { clone } = await editedClone();
		const { manager, snapshot } = await recordSession(clone);
		const blobs = manager.getSessionStore().snapshotBlobs as SqlSnapshotBlobStore;
		const bundle = (await blobs.getBlob(snapshot.bundle!.blob))!;
		await loseSnapshotBlobs(blobs, [snapshot.bundle!.blob]);
		renameSync(clone, sandbox.path("machine-a-gone"));
		const first = ready(await prepareSessionResume(manager, options()));
		const partial = first.sessionManager.getWorktreeRootMappings().at(-1)!;
		sandbox.write(join(partial.to, "README.md"), "edited by hand in the partial worktree\n");

		await blobs.putBlobs([{ hash: snapshot.bundle!.blob, data: bundle }]);
		const again = ready(await prepareSessionResume(first.sessionManager, options()));

		assert.equal(again.sessionManager.getCwd(), partial.to);
		assert.equal(
			again.sessionManager.getWorktreeRootMappings().length,
			first.sessionManager.getWorktreeRootMappings().length,
		);
		assert.equal(readFileSync(join(partial.to, "README.md"), "utf8"), "edited by hand in the partial worktree\n");
	});

	test.skipIf(process.platform === "win32")(
		"a resume compares a partly restored worktree with what it restored once, however many checkouts it checks (#4733)",
		async () => {
			const { clone } = await editedClone();
			const { manager, snapshot } = await recordSession(clone);
			const blobs = manager.getSessionStore().snapshotBlobs as SqlSnapshotBlobStore;
			const others: string[] = [];
			for (const name of ["second", "third"]) {
				const other = (await sandbox.remoteWithClone(name, { "README.md": `${name}\n` })).clone;
				const captured = await captureWorktreeSnapshot(other, { settings, blobs });
				if (captured.status !== "captured") throw new Error(captured.status);
				await manager.appendWorktreeSnapshot(other, captured.snapshot.id, captured.snapshot);
				others.push(other);
			}
			await loseSnapshotBlobs(blobs, [snapshot.bundle!.blob]);
			renameSync(clone, sandbox.path("machine-a-gone"));
			const first = ready(await prepareSessionResume(manager, options()));
			const partial = first.sessionManager.getWorktreeRootMappings().find((mapping) => mapping.degraded)!;
			for (const other of others) sandbox.write(join(other, "README.md"), "changed here since\n");

			const log = sandbox.path("git.log");
			const wrapper = sandbox.path("git-logging");
			writeFileSync(wrapper, `#!/bin/sh\nprintf '%s %s\\n' "$PWD" "$*" >> "${log}"\nexec git "$@"\n`);
			chmodSync(wrapper, 0o755);
			setWorktreeSnapshotGit(async () => ({ ...sandbox.executable, path: wrapper }));
			ready(await prepareSessionResume(first.sessionManager, options()));

			const comparisons = readFileSync(log, "utf8")
				.split("\n")
				.filter(
					(line) =>
						line.startsWith(`${realpathSync(partial.to)} `) &&
						line.includes(`read-tree --reset ${partial.degraded!.tree}`),
				);
			assert.equal(comparisons.length, 1, `${comparisons.length} comparisons`);
		},
	);
});
