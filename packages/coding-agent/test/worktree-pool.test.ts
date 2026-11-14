import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, test } from "vitest";
import { bunExecutable } from "../../../test/helpers/runtime.js";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import {
	type PrepareSessionResumeOptions,
	prepareSessionResume,
	sessionResumeOptions,
} from "../src/core/resume/session-resume.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	releaseSessionWorktrees,
	resumeSessionWorktree,
	SessionWorktreeSnapshotRecorder,
} from "../src/core/session-worktree-snapshots.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.ts";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.ts";
import {
	holdRestoredWorktree,
	type PoolSlotRecord,
	pooledWorktreeHolder,
	pooledWorktreePath,
	releaseRestoredWorktree,
	repositoryIdOf,
	type SlotNumber,
} from "../src/core/worktree-snapshot/pool.ts";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.ts";
import type { WorktreeSnapshot } from "../src/core/worktree-snapshot/types.ts";

useTemporaryAgentDir();

const settings = DEFAULT_WORKTREE_SNAPSHOT_SETTINGS;
/** A Bun child that loads the snapshot modules and takes a lease before it is killed. */
const CHILD_PROCESS_TIMEOUT_MS = 60_000;

let sandbox: GitSandbox;
let store: SqlSessionStore;
let database: Awaited<ReturnType<typeof openNodeSqliteDatabase>>;
const opened: SessionManager[] = [];

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

const storeDir = () => sandbox.path("host");
const pool = (maxIdlePerRepository = 2) => ({
	settings,
	storeDir: storeDir(),
	pool: { maxIdlePerRepository },
});

/** A clone with an edit, and its snapshot; the clone is then moved away so every session must restore it. */
async function recordedSnapshot(): Promise<{ snapshot: WorktreeSnapshot; clone: string }> {
	const { clone } = await sandbox.remoteWithClone();
	sandbox.write(join(clone, "file.txt"), "recorded\n");
	const capture = await captureWorktreeSnapshot(clone, { settings, blobs: store.snapshotBlobs });
	assert.equal(capture.status, "captured");
	if (capture.status !== "captured") throw new Error("unreachable");
	renameSync(clone, sandbox.path(`away-${Date.now()}`));
	return { snapshot: capture.snapshot, clone };
}

/** A new session that recorded `snapshot` of `clone`. */
async function sessionOf(clone: string, snapshot: WorktreeSnapshot): Promise<SessionManager> {
	const manager = await SessionManager.create(store, clone);
	await manager.appendWorktreeSnapshot(clone, snapshot.id, snapshot);
	opened.push(manager);
	return manager;
}

function slot(snapshot: WorktreeSnapshot, n: number): string {
	return pooledWorktreePath(storeDir(), repositoryIdOf(snapshot.remotes), n as SlotNumber);
}

function recordOf(snapshot: WorktreeSnapshot, n: number): PoolSlotRecord {
	const file = join(storeDir(), "pool", repositoryIdOf(snapshot.remotes), `${n}.json`);
	return JSON.parse(readFileSync(file, "utf8")) as PoolSlotRecord;
}

