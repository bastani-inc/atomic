import assert from "node:assert/strict";
import { mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { sleep } from "../../../test/helpers/runtime.js";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { renameWithRetry } from "../src/core/rename-retry.js";
import { prebuildRepository } from "../src/core/resume/blueprint/prebuild.js";
import { prepareSessionResume } from "../src/core/resume/session-resume.js";
import { SessionManager } from "../src/core/session-manager.js";
import { releaseSessionWorktrees, resumeSessionWorktree } from "../src/core/session-worktree-snapshots.js";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.js";
import {
	pooledWorktreeHolder,
	pooledWorktreePath,
	repositoryIdOf,
	type SlotNumber,
} from "../src/core/worktree-snapshot/pool.js";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.js";
import { lockShared } from "../src/core/worktree-snapshot/shared-clock.js";

const lockWait = vi.hoisted(() => ({ onSleep: undefined as (() => void) | undefined }));

vi.mock("node:timers/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:timers/promises")>();
	const setTimeout: typeof actual.setTimeout = (delay, value, options) => {
		lockWait.onSleep?.();
		return actual.setTimeout(delay, value, options);
	};
	return { ...actual, setTimeout };
});

useTemporaryAgentDir();

const settings = DEFAULT_WORKTREE_SNAPSHOT_SETTINGS;
const CANCELLED_LOCK_SETTLE_MS = 2_000;
let sandbox: GitSandbox;
let store: SqlSessionStore;
let database: Awaited<ReturnType<typeof openNodeSqliteDatabase>>;
const sessions: SessionManager[] = [];

beforeEach(async () => {
	sandbox = new GitSandbox();
	database = await openNodeSqliteDatabase(sandbox.path("sessions.sqlite"));
	store = await SqlSessionStore.open(database);
});

afterEach(async () => {
	lockWait.onSleep = undefined;
	while (sessions.length > 0) await releaseSessionWorktrees(sessions.pop()!);
	await store.close();
	await database.close();
	sandbox.dispose();
});

async function cancelWhileWaiting(file: string, action: (signal: AbortSignal) => Promise<object>): Promise<void> {
	mkdirSync(dirname(file), { recursive: true });
	const unlock = await lockShared(file, { realpath: false, stale: 30_000 });
	const controller = new AbortController();
	const cancelled = new Error("cancelled while waiting for the pool lock");
	let polled!: () => void;
	const waiting = new Promise<void>((resolve) => {
		polled = resolve;
	});
	lockWait.onSleep = () => {
		polled();
		controller.abort(cancelled);
	};
	const outcome = action(controller.signal).then(
		() => ({ status: "resolved" as const }),
		(error: Error) => ({ status: "rejected" as const, error }),
	);
	try {
		await Promise.race([waiting, outcome.then(() => assert.fail("the operation ended before waiting for its lock"))]);
		const settled = await Promise.race([
			outcome,
			sleep(CANCELLED_LOCK_SETTLE_MS).then(() => ({ status: "still-waiting" as const })),
		]);
		assert.equal(settled.status, "rejected");
		if (settled.status !== "rejected") throw new Error(settled.status);
		assert.ok(settled.error === cancelled || settled.error.cause === cancelled);
	} finally {
		lockWait.onSleep = undefined;
		controller.abort(cancelled);
		await unlock();
		await outcome;
	}
}

async function recordedSession() {
	const { clone } = await sandbox.remoteWithClone();
	const capture = await captureWorktreeSnapshot(clone, { settings, blobs: store.snapshotBlobs });
	assert.equal(capture.status, "captured");
	if (capture.status !== "captured") throw new Error(capture.status);
	const session = await SessionManager.create(store, clone);
	sessions.push(session);
	await session.appendWorktreeSnapshot(clone, capture.snapshot.id, capture.snapshot);
	await renameWithRetry(clone, sandbox.path("repo-away"));
	return { session, snapshot: capture.snapshot };
}

test("cancelling a resume interrupts admission while its repository lock stays held (#5320)", async () => {
	const { session, snapshot } = await recordedSession();
	const storeDir = sandbox.path("host");
	const repository = repositoryIdOf(snapshot.remotes);

	await cancelWhileWaiting(join(storeDir, "pool", repository), (signal) =>
		prepareSessionResume(session, {
			entryPoint: "cli",
			launchCwd: sandbox.root,
			settings,
			storeDir,
			signal,
			blueprints: "describe",
		}),
	);

	assert.deepEqual(readdirSync(join(storeDir, "pool", repository)), []);
	assert.deepEqual(session.getWorktreeRootMappings(), []);
});

test("cancelling a resume interrupts its initial slot hold without forfeiting its owner (#5320)", async () => {
	const { session, snapshot } = await recordedSession();
	const storeDir = sandbox.path("host");
	const pool = { settings, storeDir, pool: { maxIdlePerRepository: 2 } };
	assert.equal((await resumeSessionWorktree(session, pool)).status, "restored");
	await releaseSessionWorktrees(session);
	const repository = repositoryIdOf(snapshot.remotes);
	const path = pooledWorktreePath(storeDir, repository, 0 as SlotNumber);
	const before = await pooledWorktreeHolder(storeDir, path);

	await cancelWhileWaiting(join(storeDir, "pool", repository, "0.json"), (signal) =>
		prepareSessionResume(session, {
			entryPoint: "cli",
			launchCwd: sandbox.root,
			settings,
			storeDir,
			signal,
			blueprints: "describe",
		}),
	);

	assert.deepEqual(await pooledWorktreeHolder(storeDir, path), before);
	assert.equal((await resumeSessionWorktree(session, pool)).status, "verified");
});

test("cancelling a prebuild interrupts admission while its repository lock stays held (#5320)", async () => {
	const { clone, remote } = await sandbox.remoteWithClone();
	const storeDir = sandbox.path("host");
	const repository = repositoryIdOf([remote]);

	await cancelWhileWaiting(join(storeDir, "pool", repository), (signal) =>
		prebuildRepository(clone, {
			agentDir: sandbox.path("agent"),
			storeDir,
			settings,
			maxIdlePerRepository: 2,
			signal,
		}),
	);

	assert.deepEqual(readdirSync(join(storeDir, "pool", repository)), []);
});
