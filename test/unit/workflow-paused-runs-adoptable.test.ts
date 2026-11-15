import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import type { WorkflowRegistrationInput } from "../../packages/workflows/src/durable/backend.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { resumeDurableWorkflow } from "../../packages/workflows/src/durable/resume-runtime.js";
import { isSdkReleasedRunAdoptable } from "../../packages/workflows/src/durable/sdk-recovery-scope.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { expireWorkflowLease } from "../helpers/workflow-lease.js";

const definition = workflow({
	name: "paused-adoptable",
	description: "",
	inputs: {},
	outputs: {},
	run: async () => ({}),
});

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function openBackend(path: string): Promise<JournalDurableBackend> {
	const backend = await JournalDurableBackend.open(await openSqlRunJournal(path));
	cleanups.push(() => backend.close());
	return backend;
}

/** A run its owner `old-session` registered; that session's process then died, leaving its lease to expire. */
async function orphanedRun(overrides: Partial<WorkflowRegistrationInput> = {}) {
	const directory = makeTempDirectory("paused-adoptable-");
	cleanups.push(() => removeTempDirectory(directory));
	const path = join(directory, "journal.sqlite");
	const workflowId = crypto.randomUUID();
	const owner = await JournalDurableBackend.open(await openSqlRunJournal(path));
	await owner.commitWorkflowRegistration({
		workflowId,
		name: definition.name,
		inputs: {},
		status: "running",
		createdAt: 1,
		updatedAt: 1,
		invocationCwd: process.cwd(),
		modelOwner: "old-session",
		completedCheckpoints: 1,
		...overrides,
	});
	await owner.close();
	// The owner's process died holding the run's executor lease, which then expired unrenewed.
	const dead = await openSqlRunJournal(path);
	assert.equal((await dead.acquire(workflowId, "dead-host")).status, "acquired");
	await dead.close();
	expireWorkflowLease(path, workflowId);
	return { workflowId, path, backend: await openBackend(path) };
}

/** Another session's process adopts the run through its own view of the journal. */
async function adoptFromNewSession(path: string, workflowId: string) {
	const backend = await openBackend(path);
	const jobs = createJobTracker();
	const result = await resumeDurableWorkflow(workflowId, {
		registry: createRegistry([definition]),
		durableBackend: backend,
		jobs,
		baseRunOpts: { store: createStore(), cwd: process.cwd(), modelOwner: "new-session" },
	});
	await jobs.get(workflowId)?.promise;
	return { result, backend };
}

test("a crashed run that is paused is released by its dead owner, so a new session can adopt it (#5167)", async () => {
	const { workflowId, path, backend } = await orphanedRun();
	assert.equal(await backend.commitWorkflowStatusTransition(workflowId, ["running"], "paused"), true);
	const paused = backend.getWorkflow(workflowId);
	assert.deepEqual(
		[paused?.status, paused?.modelOwner, paused?.releasedModelOwner],
		["paused", "old-session", "old-session"],
	);
	assert.equal(isSdkReleasedRunAdoptable(paused!, process.cwd()), true);
	const adopted = await adoptFromNewSession(path, workflowId);
	assert.equal(adopted.result.ok, true, adopted.result.message);
	assert.equal(adopted.backend.getWorkflow(workflowId)?.modelOwner, "new-session");
});

for (const [label, pendingPrompts, resumable] of [
	["an answered prompt", 0, undefined],
	["a re-pause", undefined, undefined],
	["a resumable write", undefined, true],
] as const) {
	test(`a released run keeps its release through ${label}, so a new session can adopt it (#5167)`, async () => {
		const { workflowId, path, backend } = await orphanedRun({
			status: "paused",
			releasedModelOwner: "old-session",
			pendingPrompts: 1,
		});
		assert.equal(
			await backend.commitWorkflowStatusTransition(workflowId, ["paused"], "paused", pendingPrompts, resumable),
			true,
		);
		const handle = backend.getWorkflow(workflowId);
		assert.equal(handle?.releasedModelOwner, "old-session");
		assert.equal(isSdkReleasedRunAdoptable(handle!, process.cwd()), true);
		const adopted = await adoptFromNewSession(path, workflowId);
		assert.equal(adopted.result.ok, true, adopted.result.message);
		const after = adopted.backend.getWorkflow(workflowId);
		assert.deepEqual([after?.modelOwner, after?.releasedModelOwner], ["new-session", undefined]);
	});
}