async function restoredRoot(manager: SessionManager, maxIdle = 2): Promise<string> {
	const result = await resumeSessionWorktree(manager, pool(maxIdle));
	assert.equal(result.status, "restored");
	if (result.status !== "restored") throw new Error("unreachable");
	return result.mappings[0]!.to;
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

describe("worktree pool slots (#4748)", () => {
	test("a session resume restores into slot 0, and the same path again after that restore was removed (#4748)", async () => {
		const { snapshot, clone } = await recordedSnapshot();
		const manager = await sessionOf(clone, snapshot);
		let rolledBack: string | undefined;
		await assert.rejects(
			resumeSessionWorktree(manager, {
				...pool(),
				beforeRecord: async (mappings) => {
					rolledBack = mappings[0]!.to;
					throw new Error("stop before recording");
				},
			}),
			/stop before recording/,
		);
		assert.equal(rolledBack, slot(snapshot, 0));
		assert.equal(existsSync(slot(snapshot, 0)), false);
		assert.equal(await pooledWorktreeHolder(storeDir(), slot(snapshot, 0)), "unpooled");

		const root = await restoredRoot(manager);

		assert.equal(root, slot(snapshot, 0));
		assert.equal(readFileSync(join(root, "file.txt"), "utf8"), "recorded\n");
	});

	test("two sessions restoring the same repository get different slots (#4748)", async () => {
		const { snapshot, clone } = await recordedSnapshot();
		const [first, second] = await Promise.all([sessionOf(clone, snapshot), sessionOf(clone, snapshot)]);
		const roots = await Promise.all([restoredRoot(first), restoredRoot(second)]);
		assert.deepEqual(roots.sort(), [slot(snapshot, 0), slot(snapshot, 1)]);
	});

	test("a slot is held while its session is open and idle, still owned, once it closes (#4748)", async () => {
		const { snapshot, clone } = await recordedSnapshot();
		const manager = await sessionOf(clone, snapshot);
		const root = await restoredRoot(manager);
		const owner = { kind: "session", id: manager.getSessionId() };
		assert.deepEqual(await pooledWorktreeHolder(storeDir(), root), { owner, held: true });
		assert.equal(recordOf(snapshot, 0).releasedAt, null);

		const recorder = new SessionWorktreeSnapshotRecorder({
			sessionManager: manager,
			cwd: () => root,
			settings: () => settings,
			declaresWrites: () => false,
			onUnavailable: () => {},
		});
		await recorder.releaseWorktrees();

		assert.deepEqual(await pooledWorktreeHolder(storeDir(), root), { owner, held: false });
		const record = recordOf(snapshot, 0);
		assert.notEqual(record.releasedAt, null);
		assert.deepEqual(record.lastState, { snapshotId: snapshot.id, head: snapshot.head, tree: snapshot.tree });
	});

	test(
		"a lease held by a process killed with SIGKILL goes stale, and its owner can hold the slot again (#4748)",
		async () => {
			const { snapshot, clone } = await recordedSnapshot();
			const manager = await sessionOf(clone, snapshot);
			const root = await restoredRoot(manager);
			await releaseSessionWorktrees(manager);
			const owner = { kind: "session" as const, id: manager.getSessionId() };
			const script = sandbox.path("hold.ts");
			const poolModule = fileURLToPath(new URL("../src/core/worktree-snapshot/pool.ts", import.meta.url));
			writeFileSync(
				script,
				`import { holdRestoredWorktree } from ${JSON.stringify(poolModule)};
const lease = await holdRestoredWorktree(${JSON.stringify(storeDir())}, ${JSON.stringify(root)}, ${JSON.stringify(owner)});
process.stdout.write(lease ? "held\\n" : "refused\\n");
setInterval(() => {}, 1000);
`,
			);
			const child = spawn(bunExecutable(), [script], { stdio: ["ignore", "pipe", "inherit"] });
			const exited = new Promise((resolve) => child.once("exit", resolve));
			try {
				const line = await new Promise<string>((resolve, reject) => {
					child.stdout.once("data", (data: Buffer) => resolve(data.toString("utf8").trim()));
					child.once("error", reject);
				});
				assert.equal(line, "held");
				assert.deepEqual(await pooledWorktreeHolder(storeDir(), root), { owner, held: true });
				assert.equal(await holdRestoredWorktree(storeDir(), root, owner), undefined);
			} finally {
				child.kill("SIGKILL");
				await exited;
			}
			// Nothing refreshes the killed process's lock: once older than the stale time, the slot is idle.
			const lock = join(storeDir(), "pool", repositoryIdOf(snapshot.remotes), "0.json.lock");
			const past = new Date(Date.now() - 120_000);
			utimesSync(lock, past, past);
			assert.deepEqual(await pooledWorktreeHolder(storeDir(), root), { owner, held: false });

			const lease = await holdRestoredWorktree(storeDir(), root, owner);
			assert.ok(lease);
			assert.deepEqual(await pooledWorktreeHolder(storeDir(), root), { owner, held: true });
			await releaseRestoredWorktree(lease);
		},
		CHILD_PROCESS_TIMEOUT_MS,
	);

	test("only the owner holds a slot again, and a second hold in one process shares the lease (#4748)", async () => {
		const { snapshot, clone } = await recordedSnapshot();
		const manager = await sessionOf(clone, snapshot);
		const root = await restoredRoot(manager);
		await releaseSessionWorktrees(manager);
		const owner = { kind: "session" as const, id: manager.getSessionId() };

		assert.equal(await holdRestoredWorktree(storeDir(), root, { kind: "session", id: "other" }), undefined);
		const first = await holdRestoredWorktree(storeDir(), root, owner);
		const second = await holdRestoredWorktree(storeDir(), root, owner);
		assert.ok(first && second);
		await releaseRestoredWorktree(first);
		assert.deepEqual(await pooledWorktreeHolder(storeDir(), root), { owner, held: true });
		await releaseRestoredWorktree(second);
		assert.deepEqual(await pooledWorktreeHolder(storeDir(), root), { owner, held: false });
	});
});

describe("worktree pool ownership on resume (#4748)", () => {
	test("session X does not continue in its slot once session Y owns it, and restores fresh instead (#4748)", async () => {
		const { snapshot, clone } = await recordedSnapshot();
		const x = await sessionOf(clone, snapshot);
		const first = await prepareSessionResume(x, prepareOptions());
		assert.equal(first.status === "ready" && first.sessionManager.getCwd(), slot(snapshot, 0));
		await releaseSessionWorktrees(first.status === "ready" ? first.sessionManager : x);
		// Session Y takes the idle slot, as a claim does (S5), and changes it.
		const file = join(storeDir(), "pool", repositoryIdOf(snapshot.remotes), "0.json");
		const record = recordOf(snapshot, 0);
		writeFileSync(file, JSON.stringify({ ...record, holder: { kind: "session", id: "session-y" } }));
		sandbox.write(join(slot(snapshot, 0), "file.txt"), "session Y's work\n");

		const again = await prepareSessionResume(x, prepareOptions());

		assert.equal(again.status, "ready");
		if (again.status !== "ready") return;
		assert.equal(again.sessionManager.getCwd(), slot(snapshot, 1));
		assert.equal(readFileSync(join(slot(snapshot, 1), "file.txt"), "utf8"), "recorded\n");
		assert.equal(readFileSync(join(slot(snapshot, 0), "file.txt"), "utf8"), "session Y's work\n");
		assert.deepEqual(await pooledWorktreeHolder(storeDir(), slot(snapshot, 1)), {
			owner: { kind: "session", id: x.getSessionId() },
			held: true,
		});
		opened.push(again.sessionManager);
	});

	test("session X continues in its own released slot as it left it, and holds it again (#4748)", async () => {
		const { snapshot, clone } = await recordedSnapshot();
		const x = await sessionOf(clone, snapshot);
		const first = await prepareSessionResume(x, prepareOptions());
		assert.equal(first.status, "ready");
		if (first.status !== "ready") return;
		await releaseSessionWorktrees(first.sessionManager);
		sandbox.write(join(slot(snapshot, 0), "file.txt"), "uncaptured work\n");

		const again = await prepareSessionResume(x, prepareOptions());

		assert.equal(again.status === "ready" && again.sessionManager.getCwd(), slot(snapshot, 0));
		assert.equal(readFileSync(join(slot(snapshot, 0), "file.txt"), "utf8"), "uncaptured work\n");
		assert.equal(existsSync(slot(snapshot, 1)), false);
		assert.deepEqual(await pooledWorktreeHolder(storeDir(), slot(snapshot, 0)), {
			owner: { kind: "session", id: x.getSessionId() },
			held: true,
		});
		if (again.status === "ready") opened.push(again.sessionManager);
	});

	test("unpooled restores keep today's paths and ownership, as for workflow runs and earlier versions (#4748)", async () => {
		const { snapshot, clone } = await recordedSnapshot();
		const x = await sessionOf(clone, snapshot);
		const result = await resumeSessionWorktree(x, { settings, storeDir: storeDir() });
		assert.equal(result.status, "restored");
		if (result.status !== "restored") return;
		const root = result.mappings[0]!.to;
		assert.match(root, /[\\/]worktrees[\\/][0-9a-f]{12}-[0-9a-f]{8}$/);
		assert.equal(existsSync(join(storeDir(), "pool")), false);
		assert.equal(await pooledWorktreeHolder(storeDir(), root), "unpooled");
		sandbox.write(join(root, "file.txt"), "changed in place\n");

		const again = await prepareSessionResume(x, prepareOptions());

		assert.equal(again.status === "ready" && again.sessionManager.getCwd(), root);
		assert.equal(readFileSync(join(root, "file.txt"), "utf8"), "changed in place\n");
		assert.equal(existsSync(join(storeDir(), "pool")), false);
	});

	test("a resume restores outside the pool when the pool cannot be used (#4748)", async () => {
		const { snapshot, clone } = await recordedSnapshot();
		const x = await sessionOf(clone, snapshot);
		sandbox.write(join(storeDir(), "pool"), "not a directory\n");

		const prepared = await prepareSessionResume(x, prepareOptions());

		assert.equal(prepared.status, "ready");
		if (prepared.status !== "ready") return;
		const root = prepared.sessionManager.getCwd();
		assert.match(root, /[\\/]worktrees[\\/][0-9a-f]{12}-[0-9a-f]{8}$/);
		assert.equal(readFileSync(join(root, "file.txt"), "utf8"), "recorded\n");
	});
});

describe("worktree pool eviction (#4748)", () => {
	test("a restore removes the oldest unchanged idle slots beyond maxIdlePerRepository, keeping changed ones (#4748)", async () => {
		const { snapshot, clone } = await recordedSnapshot();
		const sessions = await Promise.all([1, 2, 3].map(() => sessionOf(clone, snapshot)));
		const roots: string[] = [];
		for (const session of sessions) roots.push(await restoredRoot(session, 2));
		assert.deepEqual(roots, [slot(snapshot, 0), slot(snapshot, 1), slot(snapshot, 2)]);
		// Released oldest first: slot 0, then 1, then 2. Slot 0 has work no snapshot recorded.
		for (const session of sessions) {
			await releaseSessionWorktrees(session);
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		sandbox.write(join(slot(snapshot, 0), "file.txt"), "uncaptured work\n");

		const fourth = await restoredRoot(await sessionOf(clone, snapshot), 2);

		// Three idle slots, two kept: slot 1, the oldest unchanged one, goes; slot 0 has changes and stays.
		assert.equal(existsSync(slot(snapshot, 1)), false);
		assert.equal(await pooledWorktreeHolder(storeDir(), slot(snapshot, 1)), "unpooled");
		assert.equal(readFileSync(join(slot(snapshot, 0), "file.txt"), "utf8"), "uncaptured work\n");
		assert.equal(existsSync(slot(snapshot, 2)), true);
		assert.equal(fourth, slot(snapshot, 3));
	});
});

describe("worktree pool settings (#4748)", () => {
	test("resume options read snapshots.pool.maxIdlePerRepository, and an invalid value falls back to 2 (#4748)", () => {
		const optionsWith = (pool: unknown) =>
			sessionResumeOptions(
				"cli",
				"/launch",
				"/agent",
				SettingsManager.inMemory({ snapshots: { pool } } as Parameters<typeof SettingsManager.inMemory>[0]),
				() => true,
			).pool;
		assert.deepEqual(optionsWith(undefined), { maxIdlePerRepository: 2 });
		assert.deepEqual(optionsWith({ maxIdlePerRepository: 0 }), { maxIdlePerRepository: 0 });
		assert.deepEqual(optionsWith({ maxIdlePerRepository: 5 }), { maxIdlePerRepository: 5 });
		for (const invalid of [-1, 1.5, "3"]) {
			assert.deepEqual(optionsWith({ maxIdlePerRepository: invalid }), { maxIdlePerRepository: 2 });
		}
	});
});
