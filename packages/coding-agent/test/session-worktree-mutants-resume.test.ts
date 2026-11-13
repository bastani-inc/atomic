import assert from "node:assert/strict";
import { chmodSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	compareWorktreeSnapshot,
	mapRestoredPath,
	resumeSessionWorktree,
} from "../src/core/session-worktree-snapshots.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.ts";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.ts";
import {
	isWorkspaceGitError,
	isWorkspaceRestoreError,
	type WorkspaceGitError,
} from "../src/core/worktree-snapshot/errors.js";
import { setWorktreeSnapshotGit } from "../src/core/worktree-snapshot/git.ts";
import { verifyWorktree } from "../src/core/worktree-snapshot/restore.ts";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.ts";
import type { WorktreeRootMapping, WorktreeSnapshot } from "../src/core/worktree-snapshot/types.ts";

let sandbox: GitSandbox;
let store: SqlSessionStore;
let database: Awaited<ReturnType<typeof openNodeSqliteDatabase>>;
beforeEach(async () => {
	sandbox = new GitSandbox();
	database = await openNodeSqliteDatabase(sandbox.path("sessions.sqlite"));
	store = await SqlSessionStore.open(database);
});
afterEach(async () => {
	await store.close();
	await database.close();
	sandbox.dispose();
});

async function record(manager: SessionManager, root: string): Promise<WorktreeSnapshot> {
	const result = await captureWorktreeSnapshot(root, { blobs: store.snapshotBlobs });
	if (result.status !== "captured") throw new Error(`no snapshot of ${root}`);
	await manager.appendWorktreeSnapshot(root, result.snapshot.id, result.snapshot);
	return result.snapshot;
}

const options = () => ({ settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS, storeDir: sandbox.path("host") });

/** Every Git command runs as usual except the one that locates a restored worktree's store, so removing it fails. */
function failWorktreeRemoval(): void {
	const wrapper = sandbox.path("git-without-removal");
	writeFileSync(
		wrapper,
		'#!/bin/sh\nfor arg in "$@"; do\n\tif [ "$arg" = "--git-common-dir" ]; then echo "fatal: injected removal failure" >&2; exit 2; fi\ndone\nexec git "$@"\n',
	);
	chmodSync(wrapper, 0o755);
	setWorktreeSnapshotGit(async () => ({ path: wrapper, env: sandbox.executable.env }));
}

/** A clone whose only unpushed commit adds a denied file, so its snapshot cannot be restored exactly anywhere else. */
async function deniedHistory(name: string): Promise<string> {
	const { clone } = await sandbox.remoteWithClone(name);
	sandbox.write(join(clone, "private.pem"), "private\n");
	await sandbox.commitAll(clone, "denied history");
	return clone;
}

/**
 * Records `root` with a remote that holds credentials, as no capture writes: a record that fails the security
 * checks, whose restore refuses the resume rather than degrading it (#4733).
 */
async function recordUnsafe(manager: SessionManager, root: string): Promise<void> {
	const result = await captureWorktreeSnapshot(root, { blobs: store.snapshotBlobs });
	if (result.status !== "captured") throw new Error(`no snapshot of ${root}`);
	const unsafe = { ...result.snapshot, remotes: ["https://user:token@example.invalid/repo.git"] };
	await manager.appendWorktreeSnapshot(root, unsafe.id, unsafe);
}

/** The refusal of a resume whose record fails the security checks: `invalid-snapshot`, naming the unsafe remote. */
function assertRefusedRecord(error: unknown): void {
	assert.ok(isWorkspaceRestoreError(error), String(error));
	assert.equal(error.code, "invalid-snapshot");
	assert.equal(error.reason, "unsafe-remote");
}

function worktreeOf(snapshot: WorktreeSnapshot): string {
	const worktrees = join(options().storeDir, "worktrees");
	const match = readdirSync(worktrees).find((name) => name.startsWith(`${snapshot.id.slice(0, 12)}-`));
	assert.ok(match, `no restored worktree for ${snapshot.id}`);
	return join(worktrees, match);
}

