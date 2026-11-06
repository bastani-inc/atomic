import assert from "node:assert/strict";
import { Socket } from "node:net";
import { test, vi } from "vitest";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

const {
	IntercomReleasedReplyError,
	isIntercomReleasedReplyError,
	isReleasedReplyAnsweredError,
	isReleasedReplyErrorCode,
	isReleasedReplyInFlightError,
	isRetryableIntercomReleasedReplyError,
	RELEASED_REPLY_ERROR_CODES,
	ReleasedReplyAnsweredError,
	ReleasedReplyInFlightError,
	readSerializedIntercomReleasedReplyError,
	rehydrateIntercomReleasedReplyError,
	serializeIntercomReleasedReplyError,
} = await import("../../packages/intercom/index.js");
const { isDeliveryFailureReasonCode } = await import("../../packages/intercom/broker/delivery-failure-reason.js");
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");

const FIELDS = { messageId: "reply-2", questionId: "question-1", childName: "worker one" } as const;

test("each released-reply refusal code has its class, retry semantics and hint (#4386)", () => {
	const answered = new ReleasedReplyAnsweredError(FIELDS);
	assert.equal(answered.name, "ReleasedReplyAnsweredError");
	assert.equal(answered.code, "released_reply_answered");
	assert.equal(answered.retryable, false);
	assert.match(answered.hint, /already took another reply/);
	assert.deepEqual(
		{ messageId: answered.messageId, questionId: answered.questionId, childName: answered.childName },
		FIELDS,
	);
	const inFlight = new ReleasedReplyInFlightError(FIELDS);
	assert.equal(inFlight.name, "ReleasedReplyInFlightError");
	assert.equal(inFlight.code, "released_reply_in_flight");
	assert.equal(inFlight.retryable, true);
	assert.match(inFlight.hint, /retry with the same message id/);
	assert.ok(answered instanceof IntercomReleasedReplyError && inFlight instanceof IntercomReleasedReplyError);
	assert.deepEqual([...RELEASED_REPLY_ERROR_CODES], ["released_reply_answered", "released_reply_in_flight"]);
	for (const code of RELEASED_REPLY_ERROR_CODES) {
		assert.ok(isReleasedReplyErrorCode(code));
		assert.ok(isDeliveryFailureReasonCode(code), `${code} is a delivery failure reason code`);
	}
	assert.equal(isReleasedReplyErrorCode("recipient_parked"), false);
});

test("the rendered message names the question, the subagent and the code, then the hint (#4386)", () => {
	const error = new ReleasedReplyAnsweredError(FIELDS);
	assert.equal(
		error.message,
		`Reply to a released subagent refused: question "question-1" of "worker one" (released_reply_answered). ${error.hint}`,
	);
});

test("guards match by class and, across realms, by name and code (#4386)", () => {
	const answered = new ReleasedReplyAnsweredError(FIELDS);
	const inFlight = new ReleasedReplyInFlightError(FIELDS);
	assert.ok(isIntercomReleasedReplyError(answered) && isIntercomReleasedReplyError(inFlight));
	assert.ok(isReleasedReplyAnsweredError(answered) && !isReleasedReplyAnsweredError(inFlight));
	assert.ok(isReleasedReplyInFlightError(inFlight) && !isReleasedReplyInFlightError(answered));
	const structural = (name: string, code: string | number) => Object.assign(new Error("other realm"), { name, code });
	assert.ok(isIntercomReleasedReplyError(structural("IntercomReleasedReplyError", "released_reply_in_flight")));
	assert.ok(isReleasedReplyAnsweredError(structural("ReleasedReplyAnsweredError", "released_reply_answered")));
	assert.ok(isReleasedReplyInFlightError(structural("ReleasedReplyInFlightError", "released_reply_in_flight")));
	assert.equal(isIntercomReleasedReplyError(structural("ReleasedReplyAnsweredError", "recipient_parked")), false);
	assert.equal(isIntercomReleasedReplyError(structural("ReleasedReplyAnsweredError", 7)), false);
	assert.equal(isIntercomReleasedReplyError(structural("Error", "released_reply_answered")), false);
	assert.equal(
		isReleasedReplyInFlightError(structural("ReleasedReplyAnsweredError", "released_reply_in_flight")),
		false,
	);
	assert.equal(
		isReleasedReplyAnsweredError(structural("ReleasedReplyInFlightError", "released_reply_answered")),
		false,
	);
	assert.equal(isIntercomReleasedReplyError(new Error("plain")), false);
});

test("only an in-flight refusal is retryable, also as a bounded cause (#4386)", () => {
	const inFlight = new ReleasedReplyInFlightError(FIELDS);
	assert.ok(isRetryableIntercomReleasedReplyError(inFlight));
	assert.equal(isRetryableIntercomReleasedReplyError(new ReleasedReplyAnsweredError(FIELDS)), false);
	assert.equal(isRetryableIntercomReleasedReplyError(new Error("plain")), false);
	const wrap = (cause: Error, depth: number): Error =>
		depth === 0 ? cause : new Error(`wrapper ${depth}`, { cause: wrap(cause, depth - 1) });
	assert.ok(isRetryableIntercomReleasedReplyError(wrap(inFlight, 4)));
	assert.equal(isRetryableIntercomReleasedReplyError(wrap(inFlight, 5)), false);
	assert.equal(isRetryableIntercomReleasedReplyError(wrap(new ReleasedReplyAnsweredError(FIELDS), 1)), false);
	const structuralRetryable = Object.assign(new Error("other realm"), {
		name: "ReleasedReplyInFlightError",
		code: "released_reply_in_flight",
		retryable: true,
	});
	assert.ok(isRetryableIntercomReleasedReplyError(structuralRetryable));
});

