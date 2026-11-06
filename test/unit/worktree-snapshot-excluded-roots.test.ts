import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import {
	captureWorktreeSnapshot,
	type WorktreeSnapshotCapture,
} from "../../packages/coding-agent/src/core/worktree-snapshot/capture.js";
import {
	isWorkspaceGitError,
	isWorkspaceSnapshotError,
	rehydrateWorkspaceError,
} from "../../packages/coding-agent/src/core/worktree-snapshot/errors.js";
import {
	setWorktreeSnapshotExcludedRootsForTest,
	worktreeSnapshotExcludedRoots,
} from "../../packages/coding-agent/src/core/worktree-snapshot/excluded-roots.js";
import { runGit, setWorktreeSnapshotGit } from "../../packages/coding-agent/src/core/worktree-snapshot/git.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { listWorkflowSnapshotBoundaries } from "../../packages/workflows/src/durable/worktree-snapshots.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { repositoryRoot } from "../../vitest.base.js";
import { closeSnapshotJournals, openSqlSnapshotJournalBackend } from "../helpers/workflow-snapshot-journal.js";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

const checkout = resolve(repositoryRoot);

let sandbox: GitSandbox;
let resolutions: number;
let restoreResolver: () => void;
let previousRoots: readonly string[];

beforeEach(() => {
	sandbox = new GitSandbox();
	resolutions = 0;
	const previous = setWorktreeSnapshotGit(async () => {
		resolutions++;
		return sandbox.executable;
	});
	restoreResolver = () => setWorktreeSnapshotGit(previous);
	previousRoots = worktreeSnapshotExcludedRoots();
});

afterEach(async () => {
	setWorktreeSnapshotExcludedRootsForTest(previousRoots);
	restoreResolver();
	await closeSnapshotJournals();
	sandbox.dispose();
});

function unavailableReason(result: WorktreeSnapshotCapture): Error {
	assert.equal(result.status, "unavailable");
	return (result as Extract<WorktreeSnapshotCapture, { status: "unavailable" }>).reason;
}

async function assertRefused(cwd: string): Promise<void> {
	await assert.rejects(runGit(["--version"], { cwd }), (error) => {
		assert.ok(isWorkspaceSnapshotError(error), `expected not-a-repository in ${cwd}, got ${String(error)}`);
		assert.equal(error.code, "not-a-repository");
		assert.equal(error.subject, cwd);
		return true;
	});
}

async function assertReachesGit(cwd: string): Promise<void> {
	const result = await runGit(["--version"], { cwd });
	assert.equal(result.exitCode, 0);
}

test("the suites exclude the checkout they run from (#4414)", () => {
	assert.deepEqual(
		worktreeSnapshotExcludedRoots().map((root) => resolve(root)),
		[checkout],
	);
});

test("recording the checkout or a directory in it is unavailable and starts no Git (#4414)", async () => {
	for (const directory of [checkout, join(checkout, "packages", "coding-agent")]) {
		const reason = unavailableReason(await captureWorktreeSnapshot(directory));
		assert.ok(isWorkspaceSnapshotError(reason));
		assert.equal(reason.code, "not-a-repository");
		assert.equal(reason.subject, directory);
	}
	assert.equal(resolutions, 0);
});

test("a workflow that runs in the checkout records no snapshot of it (#4414)", async () => {
	const fixture = await openSqlSnapshotJournalBackend(sandbox.path("journal.sqlite"));
	const store = createStore();
	const definition = workflow({
		name: "checkout-isolation",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.tool("one", {}, async () => "done");
			await ctx.tool("two", {}, async () => "done");
			return {};
		},
	});
	const result = await run(definition, {}, { cwd: checkout, durableBackend: fixture.backend, store });
	assert.equal(result.status, "completed");
	assert.deepEqual(await listWorkflowSnapshotBoundaries(fixture.journal, result.runId), []);
	const reason = store.run(result.runId)?.snapshotUnavailable;
	assert.ok(reason);
	const error = rehydrateWorkspaceError(reason);
	assert.ok(isWorkspaceSnapshotError(error));
	assert.equal(error.code, "not-a-repository");
	assert.equal(error.subject, checkout);
	assert.equal(resolutions, 0);
});

test("an excluded root refuses Git in itself and below it, and nowhere else (#4414)", async () => {
	const excluded = sandbox.path("repo");
	mkdirSync(join(excluded, "sub"), { recursive: true });
	mkdirSync(sandbox.path("repo-sibling"));
	setWorktreeSnapshotExcludedRootsForTest([sandbox.path("elsewhere"), excluded]);

	await assertRefused(excluded);
	await assertRefused(join(excluded, "sub"));
	assert.equal(resolutions, 0);
	await assertReachesGit(sandbox.path("repo-sibling"));
	await assertReachesGit(sandbox.root);
	assert.equal(resolutions, 2);
});

test("an excluded root matches through links on either side (#4414)", async () => {
	const excluded = sandbox.path("repo");
	mkdirSync(join(excluded, "sub"), { recursive: true });
	const link = sandbox.path("repo-link");
	symlinkSync(excluded, link, "junction");

	setWorktreeSnapshotExcludedRootsForTest([excluded]);
	await assertRefused(join(link, "sub"));
	setWorktreeSnapshotExcludedRootsForTest([link]);
	await assertRefused(join(excluded, "sub"));
	assert.equal(resolutions, 0);
});

test("a cancelled command in an excluded root rejects with the cancellation (#4414)", async () => {
	setWorktreeSnapshotExcludedRootsForTest([sandbox.root]);
	const reason = new Error("stop");
	await assert.rejects(runGit(["--version"], { cwd: sandbox.root, signal: AbortSignal.abort(reason) }), (error) => {
		assert.equal(error, reason);
		return true;
	});
	assert.equal(resolutions, 0);
});

test.skipIf(process.platform === "win32")(
	"with no excluded roots, Git runs even where a path cannot be resolved (#4414)",
	async () => {
		const loop = sandbox.path("loop");
		symlinkSync(loop, loop);
		setWorktreeSnapshotExcludedRootsForTest([]);
		await assert.rejects(runGit(["--version"], { cwd: loop }), (error) => {
			assert.ok(isWorkspaceGitError(error), `expected the failed Git command, got ${String(error)}`);
			return true;
		});
		assert.equal(resolutions, 1);
	},
);

test("excluded roots default to none, are copied when set, and are returned when replaced (#4414)", () => {
	const slot = Symbol.for("atomic-coding-agent/worktree-snapshot-excluded-roots@1");
	Reflect.deleteProperty(globalThis, slot);
	assert.deepEqual(worktreeSnapshotExcludedRoots(), []);

	const roots = [sandbox.path("a")];
	assert.deepEqual(setWorktreeSnapshotExcludedRootsForTest(roots), []);
	roots.push(sandbox.path("b"));
	assert.deepEqual(worktreeSnapshotExcludedRoots(), [sandbox.path("a")]);
	assert.ok(Object.isFrozen(worktreeSnapshotExcludedRoots()));
	assert.deepEqual(setWorktreeSnapshotExcludedRootsForTest([sandbox.path("c")]), [sandbox.path("a")]);
});
