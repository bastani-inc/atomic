import assert from "node:assert/strict";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	captureWorktreeSnapshot,
	isGitUnavailableError,
	isWorkspaceGitError,
	isWorkspaceSnapshotError,
	rehydrateWorkspaceError,
	setWorktreeSnapshotGit,
	WorkspaceConfigError,
	type WorktreeSnapshot,
} from "@bastani/atomic";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { DurableWorkflowBackend } from "../../packages/workflows/src/durable/backend.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { RUN_EVENT_TYPES, type RunEvent } from "../../packages/workflows/src/durable/journal/types.js";
import type { DurableToolCheckpoint } from "../../packages/workflows/src/durable/types.js";
import {
	createWorkflowSnapshotRecorder,
	releaseWorkflowSnapshotAncestry,
} from "../../packages/workflows/src/durable/worktree-snapshot-recorder.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { openSqlSnapshotJournal, type SqlSnapshotJournal } from "../helpers/workflow-snapshot-journal.js";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

let sandbox: GitSandbox;
let journals: SqlSnapshotJournal[];
beforeEach(() => {
	sandbox = new GitSandbox();
	journals = [];
});
afterEach(async () => {
	for (const journal of journals) await journal.close();
	sandbox.dispose();
});

const checkpoint = (id: string): DurableToolCheckpoint => ({
	kind: "tool",
	workflowId: "run",
	checkpointId: id,
	name: id,
	argsHash: "hash",
	output: "ok",
	completedAt: 1,
});

interface Commit {
	readonly checkpoint: DurableToolCheckpoint;
	readonly options: { readonly signal?: AbortSignal } | undefined;
}

async function harness(input: {
	readonly cwd: string;
	readonly settings?: Parameters<typeof createWorkflowSnapshotRecorder>[0]["settings"];
	readonly journal?: "sql" | "memory" | "none";
	readonly onCommit?: (commit: Commit) => Promise<void>;
	readonly rootRunId?: string;
}) {
	const commits: Commit[] = [];
	const kind = input.journal ?? "sql";
	const sql = kind === "sql" ? await openSqlSnapshotJournal(sandbox.path("journal.sqlite")) : undefined;
	if (sql) journals.push(sql);
	const journal = kind === "memory" ? new MemoryRunJournal() : sql?.journal;
	const backend = {
		commitCheckpoint: async (committed: DurableToolCheckpoint, options?: { signal?: AbortSignal }) => {
			const commit = { checkpoint: committed, options };
			commits.push(commit);
			await input.onCommit?.(commit);
		},
	} as unknown as DurableWorkflowBackend;
	const rootBackend = { snapshotJournal: journal } as unknown as DurableWorkflowBackend;
	const run = {} as RunSnapshot;
	const rootRunId = input.rootRunId ?? "run";
	const record = createWorkflowSnapshotRecorder({
		backend,
		rootBackend,
		rootRunId,
		cwd: () => input.cwd,
		settings: input.settings,
		run,
	});
	return { record, commits, run, journal, sql, rootRunId };
}

function countGitLookups(): { readonly count: () => number } {
	let count = 0;
	setWorktreeSnapshotGit(async () => {
		count++;
		return sandbox.executable;
	});
	return { count: () => count };
}

const reasonOf = (run: RunSnapshot) =>
	run.snapshotUnavailable ? rehydrateWorkspaceError(run.snapshotUnavailable) : undefined;

test("disabled snapshots commit the checkpoint untouched, with the caller's signal, and never look for Git (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const lookups = countGitLookups();
	const { record, commits, run } = await harness({ cwd: clone, settings: { enabled: false } });
	const plain = checkpoint("plain");
	assert.deepEqual(await record(plain), []);
	const controller = new AbortController();
	const signalled = checkpoint("signalled");
	assert.deepEqual(await record(signalled, controller.signal), []);
	assert.equal(lookups.count(), 0);
	assert.equal(commits.length, 2);
	assert.equal(commits[0]!.checkpoint, plain);
	assert.equal(commits[0]!.options, undefined);
	assert.equal(commits[1]!.checkpoint, signalled);
	assert.equal(commits[1]!.options?.signal, controller.signal);
	assert.equal(run.snapshotUnavailable, undefined);
	const bare = await harness({ cwd: clone, settings: { enabled: false }, journal: "memory" });
	assert.deepEqual(await bare.record(checkpoint("c")), []);
	assert.equal(bare.run.snapshotUnavailable, undefined, "a disabled run does not complain about its journal");
});