test("a refusal serializes and rehydrates into the same class with its fields and cause chain (#4386)", () => {
	const root = new Error("database is locked");
	root.name = "StorageUnavailableError";
	const cause = new Error("claim failed", { cause: root });
	const original = new ReleasedReplyInFlightError(FIELDS, { cause });
	const serialized = serializeIntercomReleasedReplyError(original);
	assert.deepEqual(serialized, {
		name: "ReleasedReplyInFlightError",
		code: "released_reply_in_flight",
		message: original.message,
		hint: original.hint,
		retryable: true,
		fields: FIELDS,
		cause: {
			name: "Error",
			message: "claim failed",
			cause: { name: "StorageUnavailableError", message: "database is locked" },
		},
	});
	const wire = readSerializedIntercomReleasedReplyError(JSON.parse(JSON.stringify(serialized)));
	assert.deepEqual(wire, serialized);
	const rehydrated = rehydrateIntercomReleasedReplyError(serialized);
	assert.ok(rehydrated instanceof ReleasedReplyInFlightError);
	assert.ok(isReleasedReplyInFlightError(rehydrated) && isRetryableIntercomReleasedReplyError(rehydrated));
	assert.equal(rehydrated.message, original.message);
	assert.deepEqual(
		{ messageId: rehydrated.messageId, questionId: rehydrated.questionId, childName: rehydrated.childName },
		FIELDS,
	);
	assert.ok(rehydrated.cause instanceof Error);
	assert.equal(rehydrated.cause.message, "claim failed");
	assert.ok(rehydrated.cause.cause instanceof Error);
	assert.equal(rehydrated.cause.cause.name, "StorageUnavailableError");

	const answered = rehydrateIntercomReleasedReplyError(
		serializeIntercomReleasedReplyError(new ReleasedReplyAnsweredError(FIELDS)),
	);
	assert.ok(answered instanceof ReleasedReplyAnsweredError);
	assert.equal(answered.cause, undefined);
	assert.equal("cause" in serializeIntercomReleasedReplyError(new ReleasedReplyAnsweredError(FIELDS)), false);

	const base = rehydrateIntercomReleasedReplyError({ ...serialized, name: "IntercomReleasedReplyError" });
	assert.equal(base.constructor, IntercomReleasedReplyError);
	assert.equal(base.name, "IntercomReleasedReplyError");
	const unknown = rehydrateIntercomReleasedReplyError({ ...serialized, name: "ReleasedReplyFromANewerBroker" });
	assert.equal(unknown.constructor, IntercomReleasedReplyError);
	assert.equal(unknown.name, "ReleasedReplyFromANewerBroker");
	assert.equal(unknown.code, "released_reply_in_flight");
	assert.equal(unknown.retryable, true);
});

test("a serialized cause chain is kept to four levels each way (#4386)", () => {
	let cause = new Error("level 6");
	for (let level = 5; level >= 1; level--) cause = new Error(`level ${level}`, { cause });
	const serialized = serializeIntercomReleasedReplyError(new ReleasedReplyAnsweredError(FIELDS, { cause }));
	const depthOf = (value: { cause?: object } | undefined): number =>
		value === undefined ? 0 : 1 + depthOf(value.cause);
	assert.equal(depthOf(serialized.cause), 4);
	const deep = {
		name: "Error",
		message: "1",
		cause: {
			name: "Error",
			message: "2",
			cause: {
				name: "Error",
				message: "3",
				cause: { name: "Error", message: "4", cause: { name: "Error", message: "5" } },
			},
		},
	};
	const read = readSerializedIntercomReleasedReplyError(JSON.parse(JSON.stringify({ ...serialized, cause: deep })));
	assert.equal(depthOf(read?.cause), 4);
	const rehydrated = rehydrateIntercomReleasedReplyError({ ...serialized, cause: deep });
	let chain = 0;
	const causeOf = (error: Error): Error | undefined => (error.cause instanceof Error ? error.cause : undefined);
	for (let current = causeOf(rehydrated); current !== undefined; current = causeOf(current)) chain++;
	assert.equal(chain, 4);
});

