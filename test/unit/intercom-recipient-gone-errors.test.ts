import assert from "node:assert/strict";
import { test } from "vitest";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

const {
	INTERCOM_RECIPIENT_GONE_ERROR_CODES,
	IntercomRecipientGoneError,
	isIntercomRecipientGoneError,
	isIntercomRecipientGoneErrorCode,
	isRetryableIntercomRecipientGoneError,
	isSubagentRecipientDisconnectedError,
	isSubagentRecipientEndedError,
	isSubagentRecipientOwnerSuspendedError,
	readSerializedIntercomRecipientGoneError,
	rehydrateIntercomRecipientGoneError,
	SUBAGENT_ENDED_OUTCOMES,
	SubagentRecipientDisconnectedError,
	SubagentRecipientEndedError,
	SubagentRecipientOwnerSuspendedError,
	serializeIntercomRecipientGoneError,
	subagentEndedCode,
} = await import("../../packages/intercom/index.js");

const FIELDS = { target: "subagent-worker-aabcf28b-1", childName: "subagent-worker-aabcf28b-1", childId: "aabcf28b:0" };

test("each gone-recipient code has its class, retry semantics, message and hint (#4639)", () => {
	const expected = {
		recipient_completed: [
			"completed and has no live session",
			'Its launching session can continue it with subagent({ action: "resume", id: "aabcf28b:0", message: "<your message>" }).',
		],
		recipient_failed: [
			"failed and has no live session",
			'Its launching session can continue it with subagent({ action: "resume", id: "aabcf28b:0", message: "<your message>" }).',
		],
		recipient_stopped: [
			"was stopped (paused or quit) and has no live session",
			'Its launching session can continue it with subagent({ action: "resume", id: "aabcf28b:0", message: "<your message>" }).',
		],
		recipient_cancelled: [
			"was cancelled for good and has no live session",
			"It cannot be resumed; launch a fresh subagent if its work is still needed.",
		],
	} as const;
	for (const [code, [what, hint]] of Object.entries(expected)) {
		const error = new SubagentRecipientEndedError(code as keyof typeof expected, FIELDS);
		assert.equal(error.name, "SubagentRecipientEndedError");
		assert.equal(error.code, code);
		assert.equal(error.retryable, false);
		assert.equal(error.hint, hint);
		assert.equal(error.message, `Subagent "subagent-worker-aabcf28b-1" ${what} (${code}). ${hint}`);
		assert.deepEqual(error.fields, FIELDS);
		assert.ok(error instanceof IntercomRecipientGoneError);
	}
	const disconnected = new SubagentRecipientDisconnectedError({ target: "abc", childName: "worker" });
	assert.equal(disconnected.name, "SubagentRecipientDisconnectedError");
	assert.equal(disconnected.code, "recipient_disconnected");
	assert.equal(disconnected.retryable, true);
	assert.equal(
		disconnected.message,
		'Subagent "worker" disconnected and has not reconnected (recipient_disconnected). Its launching session has not said why; check subagent({ action: "status" }) there, or try again shortly.',
	);
	assert.deepEqual(disconnected.fields, { target: "abc", childName: "worker" });
	assert.equal(disconnected.childId, undefined, "a refusal without a child id names none");
	const suspended = new SubagentRecipientOwnerSuspendedError({ target: "abc", childName: "worker" });
	assert.equal(suspended.name, "SubagentRecipientOwnerSuspendedError");
	assert.equal(suspended.code, "recipient_owner_suspended");
	assert.equal(suspended.retryable, true);
	assert.equal(
		suspended.message,
		'Subagent "worker" is released and the session that launched it is suspended or disconnected, so nothing can wake it now (recipient_owner_suspended). Try again once its launching session is back; to reach that session now, send to its workflow stage target (workflow:<rootRunId>/<stage>), which queues the message until the stage reopens.',
	);
	assert.ok(suspended instanceof IntercomRecipientGoneError);
});

