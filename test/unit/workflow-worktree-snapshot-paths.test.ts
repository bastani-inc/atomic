import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { WorktreeRootMapping, WorktreeSnapshot } from "@bastani/atomic";
import { test } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.ts";
import { collectSnapshotGarbage } from "../../packages/coding-agent/src/core/worktree-snapshot/garbage.ts";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { RUN_EVENT_TYPES, type RunEvent } from "../../packages/workflows/src/durable/journal/types.js";
import {
	listWorkflowSnapshotBoundaries,
	mapWorkflowWorktreePath,
	stageWorktreeSnapshot,
	type WorkflowSnapshotBoundary,
	workflowSnapshotFrontier,
} from "../../packages/workflows/src/durable/worktree-snapshots.js";
import { durableRootRegistrationForRun } from "../../packages/workflows/src/engine/run-durable-registration.js";
import { ageBlobs, textBlob } from "../helpers/snapshot-reference-index.js";

const at = (...parts: string[]): string => join(sep, ...parts);

function mapping(from: string, to: string): WorktreeRootMapping {
	return { from, to, snapshotId: "snap", tree: "tree", restoredAt: "2026-01-01T00:00:00Z" };
}

function snapshot(root: string, tree: string, extra: Partial<WorktreeSnapshot> = {}): WorktreeSnapshot {
	return {
		version: 1,
		id: tree,
		root,
		remotes: [],
		branch: null,
		head: "head",
		snapshot: "commit",
		tree,
		envHash: "env",
		delta: { base: "head", patch: null, bytes: 0 },
		chain: [{ tree, patch: null, bytes: 0 }],
		bundle: null,
		omitted: [],
		filters: null,
		capturedAt: "2026-01-01T00:00:00Z",
		...extra,
	};
}

test("a restored worktree takes over paths under the root it replaced, keeping their repository-relative part (#4245)", () => {
	const mappings = [mapping(at("old", "repo"), at("new", "wt"))];
	assert.equal(mapWorkflowWorktreePath(at("old", "repo"), mappings), at("new", "wt"));
	assert.equal(mapWorkflowWorktreePath(at("old", "repo", "src", "a.ts"), mappings), at("new", "wt", "src", "a.ts"));
	assert.equal(mapWorkflowWorktreePath(at("new", "wt", "src"), mappings), at("new", "wt", "src"));
});

test("only paths inside a replaced root move: relative paths, parents, siblings and strangers stay (#4245)", () => {
	const mappings = [mapping(at("old", "repo"), at("new", "wt"))];
	assert.equal(mapWorkflowWorktreePath(join("src", "a.ts"), mappings), join("src", "a.ts"));
	assert.equal(mapWorkflowWorktreePath(at("old"), mappings), at("old"));
	assert.equal(mapWorkflowWorktreePath(at("old", "repo-extra", "x"), mappings), at("old", "repo-extra", "x"));
	assert.equal(mapWorkflowWorktreePath(at("elsewhere", "x"), mappings), at("elsewhere", "x"));
	assert.equal(mapWorkflowWorktreePath(at("old", "repo", "x"), []), at("old", "repo", "x"));
	const replacedWorkingDirectory = [mapping(process.cwd(), at("new", "wt"))];
	assert.equal(
		mapWorkflowWorktreePath(join("src", "a.ts"), replacedWorkingDirectory),
		join("src", "a.ts"),
		"a relative path is never read against the process's working directory",
	);
});

