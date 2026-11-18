import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { useTemporaryAgentDir } from "../../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox } from "../../../../test/helpers/worktree-snapshot.js";
import { renameWithRetry } from "../../src/core/rename-retry.ts";
import {
	type PreparedSessionResume,
	type PrepareSessionResumeOptions,
	prepareSessionResume,
} from "../../src/core/resume/session-resume.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { releaseSessionWorktrees } from "../../src/core/session-worktree-snapshots.js";
import { openNodeSqliteDatabase } from "../../src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../../src/core/storage/session/sql-session-store.js";
import { captureWorktreeSnapshot } from "../../src/core/worktree-snapshot/capture.js";
import {
	type PoolSlotRecord,
	pooledWorktreePath,
	repositoryIdOf,
	type SlotNumber,
} from "../../src/core/worktree-snapshot/pool.js";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../../src/core/worktree-snapshot/settings.js";
import type { WorktreeSnapshot } from "../../src/core/worktree-snapshot/types.js";

/** The shared fixture of the worktree-pool-claim test files: a Git sandbox and session store per test. */
export const settings = DEFAULT_WORKTREE_SNAPSHOT_SETTINGS;

export let sandbox: GitSandbox;
export let store: SqlSessionStore;
let database: Awaited<ReturnType<typeof openNodeSqliteDatabase>>;
export const opened: SessionManager[] = [];

/** Registers the agent directory and the per-test sandbox and session store; call once at the top of each test file. */
export function useWorktreePoolClaimSandbox(): void {
	useTemporaryAgentDir();
	beforeEach(async () => {
		sandbox = new GitSandbox();
		database = await openNodeSqliteDatabase(sandbox.path("sessions.sqlite"));
		store = await SqlSessionStore.open(database);
	});
	afterEach(async () => {
		while (opened.length > 0) await releaseSessionWorktrees(opened.pop()!);
		await store.close();
		await database.close();
		sandbox.dispose();
	});
}

export const storeDir = () => sandbox.path("host");
export const Y = { kind: "session" as const, id: "session-y" };
export const claimOptions = () => ({ storeDir: storeDir(), owner: Y, settings, blobs: store.snapshotBlobs });

export function slot(snapshot: WorktreeSnapshot, n: number): string {
	return pooledWorktreePath(storeDir(), repositoryIdOf(snapshot.remotes), n as SlotNumber);
}

export function recordFile(snapshot: WorktreeSnapshot, n: number): string {
	return join(storeDir(), "pool", repositoryIdOf(snapshot.remotes), `${n}.json`);
}

export function recordOf(snapshot: WorktreeSnapshot, n: number): PoolSlotRecord {
	return JSON.parse(readFileSync(recordFile(snapshot, n), "utf8")) as PoolSlotRecord;
}

export async function capture(root: string): Promise<WorktreeSnapshot> {
	const result = await captureWorktreeSnapshot(root, { settings, blobs: store.snapshotBlobs });
	assert.equal(result.status, "captured");
	if (result.status !== "captured") throw new Error("unreachable");
	return result.snapshot;
}

/**
 * Two snapshots of one checkout that ignores `node_modules/` and `build/`: A edits `file.txt` and adds the untracked
 * `only-a.txt` next to the untracked `shared.txt` both keep; B edits `file.txt` differently, without `only-a.txt`, and `edit` may change more. The checkout is then
 * moved away, so every session restores.
 */
export async function twoSnapshots(edit?: (clone: string) => void) {
	const { clone } = await sandbox.remoteWithClone("repo", {
		".gitignore": "node_modules/\nbuild/\n",
		"README.md": "hello\n",
	});
	sandbox.write(join(clone, "file.txt"), "A\n");
	sandbox.write(join(clone, "only-a.txt"), "A only\n");
	sandbox.write(join(clone, "shared.txt"), "in both\n");
	const a = await capture(clone);
	rmSync(join(clone, "only-a.txt"));
	sandbox.write(join(clone, "file.txt"), "B\n");
	edit?.(clone);
	const b = await capture(clone);
	await renameWithRetry(clone, sandbox.path("repo-away"));
	return { a, b, clone };
}

export async function sessionOf(clone: string, snapshot: WorktreeSnapshot): Promise<SessionManager> {
	const manager = await SessionManager.create(store, clone);
	await manager.appendWorktreeSnapshot(clone, snapshot.id, snapshot);
	return manager;
}

function prepareOptions(overrides: Partial<PrepareSessionResumeOptions> = {}): PrepareSessionResumeOptions {
	return {
		entryPoint: "cli",
		launchCwd: sandbox.root,
		settings,
		storeDir: storeDir(),
		blueprint: { agentDir: sandbox.path("agent"), trusted: () => false },
		blueprints: "skip",
		...overrides,
	};
}

/** Resumes `manager` and keeps the session it opened until the test ends. */
export async function resume(
	manager: SessionManager,
	overrides: Partial<PrepareSessionResumeOptions> = {},
): Promise<Extract<PreparedSessionResume, { status: "ready" }>> {
	const prepared = await prepareSessionResume(manager, prepareOptions(overrides));
	assert.equal(prepared.status, "ready");
	if (prepared.status !== "ready") throw new Error("unreachable");
	opened.push(prepared.sessionManager);
	return prepared;
}

/** Session X restored A into slot 0, filled its `node_modules`, and closed. */
export async function idleSlotOfX(a: WorktreeSnapshot, clone: string) {
	const x = await sessionOf(clone, a);
	const first = await resume(x);
	assert.equal(first.sessionManager.getCwd(), slot(a, 0));
	sandbox.write(join(slot(a, 0), "node_modules", "dep", ".installed"), "marker\n");
	await releaseSessionWorktrees(first.sessionManager);
	return first.sessionManager;
}
