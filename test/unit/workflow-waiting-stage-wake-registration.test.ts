import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	deserializeStageWaitError,
	isStageWaitError,
	isStageWakeError,
	StageWakeError,
} from "../../packages/workflows/src/shared/stage-wait-errors.js";
import { isStageWakeKindRegistered, registerStageWakeKind } from "../../packages/workflows/src/shared/stage-wake.js";

/** The wake kinds a JavaScript caller can pass, whatever the types say. */
type LooseKind = Parameters<typeof registerStageWakeKind>[0];

function refusal(register: () => void): StageWakeError {
	try {
		register();
	} catch (error) {
		assert.ok(error instanceof StageWakeError);
		return error;
	}
	assert.fail("registerStageWakeKind accepted the registration");
}

describe("registerStageWakeKind refuses misuse with a typed error, before registering anything (#4309)", () => {
	test("a handler for the built-in tool-results kind is refused with builtin-kind-handler", () => {
		const error = refusal(() => registerStageWakeKind("tool-results", (() => {}) as never));

		assert.ok(isStageWakeError(error) && isStageWaitError(error));
		assert.equal(error.name, "StageWakeError");
		assert.equal(error.code, "builtin-kind-handler");
		assert.equal(error.retryable, false);
		assert.deepEqual(error.fields, { source: "sdk", field: "handler", kind: "tool-results" });
		assert.equal(
			error.message,
			'Cannot register a handler for the built-in stage wake kind "tool-results" (builtin-kind-handler). Register "tool-results" without a handler: the runtime delivers it only to a stage that waits for it.',
		);
		assert.equal(error.hint.startsWith('Register "tool-results" without a handler'), true);
	});

	test("a kind that is not a non-empty string is refused with invalid-wake-kind and stays unregistered", () => {
		const empty = refusal(() => registerStageWakeKind("" as LooseKind));
		const numeric = refusal(() => registerStageWakeKind(42 as never));

		for (const error of [empty, numeric]) {
			assert.ok(isStageWakeError(error));
			assert.equal(error.code, "invalid-wake-kind");
			assert.equal(error.fields.source, "sdk");
			assert.equal(error.fields.field, "kind");
		}
		assert.equal(empty.fields.value, '""');
		assert.equal(numeric.fields.value, "number");
		assert.equal(isStageWakeKindRegistered(""), false);
		assert.equal(
			empty.message,
			'Invalid stage wake kind passed to registerStageWakeKind: "" (invalid-wake-kind). Pass registerStageWakeKind the kind as a non-empty string, declared in StageWakeKinds by augmenting "@bastani/atomic/workflows".',
		);
	});

	test("a handler that is not a function is refused with invalid-wake-handler and the kind stays unregistered", () => {
		const kind = "invalid-handler-probe" as LooseKind;
		const error = refusal(() => registerStageWakeKind(kind, "not a function" as never));

		assert.ok(isStageWakeError(error));
		assert.equal(error.code, "invalid-wake-handler");
		assert.deepEqual(error.fields, { source: "sdk", field: "handler", kind, value: '"not a function"' });
		assert.equal(isStageWakeKindRegistered(kind), false);
		assert.equal(
			error.message,
			'Invalid handler passed to registerStageWakeKind for the wake kind "invalid-handler-probe": "not a function" (invalid-wake-handler). Pass registerStageWakeKind a function as the handler, or no handler to queue messages of the kind for the stage\'s next wait of that kind.',
		);
	});

	test("each refusal crosses a process boundary as a StageWakeError with its code and fields", () => {
		const errors = [
			refusal(() => registerStageWakeKind("tool-results", (() => {}) as never)),
			refusal(() => registerStageWakeKind("" as LooseKind)),
			refusal(() => registerStageWakeKind("probe-kind" as LooseKind, 7 as never)),
		];
		for (const original of errors) {
			const back = deserializeStageWaitError(JSON.parse(JSON.stringify(original)));
			assert.ok(back instanceof StageWakeError);
			assert.equal(back.code, original.code);
			assert.deepEqual(back.fields, original.fields);
			assert.equal(back.message, original.message);
		}
	});
});
