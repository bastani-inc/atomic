import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, test } from "vitest";
import { bunExecutable } from "../../../test/helpers/runtime.js";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import {
	continueSessionWhereItWorked,
	type PreparedSessionResume,
	type PrepareSessionResumeOptions,
	prepareSessionResume,
	sessionResumeOptions,
} from "../src/core/resume/session-resume.js";
import { SessionManager } from "../src/core/session-manager.js";
import {
	pooledWorktreeOwnedElsewhere,
	releaseSessionWorktrees,
	resumeSessionWorktree,
	SessionWorktreeSnapshotRecorder,
} from "../src/core/session-worktree-snapshots.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.js";
import {
	admitPooledWorktree,
	discardPooledWorktree,
	evictIdleWorktrees,
	holdRestoredWorktree,
	type PoolSlotRecord,
	pooledWorktreeHolder,
	pooledWorktreePath,
	recordPooledWorktreeState,
	releaseRestoredWorktree,
	repositoryIdOf,
	type SlotNumber,
} from "../src/core/worktree-snapshot/pool.js";
import { removeRestoredWorktree } from "../src/core/worktree-snapshot/restore.js";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.js";
import type { WorktreeSnapshot } from "../src/core/worktree-snapshot/types.js";

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

function recordOfFile(repository: string, n: number): PoolSlotRecord {
	return JSON.parse(readFileSync(join(storeDir(), "pool", repository, `${n}.json`), "utf8")) as PoolSlotRecord;
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

/** The session a ready resume opened, which a later resume of it continues from, as the CLI reopens it. */
function resumed(prepared: PreparedSessionResume, fallback: SessionManager): SessionManager {
	return prepared.status === "ready" ? prepared.sessionManager : fallback;
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
				// A second process of the same session shares the slot with a lease of its own (Greptile P1 on #4781).
				const shared = await holdRestoredWorktree(storeDir(), root, owner);
				assert.ok(shared);
				await releaseRestoredWorktree(shared);
				assert.deepEqual(await pooledWorktreeHolder(storeDir(), root), { owner, held: true });
				assert.equal(recordOf(snapshot, 0).releasedAt, null);
				assert.deepEqual(
					await evictIdleWorktrees(storeDir(), repositoryIdOf(snapshot.remotes), { maxIdle: 0, settings }),
					[],
				);
				assert.equal(existsSync(root), true);
			} finally {
				child.kill("SIGKILL");
				await exited;
			}
			// Nothing refreshes the killed process's lease: once older than the stale time, the slot is idle.
			const pool = join(storeDir(), "pool", repositoryIdOf(snapshot.remotes));
			const leases = readdirSync(pool).filter((name) => name.endsWith(".lease.lock"));
			assert.equal(leases.length, 1);
			const past = new Date(Date.now() - 120_000);
			utimesSync(join(pool, leases[0]!), past, past);
			assert.deepEqual(await pooledWorktreeHolder(storeDir(), root), { owner, held: false });
			assert.deepEqual(
				readdirSync(pool).filter((name) => name.endsWith(".lease.lock")),
				[],
			);

			const lease = await holdRestoredWorktree(storeDir(), root, owner);
			assert.ok(lease);
			assert.deepEqual(await pooledWorktreeHolder(storeDir(), root), { owner, held: true });
			await releaseRestoredWorktree(lease);
		},
		CHILD_PROCESS_TIMEOUT_MS,
	);

	test("two concurrent holds in one process both share the slot, which stays held until both release it (#4748)", async () => {
		const { snapshot, clone } = await recordedSnapshot();
		const manager = await sessionOf(clone, snapshot);
		const root = await restoredRoot(manager);
		await releaseSessionWorktrees(manager);
		const owner = { kind: "session" as const, id: manager.getSessionId() };

		const [first, second] = await Promise.all([
			holdRestoredWorktree(storeDir(), root, owner),
			holdRestoredWorktree(storeDir(), root, owner),
		]);

		assert.ok(first && second);
		await releaseRestoredWorktree(first);
		assert.deepEqual(await pooledWorktreeHolder(storeDir(), root), { owner, held: true });
		assert.deepEqual(
			await evictIdleWorktrees(storeDir(), repositoryIdOf(snapshot.remotes), { maxIdle: 0, settings }),
			[],
		);
		await releaseRestoredWorktree(second);
		assert.deepEqual(await pooledWorktreeHolder(storeDir(), root), { owner, held: false });
	});

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

		const again = await prepareSessionResume(resumed(first, x), prepareOptions());

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

		const again = await prepareSessionResume(resumed(first, x), prepareOptions());

		assert.equal(again.status === "ready" && again.sessionManager.getCwd(), slot(snapshot, 0));
		assert.equal(readFileSync(join(slot(snapshot, 0), "file.txt"), "utf8"), "uncaptured work\n");
		assert.equal(existsSync(slot(snapshot, 1)), false);
		assert.deepEqual(await pooledWorktreeHolder(storeDir(), slot(snapshot, 0)), {
			owner: { kind: "session", id: x.getSessionId() },
			held: true,
		});
		if (again.status === "ready") opened.push(again.sessionManager);
	});

	test("a resume started inside a slot another session owns does not reuse it, even when it matches (#4748)", async () => {
		const { snapshot, clone } = await recordedSnapshot();
		const x = await sessionOf(clone, snapshot);
		const first = await prepareSessionResume(x, prepareOptions());
		assert.equal(first.status, "ready");
		if (first.status !== "ready") return;
		await releaseSessionWorktrees(first.sessionManager);
		const file = join(storeDir(), "pool", repositoryIdOf(snapshot.remotes), "0.json");
		writeFileSync(file, JSON.stringify({ ...recordOf(snapshot, 0), holder: { kind: "session", id: "session-y" } }));

		const prepared = await prepareSessionResume(resumed(first, x), prepareOptions({ launchCwd: slot(snapshot, 0) }));

		assert.equal(prepared.status, "ready");
		if (prepared.status !== "ready") return;
		opened.push(prepared.sessionManager);
		assert.equal(prepared.sessionManager.getCwd(), slot(snapshot, 1));
		assert.deepEqual(
			prepared.notices.filter((notice) => notice.message.startsWith(`Resuming in ${slot(snapshot, 0)}`)),
			[],
		);
	});

	test("restoring a sibling checkout never evicts the idle slot the session continues in (#4748)", async () => {
		const { clone: a } = await sandbox.remoteWithClone("a");
		const b = sandbox.path("b");
		await sandbox.git(sandbox.root, "clone", "-q", sandbox.path("a.git"), b);
		const x = await SessionManager.create(store, a);
		for (const root of [a, b]) {
			sandbox.write(join(root, "file.txt"), `${root}\n`);
			const capture = await captureWorktreeSnapshot(root, { settings, blobs: store.snapshotBlobs });
			assert.equal(capture.status, "captured");
			if (capture.status !== "captured") return;
			await x.appendWorktreeSnapshot(root, capture.snapshot.id, capture.snapshot);
		}
		renameSync(a, sandbox.path("a-away"));
		renameSync(b, sandbox.path("b-away"));
		const first = await prepareSessionResume(x, prepareOptions({ pool: { maxIdlePerRepository: 0 } }));
		assert.equal(first.status, "ready");
		if (first.status !== "ready") return;
		const cwd = first.sessionManager.getCwd();
		const sibling = first.sessionManager.getWorktreeRootMappings().find((mapping) => mapping.from === b)!.to;
		await releaseSessionWorktrees(first.sessionManager);
		await removeRestoredWorktree(sibling, { storeDir: storeDir() });

		const again = await prepareSessionResume(
			resumed(first, x),
			prepareOptions({ pool: { maxIdlePerRepository: 0 } }),
		);

		assert.equal(again.status === "ready" && again.sessionManager.getCwd(), cwd);
		assert.equal(existsSync(cwd), true);
		if (again.status === "ready") opened.push(again.sessionManager);
	});

	test("a woken session holds its slot before rebuilding its blueprints, so no eviction can remove it meanwhile (#4748)", async () => {
		const { snapshot, clone } = await recordedSnapshot();
		const x = await sessionOf(clone, snapshot);
		const first = await prepareSessionResume(x, prepareOptions());
		assert.equal(first.status, "ready");
		if (first.status !== "ready") return;
		await releaseSessionWorktrees(first.sessionManager);
		const pool = join(storeDir(), "pool", repositoryIdOf(snapshot.remotes));
		const leasedDuringBuild: boolean[] = [];

		const woken = await continueSessionWhereItWorked(
			first.sessionManager,
			prepareOptions({
				blueprints: "build",
				blueprint: {
					agentDir: sandbox.path("agent"),
					setupCommand: "true",
					trusted: () => {
						leasedDuringBuild.push(readdirSync(pool).some((name) => name.endsWith(".lease.lock")));
						return true;
					},
				},
			}),
		);
		opened.push(woken);

		assert.ok(leasedDuringBuild.length > 0);
		assert.deepEqual(new Set(leasedDuringBuild), new Set([true]));
		assert.equal(woken.getCwd(), slot(snapshot, 0));
		assert.deepEqual(await pooledWorktreeHolder(storeDir(), slot(snapshot, 0)), {
			owner: { kind: "session", id: x.getSessionId() },
			held: true,
		});
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

	test("an idle slot holding a file no snapshot records, such as an untracked .env, is never evicted (#4748)", async () => {
		const { snapshot, clone } = await recordedSnapshot();
		const sessions = await Promise.all([1, 2].map(() => sessionOf(clone, snapshot)));
		for (const session of sessions) await restoredRoot(session, 0);
		for (const session of sessions) await releaseSessionWorktrees(session);
		sandbox.write(join(slot(snapshot, 0), ".env"), "TOKEN=secret\n");

		await restoredRoot(await sessionOf(clone, snapshot), 0);

		assert.equal(readFileSync(join(slot(snapshot, 0), ".env"), "utf8"), "TOKEN=secret\n");
		assert.equal(existsSync(slot(snapshot, 1)), false);
	});

	test("an idle slot with staged edits that differ from its files is never evicted (#4748)", async () => {
		const { snapshot, clone } = await recordedSnapshot();
		const sessions = await Promise.all([1, 2].map(() => sessionOf(clone, snapshot)));
		for (const session of sessions) await restoredRoot(session, 0);
		for (const session of sessions) await releaseSessionWorktrees(session);
		const staged = slot(snapshot, 0);
		sandbox.write(join(staged, "README.md"), "staged only\n");
		await sandbox.git(staged, "add", "README.md");
		sandbox.write(join(staged, "README.md"), "hello\n");

		await restoredRoot(await sessionOf(clone, snapshot), 0);

		assert.equal(await sandbox.git(staged, "show", ":README.md"), "staged only");
		assert.equal(existsSync(slot(snapshot, 1)), false);
	});

	test("an ignored .env keeps an idle slot, while ignored build output does not (#4748)", async () => {
		const { clone } = await sandbox.remoteWithClone("ignoring", {
			".gitignore": ".env\nnode_modules/\n",
			"README.md": "hi\n",
		});
		sandbox.write(join(clone, "file.txt"), "recorded\n");
		const capture = await captureWorktreeSnapshot(clone, { settings, blobs: store.snapshotBlobs });
		assert.equal(capture.status, "captured");
		if (capture.status !== "captured") return;
		const snapshot = capture.snapshot;
		renameSync(clone, sandbox.path("ignoring-away"));
		const sessions = await Promise.all([1, 2, 3].map(() => sessionOf(clone, snapshot)));
		for (const session of sessions.slice(0, 2)) await restoredRoot(session, 0);
		for (const session of sessions.slice(0, 2)) await releaseSessionWorktrees(session);
		sandbox.write(join(slot(snapshot, 0), ".env"), "TOKEN=secret\n");
		sandbox.write(join(slot(snapshot, 1), "node_modules", "dep", "index.js"), "module.exports = 1;\n");

		await restoredRoot(sessions[2]!, 0);

		assert.equal(readFileSync(join(slot(snapshot, 0), ".env"), "utf8"), "TOKEN=secret\n");
		assert.equal(existsSync(slot(snapshot, 1)), false);
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

describe("worktree pool records and leases (#4748)", () => {
	const admission = (remotes: readonly string[]) => ({
		storeDir: storeDir(),
		remotes,
		lastState: { snapshotId: "a1", head: "1".repeat(40), tree: "2".repeat(40) },
		envHash: "env",
	});
	const owner = { kind: "session" as const, id: "session-x" };

	test("a slot's record names its path, holder and state, and the repository id is the object store's name (#4748)", async () => {
		const remotes = ["https://example.com/a.git"];
		const lease = await admitPooledWorktree(admission(remotes), owner);
		const repository = repositoryIdOf(remotes);
		assert.match(repository, /^[0-9a-f]{24}$/);
		assert.equal(lease.path, join(storeDir(), "worktrees", `${repository}-0`));
		const record = JSON.parse(readFileSync(join(storeDir(), "pool", repository, "0.json"), "utf8")) as PoolSlotRecord;
		assert.deepEqual(record, {
			version: 1,
			repository,
			slot: 0,
			path: lease.path,
			holder: owner,
			lastState: admission(remotes).lastState,
			envHash: "env",
			blueprintDigest: null,
			releasedAt: null,
		});
		const degraded = { snapshotId: "a1", head: "3".repeat(40), tree: "4".repeat(40) };
		await recordPooledWorktreeState(lease, degraded);
		// The same snapshot at release keeps the state recorded for the slot.
		await releaseRestoredWorktree(lease, { snapshotId: "a1", head: "1".repeat(40), tree: "2".repeat(40) });
		await releaseRestoredWorktree(lease, { snapshotId: "b2", head: "5".repeat(40), tree: "6".repeat(40) });
		const released = JSON.parse(
			readFileSync(join(storeDir(), "pool", repository, "0.json"), "utf8"),
		) as PoolSlotRecord;
		assert.deepEqual(released.lastState, degraded);
		assert.match(released.releasedAt ?? "", /^\d{4}-\d\d-\d\dT/);
		await recordPooledWorktreeState(lease, { snapshotId: "c3", head: "7".repeat(40), tree: "8".repeat(40) });
		assert.deepEqual(recordOfFile(repository, 0).lastState, degraded);
	});

	test("a new snapshot at release becomes the slot's state (#4748)", async () => {
		const remotes = ["https://example.com/b.git"];
		const lease = await admitPooledWorktree(admission(remotes), owner);
		const next = { snapshotId: "b2", head: "5".repeat(40), tree: "6".repeat(40) };
		await releaseRestoredWorktree(lease, next);
		assert.deepEqual(recordOfFile(repositoryIdOf(remotes), 0).lastState, next);
	});

	test("admission skips a slot with an orphan directory or a live lock, and a discarded slot is free again (#4748)", async () => {
		const remotes = ["https://example.com/c.git"];
		const repository = repositoryIdOf(remotes);
		mkdirSync(join(storeDir(), "worktrees", `${repository}-0`), { recursive: true });
		mkdirSync(join(storeDir(), "pool", repository), { recursive: true });
		const unlock = await lockfile.lock(join(storeDir(), "pool", repository, "1.json"), { realpath: false });
		try {
			const lease = await admitPooledWorktree(admission(remotes), owner);
			assert.equal(lease.slot, 2);
			const second = await admitPooledWorktree(admission(remotes), owner);
			assert.equal(second.slot, 3);
			await discardPooledWorktree(lease);
			assert.equal(existsSync(join(storeDir(), "pool", repository, "2.json")), false);
			await discardPooledWorktree(lease);
			assert.equal((await admitPooledWorktree(admission(remotes), owner)).slot, 2);
		} finally {
			await unlock();
		}
	});

	test("an unreadable or foreign record makes a slot owned by no session (#4748)", async () => {
		const remotes = ["https://example.com/d.git"];
		const repository = repositoryIdOf(remotes);
		const lease = await admitPooledWorktree(admission(remotes), owner);
		await releaseRestoredWorktree(lease);
		const file = join(storeDir(), "pool", repository, "0.json");
		const valid = recordOfFile(repository, 0);
		const variants: Record<string, unknown>[] = [
			{ ...valid, version: 2 },
			{ ...valid, repository: "0".repeat(24) },
			{ ...valid, slot: 1 },
			{ ...valid, path: join(storeDir(), "elsewhere") },
			{ ...valid, holder: null },
			{ ...valid, holder: { kind: "person", id: "session-x" } },
			{ ...valid, holder: { kind: "session", id: 7 } },
			{ ...valid, lastState: { ...valid.lastState, head: 1 } },
			{ ...valid, lastState: { ...valid.lastState, tree: null } },
			{ ...valid, lastState: { ...valid.lastState, snapshotId: 3 } },
			{ ...valid, envHash: 4 },
			{ ...valid, blueprintDigest: 5 },
			{ ...valid, releasedAt: 6 },
		];
		for (const variant of variants) {
			writeFileSync(file, JSON.stringify(variant));
			assert.deepEqual(
				await pooledWorktreeHolder(storeDir(), lease.path),
				{ owner: null, held: false },
				JSON.stringify(variant),
			);
			assert.equal(await pooledWorktreeOwnedElsewhere(storeDir(), lease.path, "session-x"), true);
			assert.equal(await holdRestoredWorktree(storeDir(), lease.path, owner), undefined);
		}
		writeFileSync(file, "{ not json");
		assert.deepEqual(await pooledWorktreeHolder(storeDir(), lease.path), { owner: null, held: false });
		for (const prebuild of [{ ...valid, holder: { kind: "prebuild", id: "session-x" } }]) {
			writeFileSync(file, JSON.stringify(prebuild));
			assert.equal(await pooledWorktreeOwnedElsewhere(storeDir(), lease.path, "session-x"), true);
		}
		writeFileSync(
			file,
			JSON.stringify({ ...valid, blueprintDigest: "d", lastState: { ...valid.lastState, snapshotId: null } }),
		);
		assert.equal(await pooledWorktreeOwnedElsewhere(storeDir(), lease.path, "session-x"), false);
	});

	test("only a slot path directly under worktrees is pooled (#4748)", async () => {
		const remotes = ["https://example.com/e.git"];
		const lease = await admitPooledWorktree(admission(remotes), owner);
		const name = `${repositoryIdOf(remotes)}-0`;
		for (const path of [join(sandbox.path("elsewhere"), name), join(storeDir(), "worktrees", "nested", name)]) {
			assert.equal(await pooledWorktreeHolder(storeDir(), path), "unpooled");
			assert.equal(await holdRestoredWorktree(storeDir(), path, owner), undefined);
		}
		for (const other of [`${repositoryIdOf(remotes)}-x`, `${repositoryIdOf(remotes)}`, `x${name}`, `${name}-1`]) {
			assert.equal(await pooledWorktreeHolder(storeDir(), join(storeDir(), "worktrees", other)), "unpooled");
		}
		assert.equal(
			await pooledWorktreeHolder(storeDir(), join(storeDir(), "worktrees", `${repositoryIdOf(remotes)}-9`)),
			"unpooled",
		);
		assert.deepEqual(await pooledWorktreeHolder(storeDir(), lease.path), { owner, held: true });
		// Another owner never shares a slot this process holds.
		assert.equal(await holdRestoredWorktree(storeDir(), lease.path, { kind: "session", id: "session-y" }), undefined);
		assert.equal(
			await holdRestoredWorktree(storeDir(), lease.path, { kind: "prebuild", id: "session-x" }),
			undefined,
		);
		await releaseRestoredWorktree(lease);
	});

	test("eviction drops records of slots whose directory is gone, never touching held slots or other files (#4748)", async () => {
		const remotes = ["https://example.com/f.git"];
		const repository = repositoryIdOf(remotes);
		const idle = await admitPooledWorktree(admission(remotes), owner);
		const held = await admitPooledWorktree(admission(remotes), owner);
		await releaseRestoredWorktree(idle);
		writeFileSync(join(storeDir(), "pool", repository, "notes.json"), "{}");
		assert.deepEqual(await evictIdleWorktrees(storeDir(), repository, { maxIdle: 1, settings }), []);
		assert.deepEqual(await evictIdleWorktrees(storeDir(), repository, { maxIdle: 0, settings }), [idle.path]);
		assert.equal(existsSync(join(storeDir(), "pool", repository, "0.json")), false);
		assert.equal(existsSync(join(storeDir(), "pool", repository, "1.json")), true);
		assert.equal(existsSync(join(storeDir(), "pool", repository, "notes.json")), true);
		assert.deepEqual(
			await evictIdleWorktrees(storeDir(), "0".repeat(24) as typeof repository, { maxIdle: 0, settings }),
			[],
		);
		await releaseRestoredWorktree(held);
	});
});
