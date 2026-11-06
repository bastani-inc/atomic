import assert from "node:assert/strict";
import { isToolDetachmentError, ToolDetachmentError } from "@bastani/atomic";
import { test } from "vitest";
import { applyFailureToStage } from "../../packages/workflows/src/runs/foreground/executor-lifecycle.js";
import {
	isStageRehydrationError,
	isStageReleaseError,
	isStageWaitConfigError,
	isStageWaitError,
	isStageWakeError,
	StageRehydrationError,
	StageReleaseError,
	StageWaitConfigError,
	StageWaitError,
	StageWakeError,
} from "../../packages/workflows/src/shared/stage-wait-errors.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import {
	rehydrateTypedFailure,
	type SerializedTypedError,
	typedFailureDetail,
} from "../../packages/workflows/src/shared/typed-failure-detail.js";
import { classifyWorkflowFailure } from "../../packages/workflows/src/shared/workflow-failures-classifier.js";
import type { WorkerRequest } from "../../packages/workflows/src/workers/protocol.js";

/** What the root reads after a worker sends `result` over its IPC channel, which encodes messages as JSON. */
function throughWorkerProtocol(detail: SerializedTypedError | undefined): unknown {
	const message: WorkerRequest = {
		id: 1,
		kind: "complete",
		result: {
			runId: "child",
			status: "failed",
			error: "failed",
			...(detail === undefined ? {} : { failureDetail: detail }),
			stages: [],
			toolNodes: [],
		},
	};
	const received = JSON.parse(JSON.stringify(message)) as { readonly result: { readonly failureDetail?: unknown } };
	return received.result.failureDetail;
}

const STAGE = { runId: "run-1", stageId: "stage-1", stageName: "review" } as const;

const FAMILY_CASES = [
	{
		label: "StageWaitConfigError",
		make: () =>
			new StageWaitConfigError({
				source: "sdk",
				field: "releaseWhenWaiting.afterMs",
				value: "-1",
				stageName: "review",
			}),
		guard: isStageWaitConfigError,
		Class: StageWaitConfigError,
	},
	{
		label: "StageReleaseError",
		make: () => new StageReleaseError("stage-busy", { ...STAGE, sessionId: "session-1" }),
		guard: isStageReleaseError,
		Class: StageReleaseError,
	},
	{
		label: "StageRehydrationError",
		make: () =>
			new StageRehydrationError({ ...STAGE, sessionId: "session-1" }, { cause: new Error("store unreachable") }),
		guard: isStageRehydrationError,
		Class: StageRehydrationError,
	},
	{
		label: "StageWakeError",
		make: () => new StageWakeError({ runId: "run-1", stageId: "stage-1", kind: "pager" }),
		guard: isStageWakeError,
		Class: StageWakeError,
	},
	{
		label: "ToolDetachmentError",
		make: () => new ToolDetachmentError("session-busy", { sessionId: "session-1" }),
		guard: isToolDetachmentError,
		Class: ToolDetachmentError,
	},
] as const;

test.each(FAMILY_CASES)(
	"a $label a stage failed on crosses the worker protocol and rehydrates as itself (#4309)",
	({ make, guard, Class }) => {
		const original = make();
		// The stage's failure wraps the typed error; the detail is found down its cause chain.
		const detail = typedFailureDetail(
			new Error("stage failed", { cause: new Error("turn failed", { cause: original }) }),
		);
		assert.ok(detail);

		const reading = rehydrateTypedFailure(throughWorkerProtocol(detail));

		assert.equal(reading.ok, true, JSON.stringify(reading));
		if (!reading.ok) return;
		const rebuilt = reading.error;
		assert.ok(rebuilt instanceof Class);
		assert.equal(guard(rebuilt), true);
		assert.equal(rebuilt.name, original.name);
		assert.equal(rebuilt.code, original.code);
		assert.deepEqual(rebuilt.fields, original.fields);
		assert.equal(rebuilt.message, original.message);
		assert.equal(rebuilt.hint, original.hint);
		assert.equal(rebuilt.retryable, original.retryable);
	},
);

test("a rehydrated StageRehydrationError keeps the store failure it wraps (#4309)", () => {
	const original = new StageRehydrationError(
		{ ...STAGE, sessionId: "session-1" },
		{ cause: Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }) },
	);

	const reading = rehydrateTypedFailure(throughWorkerProtocol(typedFailureDetail(original)));

	assert.equal(reading.ok, true, JSON.stringify(reading));
	if (!reading.ok) return;
	const cause = reading.error.cause as Error & { readonly code?: string };
	assert.ok(cause instanceof Error);
	assert.equal(cause.message, "database is locked");
	assert.equal(cause.code, "SQLITE_BUSY");
});