test("a run its live owner's executor pauses is not released (#5167)", async () => {
	const directory = makeTempDirectory("paused-adoptable-live-");
	cleanups.push(() => removeTempDirectory(directory));
	const backend = await openBackend(join(directory, "journal.sqlite"));
	const workflowId = crypto.randomUUID();
	// The owner's executor registers the run, runs it here, and pauses it from within its execution.
	await backend.withWorkflowLease(workflowId, async () => {
		await backend.commitWorkflowRegistration({
			workflowId,
			name: definition.name,
			inputs: {},
			status: "running",
			createdAt: 1,
			updatedAt: 1,
			invocationCwd: process.cwd(),
			modelOwner: "live-session",
			completedCheckpoints: 1,
		});
		assert.equal(await backend.commitWorkflowStatusTransition(workflowId, ["running"], "paused"), true);
	});
	assert.equal(backend.getWorkflow(workflowId)?.releasedModelOwner, undefined);
});

test("a run another process's live executor holds is not released by a pause elsewhere (#5167)", async () => {
	const directory = makeTempDirectory("paused-adoptable-foreign-");
	cleanups.push(() => removeTempDirectory(directory));
	const path = join(directory, "journal.sqlite");
	const owner = await openBackend(path);
	const workflowId = crypto.randomUUID();
	await owner.commitWorkflowRegistration({
		workflowId,
		name: definition.name,
		inputs: {},
		status: "running",
		createdAt: 1,
		updatedAt: 1,
		invocationCwd: process.cwd(),
		modelOwner: "live-session",
		completedCheckpoints: 1,
	});
	const finish = Promise.withResolvers<void>();
	const executing = owner.withWorkflowLease(workflowId, () => finish.promise);
	try {
		const other = await openBackend(path);
		assert.equal(await other.workflowOwnership(workflowId), "foreign");
		await other.commitWorkflowStatusTransition(workflowId, ["running"], "paused").catch(() => false);
		assert.equal(other.getWorkflow(workflowId)?.releasedModelOwner, undefined);
	} finally {
		finish.resolve();
		await executing;
	}
});

test("a running run that no executor runs is released by its owner when paused, and its owner can still resume it (#5167)", async () => {
	const directory = makeTempDirectory("paused-adoptable-stopped-");
	cleanups.push(() => removeTempDirectory(directory));
	const path = join(directory, "journal.sqlite");
	const workflowId = crypto.randomUUID();
	const owner = await JournalDurableBackend.open(await openSqlRunJournal(path));
	await owner.commitWorkflowRegistration({
		workflowId,
		name: definition.name,
		inputs: {},
		status: "running",
		createdAt: 1,
		updatedAt: 1,
		invocationCwd: process.cwd(),
		modelOwner: "live-session",
		completedCheckpoints: 1,
	});
	await owner.close();
	const backend = await openBackend(path);
	assert.equal(await backend.commitWorkflowStatusTransition(workflowId, ["running"], "paused"), true);
	assert.equal(backend.getWorkflow(workflowId)?.releasedModelOwner, "live-session");
	const jobs = createJobTracker();
	const resumed = await resumeDurableWorkflow(workflowId, {
		registry: createRegistry([definition]),
		durableBackend: backend,
		jobs,
		baseRunOpts: { store: createStore(), cwd: process.cwd(), modelOwner: "live-session" },
	});
	await jobs.get(workflowId)?.promise;
	assert.equal(resumed.ok, true, resumed.message);
});

test("a failed run whose owner's process died is released by it when paused (#5167)", async () => {
	const { workflowId, backend } = await orphanedRun({ status: "failed" });
	assert.equal(await backend.commitWorkflowStatusTransition(workflowId, ["failed"], "paused"), true);
	assert.equal(backend.getWorkflow(workflowId)?.releasedModelOwner, "old-session");
});

test("a released run leaves its release when it runs again or its owner reclaims it explicitly (#5167)", async () => {
	const { workflowId, backend } = await orphanedRun({ status: "paused", releasedModelOwner: "old-session" });
	assert.equal(
		await backend.commitWorkflowStatusTransition(
			workflowId,
			["paused"],
			"paused",
			undefined,
			undefined,
			undefined,
			undefined,
			null,
		),
		true,
	);
	assert.equal(backend.getWorkflow(workflowId)?.releasedModelOwner, undefined);
	const { workflowId: rerun, backend: other } = await orphanedRun({
		status: "paused",
		releasedModelOwner: "old-session",
	});
	assert.equal(await other.commitWorkflowStatusTransition(rerun, ["paused"], "running"), true);
	assert.equal(other.getWorkflow(rerun)?.releasedModelOwner, undefined);
});

