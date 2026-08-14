/**
 * Direct tests for the kind-aware HIL answer helpers.
 *
 * The guarded call sites never pass a `custom` prompt here, so this covers the
 * malformed-descriptor branch that would otherwise fall out of the switch as
 * `undefined` and surface as a bare `TypeError: Cannot read properties of
 * undefined (reading 'ok')`.
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	coercePrimitivePromptAnswer,
	type PrimitivePrompt,
	primitivePromptAnswerExpectation,
	requirePrimitivePromptAnswer,
} from "../../packages/workflows/src/shared/prompt-answer.js";

const malformedCustomPrompt = { kind: "custom" } as unknown as PrimitivePrompt;

describe("primitive prompt answer helpers", () => {
	test("coercePrimitivePromptAnswer rejects a malformed non-primitive descriptor", () => {
		assert.deepEqual(coercePrimitivePromptAnswer(malformedCustomPrompt, "true"), { ok: false });
	});

	test("requirePrimitivePromptAnswer throws a described Error, not a TypeError", () => {
		let thrown: unknown;
		try {
			requirePrimitivePromptAnswer(malformedCustomPrompt, "true");
		} catch (err) {
			thrown = err;
		}
		assert.ok(thrown instanceof Error);
		assert.equal(thrown instanceof TypeError, false);
		assert.match((thrown as Error).message, /Invalid custom prompt answer/);
		assert.equal((thrown as Error).message.includes("undefined"), false);
	});

	test("primitivePromptAnswerExpectation stays useful for a malformed descriptor", () => {
		assert.equal(
			primitivePromptAnswerExpectation(malformedCustomPrompt),
			"Expected an answer matching the pending prompt kind.",
		);
	});
});
