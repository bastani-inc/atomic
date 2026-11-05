import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	deserializeStageWaitError,
	isStageRehydrationError,
	isStageReleaseError,
	isStageWaitConfigError,
	isStageWaitError,
	isStageWaitRecordError,
	isStageWakeError,
	StageRehydrationError,
	StageReleaseError,
	StageWaitConfigError,
	StageWaitError,
	StageWaitRecordError,
	StageWakeError,
} from "../../packages/workflows/src/shared/stage-wait-errors.js";

const STAGE = { runId: "run-1", stageId: "stage-1", stageName: "review" } as const;

describe("what a waiting stage's errors say (#4309)", () => {
	test("a failed record names what the stage was writing, and says how many attempts it took (#4309)", () => {
		const cases = [
			["wait-start", 3, 'Cannot durably record the start of the wait of stage "review" after 3 attempts'],
			["wait-results", 1, 'Cannot durably record the results stage "review" was woken with after 1 attempt'],
			[
				"wait-end",
				undefined,
				'Cannot durably record the end of the wait of stage "review" (wait-record-unavailable).',
			],
		] as const;
		for (const [phase, attempts, expected] of cases) {
			const error = new StageWaitRecordError({ ...STAGE, phase, ...(attempts === undefined ? {} : { attempts }) });
			assert.ok(error.message.startsWith(expected), error.message);
		}
		// A record error of another phase says only that the wait failed.
		assert.ok(
			new StageWaitError("wait-record-unavailable", { ...STAGE, phase: "reopen" }).message.startsWith(
				'Cannot durably record the wait of stage "review" (wait-record-unavailable).',
			),
		);
		assert.ok(
			new StageWaitError("wait-record-unavailable", STAGE).message.startsWith(
				'Cannot durably record the wait of stage "review" (',
			),
		);
	});

	test("a session that could not be reopened and one that could not save the results say which, and after how many attempts (#4309)", () => {
		const reopen = new StageRehydrationError({ ...STAGE, sessionId: "s-1", attempts: 3, phase: "reopen" });
		assert.ok(
			reopen.message.startsWith(
				'Cannot rehydrate stage "review": session s-1 could not be reopened after 3 attempts (session-unavailable).',
			),
			reopen.message,
		);
		const save = new StageRehydrationError({ ...STAGE, sessionId: "s-1", attempts: 1, phase: "resume-turn" });
		assert.ok(
			save.message.startsWith(
				'Cannot rehydrate stage "review": session s-1 could not save the results the stage was woken with after 1 attempt (session-unavailable).',
			),
			save.message,
		);
		const unnamed = new StageRehydrationError({ runId: "run-1" });
		assert.ok(
			unnamed.message.startsWith(
				'Cannot rehydrate stage "unknown": session unknown could not be reopened (session-unavailable).',
			),
			unnamed.message,
		);
		assert.ok(
			new StageRehydrationError({ stageId: "stage-9" }).message.startsWith('Cannot rehydrate stage "stage-9":'),
		);
	});

	test("missing sessions are listed by id, singular or plural, under the stage, or under the run when no stage is named (#4309)", () => {
		const message = (fields: ConstructorParameters<typeof StageRehydrationError>[0]) =>
			new StageRehydrationError(fields, { code: "session-not-found" }).message;
		assert.ok(
			message({ ...STAGE, sessionId: "s-1" }).startsWith(
				'Cannot rehydrate stage "review": session s-1 is not in the session store (session-not-found).',
			),
		);
		assert.ok(
			message({ runId: "run-1", sessionIds: ["s-1", "s-2"] }).startsWith(
				"Cannot rehydrate the waiting stages of run run-1: sessions s-1, s-2 are not in the session store (session-not-found).",
			),
		);
		assert.ok(
			message({ runId: "run-1", sessionIds: ["s-1"] }).startsWith(
				"Cannot rehydrate the waiting stages of run run-1: session s-1 is not in the session store",
			),
		);
		assert.ok(
			message({ stageId: "stage-9" }).startsWith(
				'Cannot rehydrate stage "stage-9": its sessions are not in the session store',
			),
		);
		assert.ok(message({}).startsWith("Cannot rehydrate the waiting stages of run unknown: its sessions are not in"));
		assert.equal(
			new StageRehydrationError({ ...STAGE, sessionId: "s-1" }, { code: "session-not-found" }).hint.includes(" ()"),
			false,
		);
		assert.ok(
			new StageRehydrationError({ ...STAGE, storage: "jsonl /data" }, { code: "session-not-found" }).hint.includes(
				"session storage it was started with (jsonl /data) selected through",
			),
		);
		assert.ok(
			new StageRehydrationError(STAGE, { code: "session-not-found" }).hint.startsWith(
				"Resume the run with the session storage it was started with selected through",
			),
		);
	});

	test("a refused release and a refused setting name the stage or the run they concern (#4309)", () => {
		assert.ok(
			new StageReleaseError("stage-busy", STAGE).message.startsWith(
				'Cannot release stage "review" while its prompt is running (stage-busy).',
			),
		);
		assert.ok(
			new StageReleaseError("not-reopenable", { stageId: "stage-1" }).message.startsWith(
				'Cannot release stage "stage-1": its session cannot be reopened from a store (not-reopenable).',
			),
		);
		assert.ok(new StageReleaseError("stage-busy", {}).message.startsWith('Cannot release stage "unknown" while'));
		const config = (fields: { field?: string; stageName?: string }) =>
			new StageWaitConfigError({ source: "sdk", field: "releaseWhenWaiting", value: "-1", ...fields }).message;
		assert.ok(config({}).startsWith("Invalid releaseWhenWaiting for the run: -1 (invalid-release-when-waiting)."));
		assert.ok(
			config({ stageName: "review", field: "releaseWhenWaiting.afterMs" }).startsWith(
				'Invalid releaseWhenWaiting.afterMs for stage "review": -1',
			),
		);
	});

	test("a wake that was refused says which kind, for which stage and run, and what to register (#4309)", () => {
		const unknown = new StageWakeError({ runId: "run-1", stageId: "stage-1", kind: "deploy-finished" });
		assert.ok(
			unknown.message.startsWith(
				'Cannot deliver a "deploy-finished" wake to stage "stage-1" of run run-1: no module registered that kind (unknown-wake-kind).',
			),
			unknown.message,
		);
		assert.equal(unknown.retryable, false);
		const bare = new StageWaitError("unknown-wake-kind", {});
		assert.ok(bare.message.startsWith('Cannot deliver a "unknown" wake to stage "unknown": no module registered'));
		assert.ok(!bare.message.includes(" of run "));

		const builtin = new StageWakeError(
			{ source: "sdk", field: "handler", kind: "tool-results" },
			{ code: "builtin-kind-handler" },
		);
		assert.ok(
			builtin.message.startsWith(
				'Cannot register a handler for the built-in stage wake kind "tool-results" (builtin-kind-handler).',
			),
		);
		assert.equal(
			builtin.hint,
			'Register "tool-results" without a handler: the runtime delivers it only to a stage that waits for it.',
		);
		const anonymous = new StageWakeError({ source: "sdk", field: "handler" }, { code: "builtin-kind-handler" });
		assert.ok(anonymous.message.startsWith('Cannot register a handler for the built-in stage wake kind "unknown"'));
		assert.equal(
			anonymous.hint,
			'Register "tool-results" without a handler: the runtime delivers it only to a stage that waits for it.',
		);

		const invalidKind = new StageWakeError(
			{ source: "sdk", field: "kind", value: "42" },
			{ code: "invalid-wake-kind" },
		);
		assert.ok(
			invalidKind.message.startsWith(
				"Invalid stage wake kind passed to registerStageWakeKind: 42 (invalid-wake-kind).",
			),
		);
		const invalidHandler = new StageWakeError(
			{ source: "sdk", field: "handler", kind: "deploy", value: "true" },
			{ code: "invalid-wake-handler" },
		);
		assert.ok(
			invalidHandler.message.startsWith(
				'Invalid handler passed to registerStageWakeKind for the wake kind "deploy": true (invalid-wake-handler).',
			),
		);
		const unnamedHandler = new StageWakeError(
			{ source: "sdk", field: "handler", value: "1" },
			{ code: "invalid-wake-handler" },
		);
		assert.ok(unnamedHandler.message.includes('for the wake kind "unknown": 1'));
	});
});

