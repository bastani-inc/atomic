import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	deserializeToolDetachmentError,
	findToolDetachmentError,
	isToolDetachmentError,
	type SerializedToolDetachmentError,
	type SerializedToolDetachmentErrorCause,
	ToolDetachmentError,
	type ToolDetachmentErrorCode,
} from "../src/index.ts";

const SESSION_ID = "01a1a9c4-8c43-75ae-9d13-9dc3c95b15d9";

describe("ToolDetachmentError messages (#4309)", () => {
	const cases: readonly {
		readonly code: ToolDetachmentErrorCode;
		readonly fields: ConstructorParameters<typeof ToolDetachmentError>[1];
		readonly retryable: boolean;
		readonly message: string;
	}[] = [
		{
			code: "invalid-policy",
			fields: { sessionId: SESSION_ID, field: "afterMs", value: "-5" },
			retryable: false,
			message: `Invalid tool detachment policy for session ${SESSION_ID}: afterMs is -5 (invalid-policy). Pass a policy whose afterMs is a finite number of milliseconds from 0 to 2147483647, or undefined.`,
		},
		{
			code: "unknown-tool-call",
			fields: { sessionId: SESSION_ID, toolCallId: "ci-1" },
			retryable: false,
			message: `Session ${SESSION_ID} is not waiting on tool call ci-1 (unknown-tool-call). Hand back only results of the calls takeDetachedToolCalls() or redispatchDetachedToolCalls() returned for this session's transcript.`,
		},
		{
			code: "session-busy",
			fields: { sessionId: SESSION_ID },
			retryable: true,
			message: `Session ${SESSION_ID} is still running and cannot resume its detached turn (session-busy). Wait for the session's current run to settle before resuming its detached turn.`,
		},
		{
			code: "session-closed",
			fields: { sessionId: SESSION_ID },
			retryable: false,
			message: `Session ${SESSION_ID} is closed and cannot resume its detached turn (session-closed). Reopen the session from its store and hand the results to the new session.`,
		},
		{
			code: "context-detached",
			fields: { sessionId: SESSION_ID, toolCallId: "ci-1" },
			retryable: false,
			message: `Tool call ci-1 detached from session ${SESSION_ID} and can no longer use its context (context-detached). Read what the tool's work needs from ctx before the call detaches, or pass it in the tool's arguments.`,
		},
		{
			code: "stage-parked",
			fields: { sessionId: SESSION_ID },
			retryable: true,
			message: `Workflow stage session ${SESSION_ID} is released and cannot launch a task (stage-parked). Wait for the workflow stage to reopen its session, then start the task again. A released stage launches no tasks while it waits.`,
		},
	];

	for (const { code, fields, retryable, message } of cases) {
		test(`${code} says what happened, to which session, and what to do`, () => {
			const error = new ToolDetachmentError(code, fields);

			assert.equal(error.name, "ToolDetachmentError");
			assert.equal(error.code, code);
			assert.equal(error.retryable, retryable);
			assert.deepEqual(error.fields, fields);
			assert.equal(error.message, message);
			assert.ok(message.endsWith(error.hint));
			assert.ok(isToolDetachmentError(error));
			assert.ok(error instanceof Error);
		});
	}

	test("keeps the failure that caused it", () => {
		const cause = new Error("the store is read-only");

		const error = new ToolDetachmentError("session-busy", { sessionId: SESSION_ID }, { cause });

		assert.equal(error.cause, cause);
	});
});

describe("isToolDetachmentError (#4309)", () => {
	const copy = { name: "ToolDetachmentError", code: "unknown-tool-call", message: "copied" };

	test("accepts a structural copy that crossed a process or realm boundary", () => {
		assert.equal(isToolDetachmentError(copy), true);
		for (const code of [
			"invalid-policy",
			"unknown-tool-call",
			"session-busy",
			"session-closed",
			"context-detached",
			"stage-parked",
		])
			assert.equal(isToolDetachmentError({ ...copy, code }), true);
	});

	test("rejects anything that is not one of its own errors", () => {
		assert.equal(isToolDetachmentError(undefined), false);
		assert.equal(isToolDetachmentError(null), false);
		assert.equal(isToolDetachmentError("ToolDetachmentError"), false);
		assert.equal(isToolDetachmentError(7), false);
		assert.equal(isToolDetachmentError({}), false);
		assert.equal(isToolDetachmentError(new Error("session-busy")), false);
		assert.equal(isToolDetachmentError({ ...copy, name: "StageWaitError" }), false);
		assert.equal(isToolDetachmentError({ ...copy, code: "stage-busy" }), false);
		assert.equal(isToolDetachmentError({ ...copy, code: 7 }), false);
		assert.equal(isToolDetachmentError({ name: copy.name }), false);
		assert.equal(isToolDetachmentError({ code: copy.code }), false);
	});
});

