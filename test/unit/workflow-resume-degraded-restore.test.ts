import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	currentWorktreeRestoreNotices,
	isWorkspaceDriftError,
	isWorkspaceRestoreError,
	setWorktreeSnapshotGit,
} from "@bastani/atomic";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, test } from "vitest";
import { missingGit } from "../../packages/coding-agent/test/helpers/missing-git.ts";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { resumeDurableWorkflow } from "../../packages/workflows/src/durable/resume-runtime.js";
import {
	listWorkflowSnapshotBoundaries,
	workflowSnapshotFrontier,
} from "../../packages/workflows/src/durable/worktree-snapshots.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { inspectRun } from "../../packages/workflows/src/runs/background/run-inspect.js";
import type { RunOpts } from "../../packages/workflows/src/runs/foreground/executor-types.js";
import { forkRun } from "../../packages/workflows/src/runs/foreground/sdk-fork.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { Store } from "../../packages/workflows/src/shared/store-public-types.js";
import { placedExecution } from "../../packages/workflows/src/workers/placement-choice.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import { closeMemoryTestBackends, createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { openSqlSnapshotJournalBackend } from "../helpers/workflow-snapshot-journal.js";
import { GitSandbox, loseSnapshotBlobs } from "../helpers/worktree-snapshot.js";

useTemporaryAgentDir();

let sandbox: GitSandbox;
let priorAgentDir: string | undefined;
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
	sandbox = new GitSandbox();
	priorAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
	process.env.ATOMIC_CODING_AGENT_DIR = sandbox.path("agent");
	mkdirSync(sandbox.path("agent"), { recursive: true });
	writeFileSync(sandbox.path("agent", "settings.json"), "{}");
});
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	if (priorAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = priorAgentDir;
	sandbox.dispose();
});

const adapters = { complete: { complete: async (text: string) => text } };

const restoredWorktrees = () =>
	existsSync(sandbox.path("agent", "worktree-snapshots", "worktrees"))
		? readdirSync(sandbox.path("agent", "worktree-snapshots", "worktrees"))
		: [];

const checkoutNotices = (store: Store, runId: string) =>
	store
		.notices()
		.filter((notice) => notice.runId === runId && notice.id.startsWith("workflow-worktree-restore"))
		.map((notice) => ({ level: notice.level, message: notice.message }));

interface Observation {
	readonly cwd: string;
	readonly notices: readonly string[];
}

/**
 * A run on "node A" that wrote `state.txt` in its checkout, ran a stage, and stopped; `prepare` changes the clone before
 * the run starts. The checkout is then gone, as it is on another node.
 */
