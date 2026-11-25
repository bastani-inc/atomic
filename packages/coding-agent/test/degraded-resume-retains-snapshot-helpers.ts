import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { afterEach, beforeEach } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { renameReplacing } from "../src/core/rename-retry.js";
import type { WorktreeSnapshotEntry } from "../src/core/session-manager.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SessionWorktreeSnapshotRecorder } from "../src/core/session-worktree-snapshots.js";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import type { SessionStore } from "../src/core/storage/session/types.js";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.js";
import { collectSnapshotGarbage } from "../src/core/worktree-snapshot/garbage.js";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.js";
import type { WorktreeSnapshot } from "../src/core/worktree-snapshot/types.js";
import { type PreparedSessionResume, type PrepareSessionResumeOptions, prepareSessionResume } from "../src/index.js";

/** Collection deletes every unreferenced blob at once, so a released snapshot is gone after one collection. */
export const degradedResumeSettings = { ...DEFAULT_WORKTREE_SNAPSHOT_SETTINGS, graceSeconds: 0 };

export function ready(prepared: PreparedSessionResume): Extract<PreparedSessionResume, { status: "ready" }> {
	assert.equal(prepared.status, "ready");
	return prepared as Extract<PreparedSessionResume, { status: "ready" }>;
}

const bashTurn = () => fauxAssistantMessage([fauxToolCall("bash", { command: "ls" })], { stopReason: "toolUse" });

/** One agent turn that ran a file-writing tool, recorded the way a session records it. */
export async function runTurn(manager: SessionManager, cwd: string): Promise<void> {
	const unavailable: unknown[] = [];
	const recorder = new SessionWorktreeSnapshotRecorder({
		sessionManager: manager,
		cwd: () => cwd,
		settings: () => degradedResumeSettings,
		declaresWrites: () => false,
		onUnavailable: (reason) => unavailable.push(reason),
	});
	await recorder.recordTurn(bashTurn());
	assert.deepEqual(unavailable, []);
}

export const snapshotEntries = (manager: SessionManager): WorktreeSnapshotEntry[] =>
	manager.getEntries().filter((entry): entry is WorktreeSnapshotEntry => entry.type === "worktree_snapshot");

export function useDegradedResumeFixture() {
	useTemporaryAgentDir();

	let currentSandbox: GitSandbox;
	const cleanups: Array<() => Promise<void> | void> = [];

	beforeEach(() => {
		currentSandbox = new GitSandbox();
	});
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
		currentSandbox.dispose();
	});

	async function sqlStore(): Promise<SessionStore> {
		const database = await openNodeSqliteDatabase(currentSandbox.path("sessions.sqlite"));
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
			launchCwd: currentSandbox.root,
			settings: degradedResumeSettings,
			storeDir: currentSandbox.path(storeDir),
			blueprint: { agentDir: currentSandbox.path("agent"), trusted: () => false },
		};
	}

	/**
	 * Machine A: a session whose snapshot S holds an unpushed commit that cannot be bundled, because it touches a file
	 * snapshots never copy, and an uncommitted new file.
	 */
	async function machineA() {
		const { clone } = await currentSandbox.remoteWithClone("repo", { "README.md": "hello\n" });
		const pushed = await currentSandbox.git(clone, "rev-parse", "HEAD");
		currentSandbox.write(join(clone, ".env.example"), "TOKEN=placeholder\n");
		currentSandbox.write(join(clone, "feature.txt"), "unpushed feature\n");
		const unpushed = await currentSandbox.commitAll(clone, "unpushed commit touching a denied path");
		currentSandbox.write(join(clone, "work.txt"), "uncommitted work\n");
		const store = await sqlStore();
		const manager = await SessionManager.create(store, clone);
		await manager.appendMessage({ role: "user", content: "edit the files", timestamp: Date.now() });
		const capture = await captureWorktreeSnapshot(clone, {
			settings: degradedResumeSettings,
			blobs: store.snapshotBlobs,
		});
		if (capture.status !== "captured") throw new Error(capture.status);
		assert.equal(capture.snapshot.bundle, null, "the unpushed commit touches a denied path and is not bundled");
		await manager.appendWorktreeSnapshot(clone, capture.snapshot.id, capture.snapshot);
		const elsewhere = currentSandbox.path("machine-a");
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
		assert.equal(await currentSandbox.git(b.to, "rev-parse", "HEAD"), pushed);
		assert.equal(existsSync(join(b.to, "work.txt")), false);
		work(b.to);
		await runTurn(onB.sessionManager, b.to);
		const derived = snapshotEntries(onB.sessionManager).at(-1)!;
		assert.notEqual(derived.snapshotId, snapshot.id, "the turn recorded the partly restored worktree");
		await collectSnapshotGarbage(onB.sessionManager.getSessionStore().snapshotBlobs, { graceSeconds: 0 });
		return { onB, b };
	}

	return {
		get sandbox() {
			return currentSandbox;
		},
		cleanups,
		sqlStore,
		options,
		machineA,
		degradedTurnOnB,
	};
}