describe("findToolDetachmentError (#4309)", () => {
	function wrapped(error: Error, levels: number): Error {
		let current = error;
		for (let level = 0; level < levels; level++) current = new Error(`level ${level}`, { cause: current });
		return current;
	}

	test("finds the error anywhere in the first eight links of a cause chain", () => {
		const closed = new ToolDetachmentError("session-closed", { sessionId: SESSION_ID });

		assert.equal(findToolDetachmentError(closed), closed);
		assert.equal(findToolDetachmentError(wrapped(closed, 7)), closed);
		assert.equal(findToolDetachmentError(wrapped(closed, 8)), undefined);
	});

	test("finds nothing in a chain without one, including a chain that loops", () => {
		const looping = new Error("outer");
		(looping as { cause?: unknown }).cause = looping;

		assert.equal(findToolDetachmentError(wrapped(new Error("plain"), 3)), undefined);
		assert.equal(findToolDetachmentError(looping), undefined);
		assert.equal(findToolDetachmentError("session-closed"), undefined);
		assert.equal(findToolDetachmentError(undefined), undefined);
	});
});

describe("ToolDetachmentError across a process boundary (#4309)", () => {
	function roundTrip(error: ToolDetachmentError): ToolDetachmentError {
		return deserializeToolDetachmentError(JSON.parse(JSON.stringify(error)) as SerializedToolDetachmentError);
	}

	test("comes back as the same class with its code, fields, hint and message", () => {
		const original = new ToolDetachmentError("unknown-tool-call", { sessionId: SESSION_ID, toolCallId: "ci-1" });

		const rehydrated = roundTrip(original);

		assert.ok(rehydrated instanceof ToolDetachmentError);
		assert.ok(isToolDetachmentError(rehydrated));
		assert.equal(rehydrated.name, "ToolDetachmentError");
		assert.equal(rehydrated.code, "unknown-tool-call");
		assert.equal(rehydrated.retryable, false);
		assert.deepEqual(rehydrated.fields, original.fields);
		assert.equal(rehydrated.hint, original.hint);
		assert.equal(rehydrated.message, original.message);
		assert.equal(roundTrip(new ToolDetachmentError("session-busy", { sessionId: SESSION_ID })).retryable, true);
	});

	test("a parked stage's refusal comes back as stage-parked, retryable, with its session (#4309)", () => {
		const original = new ToolDetachmentError("stage-parked", { sessionId: SESSION_ID });

		const rehydrated = roundTrip(original);

		assert.ok(rehydrated instanceof ToolDetachmentError);
		assert.ok(isToolDetachmentError(rehydrated));
		assert.equal(rehydrated.code, "stage-parked");
		assert.equal(rehydrated.retryable, true);
		assert.deepEqual(rehydrated.fields, { sessionId: SESSION_ID });
		assert.equal(rehydrated.message, original.message);
	});

	test("keeps a bounded cause chain, so the error is still found inside a wrapper on the other side", () => {
		const storeFailure = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
		const original = new ToolDetachmentError(
			"session-closed",
			{ sessionId: SESSION_ID },
			{ cause: new Error("close failed", { cause: storeFailure }) },
		);

		const serialized = JSON.parse(JSON.stringify(original)) as SerializedToolDetachmentError;
		const rehydrated = deserializeToolDetachmentError(serialized);

		assert.deepEqual(serialized.cause, {
			name: "Error",
			message: "close failed",
			cause: { name: "Error", message: "database is locked", code: "SQLITE_BUSY" },
		});
		const cause = rehydrated.cause as Error & { cause?: Error & { code?: string } };
		assert.equal(cause.message, "close failed");
		assert.equal(cause.cause?.message, "database is locked");
		assert.equal(cause.cause?.code, "SQLITE_BUSY");
		assert.equal(findToolDetachmentError(new Error("stage failed", { cause: rehydrated })), rehydrated);
	});

	test("an unknown name or code from a newer process keeps its name, code, hint and message on the base class", () => {
		const serialized: SerializedToolDetachmentError = {
			name: "ToolDetachmentQuotaError",
			code: "quota-exceeded",
			message: "Session s is over its detachment quota (quota-exceeded). Wait.",
			hint: "Wait.",
			retryable: true,
			fields: { sessionId: "s" },
		};

		const rehydrated = deserializeToolDetachmentError(serialized);

		assert.ok(rehydrated instanceof ToolDetachmentError);
		assert.equal(rehydrated.name, "ToolDetachmentQuotaError");
		assert.equal(rehydrated.code, "quota-exceeded");
		assert.equal(rehydrated.message, serialized.message);
		assert.equal(rehydrated.hint, "Wait.");
		assert.equal(rehydrated.retryable, true);
		assert.deepEqual(rehydrated.fields, { sessionId: "s" });
	});
});