test("a malformed serialized refusal on the wire is rejected (#4386)", () => {
	const valid = serializeIntercomReleasedReplyError(new ReleasedReplyAnsweredError(FIELDS));
	const wire = JSON.parse(JSON.stringify(valid));
	assert.deepEqual(readSerializedIntercomReleasedReplyError(wire), valid);
	for (const [label, value] of [
		["absent", undefined],
		["null", null],
		["array", [wire]],
		["string", "released_reply_answered"],
		["unknown code", { ...wire, code: "recipient_parked" }],
		["numeric name", { ...wire, name: 1 }],
		["missing message", { ...wire, message: undefined }],
		["missing hint", { ...wire, hint: 2 }],
		["string retryable", { ...wire, retryable: "false" }],
		["missing fields", { ...wire, fields: null }],
		["missing question", { ...wire, fields: { ...wire.fields, questionId: undefined } }],
		["numeric message id", { ...wire, fields: { ...wire.fields, messageId: 3 } }],
		["numeric child", { ...wire, fields: { ...wire.fields, childName: 3 } }],
		["bad cause", { ...wire, cause: "boom" }],
		["cause without message", { ...wire, cause: { name: "Error" } }],
		[
			"bad nested cause",
			{ ...wire, cause: { name: "Error", message: "outer", cause: { name: 1, message: "inner" } } },
		],
	] as const) {
		assert.equal(readSerializedIntercomReleasedReplyError(value as never), undefined, label);
	}
});

function connectedClient() {
	const client = new IntercomClient();
	const frames: Array<Record<string, unknown> & { attemptId: string }> = [];
	const socket = new Socket();
	vi.spyOn(socket, "write").mockImplementation((data) => {
		assert.ok(Buffer.isBuffer(data));
		frames.push(JSON.parse(data.subarray(4).toString("utf8")));
		return true;
	});
	client["socket"] = socket;
	client["_sessionId"] = "replier";
	const receive = (message: object) => client["handleBrokerMessage"](message as never);
	return { client, frames, receive };
}

test("a client resolves a refused reply to a released subagent with the typed error the broker sent (#4386)", async () => {
	const { client, frames, receive } = connectedClient();
	const sent = client.send("worker one", { text: "use config.ts", messageId: "reply-2", replyTo: "question-1" });
	const error = new ReleasedReplyAnsweredError(FIELDS);
	receive({
		type: "delivery_failed",
		messageId: "reply-2",
		attemptId: frames[0]!.attemptId,
		reason: error.message,
		reasonCode: error.code,
		error: JSON.parse(JSON.stringify(serializeIntercomReleasedReplyError(error))),
	});
	const result = await sent;
	assert.equal(result.delivered, false);
	assert.equal(result.reasonCode, "released_reply_answered");
	assert.equal(result.reason, error.message);
	assert.ok(result.error instanceof ReleasedReplyAnsweredError);
	assert.ok(isReleasedReplyAnsweredError(result.error));
	assert.equal(result.error.retryable, false);
	assert.deepEqual(
		{ messageId: result.error.messageId, questionId: result.error.questionId, childName: result.error.childName },
		FIELDS,
	);
});

test("a client refuses a delivery failure whose typed error is malformed or names another code (#4386)", () => {
	const { receive } = connectedClient();
	const serialized = serializeIntercomReleasedReplyError(new ReleasedReplyInFlightError(FIELDS));
	for (const frame of [
		{ reasonCode: "released_reply_answered", error: serialized },
		{ error: serialized },
		{ reasonCode: "released_reply_in_flight", error: { ...serialized, fields: {} } },
		{ reasonCode: "released_reply_in_flight", error: "released_reply_in_flight" },
	]) {
		assert.throws(
			() => receive({ type: "delivery_failed", messageId: "m", reason: "refused", ...frame }),
			/Invalid delivery_failed message/,
			JSON.stringify(frame),
		);
	}
	assert.doesNotThrow(() =>
		receive({ type: "delivery_failed", messageId: "m", reason: "refused", reasonCode: "released_reply_in_flight" }),
	);
});

test("a delivery failure keeps a known reason code, rejects an unknown one, and adds none it was not given (#4386)", async () => {
	const { client, frames, receive } = connectedClient();
	for (const malformed of [{ messageId: 7 }, { attemptId: 7 }, { reason: 7 }]) {
		assert.throws(
			() => receive({ type: "delivery_failed", messageId: "m", reason: "refused", ...malformed }),
			/Invalid delivery_failed message/,
			JSON.stringify(malformed),
		);
	}
	for (const reasonCode of ["not_a_code", 7]) {
		assert.throws(
			() => receive({ type: "delivery_failed", messageId: "m", reason: "refused", reasonCode }),
			/Invalid delivery_failed message/,
			String(reasonCode),
		);
	}
	const plain = client.send("someone", { text: "hi", messageId: "plain" });
	receive({
		type: "delivery_failed",
		messageId: "plain",
		attemptId: frames[0]!.attemptId,
		reason: "Session not found",
	});
	assert.deepEqual(await plain, { id: "plain", delivered: false, reason: "Session not found" });
	const coded = client.send("someone", { text: "hi", messageId: "coded" });
	receive({
		type: "delivery_failed",
		messageId: "coded",
		attemptId: frames[1]!.attemptId,
		reason: "Session not found",
		reasonCode: "session_not_found",
	});
	assert.deepEqual(await coded, {
		id: "coded",
		delivered: false,
		reason: "Session not found",
		reasonCode: "session_not_found",
	});
});
