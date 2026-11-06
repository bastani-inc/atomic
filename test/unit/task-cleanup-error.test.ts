import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	isRetryableTaskError,
	isTaskCleanupAdmissionTimeoutError,
	isTaskCleanupError,
	rehydrateTaskCleanupError,
	TaskCleanupAdmissionTimeoutError,
	TaskCleanupError,
} from "@bastani/atomic";
import { test } from "vitest";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type {
	Cleanup,
	NativeEvent,
	NativeTaskRef,
	OperationId,
	OwnerSnapshot,
	ResourceFailure,
	TaskId,
	TaskRecord,
	TaskResult,
} from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { quarantinedCleanups } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { cancelReceiptSentence } from "../../packages/coding-agent/src/core/tools/shell-task-status.js";
import { WorkflowStageAdmissionBoundary } from "../../packages/coding-agent/src/core/workflow-stage-admission.js";
import { createHarness } from "../../packages/coding-agent/test/suite/harness.js";
import { createStageControlHandle } from "../../packages/workflows/src/runs/foreground/executor-stage-control.js";
import {
	isProcessCleanupUnconfirmedError,
	isRetryableWorkflowError,
	ProcessCleanupUnconfirmedError,
	rehydrateWorkflowInfrastructureError,
	type SerializedWorkflowInfrastructureError,
	serializeWorkflowInfrastructureError,
	WorkflowInfrastructureError,
} from "../../packages/workflows/src/sdk-surface.js";
import { serializeError } from "../../packages/workflows/src/shared/error-codec.js";
import { isPoolProtocolError } from "../../packages/workflows/src/shared/worker-pool-errors.js";
import { classifyWorkflowFailure } from "../../packages/workflows/src/shared/workflow-failures.js";
import { runFailureClassification } from "../../packages/workflows/src/shared/workflow-failures-classifier.js";
import {
	failedOnPoolFault,
	WORKFLOW_INFRASTRUCTURE_FAULTS,
} from "../../packages/workflows/src/shared/workflow-infrastructure-error.js";

const drain: ResourceFailure = {
	resource: "process-group:4242",
	code: "CleanupFailed",
	message: "Output reader drain was not confirmed",
};
const exit: ResourceFailure = {
	resource: "process-group:4343",
	code: "CleanupFailed",
	message: "Process-group exit was not confirmed",
};
const intent = { kind: "agent" as const, agent: "worker", task: "Stage-owned work" };

function cleanupError(): TaskCleanupError {
	return new TaskCleanupError(
		"stage-close",
		[
			{ taskId: "task-1" as TaskId, resources: [drain] },
			{ taskId: "task-2" as TaskId, resources: [exit] },
		],
		{ cause: { code: "CleanupFailed", message: "native close refused" } },
	);
}

