import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { resumableEntryFromHandle } from "../../packages/workflows/src/durable/backend.js";
import { durableWorkflowRunSnapshots } from "../../packages/workflows/src/durable/completed-catalog.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { decodeJournalEventHandle } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resumeDurableWorkflow } from "../../packages/workflows/src/durable/resume-runtime.js";
import {
	claimsOf,
	hasForkClaim,
	hasResumeClaim,
	pendingForks,
	unsettledResumeClaims,
} from "../../packages/workflows/src/durable/run-claims.js";
import { renderCall } from "../../packages/workflows/src/extension/render-call.js";
import { renderResult } from "../../packages/workflows/src/extension/render-result.js";
import { resumeFailureCode } from "../../packages/workflows/src/extension/workflow-control-failure.js";
import { buildWorkflowRunStatusDigest } from "../../packages/workflows/src/extension/workflow-status-digest.js";
import { inspectRun } from "../../packages/workflows/src/runs/background/run-inspect.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { renderRunDetail } from "../../packages/workflows/src/tui/run-detail.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { testRunId } from "../helpers/run-id.js";
import { closeMemoryTestBackends, createMemoryTestBackend } from "../helpers/workflow-journal.js";

afterEach(async () => {
	setDurableBackend(undefined);
	await closeMemoryTestBackends();
});

const sourceId = testRunId("fork-surface-source");
const forkedFrom = { runId: sourceId, stagePath: "implement-api.review-2" };
const binding = { remotes: ["origin"], head: "c0ffee", tree: "7ree", envHash: "e1" };
const workspace = { ...binding, repository: "acme/product", branch: "main", worktree: "/w", label: "ci" };

test("re-registering a forked run keeps its lineage and repository bindings (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const id = testRunId("fork-surface-register");
	await backend.commitWorkflowRegistration({
		workflowId: id,
		name: "w",
		inputs: {},
		status: "paused",
		createdAt: 1,
		forkedFrom,
		workspace,
		snapshot: binding,
	});
	await backend.commitWorkflowRegistration({
		workflowId: id,
		name: "w",
		inputs: { x: 1 },
		status: "running",
		createdAt: 1,
	});
	const handle = backend.getWorkflow(id)!;
	assert.deepEqual(handle.forkedFrom, forkedFrom);
	assert.deepEqual(handle.workspace, workspace);
	assert.deepEqual(handle.snapshot, binding);
	assert.deepEqual(handle.inputs, { x: 1 });
	const metadata = backend.toMetadata(id)!;
	assert.deepEqual([metadata.forkedFrom, metadata.workspace, metadata.snapshot], [forkedFrom, workspace, binding]);
	assert.deepEqual(resumableEntryFromHandle(handle).forkedFrom, forkedFrom);
	const plain = testRunId("fork-surface-plain");
	await backend.commitWorkflowRegistration({
		workflowId: plain,
		name: "w",
		inputs: {},
		status: "paused",
		createdAt: 1,
	});
	assert.equal("forkedFrom" in backend.getWorkflow(plain)!, false);
	assert.equal("workspace" in backend.toMetadata(plain)!, false);
	assert.equal("forkedFrom" in resumableEntryFromHandle(backend.getWorkflow(plain)!), false);
});