test("enabled snapshots capture the workflow checkout and commit the checkpoint with the result (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	for (const settings of [undefined, { enabled: true }]) {
		const { record, commits, run } = await harness({ cwd: clone, settings });
		const snapshots = await record(checkpoint("a"));
		assert.equal(snapshots.length, 1);
		assert.equal(snapshots[0]!.root, clone);
		assert.deepEqual(commits[0]!.checkpoint.worktreeSnapshots, snapshots);
		assert.equal(commits[0]!.options, undefined);
		assert.equal(run.snapshotUnavailable, undefined, "capturing the workflow's own checkout reports nothing");
		const controller = new AbortController();
		await record(checkpoint("b"), controller.signal);
		assert.equal(commits[1]!.options?.signal, controller.signal, "the caller's signal reaches the commit");
	}
});

test.skipIf(process.platform === "win32")(
	"a checkout reached through a symbolic link continues the chain of its previous snapshot (#4245)",
	async () => {
		const { clone } = await sandbox.remoteWithClone();
		const link = sandbox.path("via-link");
		symlinkSync(clone, link);
		const { record } = await harness({ cwd: link });
		const [first] = await record(checkpoint("first"));
		assert.equal(first!.root, clone, "the snapshot root is the physical path");
		sandbox.write(join(clone, "a.txt"), "changed\n");
		const [second] = await record(checkpoint("second"));
		assert.equal(second!.delta.base, first!.id);
	},
);

test("a journal with no blob table commits unchanged, reports blob-store-unsupported and runs no Git (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const lookups = countGitLookups();
	for (const kind of ["memory", "none"] as const) {
		const { record, commits, run } = await harness({ cwd: clone, journal: kind });
		const controller = new AbortController();
		const first = checkpoint("first");
		assert.deepEqual(await record(first, controller.signal), []);
		assert.deepEqual(await record(checkpoint("second")), []);
		assert.equal(commits.length, 2);
		assert.equal(commits[0]!.checkpoint, first);
		assert.equal(commits[0]!.options?.signal, controller.signal);
		assert.equal(commits[1]!.options, undefined);
		assert.equal("worktreeSnapshots" in commits[0]!.checkpoint, false);
		const reason = reasonOf(run);
		assert.ok(isWorkspaceSnapshotError(reason));
		assert.equal(reason.code, "blob-store-unsupported");
		assert.equal(reason.subject, "workflow journal");
	}
	assert.equal(lookups.count(), 0);
});

test("missing Git is looked for once: later checkpoints commit without trying again, and the first reason stays (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	let lookups = 0;
	setWorktreeSnapshotGit(async () => {
		lookups++;
		return { path: sandbox.path("missing-git"), env: {} };
	});
	const { record, commits, run } = await harness({ cwd: clone });
	const controller = new AbortController();
	assert.deepEqual(await record(checkpoint("one")), []);
	assert.equal(lookups, 1);
	const reason = reasonOf(run);
	assert.ok(isGitUnavailableError(reason));
	const firstReason = run.snapshotUnavailable;
	const second = checkpoint("two");
	assert.deepEqual(await record(second, controller.signal), []);
	assert.deepEqual(await record(checkpoint("three")), []);
	assert.equal(lookups, 1);
	assert.equal(commits.length, 3);
	assert.equal(commits[1]!.checkpoint, second);
	assert.equal(commits[1]!.options?.signal, controller.signal);
	assert.equal(commits[2]!.options, undefined);
	assert.equal("worktreeSnapshots" in commits[1]!.checkpoint, false);
	assert.equal(run.snapshotUnavailable, firstReason);
});