test("a refusal without the child's id still names the resume call to fill in (#4639)", () => {
	const error = new SubagentRecipientEndedError("recipient_completed", { target: "w", childName: "w" });
	assert.equal(
		error.hint,
		'Its launching session can continue it with subagent({ action: "resume", id: "<child-id>", message: "<your message>" }).',
	);
});

test("the codes and outcomes are the documented unions, and each outcome maps to its code (#4639)", () => {
	assert.deepEqual(
		[...INTERCOM_RECIPIENT_GONE_ERROR_CODES],
		[
			"recipient_completed",
			"recipient_failed",
			"recipient_stopped",
			"recipient_cancelled",
			"recipient_disconnected",
			"recipient_owner_suspended",
		],
	);
	for (const code of INTERCOM_RECIPIENT_GONE_ERROR_CODES) assert.ok(isIntercomRecipientGoneErrorCode(code));
	assert.equal(isIntercomRecipientGoneErrorCode("session_not_found"), false);
	assert.equal(isIntercomRecipientGoneErrorCode(3), false);
	assert.equal(isIntercomRecipientGoneErrorCode(undefined), false);
	assert.deepEqual([...SUBAGENT_ENDED_OUTCOMES], ["completed", "failed", "stopped", "cancelled"]);
	assert.deepEqual(
		SUBAGENT_ENDED_OUTCOMES.map((outcome) => subagentEndedCode(outcome)),
		["recipient_completed", "recipient_failed", "recipient_stopped", "recipient_cancelled"],
	);
});

test("guards match by class and, across realms, by name and code (#4639)", () => {
	const ended = new SubagentRecipientEndedError("recipient_failed", FIELDS);
	const disconnected = new SubagentRecipientDisconnectedError(FIELDS);
	assert.ok(isIntercomRecipientGoneError(ended) && isIntercomRecipientGoneError(disconnected));
	assert.ok(isSubagentRecipientEndedError(ended) && !isSubagentRecipientEndedError(disconnected));
	assert.ok(isSubagentRecipientDisconnectedError(disconnected) && !isSubagentRecipientDisconnectedError(ended));
	const structural = (name: string, code: string | number) => Object.assign(new Error("other realm"), { name, code });
	assert.ok(isIntercomRecipientGoneError(structural("IntercomRecipientGoneError", "recipient_stopped")));
	assert.ok(isSubagentRecipientEndedError(structural("SubagentRecipientEndedError", "recipient_completed")));
	assert.ok(
		isSubagentRecipientDisconnectedError(structural("SubagentRecipientDisconnectedError", "recipient_disconnected")),
	);
	assert.ok(
		isSubagentRecipientOwnerSuspendedError(
			structural("SubagentRecipientOwnerSuspendedError", "recipient_owner_suspended"),
		),
	);
	assert.equal(
		isSubagentRecipientOwnerSuspendedError(structural("SubagentRecipientEndedError", "recipient_owner_suspended")),
		false,
	);
	const suspended = new SubagentRecipientOwnerSuspendedError(FIELDS);
	assert.ok(isSubagentRecipientOwnerSuspendedError(suspended) && isIntercomRecipientGoneError(suspended));
	assert.equal(isSubagentRecipientOwnerSuspendedError(disconnected), false);
	assert.equal(isIntercomRecipientGoneError(structural("SubagentRecipientEndedError", "session_not_found")), false);
	assert.equal(isIntercomRecipientGoneError(structural("SubagentRecipientEndedError", 3)), false);
	assert.equal(isIntercomRecipientGoneError(structural("Error", "recipient_completed")), false);
	assert.equal(
		isSubagentRecipientEndedError(structural("SubagentRecipientDisconnectedError", "recipient_completed")),
		false,
	);
	assert.equal(
		isSubagentRecipientDisconnectedError(structural("SubagentRecipientEndedError", "recipient_disconnected")),
		false,
	);
	assert.equal(isIntercomRecipientGoneError(new Error("plain")), false);
});

