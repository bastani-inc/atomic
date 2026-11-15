import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
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
	WINDOWS_WORKTREE_GIT_DIR_LIMIT,
	WINDOWS_WORKTREE_ROOT_LIMIT,
	worktreeGitDir,
} from "../../packages/coding-agent/src/core/worktree-snapshot/paths.ts";
import { restoreWorktreeSnapshot } from "../../packages/coding-agent/src/core/worktree-snapshot/restore.ts";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../../packages/coding-agent/src/core/worktree-snapshot/settings.ts";
import type { WorktreeSnapshot } from "../../packages/coding-agent/src/core/worktree-snapshot/types.ts";
import { snapshotRestore } from "../../packages/workflows/src/workers/snapshot-restore.ts";
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
	renameSync(clone, sandbox.path("away"));
	return { snapshot: capture.snapshot, clone };
}

/** `env` without its unset variables, as a worker host's git carries it. */
function definedEnv(env: Readonly<NodeJS.ProcessEnv> | undefined): Record<string, string> {
	return Object.fromEntries(
		Object.entries(env ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
}

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

test("a pooled workflow's restore under a 120-character agent directory restores and leases its worktree (#5139)", async () => {
	const agentDir = agentDirOf(120);
	const { snapshot } = await recordedSnapshot();
	// The restore port a worker host on the shared pool runs, into worktrees under its agent directory.
	const restore = snapshotRestore({
		recorded: async () => [snapshot],
		blobs: store.snapshotBlobs,
		storeDir: join(agentDir, "worktree-snapshots"),
		git: { path: sandbox.executable.path, env: definedEnv(sandbox.executable.env) },
	});

	const restored = await restore(
		{ remotes: [...snapshot.remotes], head: snapshot.head, tree: snapshot.tree, envHash: snapshot.envHash },
		{ signal: new AbortController().signal, snapshot },
	);

	const path = typeof restored === "string" ? restored : restored.path;
	assert.equal(readFileSync(join(path, "file.txt"), "utf8"), "recorded\n");
	// A workspace-write stage takes the worktree's writer lease, a SQLite database in its Git directory.
	const lease = await acquireWorkspaceWriterLease({ worktree: path }, { owner: "run/stage" });
	assert.ok(existsSync(lease.lockFile));
	await lease.release();
});

test.runIf(process.platform === "win32")(
	"a restore whose paths would pass Windows' limit fails before writing, naming the agent directory (#5139)",
	async () => {
		const agentDir = agentDirOf(200);
		const storeDir = join(agentDir, "worktree-snapshots");
		const { snapshot } = await recordedSnapshot();

		const error = await restoreWorktreeSnapshot(snapshot, { blobs: store.snapshotBlobs, storeDir }).then(
			() => undefined,
			(failure: unknown) => failure,
		);

		assert.ok(isWorkspaceRestoreError(error), `expected a restore error, got ${String(error)}`);
		assert.equal(error.code, "path-too-long");
		assert.ok(error.message.includes(agentDir), error.message);
		assert.equal(existsSync(join(storeDir, "worktrees")), false, "nothing was checked out");
	},
);

test.runIf(process.platform === "win32")(
	"the object stores Atomic creates on Windows turn on core.longpaths for their worktrees (#5139)",
	async () => {
		const storeDir = join(agentDirOf(120), "worktree-snapshots");
		const { snapshot } = await recordedSnapshot();

		const restored = await restoreWorktreeSnapshot(snapshot, { blobs: store.snapshotBlobs, storeDir });

		// The store's own configuration, which its worktrees share; the host's system configuration may say so too.
		assert.equal(await sandbox.git(restored, "config", "--local", "--type=bool", "--get", "core.longpaths"), "true");
	},
);

test("SQLite opens Atomic's files on Windows through the long-path form, and every other path as given (#5139)", () => {
	const file = `C:\\${"d".repeat(250)}\\atomic-writer-lease.sqlite`;
	assert.equal(sqliteFilePath(file, "win32"), `\\\\?\\${file}`);
	assert.equal(sqliteFilePath(`\\\\?\\${file}`, "win32"), `\\\\?\\${file}`);
	for (const special of [":memory:", "", "file:journal.sqlite?mode=ro"])
		assert.equal(sqliteFilePath(special, "win32"), special);
	assert.equal(sqliteFilePath("/home/user/.atomic/agent/a.sqlite", "linux"), "/home/user/.atomic/agent/a.sqlite");
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
		const root = (name: string) => join(storeDir, "worktrees", name);
		return { agentDir, storeDir, store, root };
	}

	function budgetError(check: () => void) {
		try {
			check();
		} catch (error) {
			return error;
		}
		return undefined;
	}

	test("a worktree root of 212 characters fits and one of 213 fails, naming the agent directory", () => {
		const { agentDir, storeDir, store } = layout(120);
		// A restore `into` a deep directory: its root is long while Git's directory for it, named after its last component, is not.
		const fits = `/${"r".repeat(212 - 3)}/w`;
		assert.equal(fits.length, WINDOWS_WORKTREE_ROOT_LIMIT);
		assertRestorePathBudget({ storeDir, store, roots: [fits], snapshotId: "s1", platform: "win32" });

		const over = `/${"r".repeat(212 - 2)}/w`;
		const error = budgetError(() =>
			assertRestorePathBudget({ storeDir, store, roots: [fits, over], snapshotId: "s1", platform: "win32" }),
		);

		assert.ok(isWorkspaceRestoreError(error));
		assert.equal(error.code, "path-too-long");
		assert.deepEqual(error.fields, { snapshotId: "s1", target: over, limit: 212, agentDir });
		assert.equal(
			error.message,
			`Cannot restore snapshot s1: ${over} would be 213 characters, over the 212 that Windows and Git allow for it (path-too-long). Atomic keeps restored worktrees under ${agentDir} (${agentDir.length} characters). Set ATOMIC_CODING_AGENT_DIR to a shorter directory, such as C:\\atomic, or restore with a shorter storeDir, then retry.`,
		);
	});

	test("Git's own directory for a worktree is held to 247 characters", () => {
		const { storeDir, store, root } = layout(120);
		const gitDirs = join(store, "worktrees");
		const fits = root(`.${"g".repeat(247 - gitDirs.length - 2)}`);
		assert.equal(worktreeGitDir(store, fits).length, WINDOWS_WORKTREE_GIT_DIR_LIMIT);
		assert.ok(fits.length <= WINDOWS_WORKTREE_ROOT_LIMIT);
		assertRestorePathBudget({ storeDir, store, roots: [fits], snapshotId: null, platform: "win32" });

		const error = budgetError(() =>
			assertRestorePathBudget({ storeDir, store, roots: [`${fits}g`], snapshotId: null, platform: "win32" }),
		);

		assert.ok(isWorkspaceRestoreError(error));
		assert.equal(error.target, worktreeGitDir(store, `${fits}g`));
		assert.equal(error.limit, 247);
		assert.ok(error.message.startsWith("Cannot restore: "), error.message);
	});

	test("a store outside the agent directory is the directory the error names", () => {
		const { store } = layout(40);
		const storeDir = `/${"s".repeat(230)}`;
		const error = budgetError(() =>
			assertRestorePathBudget({
				storeDir,
				store,
				roots: [join(storeDir, "worktrees", "w")],
				snapshotId: null,
				platform: "win32",
			}),
		);
		assert.ok(isWorkspaceRestoreError(error));
		assert.equal(error.agentDir, resolve(storeDir));
	});

	test("other platforms have no budget", () => {
		const { storeDir, store } = layout(120);
		assertRestorePathBudget({ storeDir, store, roots: [`/${"r".repeat(400)}`], snapshotId: null, platform: "linux" });
	});
});