function assertRemovalFailure(error: unknown, worktree: string): void {
	assert.ok(isWorkspaceGitError(error));
	assert.equal(error.code, "git-failed");
	assert.equal(error.cwd, worktree);
	assert.equal(error.exitCode, 2);
	assert.equal(error.detail, "fatal: injected removal failure");
}

describe("mapping a path through several restores (#4245)", () => {
	const at = (path: string) => resolve("/atomic-mapping-fixture", path);
	const mapping = (from: string, to: string): WorktreeRootMapping => ({
		from: at(from),
		to: at(to),
		snapshotId: "snap",
		tree: "tree",
		restoredAt: "2026-01-01T00:00:00.000Z",
	});

	test("a path in a nested repository follows that repository's restore, whichever was restored first", () => {
		assert.equal(
			mapRestoredPath(at("outer/inner/file"), [mapping("outer", "o"), mapping("outer/inner", "i")]),
			at("i/file"),
		);
		assert.equal(
			mapRestoredPath(at("outer/inner/file"), [mapping("outer/inner", "i"), mapping("outer", "o")]),
			at("i/file"),
		);
	});

	test("the first of two restores of one root moves the path, and the second no longer covers it", () => {
		assert.equal(
			mapRestoredPath(at("repo/file"), [mapping("repo", "first"), mapping("repo", "second")]),
			at("first/file"),
		);
	});
});

describe("the snapshot a resumed session reports (#4245)", () => {
	async function nested(): Promise<{ outer: string; inner: string }> {
		const outer = await sandbox.remoteWithClone("outer");
		const inner = await sandbox.remoteWithClone("inner");
		const nestedInner = join(outer.clone, "inner");
		await sandbox.git(sandbox.root, "clone", "-q", inner.remote, nestedInner);
		return { outer: outer.clone, inner: nestedInner };
	}

	for (const order of ["outer first", "inner first"] as const) {
		test(`a session in a nested repository reports that repository's snapshot when the ${order} was recorded`, async () => {
			const { outer, inner } = await nested();
			const manager = await SessionManager.create(store, inner);
			const roots = order === "outer first" ? [outer, inner] : [inner, outer];
			const snapshots = new Map<string, WorktreeSnapshot>();
			for (const root of roots) snapshots.set(root, await record(manager, root));
			const result = await resumeSessionWorktree(manager, options());
			assert.equal(result.status, "verified");
			if (result.status !== "verified") return;
			assert.equal(result.snapshot.id, snapshots.get(inner)!.id);
			assert.equal(result.cwd, inner);
		});
	}

	test("a session reports the snapshot of the repository it is in, not a longer sibling recorded after it", async () => {
		const a = await sandbox.remoteWithClone("a");
		const sibling = await sandbox.remoteWithClone("a-sibling-with-a-longer-name");
		sandbox.write(join(a.clone, "file.txt"), "recorded\n");
		const manager = await SessionManager.create(store, a.clone);
		const recorded = await record(manager, a.clone);
		await record(manager, sibling.clone);
		sandbox.write(join(a.clone, "file.txt"), "drifted\n");
		const result = await resumeSessionWorktree(manager, options());
		assert.equal(result.status, "restored");
		if (result.status !== "restored") return;
		assert.equal(result.snapshot.id, recorded.id);
		assert.equal(result.cwd, result.mappings[0]!.to);
		assert.deepEqual(result.warnings, []);
	});

	test("a session outside every recorded repository reports the last one recorded", async () => {
		const clones = [];
		for (const name of ["first", "second", "third"]) clones.push((await sandbox.remoteWithClone(name)).clone);
		const manager = await SessionManager.create(store, sandbox.root);
		const snapshots = [];
		for (const clone of clones) snapshots.push(await record(manager, clone));
		const result = await resumeSessionWorktree(manager, options());
		assert.equal(result.status, "verified");
		assert.equal(result.status === "verified" && result.snapshot.id, snapshots[2]!.id);
	});
});