describe("ToolDetachmentError serialization edges (#4309)", () => {
	function roundTrip(error: ToolDetachmentError): ToolDetachmentError {
		return deserializeToolDetachmentError(JSON.parse(JSON.stringify(error)) as SerializedToolDetachmentError);
	}

	test("an unknown name stays recognizable and findable as a ToolDetachmentError (#4309)", () => {
		const rehydrated = deserializeToolDetachmentError({
			name: "ToolDetachmentQuotaError",
			code: "session-busy",
			message: "Session s is over its detachment quota (session-busy). Wait.",
			hint: "Wait.",
			retryable: true,
			fields: { sessionId: "s" },
		});

		assert.equal(isToolDetachmentError(rehydrated), true);
		assert.equal(findToolDetachmentError(new Error("wrapped", { cause: rehydrated })), rehydrated);
	});

	test("a known code takes its hint and retryability from this side, whatever the payload says (#4309)", () => {
		const current = new ToolDetachmentError("session-busy", { sessionId: SESSION_ID });
		const stale: SerializedToolDetachmentError = { ...current.toJSON(), hint: "Retry later.", retryable: false };

		const rehydrated = deserializeToolDetachmentError(stale);

		assert.equal(rehydrated.hint, current.hint);
		assert.equal(rehydrated.retryable, true);
	});

	test("an error without a cause serializes and comes back without one (#4309)", () => {
		const original = new ToolDetachmentError("session-closed", { sessionId: SESSION_ID });

		assert.equal(Object.hasOwn(original.toJSON(), "cause"), false);
		assert.equal(roundTrip(original).cause, undefined);
	});

	test("a cause that is not an Error serializes as an Error with its text (#4309)", () => {
		const original = new ToolDetachmentError("session-closed", { sessionId: SESSION_ID }, { cause: "disk full" });

		assert.deepEqual(original.toJSON().cause, { name: "Error", message: "disk full" });
	});

	test("a cause's code is kept only when it is text, and a cause without one comes back without one (#4309)", () => {
		const original = new ToolDetachmentError(
			"session-closed",
			{ sessionId: SESSION_ID },
			{ cause: Object.assign(new TypeError("bad handle"), { code: 9 }) },
		);

		assert.deepEqual(original.toJSON().cause, { name: "TypeError", message: "bad handle" });
		const cause = roundTrip(original).cause as Error;
		assert.equal(cause.name, "TypeError");
		assert.equal(Object.hasOwn(cause, "code"), false);
	});

	test("a cause chain longer than eight links keeps its first eight, the last one without its code (#4309)", () => {
		let chain: Error | undefined;
		for (let level = 9; level >= 0; level--)
			chain = Object.assign(new RangeError(`level ${level}`, chain === undefined ? undefined : { cause: chain }), {
				code: `E${level}`,
			});
		const original = new ToolDetachmentError("session-closed", { sessionId: SESSION_ID }, { cause: chain });

		const levels: SerializedToolDetachmentErrorCause[] = [];
		for (let link = original.toJSON().cause; link !== undefined; link = link.cause) levels.push(link);

		assert.deepEqual(
			levels.map((level) => level.message),
			["level 0", "level 1", "level 2", "level 3", "level 4", "level 5", "level 6", "level 7"],
		);
		assert.deepEqual(levels.at(-1), { name: "RangeError", message: "level 7" });
		assert.equal(levels.at(-2)?.code, "E6");
	});
});

describe("findToolDetachmentError on chains that end early (#4309)", () => {
	test("finds nothing in null or in a chain whose cause is null (#4309)", () => {
		assert.equal(findToolDetachmentError(null), undefined);
		assert.equal(findToolDetachmentError(new Error("outer", { cause: null })), undefined);
	});
});