test("an error without a typed error in its chain has no failure detail (#4309)", () => {
	assert.equal(typedFailureDetail(new Error("plain", { cause: new Error("still plain") })), undefined);
	assert.equal(typedFailureDetail("text"), undefined);
});

test("a stage-wait error of a name this side does not know rehydrates as the family base, keeping name and code (#4309)", () => {
	const detail = typedFailureDetail(new StageReleaseError("stage-busy", STAGE));
	assert.ok(detail);

	const reading = rehydrateTypedFailure(
		throughWorkerProtocol({ ...detail, name: "StageFutureError", code: "future-code" } as SerializedTypedError),
	);

	assert.equal(reading.ok, true, JSON.stringify(reading));
	if (!reading.ok) return;
	assert.ok(reading.error instanceof StageWaitError);
	const { name, code, fields }: { name: string; code: string; fields: object } = reading.error;
	assert.equal(name, "StageFutureError");
	assert.equal(code, "future-code");
	assert.deepEqual(fields, STAGE);
});

test("a tool-detachment error of a name this side does not know rehydrates as its family base (#4309)", () => {
	const detail = typedFailureDetail(new ToolDetachmentError("session-busy", { sessionId: "session-1" }));
	assert.ok(detail);

	const reading = rehydrateTypedFailure(
		throughWorkerProtocol({
			...detail,
			name: "ToolDetachmentFutureError",
			code: "future-code",
		} as SerializedTypedError),
	);

	assert.equal(reading.ok, true, JSON.stringify(reading));
	if (!reading.ok) return;
	assert.ok(reading.error instanceof ToolDetachmentError);
	assert.equal(isStageWaitError(reading.error), false);
	const { name, code, fields }: { name: string; code: string; fields: object } = reading.error;
	assert.equal(name, "ToolDetachmentFutureError");
	assert.equal(code, "future-code");
	assert.deepEqual(fields, { sessionId: "session-1" });
});

const valid = typedFailureDetail(new StageReleaseError("not-reopenable", STAGE)) as SerializedTypedError;
const MALFORMED: readonly (readonly [string, unknown])[] = [
	["null", null],
	["a string", "StageReleaseError"],
	["an array", [valid]],
	["no family", { ...valid, family: undefined }],
	["an unknown family", { ...valid, family: "StorageError" }],
	["a numeric name", { ...valid, name: 7 }],
	["no code", { ...valid, code: undefined }],
	["a non-boolean retryable", { ...valid, retryable: "yes" }],
	["null fields", { ...valid, fields: null }],
	["a cause without a message", { ...valid, cause: { name: "Error" } }],
	["a cause with a numeric code", { ...valid, cause: { name: "Error", message: "m", code: 5 } }],
];

test.each(MALFORMED)(
	"a malformed failure detail (%s) is ignored with a reason, never thrown (#4309)",
	(_label, detail) => {
		const reading = rehydrateTypedFailure(JSON.parse(JSON.stringify({ detail })).detail);

		assert.equal(reading.ok, false);
		if (reading.ok) return;
		assert.equal(typeof reading.reason, "string");
		assert.notEqual(reading.reason, "");
	},
);

test("a failure detail whose cause chain never ends is ignored, not followed (#4309)", () => {
	let cause: Record<string, unknown> = { name: "Error", message: "bottom" };
	for (let depth = 0; depth < 100; depth++) cause = { name: "Error", message: `level ${depth}`, cause };

	const reading = rehydrateTypedFailure({ ...valid, cause });

	assert.equal(reading.ok, false);
});

test("a stage ended from another copy of its snapshot, as on a resumed run, keeps its failure detail in the store (#4309)", () => {
	const store = createStore();
	const restored: StageSnapshot = { id: "stage-1", name: "review", status: "running", parentIds: [], toolEvents: [] };
	store.recordRunStart({
		id: "run-1",
		name: "resumed",
		inputs: {},
		status: "running",
		stages: [restored],
		toolNodes: [],
		startedAt: 1,
	});
	const live: StageSnapshot = { ...restored, toolEvents: [] };
	applyFailureToStage(live, classifyWorkflowFailure(new StageRehydrationError({ ...STAGE, sessionId: "session-1" })));

	store.recordStageEnd("run-1", live);

	assert.equal(store.run("run-1")?.stages[0]?.failureDetail?.name, "StageRehydrationError");
});