describe.skipIf(process.platform === "win32")("rolling back restores whose removal fails (#4245)", () => {
	test("a successful rollback leaves the primary error without a cleanup cause", async () => {
		const a = await sandbox.remoteWithClone("a");
		const denied = await deniedHistory("b");
		const manager = await SessionManager.create(store, a.clone);
		await record(manager, a.clone);
		await recordUnsafe(manager, denied);
		renameSync(a.clone, sandbox.path("a-away"));
		renameSync(denied, sandbox.path("b-away"));
		await assert.rejects(resumeSessionWorktree(manager, options()), (error: unknown) => {
			assertRefusedRecord(error);
			assert.equal(Object.hasOwn(error, "cleanupCause"), false);
			return true;
		});
		assert.deepEqual(readdirSync(join(options().storeDir, "worktrees")), []);
	});

	test("one removal that fails is attached to the restore failure as its cleanup cause", async () => {
		const a = await sandbox.remoteWithClone("a");
		const denied = await deniedHistory("b");
		const manager = await SessionManager.create(store, a.clone);
		const restorable = await record(manager, a.clone);
		await recordUnsafe(manager, denied);
		renameSync(a.clone, sandbox.path("a-away"));
		renameSync(denied, sandbox.path("b-away"));
		failWorktreeRemoval();
		await assert.rejects(resumeSessionWorktree(manager, options()), (error: unknown) => {
			assertRefusedRecord(error);
			const descriptor = Object.getOwnPropertyDescriptor(error, "cleanupCause");
			assert.equal(descriptor?.configurable, true);
			assert.equal(descriptor?.enumerable, false);
			assertRemovalFailure(descriptor?.value, worktreeOf(restorable));
			return true;
		});
		assert.deepEqual(manager.getWorktreeRootMappings(), []);
	});

	test("several failed removals are aggregated in the order they were attempted, newest restore first", async () => {
		const a = await sandbox.remoteWithClone("a");
		const b = await sandbox.remoteWithClone("b");
		const denied = await deniedHistory("c");
		const manager = await SessionManager.create(store, a.clone);
		const first = await record(manager, a.clone);
		const second = await record(manager, b.clone);
		await recordUnsafe(manager, denied);
		for (const clone of [a.clone, b.clone, denied]) renameSync(clone, sandbox.path(`${basename(clone)}-away`));
		failWorktreeRemoval();
		await assert.rejects(resumeSessionWorktree(manager, options()), (error: unknown) => {
			assertRefusedRecord(error);
			const cleanup = (error as { cleanupCause?: unknown }).cleanupCause;
			assert.ok(cleanup instanceof AggregateError);
			assert.equal(cleanup.errors.length, 2);
			assertRemovalFailure(cleanup.errors[0] as WorkspaceGitError, worktreeOf(second));
			assertRemovalFailure(cleanup.errors[1] as WorkspaceGitError, worktreeOf(first));
			return true;
		});
	});

	test("a frozen primary error is rethrown unchanged when the removals behind it fail", async () => {
		const a = await sandbox.remoteWithClone("a");
		const b = await sandbox.remoteWithClone("b");
		sandbox.write(join(a.clone, "file.txt"), "a\n");
		sandbox.write(join(b.clone, "file.txt"), "b\n");
		const manager = await SessionManager.create(store, a.clone);
		await record(manager, a.clone);
		await record(manager, b.clone);
		renameSync(a.clone, sandbox.path("a-away"));
		renameSync(b.clone, sandbox.path("b-away"));
		const failure = Object.freeze(new Error("mapping could not be persisted"));
		const originalAppend = store.append.bind(store);
		let count = 0;
		store.append = async (...args) => {
			if (++count === 2) throw failure;
			return originalAppend(...args);
		};
		failWorktreeRemoval();
		try {
			await assert.rejects(resumeSessionWorktree(manager, options()), (error: unknown) => error === failure);
		} finally {
			store.append = originalAppend;
		}
		assert.equal(Object.hasOwn(failure, "cleanupCause"), false);
	});
});

test("/session snapshot agrees with verification about recorded content the current settings leave out (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	sandbox.write(join(clone, "notes.txt"), "untracked when recorded\n");
	const manager = await SessionManager.create(store, clone);
	const snapshot = await record(manager, clone);
	const settings = { ...DEFAULT_WORKTREE_SNAPSHOT_SETTINGS, includeUntracked: false };
	await verifyWorktree(snapshot, clone, { settings });
	assert.deepEqual(await compareWorktreeSnapshot(snapshot, clone, settings), { status: "match", tree: snapshot.tree });
});
