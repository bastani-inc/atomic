import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import {
	findInCauseChain,
	hasErrorIdentity,
	MAX_GUARDED_CAUSE_DEPTH,
	MAX_SERIALIZED_CAUSE_DEPTH,
	redactUrlCredentials,
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

describe("redactUrlCredentials", () => {
	it("removes the user name and password from every URL and leaves the rest of the text", () => {
		assert.equal(
			redactUrlCredentials("GET http://alice:s3cr3t@127.0.0.1:8080/models and HTTPS://bob@example.test/x"),
			"GET http://127.0.0.1:8080/models and HTTPS://example.test/x",
		);
		assert.equal(
			redactUrlCredentials("mail alice@example.test about http://host/p@th"),
			"mail alice@example.test about http://host/p@th",
		);
		assert.equal(redactUrlCredentials("s3://key:secret@bucket/x"), "s3://bucket/x");
	});

	it("removes a password that contains a raw @ up to the last @ before the path, query or fragment", () => {
		assert.equal(redactUrlCredentials("http://user:p@ss@host:8080/x"), "http://host:8080/x");
		assert.equal(
			redactUrlCredentials("http://user:p@ss@w@rd@127.0.0.1:1/models?x=a@b"),
			"http://127.0.0.1:1/models?x=a@b",
		);
		assert.equal(redactUrlCredentials("http://u:p@h?q=a@b#c@d"), "http://h?q=a@b#c@d");
		assert.equal(redactUrlCredentials("http://u:p@h#frag@x"), "http://h#frag@x");
		assert.equal(redactUrlCredentials("http://@host"), "http://host");
		assert.equal(
			redactUrlCredentials("first http://a:1@h1/x then https://b:2@h2/y and see http://host and mail a@b.com"),
			"first http://h1/x then https://h2/y and see http://host and mail a@b.com",
		);
		assert.equal(
			redactUrlCredentials("http://host/a@b and http://host/@path"),
			"http://host/a@b and http://host/@path",
		);
	});

	it("bounds regex work on adversarial error details (#4323)", () => {
		const scheme = "a.".repeat(5_000);
		const cases = [
			[scheme, scheme],
			[`a://${scheme}`, `a://${scheme}`],
			[`${scheme}://user:secret@host`, `${scheme}://host`],
			["a://".repeat(5_000), "a://".repeat(5_000)],
		] as const;
		const exec = RegExp.prototype.exec;
		let regexCharacters = 0;
		let largestRegexInput = 0;
		const spy = vi.spyOn(RegExp.prototype, "exec").mockImplementation(function (this: RegExp, input: string) {
			regexCharacters += input.length;
			largestRegexInput = Math.max(largestRegexInput, input.length);
			return exec.call(this, input);
		});
		try {
			for (const [input, expected] of cases) assert.equal(redactUrlCredentials(input), expected);
		} finally {
			spy.mockRestore();
		}
		assert.ok(largestRegexInput <= 1, `regex received ${largestRegexInput} characters`);
		assert.ok(regexCharacters <= 4 * cases.reduce((sum, [input]) => sum + input.length, 0));
	});

	it("preserves scheme boundaries and authority delimiters in error details", () => {
		const cases = [
			["1a://u:p@h x", "1a://u:p@h x"],
			["1ſa://u:p@h x", "1ſa://u:p@h x"],
			["1Ka://u:p@h x", "1Ka://u:p@h x"],
			["a+1://u:p@h x", "a+1://h x"],
			["a-1://u:p@h x", "a-1://h x"],
			["+.-://u:p@h x", "+.-://u:p@h x"],
			["a://no-user b://u:p@h x", "a://no-user b://h x"],
			["a://u/p@h x", "a://u/p@h x"],
			["a://u?x@h", "a://u?x@h"],
			["a://u#x@h", "a://u#x@h"],
			["a://u p@h", "a://u p@h"],
			["ſ://u:p@h x", "ſ://h x"],
			["K://u:p@h x", "K://h x"],
			["a://u:p@@h x", "a://h x"],
		] as const;
		for (const [input, expected] of cases) assert.equal(redactUrlCredentials(input), expected, input);
	});

	it("removes credentials from every serialized cause message", () => {
		const root = new Error("connect to http://u:p@10.0.0.1:9 refused");
		const serialized = serializeErrorCause(new TypeError("bad url http://u:p@h:1/x", { cause: root }));
		assert.deepEqual(serialized, {
			name: "TypeError",
			message: "bad url http://h:1/x",
			cause: { name: "Error", message: "connect to http://10.0.0.1:9 refused" },
		});
		assert.deepEqual(serializeErrorCause("thrown http://u:p@h:1"), { name: "Error", message: "thrown http://h:1" });
	});
});