test("a directory outside any repository does not stop later captures, and a repository's later directories are skipped once Git is gone (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const outside = sandbox.path("plain");
	mkdirSync(outside);
	const lookups = countGitLookups();
	const { record, commits, run } = await harness({ cwd: outside });
	const snapshots = await record(checkpoint("a"), undefined, [clone]);
	assert.deepEqual(
		snapshots.map((snapshot) => snapshot.root),
		[clone],
	);
	const reason = reasonOf(run);
	assert.ok(isWorkspaceSnapshotError(reason));
	assert.equal(reason.code, "not-a-repository");
	const firstReason = run.snapshotUnavailable;
	const next = await record(checkpoint("b"), undefined, [outside, clone]);
	assert.equal(next.length, 1, "a non-repository reason never switches capture off");
	assert.equal(run.snapshotUnavailable, firstReason, "the first reason is the one kept");
	assert.equal(commits.length, 2);
	assert.ok(lookups.count() > 2);

	let missing = 0;
	setWorktreeSnapshotGit(async () => {
		missing++;
		return { path: sandbox.path("missing-git"), env: {} };
	});
	const gone = await harness({ cwd: clone });
	assert.deepEqual(await gone.record(checkpoint("c"), undefined, [outside, join(clone, "sub")]), []);
	assert.equal(missing, 1, "the loop stops at the first directory once Git is known to be missing");
});

test("several directories of one repository yield one snapshot (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone("repo", { "sub/a.txt": "a\n" });
	const { record, commits } = await harness({ cwd: clone });
	const snapshots = await record(checkpoint("a"), undefined, [join(clone, "sub"), clone, "sub"]);
	assert.equal(snapshots.length, 1);
	assert.equal(commits[0]!.checkpoint.worktreeSnapshots?.length, 1);
});

test("a checkpoint without snapshots is committed as it is, without an empty snapshot list (#4245)", async () => {
	const outside = sandbox.path("plain");
	mkdirSync(outside);
	const { record, commits } = await harness({ cwd: outside });
	const original = checkpoint("a");
	assert.deepEqual(await record(original), []);
	assert.equal(commits[0]!.checkpoint, original);
	assert.equal("worktreeSnapshots" in commits[0]!.checkpoint, false);
});

async function nestedRepository(parent: string, name: string): Promise<string> {
	const path = join(parent, name);
	await sandbox.git(parent, "init", "-q", path);
	sandbox.write(join(path, "inner.txt"), "inner\n");
	await sandbox.commitAll(path, "inner");
	return path;
}

const rootOf = (snapshots: readonly WorktreeSnapshot[], root: string) =>
	snapshots.find((entry) => entry.root === root)!;

test("a directory continues the chain of the checkout that contains it, not of a repository nested inside it (#4245)", async () => {
	const { clone: outer } = await sandbox.remoteWithClone("outer");
	const inner = await nestedRepository(outer, "inner");
	const { record } = await harness({ cwd: outer });
	const first = await record(checkpoint("one"), undefined, [inner]);
	sandbox.write(join(outer, "outer.txt"), "changed\n");
	sandbox.write(join(inner, "inner.txt"), "changed\n");
	const second = await record(checkpoint("two"), undefined, [inner]);
	assert.equal(rootOf(second, outer).delta.base, rootOf(first, outer).id);
	assert.equal(rootOf(second, inner).delta.base, rootOf(first, inner).id);
});

test("a nested repository continues its own chain even when the outer checkout was recorded first or last (#4245)", async () => {
	const { clone: outer } = await sandbox.remoteWithClone("outer");
	const inner = await nestedRepository(outer, "inner");
	for (const cwd of [outer, inner]) {
		sandbox.write(join(outer, "outer.txt"), `${cwd}\n`);
		const { record } = await harness({ cwd, rootRunId: `run-${cwd.length}` });
		const other = cwd === outer ? inner : outer;
		const first = await record(checkpoint("one"), undefined, [other]);
		sandbox.write(join(inner, "inner.txt"), `after ${cwd}\n`);
		const second = await record(checkpoint("two"), undefined, [other]);
		assert.equal(rootOf(second, inner).delta.base, rootOf(first, inner).id, `inner chain, recorded from ${cwd}`);
	}
});

