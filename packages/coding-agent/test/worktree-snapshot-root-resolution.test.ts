import assert from "node:assert/strict";
import { test, vi } from "vitest";

const lstats = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const lstat = ((...args: Parameters<typeof actual.lstat>) => {
		lstats.count++;
		return actual.lstat(...args);
	}) as typeof actual.lstat;
	return { ...actual, default: { ...actual, lstat }, lstat };
});

import { currentWorktreeSnapshots } from "../src/core/session-worktree-snapshots.ts";
import type { WorktreeSnapshot } from "../src/core/worktree-snapshot/types.ts";

async function lstatsForSnapshots(count: number): Promise<number> {
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
	const current = await currentWorktreeSnapshots({
		getBranch: () => branch,
		getWorktreeRootMappings: () => [
			{ from: "/work/original", to: "/work/checkout", snapshotId: "s0", tree: "t", restoredAt: "t" },
		],
		getWorktreeSnapshotRecords: () => records,
	});
	assert.equal(current.size, 1);
	return lstats.count;
}

test("resolves each recorded checkout root once however many snapshots the session holds (#5249)", async () => {
	assert.equal(await lstatsForSnapshots(2_000), await lstatsForSnapshots(10));
});
