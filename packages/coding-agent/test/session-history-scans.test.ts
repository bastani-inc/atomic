import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.js";
import { SessionManager } from "../src/core/session-manager.js";
import type { WorktreeSnapshot } from "../src/core/worktree-snapshot/types.js";

const scans = vi.hoisted(() => ({ branchWalks: 0, branchEntries: 0, nameEntries: 0 }));

vi.mock("../src/core/session-manager-history.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/core/session-manager-history.ts")>();
	return {
		...original,
		getBranchPath: (fromId: string | null | undefined, byId: ReadonlyMap<string, SessionEntry>) => {
			const path = original.getBranchPath(fromId, byId);
			scans.branchWalks++;
			scans.branchEntries += path.length;
			return path;
		},
	};
});

vi.mock("../src/core/session-manager-entries.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/core/session-manager-entries.ts")>();
	return {
		...original,
		getLatestSessionName: (entries: Parameters<typeof original.getLatestSessionName>[0]) => {
			scans.nameEntries += entries.length;
			return original.getLatestSessionName(entries);
		},
	};
});

const ROOT = "/work/project";
const RESTORED = "/agent/worktree-snapshots/worktrees/abc";

function snapshot(id: string): WorktreeSnapshot {
	return {
		version: 1,
		id,
		root: ROOT,
		head: "a".repeat(40),
		branch: "main",
		tree: "b".repeat(40),
		remotes: ["https://example.com/project.git"],
		patches: [],
		bundles: [],
		omitted: [],
		settings: { maxFileBytes: 1, excludes: [] },
	} as unknown as WorktreeSnapshot;
}

/** A session of about `turns * 2` entries with a name, snapshot records and a recorded restore. */
async function longSession(turns: number): Promise<SessionManager> {
	const manager = SessionManager.inMemory(ROOT);
	await manager.appendSessionInfo("long-running");
	for (let turn = 0; turn < turns; turn++) {
		await manager.appendMessage({ role: "user", content: `request ${turn}`, timestamp: turn });
		if (turn % 100 === 0) {
			await manager.appendWorktreeSnapshot(ROOT, `snapshot-${turn}`, snapshot(`snapshot-${turn}`));
		} else {
			await manager.appendCustomEntry("probe", { turn });
		}
	}
	await manager.appendWorktreeSnapshot(RESTORED, "snapshot-0", undefined, {
		from: ROOT,
		to: RESTORED,
		snapshotId: "snapshot-0",
		tree: "b".repeat(40),
		restoredAt: new Date(0).toISOString(),
	});
	return manager;
}

function readEverything(manager: SessionManager): void {
	manager.getBranch();
	manager.getWorktreeRootMappings();
	manager.getLatestWorktreeSnapshots();
	manager.getWorktreeSnapshotRecords();
	manager.getSessionName();
	manager.buildSessionContext();
}

beforeEach(() => {
	scans.branchWalks = 0;
	scans.branchEntries = 0;
	scans.nameEntries = 0;
});
afterEach(() => vi.restoreAllMocks());

test("repeated reads of a long session walk its branch at most once and rescan nothing (#4660)", async () => {
	const manager = await longSession(2_000);
	scans.branchWalks = 0;
	scans.branchEntries = 0;
	scans.nameEntries = 0;
	readEverything(manager);
	const first = { ...scans };
	assert.ok(first.branchWalks <= 1, `${first.branchWalks} walks`);
	assert.ok(first.branchEntries <= manager.getEntryCount());

	for (let read = 0; read < 25; read++) readEverything(manager);

	assert.deepEqual({ ...scans }, first);
	assert.equal(manager.getSessionName(), "long-running");
	assert.deepEqual(
		manager.getWorktreeRootMappings().map((mapping) => mapping.to),
		[RESTORED],
	);
	assert.deepEqual([...manager.getLatestWorktreeSnapshots().keys()], [ROOT, RESTORED]);
	assert.equal(manager.getWorktreeSnapshotRecords().size, 20);
});

test("appending at the leaf extends what was read without walking the history again (#4660)", async () => {
	const manager = await longSession(500);
	readEverything(manager);
	const walks = scans.branchWalks;
	const named = scans.nameEntries;

	await manager.appendSessionInfo("renamed");
	await manager.appendWorktreeSnapshot(ROOT, "snapshot-late", snapshot("snapshot-late"));
	await manager.appendMessage({ role: "user", content: "later", timestamp: 1 });
	readEverything(manager);

	assert.equal(scans.branchWalks, walks);
	assert.equal(scans.nameEntries, named + 3);
	assert.equal(manager.getSessionName(), "renamed");
	assert.equal(manager.getLatestWorktreeSnapshots().get(ROOT)?.id, "snapshot-late");
	assert.equal(manager.getWorktreeSnapshotRecords().get("snapshot-late")?.id, "snapshot-late");
	assert.equal(manager.getBranch().at(-1)?.type, "message");
});

test("reads after moving the leaf follow the new branch (#4660)", async () => {
	const manager = await longSession(300);
	const early = manager.getBranch()[3]!;
	const before = manager.getWorktreeRootMappings();
	assert.equal(before.length, 1);

	await manager.branch(early.id);

	assert.equal(manager.getBranch().length, 4);
	assert.deepEqual(manager.getWorktreeRootMappings(), []);
	assert.deepEqual([...manager.getLatestWorktreeSnapshots().keys()], [ROOT]);
	await manager.appendMessage({ role: "user", content: "on the side branch", timestamp: 2 });
	assert.equal(manager.getBranch().length, 5);
	assert.equal(manager.getBranch()[3]?.id, early.id);
});

test("a caller changing the branch it got back does not change the next read (#4660)", async () => {
	const manager = await longSession(50);
	const branch = manager.getBranch();
	const length = branch.length;
	branch.length = 0;
	const mappings = manager.getWorktreeRootMappings();
	mappings.length = 0;
	const records = manager.getWorktreeSnapshotRecords();
	records.clear();

	assert.equal(manager.getBranch().length, length);
	assert.equal(manager.getWorktreeRootMappings().length, 1);
	assert.equal(manager.getWorktreeSnapshotRecords().size, 1);
});

test("a restore appended before the restores were first read is listed once (#4660)", async () => {
	const manager = await longSession(30);
	manager.getBranch();
	await manager.appendWorktreeSnapshot("/agent/worktree-snapshots/worktrees/def", "snapshot-0", undefined, {
		from: RESTORED,
		to: "/agent/worktree-snapshots/worktrees/def",
		snapshotId: "snapshot-0",
		tree: "b".repeat(40),
		restoredAt: new Date(0).toISOString(),
	});
	assert.deepEqual(
		manager.getWorktreeRootMappings().map((mapping) => mapping.to),
		[RESTORED, "/agent/worktree-snapshots/worktrees/def"],
	);
	await manager.appendMessage({ role: "user", content: "after", timestamp: 3 });
	assert.equal(manager.getWorktreeRootMappings().length, 2);
	assert.deepEqual(
		[...manager.getLatestWorktreeSnapshots().keys()],
		[ROOT, RESTORED, "/agent/worktree-snapshots/worktrees/def"],
	);
	assert.equal(manager.getWorktreeSnapshotRecords().get("snapshot-0")?.id, "snapshot-0");
});