test("TaskCleanupError carries its code, phase, failures, hint and cause, and renders them once (#4338)", () => {
	const error = cleanupError();
	assert.ok(error instanceof Error);
	assert.equal(error.name, "TaskCleanupError");
	assert.equal(error.code, "task_cleanup_unconfirmed");
	assert.equal(error.retryable, true);
	assert.equal(error.phase, "stage-close");
	assert.deepEqual(error.failures, [
		{ taskId: "task-1", resources: [drain] },
		{ taskId: "task-2", resources: [exit] },
	]);
	assert.deepEqual(error.cause, { code: "CleanupFailed", message: "native close refused" });
	assert.equal(
		error.hint,
		"Check that the listed processes have exited, then retry or resume the work; the task results are kept",
	);
	assert.equal(
		error.message,
		"Task cleanup was not confirmed: task-1 process-group:4242: Output reader drain was not confirmed; " +
			"task-2 process-group:4343: Process-group exit was not confirmed (task_cleanup_unconfirmed). " +
			"Check that the listed processes have exited, then retry or resume the work; the task results are kept.",
	);
	assert.match(new TaskCleanupError("stage-pause", []).message, /^Task cleanup was not confirmed: owned tasks \(/);
	assert.deepEqual(JSON.parse(JSON.stringify(error)), {
		name: "TaskCleanupError",
		code: "task_cleanup_unconfirmed",
		retryable: true,
		hint: error.hint,
		phase: "stage-close",
		failures: [
			{ taskId: "task-1", resources: [drain] },
			{ taskId: "task-2", resources: [exit] },
		],
	});
});

test("isTaskCleanupError matches the class and its structural copy from another realm, and nothing else (#4338)", () => {
	const error = cleanupError();
	assert.equal(isTaskCleanupError(error), true);
	const copied = { ...JSON.parse(JSON.stringify(error)), message: error.message };
	assert.equal(isTaskCleanupError(copied), true);
	for (const other of [
		{ ...copied, name: "Error" },
		{ ...copied, code: "task_cleanup_failed" },
		new Error(error.message),
		"TaskCleanupError",
		undefined,
		null,
		42,
	])
		assert.equal(isTaskCleanupError(other), false, JSON.stringify(other));
});

test("a stage whose task cleanup is unconfirmed fails with a retryable process_cleanup_unconfirmed caused by it (#4338)", () => {
	const cause = cleanupError();
	const error = new ProcessCleanupUnconfirmedError(cause);
	assert.ok(error instanceof WorkflowInfrastructureError);
	assert.equal(error.name, "ProcessCleanupUnconfirmedError");
	assert.equal(error.code, "process_cleanup_unconfirmed");
	assert.equal(error.retryable, true);
	assert.equal(error.cause, cause);
	assert.equal(error.hint, cause.hint);
	assert.equal(error.phase, "stage-close");
	assert.deepEqual(error.resources, [
		{ taskId: "task-1", ...drain },
		{ taskId: "task-2", ...exit },
	]);
	assert.equal(
		error.message,
		"Workflow stage task cleanup was not confirmed: process-group:4242, process-group:4343 " +
			`(process_cleanup_unconfirmed). ${cause.hint}`,
	);
	assert.match(
		new ProcessCleanupUnconfirmedError(new TaskCleanupError("stage-close", [])).message,
		/: owned tasks \(/,
	);
	assert.equal(isRetryableWorkflowError(error), true);
	assert.equal(isRetryableWorkflowError(new Error("stage failed", { cause: error })), true);
	assert.equal(isRetryableWorkflowError(cause), false, "only the workflow wrapper is the retryable workflow error");
	assert.ok(WORKFLOW_INFRASTRUCTURE_FAULTS.has("process_cleanup_unconfirmed"));
});

test("process_cleanup_unconfirmed classifies as a recoverable, resumable infrastructure fault in and across processes (#4338)", () => {
	const failure = classifyWorkflowFailure(new ProcessCleanupUnconfirmedError(cleanupError()));
	assert.deepEqual(
		{
			code: failure.code,
			retryable: failure.retryable,
			resumable: failure.resumable,
			recoverability: failure.recoverability,
			disposition: failure.disposition,
		},
		{
			code: "process_cleanup_unconfirmed",
			retryable: true,
			resumable: true,
			recoverability: "recoverable",
			disposition: "terminal_failed",
		},
	);
	// A pool worker and a resumed run see the stage only as recorded: its failure code still names the fault.
	const recorded = JSON.parse(
		JSON.stringify({ status: "failed", stages: [{ status: "failed", failureCode: failure.code, error: "x" }] }),
	);
	assert.equal(failedOnPoolFault(recorded), true);
	assert.equal(failedOnPoolFault({ ...recorded, stages: [{ ...recorded.stages[0], failureCode: "unknown" }] }), false);
	assert.deepEqual(runFailureClassification({ kind: "unknown", code: "process_cleanup_unconfirmed" }), {
		kind: "unknown",
		code: "process_cleanup_unconfirmed",
		retryable: true,
		resumable: true,
	});
});

test("a stage generation whose task cleanup failed rejects its close with a TaskCleanupError naming every resource (#4338)", async () => {
	const boundary = new WorkflowStageAdmissionBoundary();
	boundary.bindTaskIdentity(randomUUID(), "run", "stage");
	const host = boundary.bindAgentTaskHost({ authorizeLaunch() {} });
	const started = await host.startAgentTask(intent, randomUUID() as OperationId, () => ({
		result: new Promise<TaskResult>(() => {}),
		cleanup: Promise.resolve<Cleanup>({ kind: "failed", resources: [drain] }),
	}));
	assert.ok(started.ok);
	const reaped = await host.startAgentTask(intent, randomUUID() as OperationId, () => ({
		result: new Promise<TaskResult>(() => {}),
		cleanup: Promise.resolve<Cleanup>({ kind: "reaped" }),
	}));
	assert.ok(reaped.ok);
	const closing = boundary.close();
	await assert.rejects(closing, (error) => {
		assert.ok(isTaskCleanupError(error), String(error));
		assert.equal(error.phase, "stage-close");
		assert.deepEqual(error.failures, [{ taskId: started.value.taskId, resources: [drain] }]);
		assert.equal((error.cause as { code?: string }).code, "CleanupFailed");
		return true;
	});
	assert.equal(boundary.close(), closing, "a repeated close reports the same failure");
});

test("a session owner whose task cleanup failed reports a typed cleanup error for its close (#4338)", async () => {
	const host = new AgentTaskHost({ scope: { kind: "session", sessionId: randomUUID() }, authorizeLaunch() {} });
	const started = await host.startAgentTask(intent, randomUUID() as OperationId, () => ({
		result: new Promise<TaskResult>(() => {}),
		cleanup: Promise.resolve<Cleanup>({ kind: "failed", resources: [exit] }),
	}));
	assert.ok(started.ok);
	const closed = await host.close("session-close");
	assert.ok(!closed.ok && closed.error.code === "CleanupFailed");
	const error = host.closeError("session-close", closed.error);
	assert.ok(isTaskCleanupError(error));
	assert.equal(error.phase, "session-close");
	assert.deepEqual(error.failures, [{ taskId: started.value.taskId, resources: [exit] }]);
	assert.equal(error.cause, closed.error);
});

test("a kill result names quarantined cleanup as still being confirmed, apart from failed cleanup (#4338)", () => {
	const quarantined: Cleanup = { kind: "quarantined", resources: [{ ...drain, code: "CleanupUnconfirmed" }] };
	const receipt = {
		taskId: "task-1" as TaskId,
		decision: "already-settled" as const,
		execution: { kind: "settled" as const, result: { kind: "completed" as const, output: undefined!, exitCode: 0 } },
	};
	assert.match(
		cancelReceiptSentence({ ...receipt, cleanup: quarantined }),
		/ Cleanup quarantined, still being confirmed: process-group:4242 \(CleanupUnconfirmed\): Output reader drain was not confirmed\.$/,
	);
	assert.match(
		cancelReceiptSentence({ ...receipt, cleanup: { kind: "failed", resources: [drain] } }),
		/ Cleanup failed: process-group:4242 \(CleanupFailed\): Output reader drain was not confirmed\.$/,
	);
	assert.match(cancelReceiptSentence({ ...receipt, cleanup: { kind: "reaped" } }), / Cleanup: reaped\.$/);
	assert.match(
		cancelReceiptSentence({ ...receipt, cleanup: { kind: "quarantined", resources: [drain, exit] } }),
		/ Cleanup quarantined, still being confirmed: process-group:4242 \(CleanupFailed\): Output reader drain was not confirmed; process-group:4343 \(CleanupFailed\): Process-group exit was not confirmed\.$/,
	);
});

test("closing a session whose task cleanup failed reports a TaskCleanupError for its session close (#4338)", async () => {
	const harness = await createHarness();
	const started = await harness.session.getAgentTaskHost().startAgentTask(intent, randomUUID() as OperationId, () => ({
		result: new Promise<TaskResult>(() => {}),
		cleanup: Promise.resolve<Cleanup>({ kind: "failed", resources: [exit] }),
	}));
	assert.ok(started.ok);
	await assert.rejects(harness.cleanup(), (error) => {
		assert.ok(error instanceof AggregateError);
		const cleanup = error.errors.map((entry: Error) => entry.cause).find(isTaskCleanupError);
		assert.ok(cleanup, String(error.errors));
		assert.equal(cleanup.phase, "session-close");
		assert.deepEqual(cleanup.failures, [{ taskId: started.value.taskId, resources: [exit] }]);
		return true;
	});
});

test("a drain reports each quarantined cleanup its events or its projection show (#4338)", () => {
	const ref = (taskId: string) => ({ ownerId: "owner", taskId, attemptId: "1", generation: "1" }) as NativeTaskRef;
	const quarantined: Cleanup = { kind: "quarantined", resources: [drain] };
	const cleanupChanged = (taskId: string, cleanup: Cleanup) =>
		({ payload: { kind: "cleanup-changed", ref: ref(taskId), cleanup } }) as NativeEvent;
	const record = (taskId: string, cleanup: Cleanup) => ({ ref: ref(taskId), cleanup }) as TaskRecord;
	const projection = {
		tasks: [record("in-projection", quarantined), record("confirmed", { kind: "reaped" })],
	} as OwnerSnapshot;
	const events = [
		cleanupChanged("confirmed", quarantined),
		cleanupChanged("confirmed", { kind: "reaped" }),
		{ payload: { kind: "task-started", ref: ref("started") } } as NativeEvent,
	];
	assert.deepEqual(quarantinedCleanups(projection, events), [
		{ ref: ref("confirmed"), resources: [drain] },
		{ ref: ref("in-projection"), resources: [drain] },
	]);
	assert.deepEqual(quarantinedCleanups({ tasks: [record("x", { kind: "draining" })] } as OwnerSnapshot, []), []);
});

test("a close that fails for another reason keeps its plain error, and a closed owner has no failed cleanups (#4338)", async () => {
	const host = new AgentTaskHost({ scope: { kind: "session", sessionId: randomUUID() }, authorizeLaunch() {} });
	const error = host.closeError("session-close", { code: "EnvironmentClosing", message: "Atomic is shutting down" });
	assert.equal(isTaskCleanupError(error), false);
	assert.equal(error.message, "EnvironmentClosing: Atomic is shutting down");
	const closed = await host.close("session-close");
	assert.ok(closed.ok);
	const { supervisor, owner } = host.ownerBinding;
	assert.deepEqual(supervisor.failedTaskCleanups(owner), []);
});

test("closing a session without tasks, or whose tasks were all cleaned up, reports no task error (#4338)", async () => {
	await (await createHarness()).cleanup();
	const harness = await createHarness();
	const finished = await harness.session
		.getAgentTaskHost()
		.startAgentTask(intent, randomUUID() as OperationId, () => ({
			result: Promise.resolve<TaskResult>({ kind: "failed", code: "test", message: "done" }),
			cleanup: Promise.resolve<Cleanup>({ kind: "reaped" }),
		}));
	assert.ok(finished.ok);
	await harness.cleanup();
});

test("a stage records each quarantined resource of a task in one cleanup notice (#4338)", () => {
	let listener: ((event: { readonly type: string }) => void) | undefined;
	const notices: Array<{ runId: string; stageId: string; notice: Record<string, unknown> }> = [];
	const runtime = {
		runId: "run-cleanup",
		stageId: "stage-cleanup",
		innerCtx: {
			subscribe: (next: typeof listener) => {
				listener = next;
				return () => {};
			},
		},
		activeStore: {
			recordStageNotice: (runId: string, stageId: string, notice: Record<string, unknown>) => {
				notices.push({ runId, stageId, notice });
				return true;
			},
		},
	};
	createStageControlHandle(runtime as never);
	assert.ok(listener);
	listener({ type: "tool_execution_start" });
	listener({ type: "task_cleanup_quarantined", taskId: "task-9", resources: [drain, exit] } as never);
	assert.equal(notices.length, 1);
	const [{ runId, stageId, notice }] = notices as [(typeof notices)[number]];
	assert.deepEqual({ runId, stageId }, { runId: "run-cleanup", stageId: "stage-cleanup" });
	assert.equal(typeof notice.id, "string");
	assert.equal(typeof notice.ts, "number");
	assert.deepEqual(
		{ kind: notice.kind, to: notice.to, meta: notice.meta },
		{
			kind: "cleanup",
			to: "quarantined",
			meta:
				"task-9 process-group:4242: Output reader drain was not confirmed; " +
				"task-9 process-group:4343: Process-group exit was not confirmed",
		},
	);
});

test("isRetryableTaskError finds a retryable TaskCleanupError, or its copy, within eight causes (#4338)", () => {
	const cause = cleanupError();
	const copy = JSON.parse(JSON.stringify(cause));
	const nest = (error: unknown, links: number): unknown =>
		links === 0 ? error : nest(new Error(`link ${links}`, { cause: error }), links - 1);
	for (const retryable of [
		cause,
		new Error("stage failed", { cause }),
		new ProcessCleanupUnconfirmedError(cause),
		copy,
		{ message: "relayed", cause: copy },
		nest(cause, 7),
	])
		assert.equal(isRetryableTaskError(retryable), true);
	const cycle = new Error("cycle");
	(cycle as { cause?: unknown }).cause = cycle;
	for (const other of [
		{ ...copy, retryable: false },
		new Error("plain"),
		new Error("null cause", { cause: null }),
		new AggregateError([cause], "shutdown"),
		nest(cause, 8),
		cycle,
		"TaskCleanupError",
		undefined,
		null,
	])
		assert.equal(isRetryableTaskError(other), false);
});

test("a TaskCleanupError copy that crossed a process boundary rehydrates into the class, and a malformed one does not (#4338)", () => {
	const error = cleanupError();
	const rehydrated = rehydrateTaskCleanupError(JSON.parse(JSON.stringify(error)));
	assert.ok(rehydrated instanceof TaskCleanupError);
	assert.equal(rehydrated.phase, "stage-close");
	assert.deepEqual(rehydrated.failures, error.failures);
	assert.equal(rehydrated.message, error.message);
	const copy = JSON.parse(JSON.stringify(error));
	for (const malformed of [
		{ ...copy, phase: "stage-stop" },
		{ ...copy, phase: 3 },
		{ ...copy, failures: "none" },
		{ ...copy, failures: [null] },
		{ ...copy, failures: [{ taskId: 1, resources: [] }] },
		{ ...copy, failures: [{ taskId: "task-1", resources: "none" }] },
		{ ...copy, failures: [{ taskId: "task-1", resources: [null] }] },
		{ ...copy, failures: [{ taskId: "task-1", resources: [{ ...drain, resource: 1 }] }] },
		{ ...copy, failures: [{ taskId: "task-1", resources: [{ ...drain, code: 1 }] }] },
		{ ...copy, failures: [{ taskId: "task-1", resources: [{ ...drain, message: 1 }] }] },
		{ ...copy, failures: [{ taskId: "task-1", resources: [drain, { ...drain, code: 1 }] }] },
		{
			...copy,
			failures: [
				{ taskId: "task-1", resources: [drain] },
				{ taskId: 2, resources: [drain] },
			],
		},
		{ ...copy, name: "Error" },
		undefined,
	])
		assert.equal(rehydrateTaskCleanupError(malformed), undefined, JSON.stringify(malformed));
	for (const phase of ["session-close", "stage-close", "app-shutdown", "stage-pause"] as const)
		assert.equal(rehydrateTaskCleanupError({ ...copy, phase })?.phase, phase);
});

/** An `assert.throws` validator for the refusal of a serialized error whose `field` is not what its class sends. */
function protocolRefusal(field: string, expected: string): (error: unknown) => true {
	return (error) => {
		assert.ok(isPoolProtocolError(error), String(error));
		assert.deepEqual({ field: error.field, expected: error.expected }, { field, expected });
		return true;
	};
}

test("process_cleanup_unconfirmed survives a serialize, JSON and rehydrate round trip with its fields and cause (#4338)", () => {
	const error = new ProcessCleanupUnconfirmedError(cleanupError());
	const serialized: SerializedWorkflowInfrastructureError = JSON.parse(
		JSON.stringify(serializeWorkflowInfrastructureError(error)),
	);
	assert.equal(serialized.name, "ProcessCleanupUnconfirmedError");
	assert.equal(serialized.code, "process_cleanup_unconfirmed");
	assert.deepEqual(serialized.fields, { phase: "stage-close", resources: error.resources });
	assert.equal(serialized.cause?.name, "TaskCleanupError");
	assert.deepEqual(serialized.cause?.fields, { phase: "stage-close", failures: error.cause.failures });
	const rehydrated = rehydrateWorkflowInfrastructureError(serialized);
	assert.ok(rehydrated instanceof ProcessCleanupUnconfirmedError);
	assert.ok(isProcessCleanupUnconfirmedError(rehydrated));
	assert.equal(isRetryableWorkflowError(rehydrated), true);
	assert.equal(isRetryableTaskError(rehydrated), true);
	assert.deepEqual(
		{ message: rehydrated.message, hint: rehydrated.hint, phase: rehydrated.phase, resources: rehydrated.resources },
		{ message: error.message, hint: error.hint, phase: error.phase, resources: error.resources },
	);
	assert.ok(rehydrated.cause instanceof TaskCleanupError);
	assert.deepEqual(rehydrated.cause.failures, error.cause.failures);
	assert.ok(isProcessCleanupUnconfirmedError({ ...serialized, retryable: true, resources: error.resources }));
	for (const other of [
		{ ...serialized, retryable: true },
		{ ...serialized, retryable: true, code: "worker_lost", resources: [] },
		new WorkflowInfrastructureError("worker_lost"),
		undefined,
	])
		assert.equal(isProcessCleanupUnconfirmedError(other), false);
});

test("other infrastructure faults rehydrate as their class, and a process cleanup fault whose cause or fields are malformed is refused (#4338, #4327)", () => {
	const lost = new WorkflowInfrastructureError("worker_lost");
	const serialized = serializeWorkflowInfrastructureError(lost);
	const rehydrated = rehydrateWorkflowInfrastructureError(JSON.parse(JSON.stringify(serialized)));
	assert.equal(rehydrated.constructor, WorkflowInfrastructureError);
	assert.deepEqual(
		{ code: rehydrated.code, message: rehydrated.message },
		{ code: "worker_lost", message: lost.message },
	);
	assert.equal(rehydrated.cause, undefined);
	const unknown = rehydrateWorkflowInfrastructureError({
		name: "WorkflowInfrastructureError",
		code: "pool_gone",
		message: "m",
		family: "workflow-infrastructure",
		fields: {},
	});
	assert.equal(unknown.code, "pool_gone");
	assert.equal(unknown.message, "m");
	const process = serializeWorkflowInfrastructureError(new ProcessCleanupUnconfirmedError(cleanupError()));
	const brokenCause = { ...process.cause!, fields: { ...process.cause!.fields, phase: "lost" } };
	assert.throws(
		() => rehydrateWorkflowInfrastructureError({ ...process, cause: brokenCause }),
		protocolRefusal("error.cause.fields.failures", "the phase, failures and timing of a task cleanup error"),
	);
	const { cause: _sent, ...uncaused } = process;
	const [resource] = process.fields.resources as readonly { readonly [key: string]: string }[];
	for (const fields of [
		{ ...process.fields, phase: "lost" },
		{ ...process.fields, resources: "none" },
		{ ...process.fields, resources: 7 },
		{ ...process.fields, resources: { first: resource! } },
		{ ...process.fields, resources: [{ ...resource, message: 7 }] },
		{ ...process.fields, resources: [{ ...resource, taskId: 7 }] },
		{ ...process.fields, resources: [null] },
		{ ...process.fields, resources: [resource!, null] },
	])
		assert.throws(
			() => rehydrateWorkflowInfrastructureError({ ...uncaused, fields }),
			protocolRefusal("error.fields.resources", "a task cleanup phase and resources, each with its task"),
			JSON.stringify(fields),
		);
	for (const fields of [
		{},
		{ ...process.fields, phase: "lost" },
		{ ...process.fields, resources: "none" },
		{ ...process.fields, resources: [resource!, null] },
	])
		assert.throws(
			() => rehydrateWorkflowInfrastructureError({ ...process, fields }),
			protocolRefusal("error.fields.resources", "a task cleanup phase and resources, each with its task"),
			`a usable cause does not excuse ${JSON.stringify(fields)}`,
		);
	assert.throws(
		() => rehydrateWorkflowInfrastructureError(serializeError(new TaskCleanupError("stage-close", []))),
		protocolRefusal("error.family", "workflow-infrastructure"),
		"only an infrastructure error rehydrates here",
	);
});

test("a process cleanup error copy that lost its cause rehydrates from its fields, in order and with its message (#4338)", () => {
	const third: ResourceFailure = { resource: "process-group:4444", code: "CleanupFailed", message: "third" };
	const cause = new TaskCleanupError("stage-close", [
		{ taskId: "task-1" as TaskId, resources: [drain, third] },
		{ taskId: "task-2" as TaskId, resources: [exit] },
		{ taskId: "task-1" as TaskId, resources: [exit] },
	]);
	const original = new ProcessCleanupUnconfirmedError(cause);
	const copy = { ...JSON.parse(JSON.stringify(original)), message: "m" };
	assert.ok(isProcessCleanupUnconfirmedError(copy), "a structural copy without its cause still matches");
	const uncaused = JSON.parse(JSON.stringify(serializeWorkflowInfrastructureError(copy)));
	assert.equal("cause" in uncaused, false, "a copy that lost its cause serializes without one");
	assert.deepEqual(uncaused.fields, { phase: "stage-close", resources: original.resources });
	const rebuilt = rehydrateWorkflowInfrastructureError(uncaused);
	assert.ok(rebuilt instanceof ProcessCleanupUnconfirmedError);
	assert.ok(isProcessCleanupUnconfirmedError(rebuilt));
	assert.equal(isRetryableWorkflowError(rebuilt), true);
	assert.equal(isRetryableTaskError(rebuilt), true);
	assert.deepEqual(
		{
			code: rebuilt.code,
			phase: rebuilt.phase,
			resources: rebuilt.resources,
			hint: rebuilt.hint,
			message: rebuilt.message,
		},
		{
			code: "process_cleanup_unconfirmed",
			phase: "stage-close",
			resources: original.resources,
			hint: original.hint,
			message: "m",
		},
	);
	assert.ok(rebuilt.cause instanceof TaskCleanupError);
	assert.deepEqual(rebuilt.cause.failures, cause.failures);
	const empty = rehydrateWorkflowInfrastructureError({ ...uncaused, fields: { phase: "stage-pause", resources: [] } });
	assert.ok(empty instanceof ProcessCleanupUnconfirmedError);
	assert.deepEqual({ phase: empty.phase, failures: empty.cause.failures }, { phase: "stage-pause", failures: [] });
	const serialized = serializeWorkflowInfrastructureError(original);
	const preferred = rehydrateWorkflowInfrastructureError({
		...serialized,
		fields: { phase: "stage-pause", resources: [] },
	});
	assert.ok(preferred instanceof ProcessCleanupUnconfirmedError);
	assert.deepEqual(preferred.cause.failures, cause.failures, "a valid cause wins over the fields");
	assert.equal(preferred.phase, "stage-close");
});

const admissionTiming = { timeoutMs: 5000, elapsedMs: 5012 };

function admissionTimeoutError(options?: ErrorOptions): TaskCleanupAdmissionTimeoutError {
	return new TaskCleanupAdmissionTimeoutError(
		[{ taskId: "task-1" as TaskId, resources: [drain] }],
		admissionTiming,
		options,
	);
}

test("a command admission that timed out behind unconfirmed cleanup is a retryable TaskCleanupError with its timing (#4338)", () => {
	const cause = new Error("admission refused");
	const error = admissionTimeoutError({ cause });
	assert.ok(error instanceof TaskCleanupError);
	assert.equal(error.name, "TaskCleanupAdmissionTimeoutError");
	assert.equal(error.code, "task_cleanup_unconfirmed");
	assert.equal(error.phase, "command-admission");
	assert.equal(error.retryable, true);
	assert.equal(error.timeoutMs, 5000);
	assert.equal(error.elapsedMs, 5012);
	assert.equal(error.cause, cause);
	assert.deepEqual(error.failures, [{ taskId: "task-1", resources: [drain] }]);
	assert.equal(
		error.message,
		`Command admission timed out after 5012 ms (limit 5000 ms) behind unconfirmed task cleanup: task-1 process-group:4242: Output reader drain was not confirmed (task_cleanup_unconfirmed). ${error.hint}.`,
	);
	assert.equal(admissionTimeoutError().cause, undefined);
	assert.equal(isTaskCleanupError(error), true);
	assert.equal(isTaskCleanupAdmissionTimeoutError(error), true);
	assert.equal(isTaskCleanupAdmissionTimeoutError(cleanupError()), false);
	assert.equal(isTaskCleanupAdmissionTimeoutError(new Error(error.message)), false);
	const copy = { ...JSON.parse(JSON.stringify(error)), message: error.message };
	assert.equal(isTaskCleanupAdmissionTimeoutError(copy), true);
	assert.equal(isTaskCleanupAdmissionTimeoutError({ ...copy, name: "TaskCleanupError" }), false);
	for (const retryable of [
		error,
		copy,
		new Error("launch failed", { cause: error }),
		new ProcessCleanupUnconfirmedError(error),
	])
		assert.equal(isRetryableTaskError(retryable), true);
});

test("a TaskCleanupAdmissionTimeoutError copy rehydrates into the subtype with its timing, and a malformed one does not (#4338)", () => {
	const error = admissionTimeoutError();
	const copy = JSON.parse(JSON.stringify(error));
	const rehydrated = rehydrateTaskCleanupError(copy);
	assert.ok(rehydrated instanceof TaskCleanupAdmissionTimeoutError);
	assert.equal(rehydrated.phase, "command-admission");
	assert.equal(rehydrated.timeoutMs, 5000);
	assert.equal(rehydrated.elapsedMs, 5012);
	assert.deepEqual(rehydrated.failures, error.failures);
	assert.equal(rehydrated.message, error.message);
	for (const malformed of [
		{ ...copy, phase: "stage-close" },
		{ ...copy, timeoutMs: undefined },
		{ ...copy, elapsedMs: "5012" },
		{ ...copy, timeoutMs: -1 },
		{ ...copy, elapsedMs: Number.NaN },
		{ ...copy, timeoutMs: Number.POSITIVE_INFINITY },
		{ ...copy, elapsedMs: Number.NEGATIVE_INFINITY },
		{ ...copy, failures: [{ taskId: 1, resources: [] }] },
	])
		assert.equal(rehydrateTaskCleanupError(malformed), undefined, JSON.stringify(malformed));
	const zero = rehydrateTaskCleanupError({ ...copy, timeoutMs: 0, elapsedMs: 0 });
	assert.ok(zero instanceof TaskCleanupAdmissionTimeoutError);
	assert.equal(zero.timeoutMs, 0);
	assert.equal(zero.elapsedMs, 0);
	const base = rehydrateTaskCleanupError({ ...copy, name: "TaskCleanupError" });
	assert.ok(base instanceof TaskCleanupError && !(base instanceof TaskCleanupAdmissionTimeoutError));
	assert.equal(base.phase, "command-admission");
});

test("a process cleanup fault caused by an admission timeout keeps the subtype and its timing across a round trip (#4338)", () => {
	const error = new ProcessCleanupUnconfirmedError(admissionTimeoutError());
	const serialized: SerializedWorkflowInfrastructureError = JSON.parse(
		JSON.stringify(serializeWorkflowInfrastructureError(error)),
	);
	assert.equal(serialized.cause?.name, "TaskCleanupAdmissionTimeoutError");
	assert.equal(serialized.cause?.fields.timeoutMs, 5000);
	assert.equal(serialized.cause?.fields.elapsedMs, 5012);
	const rehydrated = rehydrateWorkflowInfrastructureError(serialized);
	assert.ok(rehydrated instanceof ProcessCleanupUnconfirmedError);
	assert.ok(rehydrated.cause instanceof TaskCleanupAdmissionTimeoutError);
	assert.equal(rehydrated.cause.timeoutMs, 5000);
	assert.equal(rehydrated.cause.elapsedMs, 5012);
	assert.equal(rehydrated.phase, "command-admission");
	assert.equal(isRetryableTaskError(rehydrated), true);
});
