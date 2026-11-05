import assert from "node:assert/strict";
import type { WorktreeSnapshot } from "@bastani/atomic";
import { test } from "vitest";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { RUN_EVENT_TYPES, type RunEvent } from "../../packages/workflows/src/durable/journal/types.js";
import {
	listWorkflowSnapshotBoundaries,
	workflowSnapshotFrontier,
} from "../../packages/workflows/src/durable/worktree-snapshots.js";

function snapshot(root: string, tree: string): WorktreeSnapshot {
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
	};
}

test("journal snapshot boundaries retain all siblings in sequence and select the last per root (#4245)", async () => {
	const journal = new MemoryRunJournal();
	await journal.createRun({ runId: "run", name: "run", cwd: "/a", status: "running", createdAt: 1 });
	const acquired = await journal.acquire("run", "holder");
	assert.equal(acquired.status, "acquired");
	if (acquired.status !== "acquired") throw new Error("lease not acquired");
	const snapshots = [snapshot("/a", "T1"), snapshot("/b", "B1"), snapshot("/a", "T2"), snapshot("/a", "T3")];
	for (const [index, item] of snapshots.entries()) {
		const event = {
			type: RUN_EVENT_TYPES.checkpointRecorded,
			payload: {
				kind: index % 2 === 0 ? "tool" : "stage",
				workflowId: "run",
				checkpointId: `checkpoint-${index}`,
				worktreeSnapshots: [item],
			},
		} as unknown as RunEvent;
		await journal.append(acquired.lease, event);
	}
	const boundaries = await listWorkflowSnapshotBoundaries(journal, "run");
	assert.deepEqual(
		boundaries.map(({ seq, checkpointId, root }) => [seq, checkpointId, root]),
		[
			[1, "checkpoint-0", "/a"],
			[2, "checkpoint-1", "/b"],
			[3, "checkpoint-2", "/a"],
			[4, "checkpoint-3", "/a"],
		],
	);
	assert.equal(boundaries[2]?.snapshot.tree, "T2");
	const frontier = workflowSnapshotFrontier(boundaries);
	assert.deepEqual(
		frontier.map(({ root, snapshot: item }) => [root, item.tree]),
		[
			["/b", "B1"],
			["/a", "T3"],
		],
	);
	await journal.close();
});
