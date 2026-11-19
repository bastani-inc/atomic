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
import { createHarness } from "../../packages/coding-agent/test/suite/harness.js";

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
const intent = { kind: "agent" as const, agent: "worker", task: "Session-owned work" };

function cleanupError(): TaskCleanupError {
	return new TaskCleanupError(
		"session-close",
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
	assert.equal(error.phase, "session-close");
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
		phase: "session-close",
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

test("isRetryableTaskError finds a retryable TaskCleanupError, or its copy, within eight causes (#4338)", () => {
	const cause = cleanupError();
	const copy = JSON.parse(JSON.stringify(cause));
	const nest = (error: unknown, links: number): unknown =>
		links === 0 ? error : nest(new Error(`link ${links}`, { cause: error }), links - 1);
	for (const retryable of [
		cause,
		new Error("session failed", { cause }),
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
	assert.equal(rehydrated.phase, "session-close");
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
	for (const phase of ["session-close", "app-shutdown", "stage-pause"] as const)
		assert.equal(rehydrateTaskCleanupError({ ...copy, phase })?.phase, phase);
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
	for (const retryable of [error, copy, new Error("launch failed", { cause: error })])
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
		{ ...copy, phase: "session-close" },
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
