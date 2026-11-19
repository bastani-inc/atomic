import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { renameWithRetry } from "../../packages/coding-agent/src/core/rename-retry.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import {
	releaseSessionWorktrees,
	resumeSessionWorktree,
} from "../../packages/coding-agent/src/core/session-worktree-snapshots.ts";
import { openNodeSqliteDatabase, sqliteFilePath } from "../../packages/coding-agent/src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.ts";
import { acquireWorkspaceWriterLease } from "../../packages/coding-agent/src/core/workspace/lease.ts";
import { captureWorktreeSnapshot } from "../../packages/coding-agent/src/core/worktree-snapshot/capture.ts";
import { isWorkspaceRestoreError } from "../../packages/coding-agent/src/core/worktree-snapshot/errors.ts";
import {
	assertRestorePathBudget,
	stagingWorktreeName,
	WINDOWS_GIT_DIR_LIMIT,
	WINDOWS_WORKTREE_GIT_DIR_LIMIT,
	WINDOWS_WORKTREE_ROOT_LIMIT,
	worktreeGitDir,
} from "../../packages/coding-agent/src/core/worktree-snapshot/paths.ts";
import { restoreWorktreeSnapshot } from "../../packages/coding-agent/src/core/worktree-snapshot/restore.ts";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../../packages/coding-agent/src/core/worktree-snapshot/settings.ts";
import type { WorktreeSnapshot } from "../../packages/coding-agent/src/core/worktree-snapshot/types.ts";

import { replaceEnvironmentVariable } from "../helpers/temporary-agent-dir.js";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

const settings = DEFAULT_WORKTREE_SNAPSHOT_SETTINGS;

let sandbox: GitSandbox;
let store: SqlSessionStore;
let database: Awaited<ReturnType<typeof openNodeSqliteDatabase>>;
const cleanups: Array<() => unknown> = [];

beforeEach(async () => {
	sandbox = new GitSandbox();
	database = await openNodeSqliteDatabase(sandbox.path("sessions.sqlite"));
	store = await SqlSessionStore.open(database);
});
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	await store.close();
	await database.close();
	sandbox.dispose();
});

/** An agent directory exactly `length` characters long, made current through `ATOMIC_CODING_AGENT_DIR`. */
function agentDirOf(length: number): string {
	const parent = sandbox.path("home");
	const padding = length - parent.length - 1;
	assert.ok(padding > 0, `the sandbox ${parent} leaves no room for a ${length}-character agent directory`);
	const agentDir = join(parent, "a".repeat(padding));
	assert.equal(agentDir.length, length);
	mkdirSync(agentDir, { recursive: true });
	cleanups.push(replaceEnvironmentVariable("ATOMIC_CODING_AGENT_DIR", agentDir));
	return agentDir;
}

/** A clone with an edit and its snapshot; the clone is then moved away, so every resume must restore it. */
async function recordedSnapshot(): Promise<{ snapshot: WorktreeSnapshot; clone: string }> {
	const { clone } = await sandbox.remoteWithClone();
	sandbox.write(join(clone, "file.txt"), "recorded\n");
	const capture = await captureWorktreeSnapshot(clone, { settings, blobs: store.snapshotBlobs });
	if (capture.status !== "captured") throw new Error("expected a snapshot");
	await renameWithRetry(clone, sandbox.path("away"));
	return { snapshot: capture.snapshot, clone };
}

/** `env` without its unset variables, as a worker host's git carries it. */

/** The administrative directories Git keeps for the worktrees of the one object store under `storeDir`. */
function worktreeGitDirs(storeDir: string): string[] {
	const repositories = join(storeDir, "repositories");
	const [repository] = readdirSync(repositories).filter((name) => name.endsWith(".git"));
	return readdirSync(join(repositories, repository!, "worktrees"));
}

test("a pooled session resume under a 120-character agent directory restores and leases its worktree (#5139)", async () => {
	const agentDir = agentDirOf(120);
	const storeDir = join(agentDir, "worktree-snapshots");
	const { snapshot, clone } = await recordedSnapshot();
	const manager = await SessionManager.create(store, clone);
	await manager.appendWorktreeSnapshot(clone, snapshot.id, snapshot);
	cleanups.push(() => releaseSessionWorktrees(manager));

	const result = await resumeSessionWorktree(manager, { settings, storeDir, pool: { maxIdlePerRepository: 2 } });

	assert.equal(result.status, "restored");
	if (result.status !== "restored") return;
	const root = result.mappings[0]!.to;
	assert.equal(readFileSync(join(root, "file.txt"), "utf8"), "recorded\n");
	// Git names a worktree's own directory after the staging worktree it was checked out in: a short name (#5139).
	assert.deepEqual(
		worktreeGitDirs(storeDir).map((name) => /^-s-[0-9a-f]{12}$/.test(name)),
		[true],
	);
	const lease = await acquireWorkspaceWriterLease({ worktree: root }, { owner: "resumed session" });
	await lease.release();
});

