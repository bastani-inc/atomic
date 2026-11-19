import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type * as Native from "@bastani/atomic-natives";
import { test } from "vitest";
import type * as C from "../../packages/coding-agent/src/core/tasks/contracts.js";
import type {
	ActivityReport,
	AgentIntent,
	ArtifactRef,
	ModelParallelResponse,
	ModelSingleResponse,
	OutputRef,
	OwnerId,
	Result,
	TaskId,
	TaskResult,
	WaitId,
	WaitOutcome,
} from "../../packages/coding-agent/src/core/tasks/contracts.js";
import type * as S from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { TaskSupervisor } from "../../packages/coding-agent/src/core/tasks/supervisor.js";

// RFC #2884: a released observation is not a terminal execution result.
test("task contracts keep yielded observations out of terminal result sinks", () => {
	const observation: WaitOutcome = {
		kind: "yielded",
		taskId: "task" as TaskId,
		waitId: "wait" as WaitId,
		reason: "elapsed",
	};
	const terminalSink = (result: TaskResult): string => result.kind;
	const checkNegativeConstruction = (): void => {
		// @ts-expect-error A WaitOutcome cannot settle a task or durable workflow.
		terminalSink(observation);
	};
	assert.equal(typeof checkNegativeConstruction, "function");
	assert.equal(terminalSink({ kind: "cancelled", cause: "user" }), "cancelled");
	assert.equal(observation.kind, "yielded");
});

// RFC #2884: wire DTOs retain raw text, omitted fields, zero and ordered duplicates.
test("task wire objects preserve raw intent and absent versus known empty artifacts", () => {
	const intent: AgentIntent = { kind: "agent", agent: "worker", task: "\n x \n", description: "" };
	assert.deepEqual(JSON.parse(JSON.stringify(intent)), intent);
	assert.equal(Object.hasOwn(intent, "cwd"), false);
	const output: OutputRef = {
		ownerId: "owner" as OwnerId,
		taskId: "task" as TaskId,
		artifactId: "output",
		byteCount: "9007199254740993",
		omittedRanges: [],
	};
	const observation: WaitOutcome = { kind: "settled", taskId: output.taskId, result: { kind: "completed", output } };
	const absent: ModelSingleResponse = { kind: "admitted", observation };
	const empty: ModelSingleResponse = { kind: "admitted", observation, artifacts: [] };
	assert.equal(Object.hasOwn(absent, "artifacts"), false);
	assert.deepEqual(empty.artifacts, []);
	const artifact: ArtifactRef = { kind: "result", uri: " raw uri " };
	const parallel: ModelParallelResponse = {
		kind: "parallel",
		slots: [
			{ ordinal: 0, outcome: { kind: "admitted", observation, artifacts: [artifact, artifact] } },
			{ ordinal: 1, outcome: empty },
			{ ordinal: 2, outcome: { kind: "unstarted", reason: { kind: "skipped", cause: "parallel-group-detach" } } },
		],
	};
	assert.deepEqual(JSON.parse(JSON.stringify(parallel)), parallel);
	assert.equal(output.byteCount, "9007199254740993");
	const metrics: ActivityReport = { reportId: "r1", change: { kind: "metrics", toolCount: 0 } };
	assert.deepEqual(metrics.change, { kind: "metrics", toolCount: 0 });
	const attention: ActivityReport = {
		reportId: "r2",
		change: {
			kind: "attention-set",
			attention: { kind: "input-needed", requestId: "q1", prompt: "", route: { sessionId: "s", promptId: "q1" } },
		},
	};
	assert.deepEqual(JSON.parse(JSON.stringify(attention)), attention);
});

// RFC #2884: success and refusal use explicit Result objects, not string proxies.
test("Result discriminates a successful value from a named refusal", () => {
	const success: Result<number, { code: "OwnerClosing"; message: string }> = { ok: true, value: 0 };
	const refusal: Result<number, { code: "OwnerClosing"; message: string }> = {
		ok: false,
		error: { code: "OwnerClosing", message: "Owner is closing" },
	};
	assert.deepEqual(success, { ok: true, value: 0 });
	assert.deepEqual(refusal, { ok: false, error: { code: "OwnerClosing", message: "Owner is closing" } });
});

