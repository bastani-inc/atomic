import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import {
	applyFailureToStage,
	finalizeKilledByFailure,
	type RunFailureMetadata,
	reconcileTerminalRunResult,
	recordActiveBlockedFailure,
	runFailureMetadata,
	runResultFromSnapshot,
	selectRunFailureDisposition,
} from "../../packages/workflows/src/runs/foreground/executor-lifecycle.js";
import type { SerializedError } from "../../packages/workflows/src/shared/error-codec.js";
import { StageRehydrationError } from "../../packages/workflows/src/shared/stage-wait-errors.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { typedFailureDetail } from "../../packages/workflows/src/shared/typed-failure-detail.js";
import type { WorkflowFailure } from "../../packages/workflows/src/shared/workflow-failures.js";

const RUN_ID = "run-failure-detail";

function rehydrationError(stageId: string): StageRehydrationError {
	return new StageRehydrationError(
		{ runId: RUN_ID, stageId, stageName: stageId, sessionId: `session-of-${stageId}` },
		{ code: "session-not-found" },
	);
}

function detailOf(error: Error): SerializedError {
	const detail = typedFailureDetail(error);
	assert.ok(detail !== undefined, "the error carries a typed error");
	return detail;
}

function failureWith(overrides: Partial<WorkflowFailure> = {}): WorkflowFailure {
	return {
		kind: "unknown",
		code: "unknown",
		message: "diagnostic text",
		userMessage: "the user's text",
		retryable: false,
		resumable: false,
		recoverability: "non_recoverable",
		disposition: "terminal_failed",
		...overrides,
	};
}

function failedStage(id: string, overrides: Partial<StageSnapshot> = {}): StageSnapshot {
	return {
		id,
		name: id,
		status: "failed",
		parentIds: [],
		toolEvents: [],
		error: `${id} failed`,
		...overrides,
	};
}

function runSnapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
	return {
		id: RUN_ID,
		name: "failure-detail",
		inputs: {},
		status: "running",
		stages: [],
		toolNodes: [],
		startedAt: 1,
		...overrides,
	};
}