test.runIf(process.platform === "win32")(
	"a 159-character agent directory restores and leases, and a 160-character one fails before writing, naming it (#5139)",
	async () => {
		const { snapshot } = await recordedSnapshot();
		const fits = join(agentDirOf(159), "worktree-snapshots");
		const restored = await restoreWorktreeSnapshot(snapshot, { blobs: store.snapshotBlobs, storeDir: fits });
		const lease = await acquireWorkspaceWriterLease({ worktree: restored }, { owner: "run/stage" });
		await lease.release();

		const agentDir = agentDirOf(160);
		const storeDir = join(agentDir, "worktree-snapshots");
		const error = await restoreWorktreeSnapshot(snapshot, { blobs: store.snapshotBlobs, storeDir }).then(
			() => undefined,
			(failure: unknown) => failure,
		);

		assert.ok(isWorkspaceRestoreError(error), `expected a restore error, got ${String(error)}`);
		assert.equal(error.code, "path-too-long");
		// The object store Git runs in is the first path past its limit.
		assert.equal(error.limit, 220);
		assert.equal(dirname(error.target!), join(storeDir, "repositories"));
		assert.ok(error.message.includes(`under ${agentDir} (160 characters)`), error.message);
		assert.equal(existsSync(storeDir), false, "nothing was written");
	},
);

/** The configuration file of the one object store under `storeDir`. */
function storeConfig(storeDir: string): string {
	const repositories = join(storeDir, "repositories");
	return join(repositories, readdirSync(repositories).find((name) => name.endsWith(".git"))!, "config");
}

test.runIf(process.platform === "win32")(
	"the object stores Atomic creates or restores from on Windows turn on core.longpaths for their worktrees (#5139)",
	async () => {
		const storeDir = join(agentDirOf(120), "worktree-snapshots");
		const { snapshot } = await recordedSnapshot();
		const restore = () => restoreWorktreeSnapshot(snapshot, { blobs: store.snapshotBlobs, storeDir });
		const longPaths = (worktree: string) =>
			sandbox.git(worktree, "config", "--local", "--type=bool", "--get", "core.longpaths");

		// The store's own configuration, which its worktrees share; the host's system configuration may say so too.
		assert.equal(await longPaths(await restore()), "true");
		// A store an earlier version created gets it too.
		await sandbox.git(sandbox.root, "config", "--file", storeConfig(storeDir), "--unset", "core.longpaths");
		assert.equal(await longPaths(await restore()), "true");
		// A store that has it is not rewritten.
		const written = statSync(storeConfig(storeDir)).mtimeMs;
		await new Promise((settle) => setTimeout(settle, 50));
		await restore();
		assert.equal(statSync(storeConfig(storeDir)).mtimeMs, written);
	},
);

test.runIf(process.platform !== "win32")(
	"object stores on other platforms keep their configuration (#5139)",
	async () => {
		const storeDir = join(agentDirOf(120), "worktree-snapshots");
		const { snapshot } = await recordedSnapshot();
		await restoreWorktreeSnapshot(snapshot, { blobs: store.snapshotBlobs, storeDir });
		assert.equal(readFileSync(storeConfig(storeDir), "utf8").includes("longpaths"), false);
	},
);

test("SQLite opens a long Windows path through the long-path form, and every other path as given (#5139)", () => {
	const file = `C:\\${"d".repeat(250)}\\atomic-writer-lease.sqlite`;
	assert.equal(sqliteFilePath(file, "win32"), `\\\\?\\${file}`);
	assert.equal(sqliteFilePath(`\\\\?\\${file}`, "win32"), `\\\\?\\${file}`);
	// Up to 240 characters a path is opened as written, so its location reads as before.
	const fits = `C:\\${"d".repeat(240 - 3)}`;
	assert.equal(sqliteFilePath(fits, "win32"), fits);
	assert.equal(sqliteFilePath(`${fits}d`, "win32"), `\\\\?\\${fits}d`);
	for (const special of [":memory:", "file:journal.sqlite?mode=ro"])
		assert.equal(sqliteFilePath(special, "win32"), special);
	assert.equal(sqliteFilePath(`/${"d".repeat(300)}`, "linux"), `/${"d".repeat(300)}`);
});

test("staging worktrees take a 15-character name from the restore's id (#5139)", () => {
	assert.equal(stagingWorktreeName("0123abcd-4567-89ef-0123-456789abcdef"), ".s-0123abcd4567");
});

