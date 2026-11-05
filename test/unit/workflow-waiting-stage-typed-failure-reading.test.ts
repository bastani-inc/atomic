import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { StageReleaseError } from "../../packages/workflows/src/shared/stage-wait-errors.js";
import { rehydrateTypedFailure, typedFailureDetail } from "../../packages/workflows/src/shared/typed-failure-detail.js";

const MAX_DEPTH = 16;

function validDetail(): Record<string, unknown> {
	const detail = typedFailureDetail(new StageReleaseError("stage-busy", { stageName: "review" }));
	assert.ok(detail !== undefined);
	return JSON.parse(JSON.stringify(detail)) as Record<string, unknown>;
}

/** `levels` causes nested one inside the other. */
function causes(levels: number): Record<string, unknown> | undefined {
	let cause: Record<string, unknown> | undefined;
	for (let level = 0; level < levels; level++)
		cause = { name: "Error", message: `level ${level}`, ...(cause ? { cause } : {}) };
	return cause;
}

function reasonOf(value: unknown): string {
	const reading = rehydrateTypedFailure(value);
	assert.equal(reading.ok, false);
	return reading.ok ? "" : reading.reason;
}

describe("the typed error a failed stage carries across a boundary (#4309)", () => {
	test("an error of the family that cannot describe itself in JSON carries no detail, and one that can carries only what JSON holds (#4309)", () => {
		assert.equal(typedFailureDetail({ name: "StageWaitError", code: "stage-busy" }), undefined);
		const withUndefined = typedFailureDetail({
			name: "StageWaitError",
			code: "stage-busy",
			toJSON: () => ({ name: "StageWaitError", code: "stage-busy", dropped: undefined, kept: 1 }),
		});
		assert.deepEqual(withUndefined, {
			name: "StageWaitError",
			code: "stage-busy",
			kept: 1,
			family: "StageWaitError",
		});
		assert.equal(Object.hasOwn(withUndefined ?? {}, "dropped"), false);
	});

	test("what is not an object, or is an array, is refused as such (#4309)", () => {
		for (const value of [undefined, null, "text", 5, [], [validDetail()]])
			assert.equal(reasonOf(value), "it is not an object");
	});

	test("a detail names the field that is wrong: its family, a text field, retryable or its fields (#4309)", () => {
		assert.equal(
			reasonOf({ ...validDetail(), family: "Other" }),
			"its family is neither StageWaitError nor ToolDetachmentError",
		);
		for (const key of ["name", "code", "message", "hint"])
			assert.equal(reasonOf({ ...validDetail(), [key]: 7 }), `its ${key} is not a string`);
		assert.equal(reasonOf({ ...validDetail(), retryable: "yes" }), "its retryable is not a boolean");
		for (const fields of [undefined, null, "text", []])
			assert.equal(reasonOf({ ...validDetail(), fields }), "its fields are not an object");
	});

	test("a cause chain is read to its sixteenth level and refused beyond it, and each cause must be an object with a name and a message (#4309)", () => {
		assert.equal(rehydrateTypedFailure({ ...validDetail(), cause: causes(MAX_DEPTH) }).ok, true);
		assert.equal(
			reasonOf({ ...validDetail(), cause: causes(MAX_DEPTH + 1) }),
			`its cause chain is deeper than ${MAX_DEPTH}`,
		);

		assert.equal(reasonOf({ ...validDetail(), cause: "text" }), "a cause is not an object");
		assert.equal(reasonOf({ ...validDetail(), cause: [] }), "a cause is not an object");
		assert.equal(
			reasonOf({ ...validDetail(), cause: { name: "Error", message: "m", cause: 5 } }),
			"a cause is not an object",
		);
		assert.equal(
			reasonOf({ ...validDetail(), cause: { name: 1, message: "m" } }),
			"a cause has no string name or message",
		);
		assert.equal(reasonOf({ ...validDetail(), cause: { name: "Error" } }), "a cause has no string name or message");
		assert.equal(reasonOf({ ...validDetail(), cause: { message: "m" } }), "a cause has no string name or message");
		assert.equal(
			reasonOf({ ...validDetail(), cause: { name: "Error", message: "m", code: 5 } }),
			"a cause's code is not a string",
		);
		assert.equal(
			rehydrateTypedFailure({ ...validDetail(), cause: { name: "Error", message: "m", code: "E1" } }).ok,
			true,
		);
	});

	test("a detail that passes the checks but cannot be rebuilt is refused with what went wrong, not thrown (#4309)", () => {
		for (const [thrown, shown] of [
			[new Error("fields would not read"), "fields would not read"],
			["a plain string", "a plain string"],
		] as const) {
			const fields = new Proxy(
				{},
				{
					get() {
						throw thrown;
					},
				},
			);
			assert.equal(
				reasonOf({ ...validDetail(), name: "StageReleaseError", fields }),
				`it could not be rebuilt: ${shown}`,
			);
		}
	});

	test("a valid detail is rebuilt as the error it describes (#4309)", () => {
		const reading = rehydrateTypedFailure(validDetail());
		assert.equal(reading.ok, true);
		assert.ok(reading.ok && reading.error instanceof StageReleaseError);
	});
});