describe("recognising and rebuilding a stage-wait error from another realm or process (#4309)", () => {
	test("a plain object is one of the family only when its name and its code both belong to it (#4309)", () => {
		const shaped = (name: unknown, code: unknown) => ({ name, code });
		assert.equal(isStageWaitError(shaped("StageWaitError", "stage-busy")), true);
		assert.equal(isStageWaitError(shaped("StageWakeError", "unknown-wake-kind")), true);
		assert.equal(isStageWaitError(shaped("StageWaitError", "not-a-code")), false);
		assert.equal(isStageWaitError(shaped("NotOurs", "stage-busy")), false);
		assert.equal(isStageWaitError(shaped(7, "stage-busy")), false);
		assert.equal(isStageWaitError(shaped("StageWaitError", 7)), false);
		assert.equal(isStageWaitError(null), false);
		assert.equal(isStageWaitError("StageWaitError"), false);

		assert.equal(isStageWaitConfigError(shaped("StageWaitConfigError", "invalid-release-when-waiting")), true);
		assert.equal(isStageWaitConfigError(shaped("StageReleaseError", "stage-busy")), false);
		assert.equal(isStageReleaseError(shaped("StageReleaseError", "stage-busy")), true);
		assert.equal(isStageReleaseError(shaped("StageWaitConfigError", "stage-busy")), false);
		assert.equal(isStageRehydrationError(shaped("StageRehydrationError", "session-not-found")), true);
		assert.equal(isStageRehydrationError(shaped("StageReleaseError", "session-not-found")), false);
		assert.equal(isStageWaitRecordError(shaped("StageWaitRecordError", "wait-record-unavailable")), true);
		assert.equal(isStageWaitRecordError(shaped("StageWaitRecordError", "stage-busy")), true);
		assert.equal(isStageWaitRecordError(shaped("StageRehydrationError", "wait-record-unavailable")), false);
		assert.equal(isStageWaitRecordError(shaped("StageWaitRecordError", "bogus")), false);
		assert.equal(isStageWaitRecordError(null), false);
		assert.equal(isStageWakeError(shaped("StageWakeError", "unknown-wake-kind")), true);
		assert.equal(isStageWakeError(shaped("StageWaitRecordError", "unknown-wake-kind")), false);
	});

	test("each serialized error is rebuilt as its own class with its code, fields and message, and one of an unknown name as the family base (#4309)", () => {
		const rebuilt = (error: StageWaitError) => deserializeStageWaitError(JSON.parse(JSON.stringify(error.toJSON())));
		const record = rebuilt(
			new StageWaitRecordError({ ...STAGE, phase: "wait-end", attempts: 3 }, { cause: new Error("journal down") }),
		);
		assert.ok(record instanceof StageWaitRecordError);
		assert.equal((record.cause as Error).message, "journal down");
		assert.deepEqual(record.fields, { ...STAGE, phase: "wait-end", attempts: 3 });

		const wake = rebuilt(new StageWakeError({ runId: "run-1", stageId: "stage-1", kind: "deploy" }));
		assert.ok(wake instanceof StageWakeError);
		assert.equal(wake.code, "unknown-wake-kind");
		const registration = rebuilt(
			new StageWakeError({ source: "sdk", field: "kind", value: "42" }, { code: "invalid-wake-kind" }),
		);
		assert.ok(registration instanceof StageWakeError);
		assert.equal(registration.code, "invalid-wake-kind");

		const notFound = rebuilt(
			new StageRehydrationError({ ...STAGE, sessionIds: ["s-1"] }, { code: "session-not-found" }),
		);
		assert.ok(notFound instanceof StageRehydrationError);
		assert.equal(notFound.code, "session-not-found");
		assert.equal(notFound.retryable, false);
		const unavailable = rebuilt(new StageRehydrationError(STAGE));
		assert.equal(unavailable.code, "session-unavailable");
		assert.equal(unavailable.retryable, true);
		const release = rebuilt(new StageReleaseError("stage-busy", STAGE));
		assert.ok(release instanceof StageReleaseError);
		assert.equal(release.code, "stage-busy");
		const config = rebuilt(new StageWaitConfigError({ source: "sdk", field: "releaseWhenWaiting", value: "1" }));
		assert.ok(config instanceof StageWaitConfigError);

		const future = deserializeStageWaitError({
			name: "StageFutureError",
			code: "stage-busy",
			message: "a message this side would not write",
			hint: "h",
			retryable: true,
			fields: STAGE,
		});
		assert.equal(future.constructor, StageWaitError);
		assert.equal(future.name, "StageFutureError");
		assert.equal(future.retryable, true);
		assert.equal(future.message, "a message this side would not write");
	});

	test("the message the sender wrote is kept only when it differs from the one this side builds (#4309)", () => {
		const original = new StageReleaseError("stage-busy", STAGE);
		const same = deserializeStageWaitError(original.toJSON());
		assert.equal(same.message, original.message);
		assert.equal(Object.getOwnPropertyDescriptor(same, "message")?.enumerable, false);
		const reworded = deserializeStageWaitError({ ...original.toJSON(), message: "reworded by an older release" });
		assert.equal(reworded.message, "reworded by an older release");
	});
});
