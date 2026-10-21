import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { describeErrorWithCauses } from "../../packages/workflows/src/shared/error-with-causes.js";

describe("describeErrorWithCauses", () => {
	test("joins an error's message with the messages of its causes", () => {
		const origin = new Error("remote store unavailable");
		const wrapped = new Error("could not record completed status", { cause: origin });
		assert.equal(describeErrorWithCauses(wrapped), "could not record completed status: remote store unavailable");
	});

	test("returns for an error that is its own cause (#3811)", () => {
		const error = new Error("journal write failed");
		error.cause = error;
		assert.equal(describeErrorWithCauses(error), "journal write failed");
	});

	test("returns for two errors that cause each other (#3811)", () => {
		const first = new Error("append rejected");
		const second = new Error("lease lost", { cause: first });
		first.cause = second;
		assert.equal(describeErrorWithCauses(first), "append rejected: lease lost");
	});

	test("stops after five causes in a chain of repeated messages (#3811)", () => {
		let error: Error = new Error("retry failed");
		for (let index = 0; index < 1000; index++) error = new Error("retry failed", { cause: error });
		assert.equal(describeErrorWithCauses(error), "retry failed");
	});
});