// RFC #2884: the trusted host refusal remains outside the native StartError domain.
test("facade host authorization rejects before runner creation and owner admission", async () => {
	const supervisor = new TaskSupervisor();
	const scope = { kind: "session" as const, sessionId: randomUUID() };
	let runs = 0;
	const host = supervisor.bindHostSession({
		scope,
		authorizeLaunch() {
			throw new Error("delegation denied");
		},
		createRunner() {
			runs++;
			throw new Error("unreachable");
		},
	});
	const opened = supervisor.openTaskOwner(host, scope);
	assert.ok(opened.ok);
	if (!opened.ok) return;
	try {
		const intent: AgentIntent = { kind: "agent", agent: "worker", task: " raw " };
		await assert.rejects(
			supervisor.startAgentTask(
				opened.value,
				intent,
				"denied" as import("../../packages/coding-agent/src/core/tasks/contracts.js").OperationId,
			),
			/delegation denied/,
		);
		assert.equal(runs, 0);
		const watched = supervisor.watchOwnerTasks(opened.value);
		assert.ok(watched.ok);
		if (watched.ok) {
			assert.deepEqual(watched.value.snapshot.tasks, []);
			watched.value.dispose();
		}
		assert.throws(() => JSON.stringify(host), /not serializable/);
		assert.throws(() => JSON.stringify(opened.value), /not serializable/);
	} finally {
		assert.ok((await supervisor.closeTaskOwner(opened.value, "session-close")).ok);
	}
});

// RFC #2884: checked consumers receive outcomes/promises, not registration leases.
test("public observation and cancellation doors assign to the exact RFC signatures", () => {
	const supervisor = new TaskSupervisor();
	const doors: {
		waitForTask(
			task: S.TaskLease,
			budgetMs?: number,
			designation?: S.HostSession,
		): Promise<C.Result<C.WaitOutcome, C.WaitError>>;
		cancelTask(task: S.TaskLease, cause: C.CancelCause): Promise<C.Result<C.CancelReceipt, C.CancelError>>;
	} = supervisor;
	assert.equal(doors.waitForTask, supervisor.waitForTask);
	assert.equal(doors.cancelTask, supervisor.cancelTask);
});

// RFC #2884: cursor is the second argument and subscription authority is opaque.
test("watch door and subscription fields assign to the exact RFC consumer shape", () => {
	const supervisor = new TaskSupervisor();
	type Subscription = {
		lease: S.SubscriptionLease;
		snapshot: C.OwnerSnapshot;
		cursor: C.Cursor;
		events: AsyncIterable<C.NativeEvent>;
		dispose(): void;
	};
	const watch: (owner: S.OwnerLease, cursor?: C.Cursor) => C.Result<Subscription, C.WatchError> =
		supervisor.watchOwnerTasks;
	assert.equal(watch, supervisor.watchOwnerTasks);
});

// RFC #2884: native storage representation must not leak into generated/public string types.
test("UTF-16 inputs remain ordinary strings in facade and generated contracts", () => {
	const raw = "\ud800\0\udfff😀";
	const intent: AgentIntent = { kind: "agent", agent: raw, task: raw, description: "", cwd: raw };
	const nativeIntent: Native.AgentIntent = intent;
	const report: ActivityReport = { reportId: raw, change: { kind: "action", tool: raw, text: raw } };
	const nativeReport: Native.ActivityReport = report;
	const nativeResult: Native.TaskResult = { kind: "failed", code: raw, message: raw };
	const message: string = nativeResult.message;
	const task: string = nativeIntent.task;
	const rejectRepresentations = () => {
		// @ts-expect-error Caller strings are not code-unit arrays.
		const facadeArray: AgentIntent = { ...intent, task: [0xd800] };
		// @ts-expect-error Generated fields must remain string, not the native owned vector.
		const nativeArray: Native.AgentIntent = { ...nativeIntent, task: [0xd800] };
		// @ts-expect-error Encoded/proxy objects cannot replace the facade string contract.
		const facadeProxy: AgentIntent = { ...intent, task: { utf16: [0xd800], toString: () => raw } };
		const nativeProxy: Native.ActivityReport = {
			...nativeReport,
			// @ts-expect-error Generated report strings cannot become encoded/proxy objects either.
			reportId: { utf16: [0xd800], toString: () => raw },
		};
		return [facadeArray, nativeArray, facadeProxy, nativeProxy];
	};
	assert.equal(typeof rejectRepresentations, "function");
	assert.equal(task, raw);
	assert.equal(message, raw);
	assert.equal(nativeReport.reportId, raw);
});
