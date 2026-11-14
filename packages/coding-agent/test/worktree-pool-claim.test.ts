import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, test } from "vitest";
import { bunExecutable, sleep } from "../../../test/helpers/runtime.js";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import {
	type PreparedSessionResume,
	type PrepareSessionResumeOptions,
	prepareSessionResume,
} from "../src/core/resume/session-resume.js";
import { latestResumeTimings } from "../src/core/resume/timings.js";
import { SessionManager } from "../src/core/session-manager.js";
import {
	openSessionInWorktree,
	releaseSessionWorktrees,
	resumeSessionWorktree,
} from "../src/core/session-worktree-snapshots.js";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.js";
import {
	claimIdleWorktree,
	holdRestoredWorktree,
	type PoolSlotRecord,
	pooledWorktreeHolder,
	pooledWorktreePath,
	releaseRestoredWorktree,
	repositoryIdOf,
	type SlotNumber,
} from "../src/core/worktree-snapshot/pool.js";
import { removeRestoredWorktree, verifyWorktree } from "../src/core/worktree-snapshot/restore.js";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.js";
import type { WorktreeSnapshot } from "../src/core/worktree-snapshot/types.js";

useTemporaryAgentDir();

const settings = DEFAULT_WORKTREE_SNAPSHOT_SETTINGS;
/** A Bun child that loads the snapshot modules and claims a slot before it is killed. */
const CHILD_PROCESS_TIMEOUT_MS = 60_000;
/** What the benchmark fixture's maintenance spends installing when its marker is missing. */
const INSTALL_MS = 2_000;
/** How much faster a resume that claims the slot holding the install must be (spec S5). */
const CLAIM_SAVES_AT_LEAST_MS = 1_500;
/** Four resumes, one of them waiting out the install, on a loaded machine. */
const BENCHMARK_TIMEOUT_MS = 60_000;

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
const Y = { kind: "session" as const, id: "session-y" };
const claimOptions = () => ({ storeDir: storeDir(), owner: Y, settings, blobs: store.snapshotBlobs });

function slot(snapshot: WorktreeSnapshot, n: number): string {
	return pooledWorktreePath(storeDir(), repositoryIdOf(snapshot.remotes), n as SlotNumber);
}

function recordFile(snapshot: WorktreeSnapshot, n: number): string {
	return join(storeDir(), "pool", repositoryIdOf(snapshot.remotes), `${n}.json`);
}

function recordOf(snapshot: WorktreeSnapshot, n: number): PoolSlotRecord {
	return JSON.parse(readFileSync(recordFile(snapshot, n), "utf8")) as PoolSlotRecord;
}

async function capture(root: string): Promise<WorktreeSnapshot> {
	const result = await captureWorktreeSnapshot(root, { settings, blobs: store.snapshotBlobs });
	assert.equal(result.status, "captured");
	if (result.status !== "captured") throw new Error("unreachable");
	return result.snapshot;
}

/**
 * Two snapshots of one checkout that ignores `node_modules/` and `build/`: A edits `file.txt` and adds the untracked
 * `only-a.txt`; B edits `file.txt` differently, without `only-a.txt`, and `edit` may change more. The checkout is then
 * moved away, so every session restores.
 */
async function twoSnapshots(edit?: (clone: string) => void) {
	const { clone } = await sandbox.remoteWithClone("repo", {
		".gitignore": "node_modules/\nbuild/\n",
		"README.md": "hello\n",
	});
	sandbox.write(join(clone, "file.txt"), "A\n");
	sandbox.write(join(clone, "only-a.txt"), "A only\n");
	const a = await capture(clone);
	rmSync(join(clone, "only-a.txt"));
	sandbox.write(join(clone, "file.txt"), "B\n");
	edit?.(clone);
	const b = await capture(clone);
	renameSync(clone, sandbox.path("repo-away"));
	return { a, b, clone };
}

