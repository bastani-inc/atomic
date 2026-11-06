import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { StageWakeError } from "../../packages/workflows/src/shared/stage-wait-errors.js";
import {
	isStageWakeKindRegistered,
	registerStageWakeKind,
	stageWakeHandler,
} from "../../packages/workflows/src/shared/stage-wake.js";

type LooseKind = Parameters<typeof registerStageWakeKind>[0];

const KIND = "wake-kinds-probe" as LooseKind;

function refusedValue(register: () => void): unknown {
	try {
		register();
	} catch (error) {
		assert.ok(error instanceof StageWakeError);
		return error.fields.value;
	}
	return assert.fail("registerStageWakeKind accepted the registration");
}

describe("how a refused wake registration shows the value it was given (#4309)", () => {
	test("a string is quoted, null reads as null, and anything else by its type (#4309)", () => {
		const shown = (kind: unknown) => refusedValue(() => registerStageWakeKind(kind as LooseKind));
		assert.equal(shown(null), "null");
		assert.equal(shown(undefined), "undefined");
		assert.equal(shown(7), "number");
		assert.equal(shown(true), "boolean");
		assert.equal(shown({}), "object");
		assert.equal(shown([]), "object");
		assert.equal(shown(Symbol("kind")), "symbol");
		assert.equal(shown(""), '""');
		const handler = (value: unknown) => refusedValue(() => registerStageWakeKind(KIND, value as never));
		assert.equal(handler(null), "null");
		assert.equal(handler("a handler"), '"a handler"');
		assert.equal(handler({}), "object");
		assert.equal(isStageWakeKindRegistered(KIND), false);
	});
});

describe("removing a wake registration (#4309)", () => {
	test("removing the last registration of a kind unregisters it, and removing it again changes nothing (#4309)", () => {
		const remove = registerStageWakeKind(KIND);
		assert.equal(isStageWakeKindRegistered(KIND), true);
		remove();
		assert.equal(isStageWakeKindRegistered(KIND), false);
		assert.doesNotThrow(() => remove());
		assert.equal(isStageWakeKindRegistered(KIND), false);
	});

	test("removing a registration twice never removes another one of the kind, and the newest registration stays in effect (#4309)", () => {
		const first = () => {};
		const second = () => {};
		const removeFirst = registerStageWakeKind(KIND, first as never);
		const removeSecond = registerStageWakeKind(KIND, second as never);
		assert.equal(stageWakeHandler(KIND), second);

		removeFirst();
		removeFirst();
		assert.equal(isStageWakeKindRegistered(KIND), true);
		assert.equal(stageWakeHandler(KIND), second);

		removeSecond();
		assert.equal(isStageWakeKindRegistered(KIND), false);
		assert.equal(stageWakeHandler(KIND), undefined);
	});

	test("the registration removed is the one the function was returned for, whatever its position (#4309)", () => {
		const first = () => {};
		const second = () => {};
		const removeFirst = registerStageWakeKind(KIND, first as never);
		const removeSecond = registerStageWakeKind(KIND, second as never);
		removeSecond();
		assert.equal(stageWakeHandler(KIND), first);
		removeFirst();
		assert.equal(isStageWakeKindRegistered(KIND), false);
	});
});
