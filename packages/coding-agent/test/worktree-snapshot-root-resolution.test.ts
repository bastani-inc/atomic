import assert from "node:assert/strict";
import { test, vi } from "vitest";

const lstats = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const lstatSync = ((...args: Parameters<typeof actual.lstatSync>) => {
		lstats.count++;
		return actual.lstatSync(...args);
	}) as typeof actual.lstatSync;
	return { ...actual, default: { ...actual, lstatSync }, lstatSync };
});

import { currentWorktreeSnapshots } from "../src/core/session-worktree-snapshots.ts";
import type { WorktreeSnapshot } from "../src/core/worktree-snapshot/types.ts";

function lstatsForSnapshots(count: number): number {
	const branch = Array.from({ length: count }, (_, i) => ({
		type: "worktree_snapshot" as const,
		id: `snapshot-${i}`,
		parentId: i === 0 ? null : `snapshot-${i - 1}`,
		timestamp: "2026-11-16T00:00:00.000Z",
		root: "/work/checkout",
		snapshotId: `s${i}`,
	}));
	const records = new Map(branch.map((entry) => [entry.snapshotId, { id: entry.snapshotId } as WorktreeSnapshot]));
	lstats.count = 0;
	const current = currentWorktreeSnapshots({
		getBranch: () => branch,
		getWorktreeRootMappings: () => [
			{ from: "/work/original", to: "/work/checkout", snapshotId: "s0", tree: "t", restoredAt: "t" },
		],
		getWorktreeSnapshotRecords: () => records,
	});
	assert.equal(current.size, 1);
	return lstats.count;
}

test("resolves each recorded checkout root once however many snapshots the session holds (#5249)", () => {
	assert.equal(lstatsForSnapshots(2_000), lstatsForSnapshots(10));
});
