import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, test } from "vitest";
import { bunExecutable, sleep } from "../../../test/helpers/runtime.js";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { SessionManager } from "../src/core/session-manager.js";
import { releaseSessionWorktrees, resumeSessionWorktree } from "../src/core/session-worktree-snapshots.js";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.js";
import {
	holdRestoredWorktree,
	type PoolSlotRecord,
	pooledWorktreePath,
	releaseRestoredWorktree,
	repositoryIdOf,
	type SlotNumber,
	type WorktreeLease,
} from "../src/core/worktree-snapshot/pool.js";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.js";
import type { WorktreeSnapshot } from "../src/core/worktree-snapshot/types.js";

useTemporaryAgentDir();

const settings = DEFAULT_WORKTREE_SNAPSHOT_SETTINGS;
/** A process loses a record lock it has not refreshed for this long, as the pool's locks are set up. */
const LOCK_STALE_MS = 30_000;
/** Bun children load the snapshot modules before they evict or claim. */
const CHILD_PROCESS_TIMEOUT_MS = 90_000;
const module = (path: string) => JSON.stringify(fileURLToPath(new URL(`../src/core/${path}`, import.meta.url)));

let sandbox: GitSandbox;
let store: SqlSessionStore;
let database: Awaited<ReturnType<typeof openNodeSqliteDatabase>>;
const cleanups: (() => Promise<void> | void)[] = [];

beforeEach(async () => {
	sandbox = new GitSandbox();
	database = await openNodeSqliteDatabase(sandbox.path("sessions.sqlite"));
	store = await SqlSessionStore.open(database);
});
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()!();
	await store.close();
	await database.close();
	sandbox.dispose();
});

const storeDir = () => sandbox.path("host");
const owner = { kind: "session" as const, id: "session-owner" };

/** A snapshot whose checkout is gone, and its owner's idle pooled slot 0 holding it. */
async function idleSlot(): Promise<{ snapshot: WorktreeSnapshot; root: string; pool: string }> {
	const { clone } = await sandbox.remoteWithClone("repo", { ".gitignore": "node_modules/\n", "README.md": "x\n" });
	sandbox.write(join(clone, "file.txt"), "recorded\n");
	const capture = await captureWorktreeSnapshot(clone, { settings, blobs: store.snapshotBlobs });
	if (capture.status !== "captured") throw new Error(`capture ${capture.status}`);
	const snapshot = capture.snapshot;
	renameSync(clone, sandbox.path("repo-away"));
	const manager = await SessionManager.create(store, clone);
	await manager.appendWorktreeSnapshot(clone, snapshot.id, snapshot);
	const resumed = await resumeSessionWorktree(manager, {
		settings,
		storeDir: storeDir(),
		pool: { maxIdlePerRepository: 2 },
	});
	const root = pooledWorktreePath(storeDir(), repositoryIdOf(snapshot.remotes), 0 as SlotNumber);
	assert.equal(resumed.status === "restored" && resumed.mappings[0]!.to, root);
	await releaseSessionWorktrees(manager);
	// The slot is the test's owner's, as when that session released it.
	const pool = join(storeDir(), "pool", repositoryIdOf(snapshot.remotes));
	const record = JSON.parse(readFileSync(join(pool, "0.json"), "utf8")) as PoolSlotRecord;
	writeFileSync(join(pool, "0.json"), JSON.stringify({ ...record, holder: owner }));
	return { snapshot, root, pool };
}

/**
 * Runs `source` in a Bun child whose Git stops the child (SIGSTOP) the first time it is run with `argument`: by
 * default as it lists the slot's ignored files, the last check an eviction or a claim makes of the slot's files.
 * Resolves once the child is stopped.
 */
async function stoppedChild(name: string, source: string, argument = "--directory") {
	const mark = sandbox.path(`${name}.stopped`);
	const git = sandbox.path(`${name}-git.sh`);
	writeFileSync(
		git,
		`#!/bin/sh\nfor arg in "$@"; do\n\tif [ "$arg" = ${JSON.stringify(argument)} ] && [ ! -e ${JSON.stringify(mark)} ]; then : > ${JSON.stringify(mark)}; kill -STOP $PPID; fi\ndone\nexec git "$@"\n`,
	);
	chmodSync(git, 0o755);
	const script = sandbox.path(`${name}.ts`);
	writeFileSync(
		script,
		`import { withWorktreeSnapshotGit } from ${module("worktree-snapshot/git.ts")};
const git = { path: ${JSON.stringify(git)}, env: { ...${JSON.stringify(sandbox.executable.env)}, PATH: process.env.PATH ?? "" } };
const outcome = await withWorktreeSnapshotGit(git, async () => {
${source}
});
process.stdout.write(JSON.stringify(outcome));
`,
	);
	const child = spawn(bunExecutable(), [script], { stdio: ["ignore", "pipe", "inherit"] });
	let output = "";
	child.stdout.on("data", (chunk: Buffer) => {
		output += chunk.toString("utf8");
	});
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	cleanups.push(async () => {
		child.kill("SIGKILL");
		await exited;
	});
	while (!existsSync(mark)) await sleep(20);
	// The signal stops the child once the wrapper sent it.
	await sleep(300);
	return {
		/** Continues the child and resolves to what it printed once it exits. */
		resume: async () => {
			child.kill("SIGCONT");
			await exited;
			return output;
		},
	};
}

/** Dates the slot's record lock back past its stale time, as a suspension longer than that leaves it. */
function ageRecordLock(pool: string): void {
	const past = new Date(Date.now() - LOCK_STALE_MS - 15_000);
	const locks = readdirSync(pool).filter((name) => name === "0.json.lock");
	assert.deepEqual(locks, ["0.json.lock"]);
	utimesSync(join(pool, "0.json.lock"), past, past);
}