async function runRecordedElsewhere(prepare: (clone: string) => Promise<void> = async () => {}) {
	const { clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n" });
	const pushed = await sandbox.git(clone, "rev-parse", "HEAD");
	await prepare(clone);
	const fixture = await openSqlSnapshotJournalBackend(sandbox.path("journal.sqlite"));
	cleanups.push(() => fixture.close());
	const store = createStore();
	const observed: Observation[] = [];
	let attempt = 0;
	const definition = workflow({
		name: "recorded-elsewhere",
		description: "",
		inputs: {},
		outputs: { ok: Type.Boolean() },
		run: async (ctx) => {
			await ctx.tool("write", {}, async () => {
				sandbox.write(join(ctx.cwd!, "state.txt"), "written on node A\n");
				return "written";
			});
			await ctx.stage("plan").complete("plan");
			if (attempt++ < 1) throw new Error("node A stopped");
			observed.push({ cwd: ctx.cwd!, notices: currentWorktreeRestoreNotices() });
			return { ok: true };
		},
	});
	const first = await run(definition, {}, { cwd: clone, durableBackend: fixture.backend, store, adapters });
	assert.equal(first.status, "failed");
	const [boundary] = workflowSnapshotFrontier(
		await listWorkflowSnapshotBoundaries(fixture.backend.snapshotJournal, first.runId),
	);
	assert.ok(boundary !== undefined, "node A recorded its checkout");
	const lose = (hashes: readonly (string | null | undefined)[]) =>
		loseSnapshotBlobs(
			fixture.journal.snapshotBlobs,
			hashes.filter((hash): hash is string => typeof hash === "string"),
		);
	const resume = async () => {
		const jobs = createJobTracker();
		const result = await resumeDurableWorkflow(first.runId, {
			registry: createRegistry().register(definition),
			durableBackend: fixture.backend,
			baseRunOpts: { cwd: sandbox.root, store, durableBackend: fixture.backend, adapters },
			jobs,
		});
		const failure = await jobs.get(first.runId)?.promise.then(
			() => undefined,
			(error: unknown) => error,
		);
		return { result, failure, status: fixture.backend.getWorkflow(first.runId)?.status };
	};
	const rerun = () =>
		run(definition, {}, { runId: first.runId, cwd: sandbox.root, durableBackend: fixture.backend, store, adapters });
	const removeCheckout = () => rmSync(clone, { recursive: true, force: true });
	return {
		clone,
		pushed,
		runId: first.runId,
		snapshot: boundary.snapshot,
		backend: fixture.backend,
		store,
		definition,
		observed,
		lose,
		resume,
		rerun,
		removeCheckout,
	};
}

describe("a workflow run's resume always resumes, restoring each checkout as well as this node can (#4738)", () => {
	test("a healthy resume restores the checkout exactly and gives no checkout notice (#4738)", async () => {
		const recorded = await runRecordedElsewhere();
		recorded.removeCheckout();

		const { result } = await recorded.resume();

		assert.equal(result.ok, true, result.ok ? "" : result.message);
		const [observation] = recorded.observed;
		assert.equal(readFileSync(join(observation!.cwd, "state.txt"), "utf8"), "written on node A\n");
		assert.deepEqual(observation!.notices, []);
		const handle = recorded.backend.getWorkflow(recorded.runId)!;
		assert.equal(handle.worktreeRootMappings?.at(-1)?.degraded, undefined);
		assert.equal(handle.worktreeRestoreOutcomes, undefined);
		assert.deepEqual(
			checkoutNotices(recorded.store, recorded.runId).map((notice) => notice.level),
			["info"],
		);
		const inspected = inspectRun(recorded.runId, { store: recorded.store });
		assert.equal(inspected.ok && inspected.detail.worktreeRestore, undefined);
	});

	test("a lost change set restores the recorded commit without it; the run, its stages and its status say so once (#4738)", async () => {
		const recorded = await runRecordedElsewhere();
		await recorded.lose(recorded.snapshot.chain.map((link) => link.patch));
		recorded.removeCheckout();

		const { result, failure, status } = await recorded.resume();

		assert.equal(result.ok, true, result.ok ? "" : result.message);
		assert.equal(status, "completed", String(failure));
		const [observation] = recorded.observed;
		assert.equal(await sandbox.git(observation!.cwd, "rev-parse", "HEAD"), recorded.snapshot.head);
		assert.equal(existsSync(join(observation!.cwd, "state.txt")), false, "the lost change set is left out whole");
		const handle = recorded.backend.getWorkflow(recorded.runId)!;
		const mapping = handle.worktreeRootMappings?.at(-1);
		assert.equal(mapping?.degraded?.stage, "partial-changes");
		assert.equal(mapping?.to, realpathSync(observation!.cwd));
		assert.equal(handle.worktreeRestoreOutcomes?.length, 1);
		const [outcome] = handle.worktreeRestoreOutcomes!;
		assert.equal(outcome!.root, recorded.clone);
		assert.equal(outcome!.degraded?.stage, "partial-changes");
		assert.doesNotMatch(outcome!.message, /fail/i);
		assert.match(outcome!.message, /0 of the 1 change sets/);
		assert.deepEqual(checkoutNotices(recorded.store, recorded.runId), [
			{ level: "warning", message: outcome!.message },
		]);
		assert.deepEqual(observation!.notices, [outcome!.message], "the run's stages are told");
		const inspected = inspectRun(recorded.runId, { store: recorded.store });
		assert.deepEqual(inspected.ok && inspected.detail.worktreeRestore, [outcome!.message]);
	});

	test("a lost bundle of unpushed commits restores the last pushed commit (#4738)", async () => {
		let unpushed = "";
		const recorded = await runRecordedElsewhere(async (clone) => {
			sandbox.write(join(clone, "committed.txt"), "unpushed\n");
			unpushed = await sandbox.commitAll(clone, "unpushed commit");
		});
		assert.ok(recorded.snapshot.bundle !== undefined && recorded.snapshot.bundle !== null);
		await recorded.lose([recorded.snapshot.bundle.blob]);
		recorded.removeCheckout();

		const finished = await recorded.rerun();

		assert.equal(finished.status, "completed", finished.error);
		const [observation] = recorded.observed;
		assert.equal(await sandbox.git(observation!.cwd, "rev-parse", "HEAD"), recorded.pushed);
		assert.equal(existsSync(join(observation!.cwd, "committed.txt")), false);
		const [outcome, ...rest] = recorded.backend.getWorkflow(recorded.runId)!.worktreeRestoreOutcomes ?? [];
		assert.deepEqual(rest, []);
		assert.equal(outcome?.degraded?.stage, "closest-commit");
		assert.equal(outcome?.degraded?.head, recorded.pushed);
		assert.ok(outcome!.message.includes(unpushed.slice(0, 12)), outcome!.message);
		assert.deepEqual(observation!.notices, [outcome!.message]);
	});

	test("without Git a resume continues in the directory it was started from and keeps the recorded one (#4738)", async () => {
		const recorded = await runRecordedElsewhere();
		recorded.removeCheckout();
		setWorktreeSnapshotGit(async () => {
			throw missingGit();
		});

		const { result, failure, status } = await recorded.resume();

		assert.equal(result.ok, true, result.ok ? "" : result.message);
		assert.equal(status, "completed", String(failure));
		const [observation] = recorded.observed;
		assert.equal(observation!.cwd, sandbox.root);
		const handle = recorded.backend.getWorkflow(recorded.runId)!;
		assert.equal(handle.invocationCwd, recorded.clone, "a later resume restores the recorded checkout again");
		const [outcome, ...rest] = handle.worktreeRestoreOutcomes ?? [];
		assert.deepEqual(rest, []);
		assert.equal(outcome?.unrestored?.cause, "not-installed");
		assert.equal(outcome?.unrestored?.place, "launch");
		assert.equal(outcome?.unrestored?.continuedIn, sandbox.root);
		assert.match(outcome!.message, /the directory the resume started from/);
		assert.deepEqual(checkoutNotices(recorded.store, recorded.runId), [
			{ level: "warning", message: outcome!.message },
		]);
		assert.deepEqual(observation!.notices, [outcome!.message]);
		assert.deepEqual(restoredWorktrees(), []);
	});

	test("a snapshot record naming a remote helper refuses the resume and restores nothing (#4738)", async () => {
		const recorded = await runRecordedElsewhere();
		recorded.removeCheckout();
		// The record is refused before any Git runs, whatever the remote: the journal names the helper.
		const handle = recorded.backend.getWorkflow(recorded.runId)!;
		const unsafe = { ...recorded.snapshot, remotes: ["ext::sh -c touch% /tmp/pwned"] };
		const journal = recorded.backend.snapshotJournal;
		const lease = await journal.acquire(recorded.runId, "node-a");
		assert.equal(lease.status, "acquired");
		if (lease.status !== "acquired") return;
		await journal.append(lease.lease, {
			type: "CheckpointRecorded",
			payload: { kind: "tool", checkpointId: "unsafe", worktreeSnapshots: [unsafe] },
		} as never);
		await journal.release(lease.lease);

		const refusal = await recorded.resume().then(
			({ result, failure }) => (result.ok ? failure : result.error),
			(error: unknown) => error,
		);

		assert.ok(isWorkspaceDriftError(refusal), String(refusal));
		assert.ok(isWorkspaceRestoreError(refusal.cause));
		assert.deepEqual([refusal.cause.code, refusal.cause.reason], ["invalid-snapshot", "unsafe-remote"]);
		assert.deepEqual(recorded.observed, []);
		assert.deepEqual(restoredWorktrees(), []);
		assert.equal(recorded.backend.getWorkflow(recorded.runId)?.worktreeRootMappings, handle.worktreeRootMappings);
	});

	test("a resume of a run this journal does not hold is refused (#4738)", async () => {
		const recorded = await runRecordedElsewhere();
		const result = await resumeDurableWorkflow("00000000-0000-4000-8000-000000000000", {
			registry: createRegistry().register(recorded.definition),
			durableBackend: recorded.backend,
			baseRunOpts: { cwd: sandbox.root, store: recorded.store, durableBackend: recorded.backend, adapters },
			jobs: createJobTracker(),
		});
		assert.equal(result.ok, false);
	});

	test("a fork from a stage of a run resumed with a partial checkout knows the checkout is partial (#4738)", async () => {
		const recorded = await runRecordedElsewhere();
		await recorded.lose(recorded.snapshot.chain.map((link) => link.patch));
		recorded.removeCheckout();
		const resumed = await recorded.resume();
		assert.equal(resumed.status, "completed", String(resumed.failure));

		const fork = await forkRun(recorded.runId, {
			fromStage: "plan",
			durableBackend: recorded.backend,
			definition: recorded.definition,
			store: recorded.store,
			adapters,
		});
		const forked = await fork.result;

		assert.equal(forked.status, "completed", forked.error);
		const handle = recorded.backend.getWorkflow(fork.runId)!;
		assert.ok(
			handle.worktreeRootMappings?.some((mapping) => mapping.degraded?.stage === "partial-changes"),
			"the fork carries the partial restore it was forked from",
		);
		const [outcome, ...rest] = handle.worktreeRestoreOutcomes ?? [];
		assert.deepEqual(rest, []);
		assert.equal(outcome?.degraded?.stage, "partial-changes");
		const observation = recorded.observed.at(-1)!;
		assert.deepEqual(observation.notices, [outcome!.message], "the fork's stages are told");
		assert.equal(existsSync(join(observation.cwd, "state.txt")), false);
	});
});

test("a pooled child placed on a partly restored worktree runs there, and its stages are told (#4738)", async () => {
	const worktree = sandbox.path("host", "worktrees", "partial");
	mkdirSync(worktree, { recursive: true });
	const partial = {
		root: "/node-a/repo",
		snapshotId: "a".repeat(32),
		message: "Restored /node-a/repo into the host's worktree at its recorded commit with 0 of the 1 change sets.",
		at: "2026-11-13T00:00:00.000Z",
	};
	const execution = placedExecution({ cwd: "/node-a/repo" }, worktree, partial);
	const observed: Observation[] = [];
	const child = workflow({
		name: "pooled-child",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("plan").complete("plan");
			observed.push({ cwd: ctx.cwd!, notices: currentWorktreeRestoreNotices() });
			return {};
		},
	});
	const store = createStore();

	const result = await run(
		child,
		{},
		{
			...(execution as RunOpts),
			store,
			adapters,
			durableBackend: await createMemoryTestBackend(),
		},
	);

	assert.equal(result.status, "completed", result.error);
	assert.deepEqual(observed, [{ cwd: worktree, notices: [partial.message] }]);
	assert.deepEqual(store.run(result.runId)?.worktreeRestoreOutcomes, [partial]);
	const unchanged = placedExecution({ cwd: "/node-a/repo" }, worktree);
	assert.equal("worktreeRestoreOutcomes" in unchanged, false, "an exact restore adds nothing");
});

afterEach(closeMemoryTestBackends);