describe("the restore path budget on Windows (#5139)", () => {
	/** A store under an agent directory of `length` characters, and its one object store. */
	function layout(length: number) {
		// Resolved, as Atomic resolves it: a drive letter on Windows.
		const agentDir = resolve(`/${"a".repeat(length - 1)}`);
		cleanups.push(replaceEnvironmentVariable("ATOMIC_CODING_AGENT_DIR", agentDir));
		const storeDir = join(agentDir, "worktree-snapshots");
		const store = join(storeDir, "repositories", `${"f".repeat(24)}.git`);
		const staging = join(storeDir, "worktrees", stagingWorktreeName("0".repeat(12)));
		return { agentDir, storeDir, store, staging };
	}

	function budgetError(budget: Omit<Parameters<typeof assertRestorePathBudget>[0], "platform">) {
		try {
			assertRestorePathBudget({ ...budget, platform: "win32" });
		} catch (error) {
			return error;
		}
		return undefined;
	}

	/** A path of exactly `length` characters whose last component is `w`, so Git's directory for it stays short. */
	const deep = (length: number) => join(resolve("/"), "r".repeat(length - resolve("/").length - 2), "w");

	test("a target root of 212 characters fits and one of 213 fails, naming the agent directory", () => {
		const { agentDir, storeDir, store, staging } = layout(120);
		const fits = deep(212);
		assert.equal(fits.length, WINDOWS_WORKTREE_ROOT_LIMIT);
		const budget = { storeDir, store: () => store, staging, snapshotId: "s1" };
		assert.equal(budgetError({ ...budget, target: fits }), undefined);

		const over = deep(213);
		const error = budgetError({ ...budget, target: over });

		assert.ok(isWorkspaceRestoreError(error));
		assert.equal(error.code, "path-too-long");
		assert.deepEqual(error.fields, { snapshotId: "s1", target: over, limit: 212, agentDir });
		assert.equal(
			error.message,
			`Cannot restore snapshot s1: ${over} would be 213 characters, over the 212 that Windows and Git allow for it (path-too-long). Atomic keeps restored worktrees under ${agentDir} (${agentDir.length} characters). Set ATOMIC_CODING_AGENT_DIR to a shorter directory, such as C:\\atomic, or restore with a shorter storeDir, then retry.`,
		);
	});

	test("a staging root is held to 212 characters too", () => {
		const { storeDir, store } = layout(40);
		const target = join(storeDir, "worktrees", "w");
		const budget = { storeDir, store: () => store, target, snapshotId: null };
		assert.equal(budgetError({ ...budget, staging: deep(212) }), undefined);
		const error = budgetError({ ...budget, staging: deep(213) });
		assert.ok(isWorkspaceRestoreError(error));
		assert.equal(error.target, deep(213));
	});

	test("the Git directory of the staging worktree is held to 247 characters, and the store to 220", () => {
		const { storeDir, store, staging } = layout(120);
		const target = join(storeDir, "worktrees", "w");
		const named = (length: number) =>
			join(dirname(staging), `.${"g".repeat(length - worktreeGitDir(store, "/x").length - 1)}x`);
		assert.equal(worktreeGitDir(store, named(247)).length, WINDOWS_WORKTREE_GIT_DIR_LIMIT);
		const budget = { storeDir, store: () => store, target, snapshotId: null };
		assert.equal(budgetError({ ...budget, staging: named(247) }), undefined);

		const error = budgetError({ ...budget, staging: named(248) });
		assert.ok(isWorkspaceRestoreError(error));
		assert.equal(error.target, worktreeGitDir(store, named(248)));
		assert.equal(error.limit, 247);
		assert.ok(error.message.startsWith("Cannot restore: "), error.message);

		const longStore = (length: number) => `${store}${"s".repeat(length - store.length)}`;
		assert.equal(budgetError({ ...budget, staging, store: () => longStore(WINDOWS_GIT_DIR_LIMIT) }), undefined);
		const storeError = budgetError({ ...budget, staging, store: () => longStore(221) });
		assert.ok(isWorkspaceRestoreError(storeError));
		assert.equal(storeError.target, longStore(221));
		assert.equal(storeError.limit, 220);
	});

	test("a store outside the agent directory is the directory the error names", () => {
		const { store } = layout(40);
		const storeDir = `/${"s".repeat(230)}`;
		const error = budgetError({
			storeDir,
			store: () => store,
			staging: join(storeDir, "worktrees", ".s"),
			target: join(storeDir, "worktrees", "w"),
			snapshotId: null,
		});
		assert.ok(isWorkspaceRestoreError(error));
		assert.equal(error.agentDir, resolve(storeDir));
	});

	test("a store that cannot be named is left for the restore to report", () => {
		const { storeDir, staging } = layout(40);
		const unnamed = () => {
			throw new Error("no store");
		};
		assert.equal(budgetError({ storeDir, store: unnamed, staging, target: deep(400), snapshotId: null }), undefined);
	});

	test("other platforms have no budget", () => {
		const { storeDir, store } = layout(120);
		assertRestorePathBudget({
			storeDir,
			store: () => store,
			staging: deep(400),
			target: deep(400),
			snapshotId: null,
			platform: "linux",
		});
	});
});