test("a crashed run paused by a process that already took over its dead owner's lease is still released (#5167)", async () => {
	const { workflowId, path, backend } = await orphanedRun();
	// Any write takes over the expired lease first, as a resume in progress here would.
	await backend.commitPendingPromptAdjustment(workflowId, 0);
	assert.equal(await backend.workflowOwnership(workflowId), "local");
	assert.equal(await backend.commitWorkflowStatusTransition(workflowId, ["running"], "paused"), true);
	assert.equal(backend.getWorkflow(workflowId)?.releasedModelOwner, "old-session");
	const adopted = await adoptFromNewSession(path, workflowId);
	assert.equal(adopted.result.ok, true, adopted.result.message);
});

test("a crashed run handed to a new owner whose executor runs it is that owner's: its pause does not release it (#5167)", async () => {
	const { workflowId, backend } = await orphanedRun();
	await backend.withWorkflowLease(workflowId, async () => {
		// The adoption claim hands the run over; the new owner's executor then registers the run it claimed.
		assert.equal(
			await backend.commitWorkflowStatusTransition(
				workflowId,
				["running"],
				"running",
				undefined,
				undefined,
				undefined,
				"new-session",
			),
			true,
		);
		const claimed = backend.getWorkflow(workflowId)!;
		assert.equal(
			await backend.commitClaimedWorkflowRegistration({ ...claimed, status: "running" }, "new-session"),
			true,
		);
		assert.equal(await backend.commitWorkflowStatusTransition(workflowId, ["running"], "paused"), true);
	});
	const handle = backend.getWorkflow(workflowId);
	assert.deepEqual([handle?.modelOwner, handle?.releasedModelOwner], ["new-session", undefined]);
});

test("a crashed run paused after another process took over and cleanly released its dead owner's lease is still released (#5167)", async () => {
	const { workflowId, path, backend } = await orphanedRun();
	// Another session's process takes over the dead lease (a write, or an adoption it then aborted) and releases it.
	const other = await openBackend(path);
	await other.commitPendingPromptAdjustment(workflowId, 0);
	await other.releaseWorkflow(workflowId);
	assert.equal(await backend.commitWorkflowStatusTransition(workflowId, ["running"], "paused"), true);
	assert.equal(backend.getWorkflow(workflowId)?.releasedModelOwner, "old-session");
	const adopted = await adoptFromNewSession(path, workflowId);
	assert.equal(adopted.result.ok, true, adopted.result.message);
});

test("a session whose process took over a crashed run's dead lease can adopt the run (#5167)", async () => {
	const { workflowId, backend } = await orphanedRun();
	// Answering a prompt of the crashed run takes its expired lease over in this process.
	await backend.commitPendingPromptAdjustment(workflowId, 0);
	assert.equal(await backend.workflowOwnership(workflowId), "local");
	const jobs = createJobTracker();
	const result = await resumeDurableWorkflow(workflowId, {
		registry: createRegistry([definition]),
		durableBackend: backend,
		jobs,
		baseRunOpts: { store: createStore(), cwd: process.cwd(), modelOwner: "new-session" },
	});
	await jobs.get(workflowId)?.promise;
	assert.equal(result.ok, true, result.message);
	assert.equal(backend.getWorkflow(workflowId)?.modelOwner, "new-session");
});

test("a crashed run paused while a resume of it is still deciding is released: nothing runs it yet (#5167)", async () => {
	const { workflowId, path, backend } = await orphanedRun();
	// A resume holds the run's execution scope while it decides, before it claims the run.
	await backend.withWorkflowLease(workflowId, async () => {
		assert.equal(await backend.commitWorkflowStatusTransition(workflowId, ["running"], "paused"), true);
	});
	assert.equal(backend.getWorkflow(workflowId)?.releasedModelOwner, "old-session");
	const adopted = await adoptFromNewSession(path, workflowId);
	assert.equal(adopted.result.ok, true, adopted.result.message);
});