test("the chain never comes from an unrelated repository, even one whose path is longer (#4245)", async () => {
	const { clone: short } = await sandbox.remoteWithClone("x");
	const { clone: long } = await sandbox.remoteWithClone("an-unrelated-repository-with-a-long-name");
	const { record } = await harness({ cwd: short });
	const first = await record(checkpoint("one"), undefined, [long]);
	sandbox.write(join(short, "a.txt"), "changed\n");
	sandbox.write(join(long, "a.txt"), "changed\n");
	const second = await record(checkpoint("two"), undefined, [long]);
	assert.equal(rootOf(second, short).delta.base, rootOf(first, short).id);
	assert.equal(rootOf(second, long).delta.base, rootOf(first, long).id);
});

test("a directory beside a nested repository, or above it, still continues its own checkout's chain (#4245)", async () => {
	const { clone: outer } = await sandbox.remoteWithClone("outer");
	const inner = await nestedRepository(outer, "inner");
	sandbox.write(join(outer, "beside", "b.txt"), "beside\n");
	const { record } = await harness({ cwd: inner });
	const first = await record(checkpoint("one"), undefined, [outer]);
	sandbox.write(join(outer, "beside", "b.txt"), "changed\n");
	const second = await record(checkpoint("two"), undefined, [join(outer, "beside")]);
	assert.equal(rootOf(second, outer).delta.base, rootOf(first, outer).id);
});

function deferred() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

test("checkpoints of one run are captured and committed one at a time, in arrival order (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const lookups = countGitLookups();
	const gates = [deferred(), deferred(), deferred()];
	const { record, commits } = await harness({
		cwd: clone,
		onCommit: async () => {
			await gates[commits.length - 1]!.promise;
		},
	});
	const first = record(checkpoint("one"));
	await vi.waitFor(() => assert.equal(commits.length, 1));
	const second = record(checkpoint("two"));
	const lookupsDuringFirstCommit = lookups.count();
	await settle();
	assert.equal(lookups.count(), lookupsDuringFirstCommit, "the second capture waits for the first commit");
	assert.equal(commits.length, 1);
	gates[0]!.release();
	await first;
	await vi.waitFor(() => assert.equal(commits.length, 2));
	const third = record(checkpoint("three"));
	const lookupsDuringSecondCommit = lookups.count();
	await settle();
	assert.equal(lookups.count(), lookupsDuringSecondCommit, "a later arrival queues behind the running one");
	assert.equal(commits.length, 2);
	gates[1]!.release();
	await second;
	await vi.waitFor(() => assert.equal(commits.length, 3));
	gates[2]!.release();
	await third;
	assert.deepEqual(
		commits.map((commit) => commit.checkpoint.checkpointId),
		["one", "two", "three"],
	);
});

test("a run's queue does not hold up another run (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const gate = deferred();
	const slow = await harness({ cwd: clone, rootRunId: "slow", onCommit: () => gate.promise });
	const quick = await harness({ cwd: clone, rootRunId: "quick" });
	const blocked = slow.record(checkpoint("slow"));
	await vi.waitFor(() => assert.equal(slow.commits.length, 1));
	await quick.record(checkpoint("quick"));
	assert.equal(quick.commits.length, 1);
	gate.release();
	await blocked;
});

async function seededRun(journal: SqlSnapshotJournal["journal"], runId: string) {
	await journal.createRun({ runId, name: runId, cwd: "/", status: "running", createdAt: 1 });
	const acquired = await journal.acquire(runId, "holder");
	assert.equal(acquired.status, "acquired");
	if (acquired.status !== "acquired") throw new Error("lease not acquired");
	return async (checkpointId: string, snapshot: WorktreeSnapshot) =>
		journal.append(acquired.lease, {
			type: RUN_EVENT_TYPES.checkpointRecorded,
			payload: { kind: "tool", checkpointId, worktreeSnapshots: [snapshot] },
		} as unknown as RunEvent);
}

