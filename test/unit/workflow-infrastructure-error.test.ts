import assert from "node:assert/strict";
import { TaskCleanupError, type TaskId } from "@bastani/atomic";
import { StorageUnavailableError } from "@bastani/atomic/storage";
import { test } from "vitest";
import { IntercomRuntimeInactiveError } from "../../packages/intercom/runtime-inactive-error.js";
import { StaleLeaseError } from "../../packages/workflows/src/durable/journal/types.js";
import {
	isRetryableWorkflowError,
	isWorkflowInfrastructureError,
	ProcessCleanupUnconfirmedError,
	PublicationRejectedError,
	StaleWorkLeaseError,
	WorkerCleanupUnconfirmedError,
	WorkerLostError,
	WorkerRetryLimitError,
	WorkerStartupTimeoutError,
	WorkflowInfrastructureError,
} from "../../packages/workflows/src/sdk-surface.js";
import { classifyWorkflowFailure } from "../../packages/workflows/src/shared/workflow-failures.js";
import {
	type WorkflowInfrastructureFault,
	workflowInfrastructureErrorFor,
} from "../../packages/workflows/src/shared/workflow-infrastructure-error.js";

/** One typed producer per infrastructure fault code, as the pool and its runtime throw them. */
const PRODUCERS: Readonly<Record<WorkflowInfrastructureFault, () => Error>> = {
	worker_lost: () => new WorkerLostError({ phase: "coordinator", pid: 7, signal: "SIGKILL" }),
	worker_cleanup_unconfirmed: () => new WorkerCleanupUnconfirmedError({ processGroups: [11] }),
	worker_retry_limit: () =>
		new WorkerRetryLimitError({ reason: "worker-lost", attempts: 3, limit: 3, childRunId: "c", exportName: "c" }),
	worker_startup_failed: () => new WorkerStartupTimeoutError({ logPath: "/w.log", timeoutMs: 500, elapsedMs: 501 }),
	stale_work_lease: () => new StaleWorkLeaseError({ root: "r", workId: "w", generation: 2, reason: "expired" }),
	intercom_unavailable: () => new IntercomRuntimeInactiveError(),
	storage_unavailable: () =>
		new StorageUnavailableError({ adapter: "node-sqlite", location: "/tmp/journal.sqlite" }, new Error("busy")),
	process_cleanup_unconfirmed: () =>
		new ProcessCleanupUnconfirmedError(
			new TaskCleanupError("stage-close", [
				{
					taskId: "task-1" as TaskId,
					resources: [{ resource: "process-group:4242", code: "CleanupFailed", message: "still running" }],
				},
			]),
		),
};

test("each infrastructure fault reaches a pool caller as a typed retryable error built from its typed cause (#3889, #4327)", () => {
	for (const [code, produce] of Object.entries(PRODUCERS)) {
		const cause = produce();
		const typed = workflowInfrastructureErrorFor(new Error("a stage failed", { cause }));
		assert.ok(typed instanceof WorkflowInfrastructureError, code);
		assert.equal(isWorkflowInfrastructureError(typed), true);
		assert.equal(typed.code, code);
		assert.equal(typed.retryable, true);
		assert.ok(typed.hint.length > 0);
		assert.equal(isRetryableWorkflowError(typed), true);
		if (cause instanceof WorkflowInfrastructureError) assert.equal(workflowInfrastructureErrorFor(cause), cause);
		else assert.equal((typed.cause as Error).cause, cause);
	}
	assert.equal(workflowInfrastructureErrorFor(new Error("child logic rejected the input")), undefined);
	assert.equal(workflowInfrastructureErrorFor(new StaleLeaseError("r", 1, 2)), undefined);
	assert.equal(
		workflowInfrastructureErrorFor(
			new PublicationRejectedError({ root: "r", workId: "w", generation: 1, reason: "outside-subtree" }),
		),
		undefined,
	);
});

test("retryable faults are recognized through causes but ordinary failures are not (#3889)", () => {
	const fault = new WorkerLostError({ phase: "delivery" });
	assert.equal(isRetryableWorkflowError(new Error("wrapped", { cause: new Error("again", { cause: fault }) })), true);
	const copied = Object.assign(new Error("copied"), {
		name: "WorkerLostError",
		retryable: true,
		code: "worker_lost",
	});
	assert.equal(isRetryableWorkflowError(copied), true);
	for (const failure of [
		new Error("Stale work lease"),
		"Stale work lease",
		undefined,
		null,
		{ retryable: true },
		Object.assign(new Error("copied"), { name: "WorkflowInfrastructureError", retryable: true, code: "x" }),
	])
		assert.equal(isRetryableWorkflowError(failure), false);
});

test("a stage that fails on a typed pool fault is a recoverable, retryable failure; the same words untyped are not (#4327)", () => {
	for (const [code, produce] of Object.entries(PRODUCERS)) {
		for (const error of [produce(), new Error("a tool failed", { cause: produce() })]) {
			const failure = classifyWorkflowFailure(error);
			assert.equal(failure.code, code, `${code}: ${error.message}`);
			assert.equal(failure.recoverability, "recoverable", code);
			assert.equal(failure.retryable, true, code);
			assert.equal(failure.resumable, true, code);
		}
		const sameWords = classifyWorkflowFailure(new Error(produce().message));
		assert.notEqual(sameWords.code, code, `untyped text of ${code} is not that fault`);
	}
	for (const message of [
		"Worker exited before delivery acknowledgement",
		"Stale work lease",
		"Stale resource admission attempt",
		"Local worker pool coordinator exited (SIGKILL)",
		"Intercom runtime no longer active",
		"Storage unavailable: node-sqlite at /tmp/journal.sqlite",
	])
		assert.equal(classifyWorkflowFailure(new Error(message)).recoverability, "unknown", message);
});
