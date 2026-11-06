import assert from "node:assert/strict";
import { test } from "vitest";
import type { PoolClaimCandidate } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import {
	boundWait,
	childPlacement,
	choosePlacement,
	placedExecution,
	sharedSettlement,
	waitedMs,
} from "../../packages/workflows/src/workers/placement-choice.js";
import {
	bindingIdentity,
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
const always = () => true;
const never = () => false;
const warmOnly =
	(trees: Record<string, string>) =>
	async (binding: WorkspaceBinding): Promise<string | undefined> =>
		trees[binding.tree];

test("a host claims bound work it has warm first, wherever it is in the queue (#4310)", async () => {
	const choice = await choosePlacement(
		[candidate("free"), candidate("cold", bound("t1")), candidate("warm", bound("t2"))],
		warmOnly({ t2: "/work/t2" }),
		always,
	);
	assert.deepEqual(choice, { candidate: candidate("warm", bound("t2")), worktree: "/work/t2", restore: false });
});

test("without warm work a host takes the oldest unbound or restorable work (#4310)", async () => {
	assert.deepEqual(
		await choosePlacement([candidate("cold", bound("t1")), candidate("free")], warmOnly({}), always),
		{ candidate: candidate("cold", bound("t1")), restore: true },
		"a host that can restore takes the oldest, bound or not",
	);
	assert.deepEqual(await choosePlacement([candidate("free"), candidate("cold", bound("t1"))], warmOnly({}), always), {
		candidate: candidate("free"),
		restore: false,
	});
});

test("a host that can neither find nor restore a tree never takes its bound work (#4310)", async () => {
	assert.deepEqual(await choosePlacement([candidate("cold", bound("t1")), candidate("free")], warmOnly({}), never), {
		candidate: candidate("free"),
		restore: false,
	});
	assert.equal(await choosePlacement([candidate("cold", bound("t1"))], warmOnly({}), never), undefined);
	assert.equal(await choosePlacement([], warmOnly({}), always), undefined);
	assert.deepEqual(
		await choosePlacement([candidate("warm", bound("t1"))], warmOnly({ t1: "/w" }), never),
		{ candidate: candidate("warm", bound("t1")), worktree: "/w", restore: false },
		"a warm tree needs no restore",
	);
});

test("a host restores only bindings it does not back off from, and still takes warm or other work (#4416)", async () => {
	const asked: string[] = [];
	const notT1 = (binding: WorkspaceBinding) => {
		asked.push(binding.tree);
		return binding.tree !== "t1";
	};
	assert.deepEqual(
		await choosePlacement([candidate("failing", bound("t1")), candidate("other", bound("t2"))], warmOnly({}), notT1),
		{ candidate: candidate("other", bound("t2")), restore: true },
		"bound work of another binding is restored",
	);
	assert.deepEqual(
		await choosePlacement([candidate("failing", bound("t1")), candidate("free")], warmOnly({}), notT1),
		{ candidate: candidate("free"), restore: false },
		"unbound work behind it is taken",
	);
	assert.equal(await choosePlacement([candidate("failing", bound("t1"))], warmOnly({}), notT1), undefined);
	assert.deepEqual(
		await choosePlacement([candidate("failing", bound("t1"))], warmOnly({ t1: "/w" }), notT1),
		{ candidate: candidate("failing", bound("t1")), worktree: "/w", restore: false },
		"a binding it backs off from still runs where its tree is warm",
	);
	asked.length = 0;
	assert.deepEqual(
		await choosePlacement([candidate("a", bound("t2")), candidate("b", bound("t3"))], warmOnly({}), notT1),
		{ candidate: candidate("a", bound("t2")), restore: true },
	);
	assert.deepEqual(asked, ["t2"], "once it chose work to restore, it asks about no other binding");
});

const boundWorkspace = {
	kind: "bound-workspace",
	version: 1,
	remotes: ["https://example.invalid/r.git"],
	head: "h",
	tree: "t",
	envHash: "e",
	repo: "/root-host/repo",
	branch: "feature",
	worktree: "/root-host/worktree",
	repository: "/root-host/repo",
	base: "main",
	baseCommit: "b",
	sandbox: "read-only",
} as const;

test("a placed child runs in the host's worktree, and a child bound to a workspace is bound to it there (#4416)", () => {
	const execution = { cwd: "/root-host/worktree", depth: 1, workspace: boundWorkspace };
	assert.deepEqual(placedExecution(execution, "/host/restored"), {
		cwd: "/host/restored",
		depth: 1,
		workspace: { ...boundWorkspace, worktree: "/host/restored" },
	});
	assert.equal(execution.workspace.worktree, "/root-host/worktree", "the queued execution is left as it was");
	assert.deepEqual(placedExecution({ cwd: "/root", depth: 1 }, "/host/warm"), { cwd: "/host/warm", depth: 1 });
	assert.deepEqual(
		placedExecution({ cwd: "/root", workspace: { kind: "unbound", worktree: "/root" } }, "/host/warm"),
		{ cwd: "/host/warm", workspace: { kind: "unbound", worktree: "/root" } },
		"only a bound workspace is rebound",
	);
});

test("a pooled child is placed by its own bound workspace on a shared pool, else by its root's binding (#4416)", () => {
	const identity = { remotes: ["https://example.invalid/r.git"], head: "h", tree: "t", envHash: "e" };
	const root = bound("root-tree");
	assert.deepEqual(childPlacement(true, root, boundWorkspace), { workspaceBinding: identity });
	assert.deepEqual(childPlacement(true, undefined, boundWorkspace), { workspaceBinding: identity });
	assert.deepEqual(childPlacement(true, root, undefined), { workspaceBinding: root });
	assert.deepEqual(childPlacement(true, root, { kind: "unbound", worktree: "/w" }), { workspaceBinding: root });
	assert.deepEqual(childPlacement(true, undefined, undefined), {});
	assert.deepEqual(childPlacement(false, undefined, boundWorkspace), {}, "a pool on one machine places nothing");
});

test("bound work waits from when the root first saw it ready, through claims put back unplaced (#4416)", () => {
	const execution = { workspaceBinding: { tree: "t" } };
	assert.equal(boundWait(undefined, { state: "ready", generation: 0, execution: {} }, 5), undefined, "unbound work");
	const first = boundWait(undefined, { state: "ready", generation: 0, execution }, 5);
	assert.deepEqual(first, { since: 5, generation: 0 });
	assert.equal(boundWait(first, { state: "leased", generation: 1, execution }, 9), first, "a claim in flight");
	assert.equal(
		boundWait(first, { state: "ready", generation: 0, execution }, 9),
		first,
		"put back unplaced, at its generation, it has waited since it first did",
	);
	assert.deepEqual(
		boundWait(first, { state: "ready", generation: 1, execution }, 9),
		{ since: 9, generation: 1 },
		"an attempt that ran starts the wait over",
	);
	assert.equal(boundWait(undefined, { state: "leased", generation: 1, execution }, 9), undefined);
	for (const state of ["completed", "failed"] as const)
		assert.equal(boundWait(first, { state, generation: 0, execution }, 9), undefined, state);
	assert.equal(waitedMs(first, 9), 4);
	assert.equal(waitedMs(undefined, 9), 0, "work that waits for no host has waited no time");
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

test("a binding is well formed when its identity fields are strings; a bound workspace's other fields are its own (#4310)", () => {
	const valid = { remotes: ["a", "b"], head: "h", tree: "t", envHash: "" };
	assert.equal(isWorkspaceBinding(valid), true);
	assert.equal(isWorkspaceBinding({ ...valid, remotes: [] }), true);
	assert.equal(
		isWorkspaceBinding({ ...valid, repo: "/r", branch: "main", worktree: "/w", kind: "bound-workspace" }),
		true,
	);
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
	])
		assert.equal(isWorkspaceBinding(broken), false, JSON.stringify(broken));
	assert.deepEqual(bindingIdentity({ ...valid, branch: "main", worktree: "/w" } as never), valid);
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