test.skipIf(process.platform === "win32")(
	"without restores an absolute path comes back as given, even one whose links cannot be resolved (symbolic links need a privilege on Windows) (#4245)",
	() => {
		const directory = mkdtempSync(join(tmpdir(), "atomic-workflow-paths-"));
		try {
			symlinkSync(join(directory, "loop"), join(directory, "loop"));
			const path = join(directory, "loop", "repo");
			assert.equal(mapWorkflowWorktreePath(path, []), path);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
);

test("the most specific replaced root wins, whatever order the restores were recorded in (#4245)", () => {
	const outer = mapping(at("a"), at("x"));
	const inner = mapping(at("a", "b"), at("y"));
	for (const mappings of [
		[outer, inner],
		[inner, outer],
	]) {
		assert.equal(mapWorkflowWorktreePath(at("a", "b", "c"), mappings), at("y", "c"));
		assert.equal(mapWorkflowWorktreePath(at("a", "z"), mappings), at("x", "z"));
	}
});

test("a root restored twice maps both the original and the first restore to the latest one (#4245)", () => {
	const mappings = [mapping(at("r"), at("s1")), mapping(at("r"), at("s2"))];
	assert.equal(mapWorkflowWorktreePath(at("r", "x"), mappings), at("s2", "x"));
	assert.equal(mapWorkflowWorktreePath(at("s1", "x"), mappings), at("s2", "x"));
	assert.equal(mapWorkflowWorktreePath(at("s2", "x"), mappings), at("s2", "x"));
});

test("a chain of restores leads every earlier location to the last one, and a cycle terminates (#4245)", () => {
	const chain = [mapping(at("r"), at("s")), mapping(at("s"), at("t"))];
	assert.equal(mapWorkflowWorktreePath(at("r", "x"), chain), at("t", "x"));
	assert.equal(mapWorkflowWorktreePath(at("s", "x"), chain), at("t", "x"));
	assert.equal(mapWorkflowWorktreePath(at("t", "x"), chain), at("t", "x"));
	const cycle = [mapping(at("a"), at("b")), mapping(at("b"), at("a"))];
	assert.equal(typeof mapWorkflowWorktreePath(at("a", "x"), cycle), "string");
});

test("the frontier keeps each root's latest boundary by journal sequence, however the boundaries are ordered (#4245)", () => {
	const boundary = (seq: number, root: string, tree: string): WorkflowSnapshotBoundary => ({
		seq,
		kind: "tool",
		checkpointId: `c${seq}`,
		root,
		snapshot: snapshot(root, tree),
	});
	assert.deepEqual(
		workflowSnapshotFrontier([boundary(5, "/a", "late"), boundary(2, "/a", "early"), boundary(3, "/b", "b")]).map(
			(entry) => [entry.root, entry.snapshot.tree],
		),
		[
			["/b", "b"],
			["/a", "late"],
		],
	);
	assert.deepEqual(
		workflowSnapshotFrontier([boundary(4, "/a", "first"), boundary(4, "/a", "second")]).map(
			(entry) => entry.snapshot.tree,
		),
		["second"],
	);
	assert.deepEqual(workflowSnapshotFrontier([]), []);
});

test("a stage summary names the snapshot and warns about omitted content and conversion filters (#4245)", () => {
	const clean = snapshot("/repo", "tree-clean");
	assert.deepEqual(stageWorktreeSnapshot(clean), {
		id: "tree-clean",
		root: "/repo",
		head: "head",
		tree: "tree-clean",
		omittedCount: 0,
		warnings: [],
	});
	const omitted = snapshot("/repo", "tree-omitted", {
		omitted: [
			{ reason: "denied", path: ".env" },
			{ reason: "over-file-cap", path: "big.bin", bytes: 9 },
		],
	});
	assert.deepEqual(stageWorktreeSnapshot(omitted).warnings, ["2 omitted item(s)"]);
	assert.equal(stageWorktreeSnapshot(omitted).omittedCount, 2);
	const filtered = snapshot("/repo", "tree-filtered", { filters: { autocrlf: "true", eol: null, drivers: [] } });
	assert.deepEqual(stageWorktreeSnapshot(filtered).warnings, ["Git conversion filters were used"]);
	assert.deepEqual(
		stageWorktreeSnapshot(
			snapshot("/repo", "both", {
				omitted: [{ reason: "denied", path: ".env" }],
				filters: { autocrlf: null, eol: null, drivers: ["lfs"] },
			}),
		).warnings,
		["1 omitted item(s)", "Git conversion filters were used"],
	);
});

async function journalWithRun(runId: string, header: { status?: string } = {}) {
	const journal = new MemoryRunJournal();
	await journal.createRun({ runId, name: runId, cwd: "/", status: header.status ?? "running", createdAt: 1 });
	const acquired = await journal.acquire(runId, "holder");
	assert.equal(acquired.status, "acquired");
	if (acquired.status !== "acquired") throw new Error("lease not acquired");
	const append = (type: string, payload: object) =>
		journal.append(acquired.lease, { type, payload } as unknown as RunEvent);
	return { journal, append };
}

test("only tool and stage checkpoints contribute boundaries; other events and kinds never do (#4245)", async () => {
	const { journal, append } = await journalWithRun("run");
	const carried = [snapshot("/repo", "carried")];
	await append(RUN_EVENT_TYPES.statusChanged, {
		kind: "tool",
		status: "paused",
		checkpointId: "status",
		worktreeSnapshots: carried,
	});
	await append(RUN_EVENT_TYPES.checkpointRecorded, { kind: "ui", checkpointId: "ui", worktreeSnapshots: carried });
	await append(RUN_EVENT_TYPES.checkpointRecorded, {
		kind: "boundary",
		checkpointId: "boundary",
		worktreeSnapshots: carried,
	});
	await append(RUN_EVENT_TYPES.checkpointRecorded, { kind: "tool", checkpointId: "bare" });
	await append(RUN_EVENT_TYPES.checkpointRecorded, {
		kind: "stage",
		checkpointId: "stage",
		worktreeSnapshots: carried,
	});
	assert.deepEqual(
		(await listWorkflowSnapshotBoundaries(journal, "run")).map(({ seq, kind, checkpointId, root }) => ({
			seq,
			kind,
			checkpointId,
			root,
		})),
		[{ seq: 5, kind: "stage", checkpointId: "stage", root: "/repo" }],
	);
	await journal.close();
});

/**
 * The trees whose patch blob a collection keeps after `events` are journaled to one run, in the order they were
 * journaled: what retention keeps, read through the reference index the journal maintains.
 */
async function retained(
	events: readonly { type: string; payload: object }[],
	header: { status?: string } = {},
): Promise<readonly string[]> {
	const directory = mkdtempSync(join(tmpdir(), "snapshot-retained-"));
	const database = await openNodeSqliteDatabase(join(directory, "journal.sqlite"));
	const journal = await SqlRunJournal.open(database);
	try {
		await journal.createRun({
			runId: "run",
			name: "run",
			cwd: "/",
			status: header.status ?? "running",
			createdAt: 1,
		});
		const acquired = await journal.acquire("run", "holder");
		if (acquired.status !== "acquired") throw new Error("lease not acquired");
		const trees: string[] = [];
		for (const event of events) {
			await journal.append(acquired.lease, event as unknown as RunEvent);
			const carried = (event.payload as { worktreeSnapshots?: WorktreeSnapshot[] }).worktreeSnapshots ?? [];
			trees.push(...carried.map((item) => item.tree));
		}
		await journal.snapshotBlobs.putBlobs(trees.map(textBlob));
		await ageBlobs(database, journal.snapshotBlobs.table, 10_000);
		await collectSnapshotGarbage(journal.snapshotBlobs);
		const kept = new Set(await journal.snapshotBlobs.listBlobHashes());
		return trees.filter((tree) => kept.has(textBlob(tree).hash));
	} finally {
		await journal.close();
		await database.close();
		rmSync(directory, { recursive: true, force: true });
	}
}

/** A snapshot of `tree` whose one patch blob is the text of `tree`. */
const patched = (tree: string) => snapshot("/repo", tree, { chain: [{ tree, patch: textBlob(tree).hash, bytes: 1 }] });
const checkpoint = (kind: string, tree: string) => ({
	type: RUN_EVENT_TYPES.checkpointRecorded,
	payload: { kind, checkpointId: `${kind}-${tree}`, worktreeSnapshots: [patched(tree)] },
});
const candidate = (type: string, fields: object) => ({
	type,
	payload: { workflowId: "run", status: "paused", completedCheckpoints: 1, pendingPrompts: 0, ...fields },
});

test("a resumable run pins the snapshots of its tool and stage checkpoints only (#4245)", async () => {
	assert.deepEqual(
		await retained([
			candidate(RUN_EVENT_TYPES.statusChanged, {}),
			checkpoint("tool", "tool"),
			checkpoint("ui", "ui"),
			checkpoint("stage", "stage"),
			{ type: RUN_EVENT_TYPES.checkpointRecorded, payload: { kind: "tool", checkpointId: "bare" } },
			{ type: RUN_EVENT_TYPES.checkpointRecorded, payload: { kind: "stage", checkpointId: "bare-stage" } },
			{
				type: RUN_EVENT_TYPES.promptAsked,
				payload: { kind: "tool", checkpointId: "prompt", worktreeSnapshots: [patched("prompt")] },
			},
		]),
		["tool", "stage"],
	);
});

test("a run's resumability comes from its latest well-formed start or status event (#4245)", async () => {
	const header = { status: "completed" };
	assert.deepEqual(
		await retained([candidate(RUN_EVENT_TYPES.runStarted, {}), checkpoint("tool", "kept")], header),
		["kept"],
		"a start event alone can mark a run resumable",
	);
	assert.deepEqual(
		await retained([candidate(RUN_EVENT_TYPES.statusChanged, {}), checkpoint("tool", "kept")], header),
		["kept"],
	);
	assert.deepEqual(
		await retained([candidate(RUN_EVENT_TYPES.promptAsked, {}), checkpoint("tool", "ignored")], {
			status: "completed",
		}),
		[],
		"other events never decide resumability",
	);
	for (const malformed of [{ workflowId: 7 }, { status: 7 }, { completedCheckpoints: "1" }, { pendingPrompts: "0" }]) {
		assert.deepEqual(
			await retained([
				candidate(RUN_EVENT_TYPES.runStarted, {}),
				checkpoint("tool", "kept"),
				candidate(RUN_EVENT_TYPES.runStarted, { status: "completed", ...malformed }),
			]),
			["kept"],
			`a start event with ${JSON.stringify(malformed)} is ignored`,
		);
	}
	assert.deepEqual(
		await retained([
			candidate(RUN_EVENT_TYPES.statusChanged, { resumable: false }),
			checkpoint("tool", "not-resumable"),
		]),
		[],
		"a status event can mark the run not resumable",
	);
	assert.deepEqual(
		await retained([
			candidate(RUN_EVENT_TYPES.statusChanged, {}),
			checkpoint("tool", "gone"),
			candidate(RUN_EVENT_TYPES.statusChanged, { status: "completed" }),
		]),
		[],
		"a later well-formed completed status ends retention",
	);
});

test("retention keeps a paused run's snapshots and releases a completed run's (#4245)", async () => {
	assert.deepEqual(await retained([candidate(RUN_EVENT_TYPES.statusChanged, {}), checkpoint("stage", "paused")]), [
		"paused",
	]);
	assert.deepEqual(
		await retained([candidate(RUN_EVENT_TYPES.statusChanged, { status: "completed" }), checkpoint("stage", "done")]),
		[],
	);
});

test("retention keeps a running run's checkpoints even when its last status predates them (#4245)", async () => {
	assert.deepEqual(
		await retained([
			candidate(RUN_EVENT_TYPES.runStarted, { status: "running", completedCheckpoints: 0 }),
			checkpoint("tool", "T1"),
		]),
		["T1"],
	);
});

test("without a status event, a run's header decides: completed and cancelled runs release their snapshots (#4245)", async () => {
	for (const [status, expected] of [
		["running", ["kept"]],
		["failed", ["kept"]],
		["paused", ["kept"]],
		["completed", []],
		["cancelled", []],
	] as const) {
		assert.deepEqual(await retained([checkpoint("tool", "kept")], { status }), expected, status);
	}
});

test("a durable registration records the run's snapshot settings only when it has some (#4245)", () => {
	const base = {
		runId: "run",
		name: "wf",
		inputs: {},
		createdAt: 1,
		hasPersistence: false,
		isChildRun: false,
		continuationSourceId: undefined,
	};
	assert.equal("snapshots" in (durableRootRegistrationForRun(base) ?? {}), false);
	assert.deepEqual(durableRootRegistrationForRun({ ...base, snapshots: { fullEvery: 4 } })?.snapshots, {
		fullEvery: 4,
	});
	assert.equal(durableRootRegistrationForRun({ ...base, isChildRun: true }), undefined);
});