async function capturedInto(
	journal: SqlSnapshotJournal["journal"],
	dir: string,
	previous?: WorktreeSnapshot,
): Promise<WorktreeSnapshot> {
	const result = await captureWorktreeSnapshot(dir, { blobs: journal.snapshotBlobs, previous });
	assert.equal(result.status, "captured");
	if (result.status !== "captured") throw new Error("capture failed");
	return result.snapshot;
}

test("a resumed run continues the chain recorded in its journal, and a released run starts from the journal again (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const { record, sql, rootRunId } = await harness({ cwd: clone });
	assert.ok(sql);
	const journal = sql.journal;
	const append = await seededRun(journal, rootRunId);
	sandbox.write(join(clone, "a.txt"), "recorded\n");
	const recorded = await capturedInto(journal, clone);
	await append("earlier", recorded);

	sandbox.write(join(clone, "a.txt"), "next\n");
	const [next] = await record(checkpoint("next"));
	assert.equal(next!.delta.base, recorded.id, "the first capture of a run is based on what its journal recorded");

	sandbox.write(join(clone, "a.txt"), "elsewhere\n");
	const elsewhere = await capturedInto(journal, clone, next);
	await append("elsewhere", elsewhere);
	sandbox.write(join(clone, "a.txt"), "cached\n");
	const [cached] = await record(checkpoint("cached"));
	assert.equal(cached!.delta.base, next!.id, "while the run executes, its own chain is kept in memory");

	releaseWorkflowSnapshotAncestry(journal, "another-run");
	sandbox.write(join(clone, "a.txt"), "still cached\n");
	const [stillCached] = await record(checkpoint("still-cached"));
	assert.equal(stillCached!.delta.base, cached!.id, "releasing another run leaves this one's chain alone");

	releaseWorkflowSnapshotAncestry(journal, rootRunId);
	sandbox.write(join(clone, "a.txt"), "reseeded\n");
	const [reseeded] = await record(checkpoint("reseeded"));
	assert.equal(reseeded!.delta.base, elsewhere.id, "after release the journal is read again");
});

test("a Git failure is reported and the checkpoint still commits; other failures reject before committing (#4245)", async () => {
	if (process.platform === "win32") return;
	const { clone } = await sandbox.remoteWithClone();
	const wrapper = sandbox.path("failing-git");
	writeFileSync(
		wrapper,
		`#!/bin/sh\nfor argument in "$@"; do\n  if [ "$argument" = commit-tree ]; then echo "fatal: injected failure" >&2; exit 1; fi\ndone\nexec git "$@"\n`,
	);
	chmodSync(wrapper, 0o755);
	setWorktreeSnapshotGit(async () => ({ path: wrapper, env: sandbox.executable.env }));
	sandbox.write(join(clone, "a.txt"), "changed\n");
	const { record, commits, run } = await harness({ cwd: clone });
	const original = checkpoint("a");
	assert.deepEqual(await record(original), []);
	assert.equal(commits.length, 1);
	assert.equal(commits[0]!.checkpoint, original);
	const reason = reasonOf(run);
	assert.ok(isWorkspaceGitError(reason));
	assert.equal(reason.code, "git-failed");
	assert.equal(reason.operation, "commit-tree");

	setWorktreeSnapshotGit(async () => sandbox.executable);
	const invalid = await harness({ cwd: clone, settings: { fullEvery: 0 } });
	await assert.rejects(
		invalid.record(checkpoint("b")),
		(error: unknown) => error instanceof WorkspaceConfigError && error.field === "settings.fullEvery",
	);
	assert.equal(invalid.commits.length, 0);
});

test("an aborted capture rejects with the signal's reason and commits nothing (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const { record, commits } = await harness({ cwd: clone });
	const reason = new Error("stop");
	const controller = new AbortController();
	controller.abort(reason);
	await assert.rejects(record(checkpoint("a"), controller.signal), (error: unknown) => error === reason);
	assert.equal(commits.length, 0);
});