/** The owner continues meanwhile: it holds its slot again and works in it. */
async function ownerHoldsAgain(root: string): Promise<WorktreeLease> {
	const lease = await holdRestoredWorktree(storeDir(), root, owner);
	assert.ok(lease, "the owner holds its slot again");
	writeFileSync(join(root, "new-work.txt"), "work done after resuming\n");
	cleanups.push(async () => {
		await releaseRestoredWorktree(lease);
	});
	return lease;
}

/** An eviction of every idle slot of `snapshot`'s repository, in a child stopped at `argument`. */
function evictor(snapshot: WorktreeSnapshot, argument?: string) {
	return stoppedChild(
		"evictor",
		`const { evictIdleWorktrees } = await import(${module("worktree-snapshot/pool.ts")});
const { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } = await import(${module("worktree-snapshot/settings.ts")});
return evictIdleWorktrees(${JSON.stringify(storeDir())}, ${JSON.stringify(repositoryIdOf(snapshot.remotes))}, { maxIdle: 0, settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS });`,
		argument,
	);
}

describe.skipIf(process.platform === "win32")("a pool action suspended inside a slot's record lock (#4991)", () => {
	test(
		"an eviction suspended as it reads the worktree's store, its last step before removing, leaves a slot its owner held again (#4991)",
		async () => {
			const { snapshot, root, pool } = await idleSlot();
			const evicting = await evictor(snapshot, "--git-common-dir");
			ageRecordLock(pool);
			const lease = await ownerHoldsAgain(root);
			const held = readFileSync(join(pool, "0.json"), "utf8");

			assert.deepEqual(JSON.parse(await evicting.resume()), []);

			assert.equal(readFileSync(join(root, "new-work.txt"), "utf8"), "work done after resuming\n");
			assert.equal(readFileSync(join(pool, "0.json"), "utf8"), held);
			assert.equal(await releaseRestoredWorktree(lease), true);
			assert.equal(existsSync(join(root, "new-work.txt")), true);
		},
		CHILD_PROCESS_TIMEOUT_MS,
	);

	test(
		"an eviction suspended while it deletes a slot it took leaves nothing its owner can hold, and finishes (#4991)",
		async () => {
			const { snapshot, root, pool } = await idleSlot();
			const evicting = await evictor(snapshot, "prune");
			ageRecordLock(pool);

			// The slot is already out of reach: its record is gone, so its owner restores elsewhere and loses nothing.
			assert.equal(await holdRestoredWorktree(storeDir(), root, owner), undefined);
			assert.equal(existsSync(root), false);

			assert.deepEqual(JSON.parse(await evicting.resume()), [root]);
			assert.equal(existsSync(join(pool, "0.json")), false);
			assert.deepEqual(
				readdirSync(join(storeDir(), "worktrees")).filter((name) =>
					name.startsWith(`${repositoryIdOf(snapshot.remotes)}-0`),
				),
				[],
			);
		},
		CHILD_PROCESS_TIMEOUT_MS,
	);

	test(
		"an eviction suspended past the lock's stale time leaves a slot its owner held again meanwhile (#4991)",
		async () => {
			const { snapshot, root, pool } = await idleSlot();
			const evicting = await evictor(snapshot);
			ageRecordLock(pool);
			await ownerHoldsAgain(root);
			const held = readFileSync(join(pool, "0.json"), "utf8");

			assert.deepEqual(JSON.parse(await evicting.resume()), []);

			assert.equal(readFileSync(join(root, "new-work.txt"), "utf8"), "work done after resuming\n");
			assert.equal(readFileSync(join(root, "file.txt"), "utf8"), "recorded\n");
			assert.equal(readFileSync(join(pool, "0.json"), "utf8"), held);
		},
		CHILD_PROCESS_TIMEOUT_MS,
	);

	test(
		"a claim suspended past the lock's stale time never marks or resets a slot its owner held again meanwhile (#4991)",
		async () => {
			const { snapshot, root, pool } = await idleSlot();
			const claimer = await stoppedChild(
				"claimer",
				`const { claimIdleWorktree } = await import(${module("worktree-snapshot/pool.ts")});
const { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } = await import(${module("worktree-snapshot/settings.ts")});
const { openNodeSqliteDatabase } = await import(${module("storage/node-sqlite.ts")});
const { SqlSessionStore } = await import(${module("storage/session/sql-session-store.ts")});
const store = await SqlSessionStore.open(await openNodeSqliteDatabase(${JSON.stringify(sandbox.path("sessions.sqlite"))}));
const claim = await claimIdleWorktree(${JSON.stringify(snapshot)}, {
	storeDir: ${JSON.stringify(storeDir())},
	owner: { kind: "session", id: "session-claimer" },
	settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
	blobs: store.snapshotBlobs,
});
return claim.claimed ? { claimed: true } : claim;`,
			);
			ageRecordLock(pool);
			const lease = await ownerHoldsAgain(root);
			const held = readFileSync(join(pool, "0.json"), "utf8");

			assert.deepEqual(JSON.parse(await claimer.resume()), { claimed: false, reason: "busy" });

			assert.equal(readFileSync(join(pool, "0.json"), "utf8"), held);
			assert.equal(readFileSync(join(root, "new-work.txt"), "utf8"), "work done after resuming\n");
			// The owner's hold is still its own: it records and releases the slot.
			assert.equal(await releaseRestoredWorktree(lease), true);
			assert.deepEqual((JSON.parse(readFileSync(join(pool, "0.json"), "utf8")) as PoolSlotRecord).holder, owner);
		},
		CHILD_PROCESS_TIMEOUT_MS,
	);
});