test("a forked run's lineage reaches restored snapshots, run detail and the status digest (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const id = testRunId("fork-surface-snapshot");
	await backend.commitWorkflowRegistration({
		workflowId: id,
		name: "w",
		inputs: {},
		status: "completed",
		createdAt: 1,
		forkedFrom,
	});
	await backend.commitCheckpoint({
		kind: "stage",
		workflowId: id,
		checkpointId: "stage:plan",
		name: "plan",
		replayKey: "stage:plan:1",
		output: "done",
		completedAt: 2,
	});
	const [root] = durableWorkflowRunSnapshots(backend, backend.getWorkflow(id)!);
	assert.deepEqual(root?.forkedFrom, forkedFrom);
	const store = createStore();
	store.recordRunStart({ ...root!, stages: [], toolNodes: [] });
	const detail = inspectRun(id, { store });
	assert.ok(detail.ok);
	assert.deepEqual(detail.detail.forkedFrom, forkedFrom);
	assert.deepEqual(buildWorkflowRunStatusDigest(detail.detail).forkedFrom, forkedFrom);
	assert.match(
		renderRunDetail(detail.detail, { width: 160 }),
		new RegExp(`forked from\\s+${sourceId} at implement-api\\.review-2`),
	);
	const wholeRun = renderRunDetail({ ...detail.detail, forkedFrom: { runId: sourceId } }, { width: 160 });
	assert.match(wholeRun, new RegExp(`forked from\\s+${sourceId}\\s`));
	assert.doesNotMatch(wholeRun, /forked from.* at /);
	assert.doesNotMatch(wholeRun, /undefined/);
	const unforked = testRunId("fork-surface-unforked");
	store.recordRunStart({
		id: unforked,
		name: "w",
		inputs: {},
		status: "completed",
		stages: [],
		toolNodes: [],
		startedAt: 1,
	});
	const plain = inspectRun(unforked, { store });
	assert.ok(plain.ok);
	assert.equal("forkedFrom" in plain.detail, false);
	assert.equal("forkedFrom" in buildWorkflowRunStatusDigest(plain.detail), false);
	assert.doesNotMatch(renderRunDetail(plain.detail, { width: 160 }), /forked from/);
});

test("decodeJournalEventHandle decodes handle events and ignores events without one (#4321)", () => {
	const handle = {
		workflowId: sourceId,
		name: "w",
		inputs: {},
		createdAt: 1,
		updatedAt: 1,
		status: "paused" as const,
		completedCheckpoints: 0,
		pendingPrompts: 0,
	};
	assert.deepEqual(decodeJournalEventHandle({ type: "RunStarted", payload: handle }, undefined), handle);
	assert.equal(decodeJournalEventHandle({ type: "CheckpointRecorded", payload: { kind: "tool" } }, handle), undefined);
	assert.equal(decodeJournalEventHandle({ type: "MessageSettled", payload: {} }, handle), undefined);
	assert.deepEqual(
		decodeJournalEventHandle({ type: "PromptAsked", payload: { handle: { ...handle, pendingPrompts: 1 } } }, handle),
		{ ...handle, pendingPrompts: 1 },
	);
});

test("fork and resume claims on one backend are told apart, and a forked run is not resumable meanwhile (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const id = testRunId("fork-surface-claims");
	assert.equal(hasForkClaim(backend, id), false);
	assert.equal(hasResumeClaim(backend, id), false);
	claimsOf(unsettledResumeClaims, backend).add(id);
	assert.equal(hasResumeClaim(backend, id), true);
	assert.equal(hasForkClaim(backend, id), false);
	claimsOf(unsettledResumeClaims, backend).delete(id);
	claimsOf(pendingForks, backend).add(id);
	assert.equal(claimsOf(pendingForks, backend), claimsOf(pendingForks, backend));
	assert.equal(hasForkClaim(backend, id), true);
	await backend.commitWorkflowRegistration({ workflowId: id, name: "w", inputs: {}, status: "paused", createdAt: 1 });
	const refused = await resumeDurableWorkflow(id, {
		registry: createRegistry(),
		durableBackend: backend,
		baseRunOpts: { store: createStore() },
	});
	assert.equal(refused.ok, false);
	assert.ok(!refused.ok && refused.reason === "not_resumable");
	assert.ok(!refused.ok && refused.message.includes("being forked"));
	claimsOf(pendingForks, backend).delete(id);
	assert.equal(hasForkClaim(backend, id), false);
});

test("the fork action renders its call, result and failure code (#4321)", () => {
	assert.equal(renderCall({ action: "fork", runId: "abc" }), 'workflow: fork run "abc"');
	assert.equal(renderCall({ action: "fork" }), "workflow: fork run");
	const ok = renderResult({
		action: "fork",
		runId: "fork-id",
		sourceRunId: sourceId,
		status: "running",
		message: "Forked workflow.",
		forkedFrom,
	});
	assert.match(ok, /WORKFLOW FORK/);
	assert.match(ok, /fork-id: Forked workflow\./);
	const failed = renderResult({
		action: "fork",
		runId: "",
		sourceRunId: sourceId,
		status: "failed",
		message: "Fork source busy.",
		code: "source-busy",
	});
	assert.match(failed, new RegExp(`${sourceId}: Fork source busy\\.`));
	assert.equal(resumeFailureCode("fork_failed"), "control_failed");
});