async function sessionOf(clone: string, snapshot: WorktreeSnapshot): Promise<SessionManager> {
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
async function resume(
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
async function idleSlotOfX(a: WorktreeSnapshot, clone: string) {
	const x = await sessionOf(clone, a);
	const first = await resume(x);
	assert.equal(first.sessionManager.getCwd(), slot(a, 0));
	sandbox.write(join(slot(a, 0), "node_modules", "dep", ".installed"), "marker\n");
	await releaseSessionWorktrees(first.sessionManager);
	return first.sessionManager;
}

describe("claiming an idle pooled worktree on resume (#4748)", () => {
	test("a resume claims another session's idle slot, resets it to its snapshot and keeps node_modules (#4748)", async () => {
		const { a, b, clone } = await twoSnapshots();
		await idleSlotOfX(a, clone);
		const y = await sessionOf(clone, b);

		const prepared = await resume(y);

		const root = slot(b, 0);
		assert.equal(prepared.sessionManager.getCwd(), root);
		assert.equal(readFileSync(join(root, "file.txt"), "utf8"), "B\n");
		assert.equal(existsSync(join(root, "only-a.txt")), false);
		assert.equal(readFileSync(join(root, "node_modules", "dep", ".installed"), "utf8"), "marker\n");
		await verifyWorktree(b, root, { settings });
		assert.deepEqual(await pooledWorktreeHolder(storeDir(), root), {
			owner: { kind: "session", id: y.getSessionId() },
			held: true,
		});
		const record = recordOf(b, 0);
		assert.deepEqual(record.lastState, { snapshotId: b.id, head: b.head, tree: b.tree });
		assert.equal(record.releasedAt, null);
		assert.equal(record.resetting, undefined);
		assert.equal(existsSync(slot(b, 1)), false);
		const timings = latestResumeTimings(prepared.sessionManager);
		assert.deepEqual(
			timings?.restores.map((restore) => restore.mode),
			["claimed"],
		);
	});

	test("the previous owner of a claimed slot restores fresh on its next resume and loses nothing (#4748)", async () => {
		const { a, b, clone } = await twoSnapshots();
		const x = await idleSlotOfX(a, clone);
		await resume(await sessionOf(clone, b));

		const again = await resume(x);

		assert.equal(again.sessionManager.getCwd(), slot(a, 1));
		assert.equal(readFileSync(join(slot(a, 1), "file.txt"), "utf8"), "A\n");
		assert.equal(readFileSync(join(slot(a, 1), "only-a.txt"), "utf8"), "A only\n");
		assert.equal(readFileSync(join(slot(a, 0), "file.txt"), "utf8"), "B\n");
		assert.deepEqual(
			latestResumeTimings(again.sessionManager)?.restores.map((restore) => restore.mode),
			["fresh"],
		);
	});

	const fallbacks: [string, (root: string) => void, string][] = [
		["an uncaptured edit", (root) => sandbox.write(join(root, "file.txt"), "uncaptured\n"), "file.txt"],
		["an untracked file", (root) => sandbox.write(join(root, "notes.txt"), "mine\n"), "notes.txt"],
		["a .env no snapshot records", (root) => sandbox.write(join(root, ".env"), "TOKEN=1\n"), ".env"],
	];
	for (const [what, change, file] of fallbacks) {
		test(`a slot holding ${what} is not claimed: the resume restores fresh and the slot keeps it (#4748)`, async () => {
			const { a, b, clone } = await twoSnapshots();
			const x = await idleSlotOfX(a, clone);
			change(slot(a, 0));
			const kept = readFileSync(join(slot(a, 0), file), "utf8");

			assert.deepEqual(await claimIdleWorktree(b, claimOptions()), { claimed: false, reason: "dirty" });
			const prepared = await resume(await sessionOf(clone, b));

			assert.equal(prepared.sessionManager.getCwd(), slot(b, 1));
			assert.equal(readFileSync(join(slot(b, 1), "file.txt"), "utf8"), "B\n");
			assert.equal(readFileSync(join(slot(a, 0), file), "utf8"), kept);
			assert.deepEqual(recordOf(a, 0).holder, { kind: "session", id: x.getSessionId() });
		});
	}

	test("a slot its owner holds is busy: the resume restores fresh and leaves it alone (#4748)", async () => {
		const { a, b, clone } = await twoSnapshots();
		const x = await idleSlotOfX(a, clone);
		const held = await holdRestoredWorktree(storeDir(), slot(a, 0), { kind: "session", id: x.getSessionId() });
		assert.ok(held);
		try {
			assert.deepEqual(await claimIdleWorktree(b, claimOptions()), { claimed: false, reason: "busy" });
			const prepared = await resume(await sessionOf(clone, b));

			assert.equal(prepared.sessionManager.getCwd(), slot(b, 1));
			assert.equal(readFileSync(join(slot(a, 0), "file.txt"), "utf8"), "A\n");
		} finally {
			await releaseRestoredWorktree(held);
		}
	});

	test("a reset that fails verification leaves the slot marked; the resume restores fresh and eviction removes it (#4748)", async () => {
		// B stops ignoring build/, so the build output A's slot keeps there becomes an untracked file B never recorded.
		const { a, b, clone } = await twoSnapshots((root) => sandbox.write(join(root, ".gitignore"), "node_modules/\n"));
		await idleSlotOfX(a, clone);
		sandbox.write(join(slot(a, 0), "build", "out.txt"), "built\n");

		assert.deepEqual(await claimIdleWorktree(b, claimOptions()), { claimed: false, reason: "verify-failed" });
		assert.deepEqual(recordOf(a, 0).resetting, { snapshotId: b.id, head: b.head, tree: b.tree });
		assert.deepEqual(recordOf(a, 0).holder, Y);
		assert.deepEqual(await claimIdleWorktree(b, claimOptions()), { claimed: false, reason: "dirty" });

		const prepared = await resume(await sessionOf(clone, b), { pool: { maxIdlePerRepository: 5 } });

		assert.equal(prepared.sessionManager.getCwd(), slot(b, 1));
		await verifyWorktree(b, slot(b, 1), { settings });
		assert.equal(existsSync(slot(a, 0)), false);
		assert.equal(existsSync(recordFile(a, 0)), false);
	});

	test("a claim whose snapshot content is missing gives the slot back to its owner untouched (#4748)", async () => {
		const { a, b, clone } = await twoSnapshots();
		const x = await idleSlotOfX(a, clone);
		const before = recordOf(a, 0);

		// Without the blob storage, B's change set cannot be read, and the store does not hold B's tree.
		assert.deepEqual(await claimIdleWorktree(b, { ...claimOptions(), blobs: undefined }), {
			claimed: false,
			reason: "fetch-failed",
		});

		assert.deepEqual(recordOf(a, 0), before);
		assert.deepEqual(await pooledWorktreeHolder(storeDir(), slot(a, 0)), {
			owner: { kind: "session", id: x.getSessionId() },
			held: false,
		});
		assert.equal(readFileSync(join(slot(a, 0), "file.txt"), "utf8"), "A\n");
	});

	test.skipIf(process.platform === "win32")(
		"a claim killed with SIGKILL mid-reset leaves a slot the next claim skips and eviction removes (#4748)",
		async () => {
			const { a, b, clone } = await twoSnapshots();
			const x = await idleSlotOfX(a, clone);
			// The child's Git stops for good right after the reset wrote the slot's files, before HEAD moves.
			const mark = sandbox.path("reset-written");
			const git = sandbox.path("git-wrapper.sh");
			writeFileSync(
				git,
				`#!/bin/sh\nfor arg in "$@"; do\n\tif [ "$arg" = "--no-deref" ]; then : > ${JSON.stringify(mark)}; exec sleep 600; fi\ndone\nexec git "$@"\n`,
			);
			chmodSync(git, 0o755);
			const patches: Record<string, string> = {};
			for (const link of b.chain) {
				if (link.patch === null) continue;
				patches[link.patch] = Buffer.from((await store.snapshotBlobs.getBlob(link.patch))!).toString("base64");
			}
			const script = sandbox.path("claim.ts");
			const module = (path: string) =>
				JSON.stringify(fileURLToPath(new URL(`../src/core/worktree-snapshot/${path}`, import.meta.url)));
			writeFileSync(
				script,
				`import { claimIdleWorktree } from ${module("pool.ts")};
import { withWorktreeSnapshotGit } from ${module("git.ts")};
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from ${module("settings.ts")};
const patches = ${JSON.stringify(patches)};
const blobs = { getBlob: async (hash) => patches[hash] === undefined ? undefined : new Uint8Array(Buffer.from(patches[hash], "base64")) };
const env = { ...${JSON.stringify(sandbox.executable.env)}, PATH: process.env.PATH };
await withWorktreeSnapshotGit({ path: ${JSON.stringify(git)}, env }, () =>
	claimIdleWorktree(${JSON.stringify(b)}, { storeDir: ${JSON.stringify(storeDir())}, owner: { kind: "session", id: "killed" }, settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS, blobs }),
);
`,
			);
			const child = spawn(bunExecutable(), [script], { stdio: ["ignore", "inherit", "inherit"] });
			const exited = new Promise((resolve) => child.once("exit", resolve));
			try {
				while (!existsSync(mark)) {
					assert.equal(child.exitCode, null, "the claim ended before it reset the slot");
					await sleep(20);
				}
			} finally {
				child.kill("SIGKILL");
				await exited;
			}
			assert.equal(readFileSync(join(slot(a, 0), "file.txt"), "utf8"), "B\n");
			assert.deepEqual(recordOf(a, 0).resetting, { snapshotId: b.id, head: b.head, tree: b.tree });
			assert.deepEqual(recordOf(a, 0).holder, { kind: "session", id: "killed" });
			// Nothing refreshes the killed process's lease: once older than the stale time, the slot is idle.
			const pool = join(storeDir(), "pool", repositoryIdOf(a.remotes));
			const past = new Date(Date.now() - 120_000);
			for (const name of readdirSync(pool).filter((entry) => entry.endsWith(".lock"))) {
				utimesSync(join(pool, name), past, past);
			}

			assert.deepEqual(await claimIdleWorktree(b, claimOptions()), { claimed: false, reason: "dirty" });
			// The previous owner restores fresh, as its slot belongs to the killed claim; eviction removes that slot.
			const again = await resume(x);
			assert.equal(again.sessionManager.getCwd(), slot(a, 1));
			assert.equal(readFileSync(join(slot(a, 1), "only-a.txt"), "utf8"), "A only\n");
			assert.equal(existsSync(slot(a, 0)), false);
			assert.equal(existsSync(recordFile(a, 0)), false);
		},
		CHILD_PROCESS_TIMEOUT_MS,
	);

	test(
		"a resume that claims the slot an install filled is at least 1.5 s faster than a fresh one (#4748)",
		async () => {
			const { a, b, clone } = await twoSnapshots();
			// POSIX paths: the step runs in bash on every platform, where a backslash would escape the next character.
			const installed = "node_modules/.installed";
			const installs = sandbox.path("installs.log").replace(/\\/g, "/");
			const blueprints = {
				blueprints: "build" as const,
				blueprint: {
					agentDir: sandbox.path("agent"),
					setupCommand: `test -f ${installed} || { echo install >> ${JSON.stringify(installs)}; sleep ${INSTALL_MS / 1000} && mkdir -p node_modules && : > ${installed}; }`,
					trusted: () => true,
				},
			};
			const timed = async (snapshot: WorktreeSnapshot) => {
				const started = performance.now();
				const prepared = await resume(await sessionOf(clone, snapshot), blueprints);
				const ms = performance.now() - started;
				assert.equal(prepared.sessionManager.getCwd(), slot(a, 0));
				await releaseSessionWorktrees(prepared.sessionManager);
				return ms;
			};
			const freshMs = await timed(a);
			// The best of a few claims, alternating snapshots so each resets the slot, so one load spike cannot fail it.
			const claimedMs = Math.min(await timed(b), await timed(a), await timed(b));

			assert.equal(readFileSync(sandbox.path("installs.log"), "utf8"), "install\n");
			assert.ok(
				freshMs - claimedMs >= CLAIM_SAVES_AT_LEAST_MS,
				`fresh ${Math.round(freshMs)} ms, best claimed ${Math.round(claimedMs)} ms`,
			);
		},
		BENCHMARK_TIMEOUT_MS,
	);
});

describe("pooled resume edges (#4748)", () => {
	test("a pooled resume that continues in its own idle slot holds it, so no claim can take it meanwhile (#4748)", async () => {
		const { a, b, clone } = await twoSnapshots();
		const x = await sessionOf(clone, a);
		opened.push(x);
		const pool = { settings, storeDir: storeDir(), pool: { maxIdlePerRepository: 2 } };
		assert.equal(await resumeSessionWorktree(x, pool).then((result) => result.status), "restored");
		await releaseSessionWorktrees(x);
		const owner = { kind: "session" as const, id: x.getSessionId() };

		assert.equal((await resumeSessionWorktree(x, pool)).status, "verified");

		assert.deepEqual(await pooledWorktreeHolder(storeDir(), slot(a, 0)), { owner, held: true });
		assert.deepEqual(await claimIdleWorktree(b, claimOptions()), { claimed: false, reason: "busy" });
		await releaseSessionWorktrees(x);

		const continued = await openSessionInWorktree(x, pool);
		opened.push(continued.sessionManager);
		assert.equal(continued.sessionManager.getCwd(), slot(a, 0));
		assert.deepEqual(await pooledWorktreeHolder(storeDir(), slot(a, 0)), { owner, held: true });
		await releaseSessionWorktrees(x);
		assert.deepEqual(await claimIdleWorktree(b, claimOptions()), { claimed: false, reason: "busy" });
		await releaseSessionWorktrees(continued.sessionManager);
		assert.deepEqual(await pooledWorktreeHolder(storeDir(), slot(a, 0)), { owner, held: false });
	});

	test("a resume without pool settings keeps two idle slots by default (#4748)", async () => {
		const { a, clone } = await twoSnapshots();
		const sessions: SessionManager[] = [];
		for (let n = 0; n < 4; n++) sessions.push((await resume(await sessionOf(clone, a))).sessionManager);
		assert.deepEqual(
			sessions.map((session) => session.getCwd()),
			[0, 1, 2, 3].map((n) => slot(a, n)),
		);
		for (const session of sessions) {
			await releaseSessionWorktrees(session);
			await sleep(5);
		}

		const fifth = await resume(await sessionOf(clone, a));

		assert.equal(fifth.sessionManager.getCwd(), slot(a, 3));
		assert.equal(existsSync(slot(a, 0)), false);
		assert.equal(existsSync(slot(a, 1)), true);
		assert.equal(existsSync(slot(a, 2)), true);
	});

	test("only a pooled restore treats a slot another session holds as gone; its owner's own slot verifies (#4748)", async () => {
		const { a, clone } = await twoSnapshots();
		const x = await sessionOf(clone, a);
		opened.push(x);
		const pool = { settings, storeDir: storeDir(), pool: { maxIdlePerRepository: 2 } };
		const first = await resumeSessionWorktree(x, pool);
		assert.equal(first.status === "restored" && first.mappings[0]?.to, slot(a, 0));
		assert.equal((await resumeSessionWorktree(x, pool)).status, "verified");
		await releaseSessionWorktrees(x);
		writeFileSync(recordFile(a, 0), JSON.stringify({ ...recordOf(a, 0), holder: Y }));
		const held = await holdRestoredWorktree(storeDir(), slot(a, 0), Y);
		assert.ok(held);
		try {
			assert.equal((await resumeSessionWorktree(x, { settings, storeDir: storeDir() })).status, "verified");
			const pooled = await resumeSessionWorktree(x, pool);
			assert.equal(pooled.status === "restored" && pooled.mappings[0]?.to, slot(a, 1));
		} finally {
			await releaseRestoredWorktree(held);
		}
	});

	test("a resume that reuses the launch checkout keeps a changed sibling slot the session owns (#4748)", async () => {
		const { clone: main } = await sandbox.remoteWithClone("main");
		const { clone: sibling } = await sandbox.remoteWithClone("sibling");
		const x = await SessionManager.create(store, main);
		for (const root of [main, sibling]) {
			sandbox.write(join(root, "file.txt"), `${root}\n`);
			const snapshot = await capture(root);
			await x.appendWorktreeSnapshot(root, snapshot.id, snapshot);
		}
		const launch = sandbox.path("launch");
		cpSync(main, launch, { recursive: true });
		renameSync(main, sandbox.path("main-away"));
		renameSync(sibling, sandbox.path("sibling-away"));
		const first = await resume(x);
		const mainSlot = first.sessionManager.getCwd();
		const siblingSlot = first.sessionManager
			.getWorktreeRootMappings()
			.find((mapping) => mapping.from === sibling)!.to;
		await releaseSessionWorktrees(first.sessionManager);
		opened.pop();
		await removeRestoredWorktree(mainSlot, { storeDir: storeDir() });
		sandbox.write(join(siblingSlot, "file.txt"), "uncaptured sibling work\n");

		const again = await resume(first.sessionManager, { launchCwd: launch });

		assert.equal(again.sessionManager.getCwd(), launch);
		assert.equal(readFileSync(join(siblingSlot, "file.txt"), "utf8"), "uncaptured sibling work\n");
		assert.ok(
			again.notices.some(
				(notice) =>
					notice.message.includes(siblingSlot) && notice.message.includes("the session worked in it on this node"),
			),
			JSON.stringify(again.notices),
		);
	});
});