test("only a disconnected recipient is retryable, also as a bounded cause (#4639)", () => {
	const disconnected = new SubagentRecipientDisconnectedError(FIELDS);
	assert.ok(isRetryableIntercomRecipientGoneError(disconnected));
	assert.ok(isRetryableIntercomRecipientGoneError(new SubagentRecipientOwnerSuspendedError(FIELDS)));
	assert.equal(
		isRetryableIntercomRecipientGoneError(new SubagentRecipientEndedError("recipient_completed", FIELDS)),
		false,
	);
	assert.equal(isRetryableIntercomRecipientGoneError(new Error("plain")), false);
	const wrap = (cause: Error, depth: number): Error =>
		depth === 0 ? cause : new Error(`wrapper ${depth}`, { cause: wrap(cause, depth - 1) });
	assert.ok(isRetryableIntercomRecipientGoneError(wrap(disconnected, 4)));
	assert.equal(isRetryableIntercomRecipientGoneError(wrap(disconnected, 5)), false);
	assert.equal(
		isRetryableIntercomRecipientGoneError(Object.assign(new Error("not an error cause"), { cause: "string" })),
		false,
	);
});

test("a refusal serializes and rehydrates into the same class with its fields and cause chain (#4639)", () => {
	const root = new Error("socket reset");
	root.name = "IntercomDisconnectError";
	const original = new SubagentRecipientEndedError("recipient_completed", FIELDS, {
		cause: new Error("session closed", { cause: root }),
	});
	const serialized = serializeIntercomRecipientGoneError(original);
	assert.deepEqual(serialized, {
		name: "SubagentRecipientEndedError",
		code: "recipient_completed",
		message: original.message,
		hint: original.hint,
		retryable: false,
		fields: FIELDS,
		cause: {
			name: "Error",
			message: "session closed",
			cause: { name: "IntercomDisconnectError", message: "socket reset" },
		},
	});
	const wire = readSerializedIntercomRecipientGoneError(JSON.parse(JSON.stringify(serialized)));
	assert.deepEqual(wire, serialized);
	const rehydrated = rehydrateIntercomRecipientGoneError(serialized);
	assert.ok(rehydrated instanceof SubagentRecipientEndedError);
	assert.equal(rehydrated.message, original.message);
	assert.deepEqual(rehydrated.fields, FIELDS);
	assert.ok(rehydrated.cause instanceof Error);
	assert.equal(rehydrated.cause.message, "session closed");
	assert.ok(rehydrated.cause.cause instanceof Error);
	assert.equal(rehydrated.cause.cause.name, "IntercomDisconnectError");

	const disconnected = rehydrateIntercomRecipientGoneError(
		serializeIntercomRecipientGoneError(new SubagentRecipientDisconnectedError({ target: "t", childName: "c" })),
	);
	assert.ok(disconnected instanceof SubagentRecipientDisconnectedError);
	assert.equal(disconnected.cause, undefined);
	assert.deepEqual(disconnected.fields, { target: "t", childName: "c" });
	assert.equal("cause" in serializeIntercomRecipientGoneError(new SubagentRecipientDisconnectedError(FIELDS)), false);

	const base = rehydrateIntercomRecipientGoneError({ ...serialized, name: "IntercomRecipientGoneError" });
	assert.equal(base.constructor, IntercomRecipientGoneError);
	assert.equal(base.name, "IntercomRecipientGoneError");
	const unknown = rehydrateIntercomRecipientGoneError({ ...serialized, name: "RecipientGoneFromANewerBroker" });
	assert.equal(unknown.constructor, IntercomRecipientGoneError);
	assert.equal(unknown.name, "RecipientGoneFromANewerBroker");
	assert.equal(unknown.code, "recipient_completed");
	const mismatched = rehydrateIntercomRecipientGoneError({ ...serialized, code: "recipient_disconnected" });
	assert.equal(
		mismatched.constructor,
		IntercomRecipientGoneError,
		"an ended class never carries the disconnected code",
	);
	assert.equal(mismatched.name, "SubagentRecipientEndedError");
	const disconnectedEnded = rehydrateIntercomRecipientGoneError({
		...serialized,
		name: "SubagentRecipientDisconnectedError",
	});
	assert.equal(disconnectedEnded.constructor, IntercomRecipientGoneError);
	assert.equal(disconnectedEnded.retryable, false);
	const suspended = serializeIntercomRecipientGoneError(new SubagentRecipientOwnerSuspendedError(FIELDS));
	assert.ok(rehydrateIntercomRecipientGoneError(suspended) instanceof SubagentRecipientOwnerSuspendedError);
	const suspendedAsEnded = rehydrateIntercomRecipientGoneError({ ...suspended, name: "SubagentRecipientEndedError" });
	assert.equal(suspendedAsEnded.constructor, IntercomRecipientGoneError, "an ended class never carries this code");
	assert.equal(suspendedAsEnded.retryable, true);
	const endedAsSuspended = rehydrateIntercomRecipientGoneError({
		...serialized,
		name: "SubagentRecipientOwnerSuspendedError",
	});
	assert.equal(endedAsSuspended.constructor, IntercomRecipientGoneError);
});