describe("the typed error of a failed run, from its stage or its thrown error (#4309)", () => {
	test("a failed stage records the typed error of its failure, and drops one it no longer has (#4309)", () => {
		const stage = failedStage("review", { status: "running" });
		const error = rehydrationError("review");
		applyFailureToStage(stage, failureWith({ cause: error }));
		assert.deepEqual(stage.failureDetail, detailOf(error));
		assert.equal(stage.status, "failed");

		applyFailureToStage(stage, failureWith({ cause: new Error("plain") }));
		assert.equal(Object.hasOwn(stage, "failureDetail"), false);
	});

	test("the run's failure takes the typed error of its failed stage, else of the error that was thrown (#4309)", () => {
		const stageError = rehydrationError("stage-side");
		const thrown = rehydrationError("thrown-side");
		const withDetail = failedStage("a", { failureDetail: detailOf(stageError) });
		const withoutDetail = failedStage("b");

		assert.deepEqual(
			runFailureMetadata(failureWith({ cause: thrown }), [withDetail]).failureDetail,
			detailOf(stageError),
		);
		// The failed stage is the run's failure: its own typed error, or none, however the thrown error reads.
		assert.equal(
			Object.hasOwn(runFailureMetadata(failureWith({ cause: thrown }), [withoutDetail]), "failureDetail"),
			false,
		);
		assert.deepEqual(runFailureMetadata(failureWith({ cause: thrown }), []).failureDetail, detailOf(thrown));
		assert.equal(
			Object.hasOwn(runFailureMetadata(failureWith({ cause: new Error("x") }), []), "failureDetail"),
			false,
		);
	});

	test("the selected failure carries the typed error of the stage, the aggregate item or the outer error it came from (#4309)", () => {
		const stageError = rehydrationError("stage-side");
		const innerError = rehydrationError("inner-side");
		const outerError = rehydrationError("outer-side");
		const classify = (error: unknown): WorkflowFailure => failureWith({ cause: error });

		const fromStage = selectRunFailureDisposition({
			outerFailure: failureWith({ cause: outerError }),
			thrownError: new Error("outer"),
			stages: [failedStage("a", { failureDetail: detailOf(stageError) })],
			classifyFailure: classify,
		});
		assert.deepEqual(fromStage.failureDetail, detailOf(stageError));
		assert.deepEqual(fromStage.failedStageIds, ["a"]);

		const stageWithout = selectRunFailureDisposition({
			outerFailure: failureWith({ cause: outerError }),
			thrownError: new Error("outer"),
			stages: [failedStage("a")],
			classifyFailure: classify,
		});
		assert.equal(Object.hasOwn(stageWithout, "failureDetail"), false);

		const fromOuter = selectRunFailureDisposition({
			outerFailure: failureWith({ cause: outerError }),
			thrownError: outerError,
			stages: [],
			classifyFailure: classify,
		});
		assert.deepEqual(fromOuter.failureDetail, detailOf(outerError));

		const fromAggregate = selectRunFailureDisposition({
			outerFailure: failureWith({ cause: new Error("wrapper") }),
			thrownError: new AggregateError([innerError], "several failures"),
			stages: [],
			classifyFailure: classify,
		});
		assert.deepEqual(fromAggregate.failureDetail, detailOf(innerError));

		const untyped = selectRunFailureDisposition({
			outerFailure: failureWith({ cause: new Error("plain") }),
			thrownError: new Error("plain"),
			stages: [],
			classifyFailure: classify,
		});
		assert.equal(Object.hasOwn(untyped, "failureDetail"), false);
	});

	test("a blocked failure from a recoverable error and a killed one keep the typed error of the stage that failed (#4309)", () => {
		const stageError = rehydrationError("stage-side");
		const blocked = selectRunFailureDisposition({
			outerFailure: failureWith({
				kind: "provider",
				disposition: "active_blocked",
				recoverability: "recoverable",
				resumable: true,
				cause: new Error("outer"),
			}),
			thrownError: new Error("outer"),
			stages: [
				failedStage("a", {
					failureDisposition: "active_blocked",
					failureRecoverability: "recoverable",
					failureDetail: detailOf(stageError),
				}),
			],
			classifyFailure: (error) => failureWith({ cause: error }),
		});
		assert.deepEqual(blocked.failureDetail, detailOf(stageError));
		assert.equal(blocked.failureDisposition, "active_blocked");
	});

	test("a run result names the typed error of the stage the run recorded as its failure, and only that one (#4309)", () => {
		const detail = detailOf(rehydrationError("a"));
		const other = detailOf(rehydrationError("b"));
		const snapshot = runSnapshot({
			status: "failed",
			failedStageId: "a",
			stages: [failedStage("b", { failureDetail: other }), failedStage("a", { failureDetail: detail })],
		});
		assert.deepEqual(runResultFromSnapshot(snapshot).failureDetail, detail);

		for (const unmatched of [
			{ ...snapshot, failedStageId: undefined },
			{ ...snapshot, failedStageId: "missing" },
			{ ...snapshot, failedStageId: "c", stages: [failedStage("c")] },
		])
			assert.equal(Object.hasOwn(runResultFromSnapshot(unmatched), "failureDetail"), false);
	});

	test("the run's terminal result keeps the thrown error's typed error only when the store recorded that same failure with no failed stage (#4309)", () => {
		const detail = detailOf(rehydrationError("outer"));
		const fallback = { status: "failed" as const, error: "the run failed", failureDetail: detail };
		const onRunEnd = vi.fn();
		const record = (overrides: Partial<RunSnapshot>) => {
			const store = createStore();
			store.recordRunStart(runSnapshot({ status: "running" }));
			store.recordRunEnd(RUN_ID, overrides.status ?? "failed", undefined, overrides.error ?? "the run failed", {
				...(overrides.failedStageId === undefined ? {} : { failedStageId: overrides.failedStageId }),
			});
			return store;
		};
		const snapshot = runSnapshot();

		const same = reconcileTerminalRunResult(RUN_ID, snapshot, record({}), fallback, onRunEnd);
		assert.deepEqual(same.failureDetail, detail);
		assert.deepEqual(onRunEnd.mock.calls.at(-1), [RUN_ID, "failed", undefined, "the run failed", undefined]);

		const otherError = reconcileTerminalRunResult(
			RUN_ID,
			snapshot,
			record({ error: "another error" }),
			fallback,
			onRunEnd,
		);
		assert.equal(otherError.error, "another error");
		assert.equal(Object.hasOwn(otherError, "failureDetail"), false);

		const otherStatus = reconcileTerminalRunResult(
			RUN_ID,
			snapshot,
			record({ status: "killed" }),
			fallback,
			onRunEnd,
		);
		assert.equal(otherStatus.status, "killed");
		assert.equal(Object.hasOwn(otherStatus, "failureDetail"), false);

		const withStage = createStore();
		withStage.recordRunStart(runSnapshot({ stages: [failedStage("a")] }));
		withStage.recordRunEnd(RUN_ID, "failed", undefined, "the run failed", { failedStageId: "a" });
		const stageFailure = reconcileTerminalRunResult(RUN_ID, snapshot, withStage, fallback, onRunEnd);
		assert.equal(Object.hasOwn(stageFailure, "failureDetail"), false);

		// A run the store has no terminal record of is the fallback as given.
		const unrecorded = createStore();
		unrecorded.recordRunStart(runSnapshot());
		const asGiven = reconcileTerminalRunResult(RUN_ID, snapshot, unrecorded, fallback, onRunEnd);
		assert.deepEqual(asGiven.failureDetail, detail);
		assert.equal(asGiven.runId, RUN_ID);
	});

	test("a run killed by a failure and a run blocked by one both report the typed error that caused it (#4309)", async () => {
		const detail = detailOf(rehydrationError("a"));
		const metadata: RunFailureMetadata = {
			errorMessage: "the run failed",
			failureKind: "unknown",
			failureCode: "unknown",
			failureRecoverability: "recoverable",
			failureDisposition: "active_blocked",
			failureMessage: "diagnostic text",
			resumable: true,
			failureDetail: detail,
		};

		const killedStore = createStore();
		killedStore.recordRunStart(runSnapshot());
		const killed = await finalizeKilledByFailure(RUN_ID, runSnapshot(), killedStore, undefined, undefined, metadata);
		assert.equal(killed.status, "killed");
		assert.deepEqual(killed.failureDetail, detail);

		const plainStore = createStore();
		plainStore.recordRunStart(runSnapshot());
		const { failureDetail: _omitted, ...withoutDetail } = metadata;
		const plain = await finalizeKilledByFailure(
			RUN_ID,
			runSnapshot(),
			plainStore,
			undefined,
			undefined,
			withoutDetail,
		);
		assert.equal(Object.hasOwn(plain, "failureDetail"), false);

		const blockedStore = createStore();
		blockedStore.recordRunStart(runSnapshot());
		const blocked = await recordActiveBlockedFailure(RUN_ID, runSnapshot(), blockedStore, undefined, {
			...metadata,
			failureRecoverability: "recoverable",
		});
		assert.equal(blocked.status, "running");
		assert.deepEqual(blocked.failureDetail, detail);
		const blockedPlain = await recordActiveBlockedFailure(RUN_ID, runSnapshot(), blockedStore, undefined, {
			...withoutDetail,
			failureRecoverability: "recoverable",
		});
		assert.equal(Object.hasOwn(blockedPlain, "failureDetail"), false);
	});
});
