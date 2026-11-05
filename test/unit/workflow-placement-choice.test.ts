import assert from "node:assert/strict";
import { test } from "vitest";
import type { PoolClaimCandidate } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { choosePlacement, sharedSettlement } from "../../packages/workflows/src/workers/placement-choice.js";
import {
	isWorkspaceBinding,
	type WorkspaceBinding,
	workspaceAffinityKey,
} from "../../packages/workflows/src/workers/workspace-binding.js";

const bound = (tree: string): WorkspaceBinding => ({ remotes: ["r"], head: "h", tree, envHash: "e" });
const candidate = (id: string, workspace?: WorkspaceBinding): PoolClaimCandidate => ({
	id,
	generation: 0,
	...(workspace === undefined ? {} : { workspace }),
});
const warmOnly =
	(trees: Record<string, string>) =>
	async (binding: WorkspaceBinding): Promise<string | undefined> =>
		trees[binding.tree];

test("a host claims bound work it has warm first, wherever it is in the queue (#4310)", async () => {
	const choice = await choosePlacement(
		[candidate("free"), candidate("cold", bound("t1")), candidate("warm", bound("t2"))],
		warmOnly({ t2: "/work/t2" }),
		true,
	);
	assert.deepEqual(choice, { candidate: candidate("warm", bound("t2")), worktree: "/work/t2", restore: false });
});

test("without warm work a host takes the oldest unbound or restorable work (#4310)", async () => {
	assert.deepEqual(
		await choosePlacement([candidate("cold", bound("t1")), candidate("free")], warmOnly({}), true),
		{ candidate: candidate("cold", bound("t1")), restore: true },
		"a host that can restore takes the oldest, bound or not",
	);
	assert.deepEqual(await choosePlacement([candidate("free"), candidate("cold", bound("t1"))], warmOnly({}), true), {
		candidate: candidate("free"),
		restore: false,
	});
});

test("a host that can neither find nor restore a tree never takes its bound work (#4310)", async () => {
	assert.deepEqual(await choosePlacement([candidate("cold", bound("t1")), candidate("free")], warmOnly({}), false), {
		candidate: candidate("free"),
		restore: false,
	});
	assert.equal(await choosePlacement([candidate("cold", bound("t1"))], warmOnly({}), false), undefined);
	assert.equal(await choosePlacement([], warmOnly({}), true), undefined);
	assert.deepEqual(
		await choosePlacement([candidate("warm", bound("t1"))], warmOnly({ t1: "/w" }), false),
		{ candidate: candidate("warm", bound("t1")), worktree: "/w", restore: false },
		"a warm tree needs no restore",
	);
});

test("the root settles other hosts' work: results, exhausted attempts and an expired claim window (#4310)", () => {
	const context = {
		reported: false,
		heldHere: false,
		epoch: 2,
		attempts: 0,
		maxAttempts: 3,
		readyForMs: 0,
		claimWindowMs: 1_000,
	};
	const ready = { state: "ready" as const, epoch: 2, execution: {} };
	const readyBound = { ...ready, execution: { workspaceBinding: { tree: "t" } } };
	assert.equal(sharedSettlement({ ...ready, state: "completed" }, context), "report-result");
	assert.equal(sharedSettlement({ ...ready, state: "completed" }, { ...context, reported: true }), "none");
	assert.equal(sharedSettlement({ ...ready, state: "completed" }, { ...context, heldHere: true }), "none");
	// Work that is not ready in this incarnation is never settled here, however many attempts it had.
	const exhausted = { ...context, attempts: 9 };
	assert.equal(sharedSettlement({ ...ready, state: "leased" }, exhausted), "none");
	assert.equal(sharedSettlement({ ...ready, state: "failed" }, exhausted), "none");
	assert.equal(sharedSettlement({ ...ready, epoch: 1 }, exhausted), "none", "an earlier incarnation's work waits");
	assert.equal(sharedSettlement(ready, { ...context, attempts: 3 }), "attempts-exhausted");
	assert.equal(sharedSettlement(ready, { ...context, attempts: 2 }), "none");
	assert.equal(sharedSettlement(ready, { ...context, readyForMs: 5_000 }), "none", "unbound work has no window");
	assert.equal(sharedSettlement(readyBound, { ...context, readyForMs: 999 }), "none");
	assert.equal(sharedSettlement(readyBound, { ...context, readyForMs: 1_000 }), "claim-window-passed");
	assert.equal(
		sharedSettlement(readyBound, { ...context, readyForMs: 5_000, attempts: 3 }),
		"attempts-exhausted",
		"an exhausted child fails as such, bound or not",
	);
});

test("a binding is well formed when its identity fields are strings and its informational ones strings or absent (#4310)", () => {
	const valid = { remotes: ["a", "b"], head: "h", tree: "t", envHash: "" };
	assert.equal(isWorkspaceBinding(valid), true);
	assert.equal(isWorkspaceBinding({ ...valid, remotes: [] }), true);
	assert.equal(isWorkspaceBinding({ ...valid, root: "/r", branch: "main", worktree: "/w" }), true);
	for (const broken of [
		null,
		undefined,
		"binding",
		[valid],
		{ ...valid, remotes: "a" },
		{ ...valid, remotes: ["a", 1] },
		{ ...valid, head: 1 },
		{ ...valid, tree: undefined },
		{ ...valid, envHash: null },
		{ ...valid, root: 1 },
		{ ...valid, branch: false },
		{ ...valid, worktree: {} },
	])
		assert.equal(isWorkspaceBinding(broken), false, JSON.stringify(broken));
});

test("affinity is the repository's remotes, in any order, and the tree; nothing else (#4310)", () => {
	const key = workspaceAffinityKey({ remotes: ["b", "a"], tree: "t" });
	assert.equal(key, JSON.stringify([["a", "b"], "t"]));
	assert.equal(workspaceAffinityKey({ remotes: ["a", "b"], tree: "t" }), key);
	assert.notEqual(workspaceAffinityKey({ remotes: ["a", "b"], tree: "u" }), key);
	const remotes = ["b", "a"];
	workspaceAffinityKey({ remotes, tree: "t" });
	assert.deepEqual(remotes, ["b", "a"], "the binding's own remotes are left in their order");
});