test("a malformed serialized refusal on the wire is rejected (#4639)", () => {
	const valid = serializeIntercomRecipientGoneError(new SubagentRecipientEndedError("recipient_stopped", FIELDS));
	const wire = JSON.parse(JSON.stringify(valid));
	assert.deepEqual(readSerializedIntercomRecipientGoneError(wire), valid);
	const noChildId = { ...wire, fields: { target: "t", childName: "c" } };
	assert.deepEqual(readSerializedIntercomRecipientGoneError(noChildId)?.fields, { target: "t", childName: "c" });
	for (const [label, value] of [
		["absent", undefined],
		["null", null],
		["array", [wire]],
		["string", "recipient_completed"],
		["unknown code", { ...wire, code: "recipient_parked" }],
		["numeric code", { ...wire, code: 1 }],
		["numeric name", { ...wire, name: 1 }],
		["missing message", { ...wire, message: undefined }],
		["numeric hint", { ...wire, hint: 2 }],
		["string retryable", { ...wire, retryable: "false" }],
		["missing fields", { ...wire, fields: null }],
		["array fields", { ...wire, fields: [] }],
		["missing target", { ...wire, fields: { ...wire.fields, target: undefined } }],
		["numeric child", { ...wire, fields: { ...wire.fields, childName: 3 } }],
		["numeric child id", { ...wire, fields: { ...wire.fields, childId: 3 } }],
		["bad cause", { ...wire, cause: "boom" }],
		["cause without message", { ...wire, cause: { name: "Error" } }],
		["cause without name", { ...wire, cause: { message: "m" } }],
		["bad nested cause", { ...wire, cause: { name: "Error", message: "m", cause: 4 } }],
	] as const) {
		assert.equal(readSerializedIntercomRecipientGoneError(value as never), undefined, label);
	}
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
	const depthOf = (value: { cause?: object } | undefined): number =>
		value === undefined ? 0 : 1 + depthOf(value.cause);
	assert.equal(depthOf(readSerializedIntercomRecipientGoneError({ ...wire, cause: deep })?.cause), 4);
	assert.equal(
		depthOf(
			readSerializedIntercomRecipientGoneError({
				...wire,
				cause: {
					...deep,
					cause: { ...deep.cause, cause: { ...deep.cause.cause, cause: { ...deep.cause.cause.cause, cause: 5 } } },
				},
			})?.cause,
		),
		4,
		"a malformed level past the fourth is never read",
	);
});
