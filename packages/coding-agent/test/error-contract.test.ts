import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	findInCauseChain,
	hasErrorIdentity,
	MAX_GUARDED_CAUSE_DEPTH,
	MAX_SERIALIZED_CAUSE_DEPTH,
	rehydrateErrorCause,
	type SerializedErrorCause,
	serializeErrorCause,
} from "../src/core/error-contract.js";

function chainOf(length: number): Error {
	let current = new Error(`level ${length - 1}`);
	for (let level = length - 2; level >= 0; level--) {
		current = new Error(`level ${level}`, { cause: current });
	}
	return current;
}

function depthOf(cause: SerializedErrorCause | undefined): number {
	let depth = 0;
	for (let link = cause; link; link = link.cause) depth++;
	return depth;
}

describe("serializeErrorCause", () => {
	it("serializes nothing for an absent cause", () => {
		assert.equal(serializeErrorCause(undefined), undefined);
		assert.equal(serializeErrorCause(null), undefined);
	});

	it("keeps only the first MAX_SERIALIZED_CAUSE_DEPTH links of a longer chain", () => {
		const serialized = serializeErrorCause(chainOf(MAX_SERIALIZED_CAUSE_DEPTH + 3));
		assert.equal(depthOf(serialized), MAX_SERIALIZED_CAUSE_DEPTH);
		assert.equal(depthOf(serializeErrorCause(chainOf(MAX_SERIALIZED_CAUSE_DEPTH))), MAX_SERIALIZED_CAUSE_DEPTH);
	});

	it("wraps a thrown non-error value as a plain Error", () => {
		assert.deepEqual(serializeErrorCause("disk on fire"), { name: "Error", message: "disk on fire" });
		assert.deepEqual(serializeErrorCause({ code: "X" }), { name: "Error", message: "[object Object]" });
	});

	it("keeps the name, message and a string code, and nests the cause", () => {
		const root = Object.assign(new Error("root"), { code: "EIO" });
		const serialized = serializeErrorCause(new TypeError("outer", { cause: root }));
		assert.deepEqual(serialized, {
			name: "TypeError",
			message: "outer",
			cause: { name: "Error", message: "root", code: "EIO" },
		});
	});

	it("leaves out a code that is not a string", () => {
		const numeric = Object.assign(new Error("numeric"), { code: 42 });
		assert.deepEqual(serializeErrorCause(numeric), { name: "Error", message: "numeric" });
		assert.deepEqual(serializeErrorCause(new Error("plain")), { name: "Error", message: "plain" });
	});
});

describe("rehydrateErrorCause", () => {
	it("rebuilds a chain with the original names, messages and codes", () => {
		const rehydrated = rehydrateErrorCause({
			name: "TypeError",
			message: "outer",
			cause: { name: "SystemError", message: "root", code: "EIO" },
		});
		assert.ok(rehydrated instanceof Error);
		assert.equal(rehydrated.name, "TypeError");
		assert.equal(rehydrated.message, "outer");
		assert.equal(Object.hasOwn(rehydrated, "code"), false);
		const root = rehydrated.cause as Error & { code?: string };
		assert.equal(root.name, "SystemError");
		assert.equal(root.code, "EIO");
		assert.equal(Object.hasOwn(root, "cause"), false);
	});

	it("returns undefined for no cause", () => {
		assert.equal(rehydrateErrorCause(undefined), undefined);
	});
});

describe("hasErrorIdentity", () => {
	const names = new Set(["KnownError"]);
	const codes = new Set(["known-code"]);

	it("accepts an object with a known name and a known code", () => {
		assert.equal(hasErrorIdentity({ name: "KnownError", code: "known-code" }, names, codes), true);
	});

	it("rejects an unknown name, an unknown code, or a missing one", () => {
		assert.equal(hasErrorIdentity({ name: "Other", code: "known-code" }, names, codes), false);
		assert.equal(hasErrorIdentity({ name: "KnownError", code: "other" }, names, codes), false);
		assert.equal(hasErrorIdentity({ name: "KnownError" }, names, codes), false);
		assert.equal(hasErrorIdentity({ code: "known-code" }, names, codes), false);
	});

	it("rejects null and values that are not objects", () => {
		assert.equal(hasErrorIdentity(null, names, codes), false);
		assert.equal(hasErrorIdentity(undefined, names, codes), false);
		assert.equal(hasErrorIdentity("KnownError", names, codes), false);
	});
});

describe("findInCauseChain", () => {
	interface Marked {
		marked: true;
	}
	const isMarked = (candidate: unknown): candidate is Marked =>
		typeof candidate === "object" && candidate !== null && "marked" in candidate;

	function chainWithMarkAt(depth: number): Error {
		let current: Error = Object.assign(new Error("marked"), { marked: true });
		for (let level = 0; level < depth; level++) current = new Error(`wrapper ${level}`, { cause: current });
		return current;
	}

	it("finds the error itself and a marked cause down the chain", () => {
		const marked = Object.assign(new Error("marked"), { marked: true });
		assert.equal(findInCauseChain(marked, isMarked), marked);
		const wrapped = new Error("outer", { cause: new Error("middle", { cause: marked }) });
		assert.equal(findInCauseChain(wrapped, isMarked), marked);
	});

	it("inspects MAX_GUARDED_CAUSE_DEPTH + 1 links and no more", () => {
		assert.ok(findInCauseChain(chainWithMarkAt(MAX_GUARDED_CAUSE_DEPTH), isMarked));
		assert.equal(findInCauseChain(chainWithMarkAt(MAX_GUARDED_CAUSE_DEPTH + 1), isMarked), undefined);
	});

	it("stops on a circular chain that no link satisfies", () => {
		const first = new Error("first");
		const second = new Error("second", { cause: first });
		first.cause = second;
		const inspected: unknown[] = [];
		const result = findInCauseChain(first, (candidate): candidate is Marked => {
			inspected.push(candidate);
			return false;
		});
		assert.equal(result, undefined);
		assert.equal(inspected.length, MAX_GUARDED_CAUSE_DEPTH + 1);
	});

	it("never hands the guard a missing cause", () => {
		const inspected: unknown[] = [];
		const record = (candidate: unknown): candidate is Marked => {
			inspected.push(candidate);
			return false;
		};
		const plain = new Error("no cause");
		assert.equal(findInCauseChain(plain, record), undefined);
		assert.deepEqual(inspected, [plain]);

		inspected.length = 0;
		const nullCause = new Error("null cause", { cause: null });
		assert.equal(findInCauseChain(nullCause, record), undefined);
		assert.deepEqual(inspected, [nullCause]);

		inspected.length = 0;
		assert.equal(findInCauseChain(undefined, record), undefined);
		assert.equal(findInCauseChain(null, record), undefined);
		assert.deepEqual(inspected, []);
	});

	it("does not follow a cause held by a value that is not an object", () => {
		const hidden = Object.assign(new Error("marked"), { marked: true });
		const opaque = Object.assign(() => {}, { cause: hidden });
		const wrapped = new Error("outer", { cause: opaque });
		assert.equal(findInCauseChain(wrapped, isMarked), undefined);
	});
});
