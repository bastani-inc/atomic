import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import { IntercomClient } from "../../packages/intercom/broker/client.js";
import { isSessionRegistration } from "../../packages/intercom/broker/client-message-validation.js";
import type { JsonWireValue } from "../../packages/intercom/broker/framing.js";
import {
	HOSTED_SESSION_ERROR_CODES,
	HostedSessionRequestError,
	hostedSessionErrorFor,
	IntercomHostedSessionError,
	isHostedSessionErrorCode,
	isHostedSessionRequestError,
	isIntercomHostedSessionError,
	isNotHostedSessionError,
	NotHostedSessionError,
	readHostedSessionRefusal,
	readSerializedIntercomHostedSessionError,
	rehydrateIntercomHostedSessionError,
	serializeIntercomHostedSessionError,
} from "../../packages/intercom/broker/hosted-session-errors.js";
import {
	HOSTED_SESSION_FRAME_MAX,
	readHostedSessionAssignments,
	validateHostSessionsFrame,
	validateUnhostSessionsFrame,
} from "../../packages/intercom/broker/hosted-sessions.js";
import {
	ReleasedReplyAnsweredError,
	serializeIntercomReleasedReplyError,
} from "../../packages/intercom/broker/released-reply-errors.js";
import {
	IntercomHostedSessionTimeoutError,
	isIntercomHostedSessionTimeoutError,
} from "../../packages/intercom/hosted-session-timeout-error.js";
import * as intercom from "../../packages/intercom/index.js";
import { IntercomBrokerTimeoutError } from "../../packages/intercom/recoverable-disconnect.js";

const session = {
	name: "subagent-chat-1",
	cwd: "/repo",
	model: "m",
	pid: 1,
	startedAt: 1,
	lastActivity: 1,
	status: "closed · reply: post-mortem only",
	groups: ["workflow:run"],
	group: "workflow:run",
};

const liveRoute = { runId: "run", stageKeys: ["stage-1", "reviewer"], capability: "secret" };

const refused = (code: string, key?: string) => ({
	ok: false,
	refusal: key === undefined ? { code } : { code, key },
});

describe("host_sessions frames (#4642)", () => {
	test("parses valid items, keeping return addresses and live routes", () => {
		const frame: JsonWireValue = [
			{ key: "a", session, returnAddress: "s1:released-stage", liveRoute },
			{ key: "b", session: { ...session, name: "subagent-chat-2" } },
		];
		assert.deepEqual(validateHostSessionsFrame(frame), {
			ok: true,
			sessions: [
				{ key: "a", session, returnAddress: "s1:released-stage", liveRoute },
				{ key: "b", session: { ...session, name: "subagent-chat-2" } },
			],
		});
	});

	test("accepts up to 500 items and refuses an empty, oversized or non-array frame", () => {
		const items = (count: number) => Array.from({ length: count }, (_, index) => ({ key: `k${index}`, session }));
		assert.equal(validateHostSessionsFrame(items(HOSTED_SESSION_FRAME_MAX)).ok, true);
		assert.deepEqual(validateHostSessionsFrame(items(HOSTED_SESSION_FRAME_MAX + 1)), refused("invalid_hosted_frame"));
		assert.deepEqual(validateHostSessionsFrame([]), refused("invalid_hosted_frame"));
		assert.deepEqual(validateHostSessionsFrame(undefined), refused("invalid_hosted_frame"));
		assert.deepEqual(validateHostSessionsFrame({ key: "a", session }), refused("invalid_hosted_frame"));
	});

	test("refuses an item without a distinct non-empty key as a malformed frame", () => {
		assert.deepEqual(
			validateHostSessionsFrame([
				{ key: "a", session },
				{ key: "a", session },
			]),
			refused("invalid_hosted_frame", "a"),
		);
		assert.deepEqual(validateHostSessionsFrame([{ key: " ", session }]), refused("invalid_hosted_frame", " "));
		assert.deepEqual(validateHostSessionsFrame([{ key: 7, session }]), refused("invalid_hosted_frame"));
		assert.deepEqual(validateHostSessionsFrame([null]), refused("invalid_hosted_frame"));
		assert.deepEqual(validateHostSessionsFrame([["a"]]), refused("invalid_hosted_frame"));
	});

	test("refuses a session that is unnamed, a control connection or not a registration, naming its key", () => {
		const { name: _name, ...nameless } = session;
		for (const invalid of [
			nameless,
			{ ...session, name: "  " },
			{ ...session, recipientPurpose: "control" },
			{ ...session, pid: "1" },
			{ ...session, groups: "workflow:run" },
			"session",
		]) {
			assert.deepEqual(
				validateHostSessionsFrame([{ key: "a", session: invalid }]),
				refused("invalid_hosted_session", "a"),
			);
		}
		assert.equal(
			validateHostSessionsFrame([{ key: "a", session: { ...session, recipientPurpose: "agent" } }]).ok,
			true,
		);
	});

	test("refuses a blank return address and a malformed live route, naming the item's key", () => {
		const invalidRoutes: JsonWireValue[] = [
			"route",
			{ ...liveRoute, runId: "" },
			{ ...liveRoute, capability: " " },
			{ ...liveRoute, stageKeys: [] },
			{ ...liveRoute, stageKeys: ["a", "b", "c"] },
			{ ...liveRoute, stageKeys: ["a", ""] },
			{ ...liveRoute, stageKeys: "a" },
		];
		for (const route of invalidRoutes) {
			assert.deepEqual(
				validateHostSessionsFrame([{ key: "a", session, liveRoute: route }]),
				refused("invalid_hosted_session", "a"),
			);
		}
		assert.deepEqual(
			validateHostSessionsFrame([{ key: "a", session, returnAddress: "" }]),
			refused("invalid_hosted_session", "a"),
		);
		assert.deepEqual(
			validateHostSessionsFrame([{ key: "a", session, liveRoute: { ...liveRoute, stageKeys: ["a"] } }]),
			{
				ok: true,
				sessions: [{ key: "a", session, liveRoute: { ...liveRoute, stageKeys: ["a"] } }],
			},
		);
	});

	test("unhost_sessions takes 1 to 500 non-empty session ids", () => {
		assert.deepEqual(validateUnhostSessionsFrame(["s1", "s2"]), { ok: true, sessionIds: ["s1", "s2"] });
		const ids = (count: number) => Array.from({ length: count }, (_, index) => `s${index}`);
		assert.equal(validateUnhostSessionsFrame(ids(HOSTED_SESSION_FRAME_MAX)).ok, true);
		for (const invalid of [ids(HOSTED_SESSION_FRAME_MAX + 1), [], undefined, ["s1", ""], ["s1", 2], "s1"]) {
			assert.deepEqual(validateUnhostSessionsFrame(invalid as JsonWireValue), refused("invalid_hosted_frame"));
		}
	});

	test("reads the broker's assignments and refuses a malformed answer", () => {
		assert.deepEqual(
			readHostedSessionAssignments([
				{ key: "a", sessionId: "s1" },
				{ key: "b", sessionId: "s2", liveRouteRefusal: "owner_missing" },
			]),
			[
				{ key: "a", sessionId: "s1" },
				{ key: "b", sessionId: "s2", liveRouteRefusal: "owner_missing" },
			],
		);
		assert.deepEqual(readHostedSessionAssignments([]), []);
		for (const invalid of [
			undefined,
			{ key: "a", sessionId: "s1" },
			[null],
			[{ key: 1, sessionId: "s1" }],
			[{ key: "a", sessionId: "" }],
			[{ key: "a", sessionId: "s1", liveRouteRefusal: "nope" }],
		]) {
			assert.equal(readHostedSessionAssignments(invalid as JsonWireValue), undefined, JSON.stringify(invalid));
		}
	});
});

describe("hosted-session errors (#4642)", () => {
	test("each refusal code becomes its typed error, with fields, hint and no retry", () => {
		assert.deepEqual(HOSTED_SESSION_ERROR_CODES, [
			"invalid_hosted_frame",
			"invalid_hosted_session",
			"not_hosted_by_connection",
		]);
		const notHosted = hostedSessionErrorFor({ code: "not_hosted_by_connection", sessionId: "s1" });
		assert.ok(notHosted instanceof NotHostedSessionError);
		assert.ok(notHosted instanceof IntercomHostedSessionError);
		assert.equal(notHosted.name, "NotHostedSessionError");
		assert.equal(notHosted.code, "not_hosted_by_connection");
		assert.equal(notHosted.sessionId, "s1");
		assert.equal(notHosted.key, undefined);
		assert.equal(notHosted.retryable, false);
		assert.match(notHosted.hint, /connection that hosts/);
		for (const code of ["invalid_hosted_frame", "invalid_hosted_session"] as const) {
			const error = hostedSessionErrorFor({ code, key: "k" });
			assert.ok(error instanceof HostedSessionRequestError);
			assert.equal(error.name, "HostedSessionRequestError");
			assert.equal(error.code, code);
			assert.equal(error.key, "k");
			assert.equal(error.sessionId, undefined);
			assert.equal(error.retryable, false);
			assert.notEqual(error.hint, notHosted.hint);
		}
	});

	test("its message names the item, the code and what to do", () => {
		assert.equal(
			new NotHostedSessionError({ sessionId: "s1" }).message,
			'Hosted-session request refused: session "s1" (not_hosted_by_connection). Only the connection that hosts a session may send as it or remove it; host the session again after a reconnect.',
		);
		assert.match(
			new HostedSessionRequestError("invalid_hosted_frame").message,
			/^Hosted-session request refused: request \(invalid_hosted_frame\)\./,
		);
		assert.match(new HostedSessionRequestError("invalid_hosted_session", { key: "k" }).message, /hosted session "k"/);
	});

	test("guards match the class, and a plain error carrying its name and code", () => {
		const structural = Object.assign(new Error("x"), {
			name: "NotHostedSessionError",
			code: "not_hosted_by_connection",
		});
		assert.equal(isNotHostedSessionError(structural), true);
		assert.equal(isIntercomHostedSessionError(structural), true);
		assert.equal(isHostedSessionRequestError(structural), false);
		const request = Object.assign(new Error("x"), {
			name: "HostedSessionRequestError",
			code: "invalid_hosted_frame",
		});
		assert.equal(isHostedSessionRequestError(request), true);
		assert.equal(isNotHostedSessionError(request), false);
		assert.equal(
			isIntercomHostedSessionError(Object.assign(new Error("x"), { name: "NotHostedSessionError", code: "other" })),
			false,
		);
		assert.equal(
			isIntercomHostedSessionError(Object.assign(new Error("x"), { name: "Other", code: "invalid_hosted_frame" })),
			false,
		);
		assert.equal(isIntercomHostedSessionError(new HostedSessionRequestError("invalid_hosted_frame")), true);
		assert.equal(isHostedSessionErrorCode("invalid_hosted_frame"), true);
		assert.equal(isHostedSessionErrorCode("not_owner"), false);
	});

	test("a refusal survives the wire: serialized, read back and rehydrated into the same class with its cause", () => {
		const original = new NotHostedSessionError({ sessionId: "s1" }, { cause: new Error("socket gone") });
		const wire: JsonWireValue = JSON.parse(JSON.stringify(serializeIntercomHostedSessionError(original)));
		const read = readSerializedIntercomHostedSessionError(wire);
		assert.ok(read !== undefined);
		const rehydrated = rehydrateIntercomHostedSessionError(read);
		assert.ok(rehydrated instanceof NotHostedSessionError);
		assert.equal(rehydrated.code, "not_hosted_by_connection");
		assert.equal(rehydrated.sessionId, "s1");
		assert.equal(rehydrated.message, original.message);
		assert.ok(rehydrated.cause instanceof Error);
		assert.equal(rehydrated.cause.message, "socket gone");

		const request = rehydrateIntercomHostedSessionError(
			serializeIntercomHostedSessionError(new HostedSessionRequestError("invalid_hosted_session", { key: "k" })),
		);
		assert.ok(request instanceof HostedSessionRequestError);
		assert.equal(request.key, "k");
		assert.equal(request.cause, undefined);

		const unknown = rehydrateIntercomHostedSessionError({
			...serializeIntercomHostedSessionError(new HostedSessionRequestError("invalid_hosted_frame")),
			name: "FutureHostedSessionError",
		});
		assert.equal(unknown.constructor, IntercomHostedSessionError);
		assert.equal(unknown.name, "FutureHostedSessionError");
		assert.equal(unknown.code, "invalid_hosted_frame");
	});

	test("malformed serialized errors and refusals are not read", () => {
		const valid = serializeIntercomHostedSessionError(new NotHostedSessionError({ sessionId: "s1" }));
		for (const invalid of [
			undefined,
			"error",
			{ ...valid, code: "not_owner" },
			{ ...valid, retryable: true },
			{ ...valid, hint: 1 },
			{ ...valid, message: undefined },
			{ ...valid, fields: { sessionId: 1 } },
			{ ...valid, fields: "s1" },
			{ ...valid, cause: { name: "Error" } },
		]) {
			assert.equal(
				readSerializedIntercomHostedSessionError(invalid as JsonWireValue),
				undefined,
				JSON.stringify(invalid),
			);
		}
		assert.deepEqual(readHostedSessionRefusal({ code: "invalid_hosted_session", key: "k" }), {
			code: "invalid_hosted_session",
			key: "k",
		});
		const invalidRefusals: (JsonWireValue | undefined)[] = [
			undefined,
			{ code: "nope" },
			{ code: "invalid_hosted_frame", key: 1 },
			{ code: "invalid_hosted_frame", sessionId: 1 },
		];
		for (const invalid of invalidRefusals) assert.equal(readHostedSessionRefusal(invalid), undefined);
	});

	test("the errors and their guards are exported from @bastani/intercom", () => {
		assert.equal(intercom.NotHostedSessionError, NotHostedSessionError);
		assert.equal(intercom.HostedSessionRequestError, HostedSessionRequestError);
		assert.equal(intercom.IntercomHostedSessionError, IntercomHostedSessionError);
		assert.equal(intercom.isIntercomHostedSessionError, isIntercomHostedSessionError);
		assert.equal(intercom.isNotHostedSessionError, isNotHostedSessionError);
		assert.equal(intercom.isHostedSessionRequestError, isHostedSessionRequestError);
		assert.equal(intercom.rehydrateIntercomHostedSessionError, rehydrateIntercomHostedSessionError);
		assert.equal(intercom.serializeIntercomHostedSessionError, serializeIntercomHostedSessionError);
	});
});

/** A chain of `depth` causes, the outermost first. */
function causeChain(depth: number): Error {
	let cause: Error | undefined;
	for (let level = depth; level >= 1; level--)
		cause = new Error(`level ${level}`, cause === undefined ? {} : { cause });
	return cause!;
}

function causeDepth(cause: { readonly cause?: object } | undefined): number {
	let depth = 0;
	for (let current = cause; current !== undefined; current = current.cause as { cause?: object } | undefined) depth++;
	return depth;
}

describe("hosted-session errors on the wire (#4642)", () => {
	test("each code has its own hint, which ends the message", () => {
		const errors = HOSTED_SESSION_ERROR_CODES.map((code) => hostedSessionErrorFor({ code }));
		assert.equal(new Set(errors.map((error) => error.hint)).size, HOSTED_SESSION_ERROR_CODES.length);
		for (const error of errors) {
			assert.ok(error.hint.length > 0);
			assert.ok(error.message.endsWith(error.hint));
		}
	});

	test("the family base keeps its own name, and a plain error with it is one of the family", () => {
		const base = new IntercomHostedSessionError("invalid_hosted_frame");
		assert.equal(base.name, "IntercomHostedSessionError");
		const structural = Object.assign(new Error("x"), {
			name: "IntercomHostedSessionError",
			code: "invalid_hosted_frame",
		});
		assert.equal(isIntercomHostedSessionError(structural), true);
		const rehydrated = rehydrateIntercomHostedSessionError(serializeIntercomHostedSessionError(base));
		assert.equal(rehydrated.constructor, IntercomHostedSessionError);
		assert.equal(rehydrated.name, "IntercomHostedSessionError");
	});

	test("a serialized error carries only the fields it has and reads back exactly as sent", () => {
		assert.deepEqual(serializeIntercomHostedSessionError(new NotHostedSessionError({ sessionId: "s1" })).fields, {
			sessionId: "s1",
		});
		assert.deepEqual(
			serializeIntercomHostedSessionError(new HostedSessionRequestError("invalid_hosted_session", { key: "k" }))
				.fields,
			{ key: "k" },
		);
		for (const error of [
			new NotHostedSessionError({ sessionId: "s1" }),
			new HostedSessionRequestError("invalid_hosted_session", { key: "k" }),
			new HostedSessionRequestError("invalid_hosted_frame"),
			new NotHostedSessionError({ sessionId: "s2" }, { cause: causeChain(2) }),
		]) {
			const wire: JsonWireValue = JSON.parse(JSON.stringify(serializeIntercomHostedSessionError(error)));
			assert.deepEqual(readSerializedIntercomHostedSessionError(wire), wire);
		}
	});

	test("a cause is read four levels deep at most, and a malformed one anywhere in them refuses the error", () => {
		const valid: { [key: string]: JsonWireValue } = JSON.parse(
			JSON.stringify(serializeIntercomHostedSessionError(new NotHostedSessionError({ sessionId: "s1" }))),
		);
		const nested = (depth: number, innermost: JsonWireValue = { name: "Error", message: `level ${depth}` }) => {
			let cause: JsonWireValue = innermost;
			for (let level = depth - 1; level >= 1; level--) cause = { name: "Error", message: `level ${level}`, cause };
			return cause;
		};
		assert.equal(causeDepth(readSerializedIntercomHostedSessionError({ ...valid, cause: nested(2) })?.cause), 2);
		assert.equal(causeDepth(readSerializedIntercomHostedSessionError({ ...valid, cause: nested(6) })?.cause), 4);
		assert.equal(
			causeDepth(readSerializedIntercomHostedSessionError({ ...valid, cause: nested(5, { name: 1 }) })?.cause),
			4,
			"a malformed cause below the fourth level is never read",
		);
		for (const malformed of [nested(2, { name: 1, message: "m" }), nested(3, null), nested(2, { message: "m" })]) {
			assert.equal(readSerializedIntercomHostedSessionError({ ...valid, cause: malformed }), undefined);
		}
	});

	test("a serialized error or refusal that is not one is not read", () => {
		const valid = serializeIntercomHostedSessionError(new NotHostedSessionError({ sessionId: "s1" }));
		for (const invalid of [null, [], { ...valid, name: 1 }, { ...valid, fields: [] }, { ...valid, cause: null }]) {
			assert.equal(
				readSerializedIntercomHostedSessionError(invalid as JsonWireValue),
				undefined,
				JSON.stringify(invalid),
			);
		}
		assert.equal(readHostedSessionRefusal(null), undefined);
		assert.equal(readHostedSessionRefusal([]), undefined);
		assert.deepEqual(readHostedSessionRefusal({ code: "not_hosted_by_connection", sessionId: "s1" }), {
			code: "not_hosted_by_connection",
			sessionId: "s1",
		});
		assert.deepEqual(readHostedSessionRefusal({ code: "invalid_hosted_frame" }), { code: "invalid_hosted_frame" });
	});

	test("a live route that is not an object refuses its item", () => {
		for (const liveRoute of [null, "route", ["run", ["stage"], "cap"]]) {
			assert.deepEqual(
				validateHostSessionsFrame([{ key: "a", session, liveRoute }] as JsonWireValue),
				refused("invalid_hosted_session", "a"),
				JSON.stringify(liveRoute),
			);
		}
	});
});

describe("a hosted session's registration is checked as a register frame's (#4642)", () => {
	const registration = { cwd: "/repo", model: "m", pid: 1, startedAt: 1, lastActivity: 1 };

	test("a registration with every optional field valid is accepted", () => {
		assert.equal(isSessionRegistration(registration), true);
		assert.equal(
			isSessionRegistration({
				...registration,
				name: "n",
				group: "g",
				groups: ["g", "h"],
				status: "idle",
				replyCapability: "terminal",
				recipientPurpose: "agent",
			}),
			true,
		);
		for (const field of [{ replyCapability: "live" }, { recipientPurpose: "control" }, { groups: [] }] as const) {
			assert.equal(isSessionRegistration({ ...registration, ...field }), true, JSON.stringify(field));
		}
	});

	test("anything that is not an object, or lacks a required field, is refused", () => {
		const arrayWithFields = Object.assign([], registration);
		for (const value of [null, undefined, "session", 7, arrayWithFields]) {
			assert.equal(isSessionRegistration(value), false, String(value));
		}
		for (const field of ["cwd", "model", "pid", "startedAt", "lastActivity"] as const) {
			const { [field]: _left, ...rest } = registration;
			assert.equal(isSessionRegistration(rest), false, `without ${field}`);
			assert.equal(isSessionRegistration({ ...registration, [field]: true }), false, `${field} of the wrong type`);
		}
	});

	test("an optional field of the wrong kind is refused", () => {
		for (const field of [
			{ name: 1 },
			{ group: 1 },
			{ replyCapability: "always" },
			{ recipientPurpose: "observer" },
			{ groups: "g" },
			{ groups: [1] },
			{ groups: ["g", 1] },
			{ status: 1 },
		]) {
			assert.equal(isSessionRegistration({ ...registration, ...field }), false, JSON.stringify(field));
		}
	});
});

interface WrittenFrame {
	readonly type: string;
	readonly requestId: string;
	readonly sessions?: readonly { readonly key: string }[];
	readonly sessionIds?: readonly string[];
	readonly hostedSender?: string;
}

interface ClientInternals {
	_sessionId: string;
	_brokerProtocol: { min: number; max: number };
	socket: { destroyed: boolean; writableEnded: boolean; writable: boolean; write(data: Buffer): boolean };
	handleBrokerMessage(message: JsonWireValue): void;
}

/** A client registered with a broker of `protocol` whose frames are recorded and answered by `answer`. */
function hostingClient(
	protocol: { min: number; max: number },
	answer?: (frame: WrittenFrame) => JsonWireValue | undefined,
): { client: IntercomClient; internals: ClientInternals; frames: WrittenFrame[] } {
	const client = new IntercomClient();
	const internals = client as unknown as ClientInternals;
	const frames: WrittenFrame[] = [];
	internals._sessionId = "host";
	internals._brokerProtocol = protocol;
	internals.socket = {
		destroyed: false,
		writableEnded: false,
		writable: true,
		write(data) {
			const frame = JSON.parse(data.subarray(4).toString("utf-8")) as WrittenFrame;
			frames.push(frame);
			const reply = answer?.(frame);
			if (reply !== undefined) queueMicrotask(() => internals.handleBrokerMessage(reply));
			return true;
		},
	};
	return { client, internals, frames };
}

const assignAll = (frame: WrittenFrame): JsonWireValue => ({
	type: "hosted_sessions_ack",
	requestId: frame.requestId,
	sessions: (frame.sessions ?? []).map((item) => ({ key: item.key, sessionId: `id-${item.key}` })),
});

const items = (count: number) => Array.from({ length: count }, (_, index) => ({ key: `k${index}`, session }));

describe("hosting sessions through the client (#4642)", () => {
	test("a broker older than protocol 3 is refused before anything is sent", async () => {
		const { client, frames } = hostingClient({ min: 1, max: 2 }, assignAll);
		for (const request of [() => client.hostSessions(items(1)), () => client.unhostSessions(["id-k0"])]) {
			await assert.rejects(request(), (error: Error) => {
				assert.equal(error.name, "IntercomBrokerProtocolError");
				assert.equal((error as Error & { requiredProtocol: number }).requiredProtocol, 3);
				assert.equal((error as Error & { brokerProtocolMax: number }).brokerProtocolMax, 2);
				return true;
			});
		}
		assert.deepEqual(frames, []);
	});

	test("hosts 501 sessions in frames of 500 and 1 and returns every broker id in order", async () => {
		const { client, frames } = hostingClient({ min: 1, max: 3 }, assignAll);
		const assigned = await client.hostSessions(items(HOSTED_SESSION_FRAME_MAX + 1));
		assert.deepEqual(
			frames.map((frame) => [frame.type, frame.sessions?.length]),
			[
				["host_sessions", HOSTED_SESSION_FRAME_MAX],
				["host_sessions", 1],
			],
		);
		assert.equal(assigned.length, HOSTED_SESSION_FRAME_MAX + 1);
		assert.deepEqual(assigned.at(-1), {
			key: `k${HOSTED_SESSION_FRAME_MAX}`,
			sessionId: `id-k${HOSTED_SESSION_FRAME_MAX}`,
		});
	});

	test("an invalid item in any frame sends nothing, and an empty removal is refused", async () => {
		const { client, frames } = hostingClient({ min: 1, max: 3 }, assignAll);
		const invalid = [...items(HOSTED_SESSION_FRAME_MAX), { key: "late", session: { ...session, name: "" } }];
		await assert.rejects(client.hostSessions(invalid), (error: Error) => {
			assert.ok(isHostedSessionRequestError(error));
			assert.equal(error.code, "invalid_hosted_session");
			assert.equal(error.key, "late");
			return true;
		});
		await assert.rejects(client.unhostSessions([]), (error: Error) => {
			assert.ok(error instanceof HostedSessionRequestError);
			assert.equal(error.code, "invalid_hosted_frame");
			return true;
		});
		assert.deepEqual(frames, []);
	});

	test("a broker refusal rejects with its typed error, and removals go out in frames of 500", async () => {
		const { client, frames } = hostingClient(
			{ min: 1, max: 3 },
			(frame): JsonWireValue =>
				frame.sessionIds?.includes("foreign") === true
					? {
							type: "hosted_sessions_ack",
							requestId: frame.requestId,
							refusal: { code: "not_hosted_by_connection", sessionId: "foreign" },
						}
					: { type: "hosted_sessions_ack", requestId: frame.requestId },
		);
		const ids = Array.from({ length: HOSTED_SESSION_FRAME_MAX + 2 }, (_, index) => `id-${index}`);
		await client.unhostSessions(ids);
		assert.deepEqual(
			frames.map((frame) => frame.sessionIds?.length),
			[HOSTED_SESSION_FRAME_MAX, 2],
		);
		await assert.rejects(client.unhostSessions(["foreign"]), (error: Error) => {
			assert.ok(error instanceof NotHostedSessionError);
			assert.equal(error.sessionId, "foreign");
			return true;
		});
	});

	test("a message for a hosted session is emitted as hosted_message, never as the host's own message", () => {
		const { client, internals } = hostingClient({ min: 1, max: 3 });
		const own: string[] = [];
		const hosted: string[] = [];
		client.on("message", (_from: { id: string }, message: { content: { text: string } }) =>
			own.push(message.content.text),
		);
		client.on("hosted_message", (recipient: string, _from: { id: string }, message: { content: { text: string } }) =>
			hosted.push(`${recipient}:${message.content.text}`),
		);
		const from = { id: "asker", cwd: "/", model: "m", pid: 1, startedAt: 1, lastActivity: 1 };
		const message = (text: string) => ({ id: text, timestamp: 1, content: { text } });
		internals.handleBrokerMessage({ type: "message", from, message: message("for-host") });
		internals.handleBrokerMessage({
			type: "message",
			from,
			message: message("for-stage"),
			hostedRecipient: "stage-1",
		});
		assert.deepEqual(own, ["for-host"]);
		assert.deepEqual(hosted, ["stage-1:for-stage"]);
		assert.throws(
			() => internals.handleBrokerMessage({ type: "message", from, message: message("x"), hostedRecipient: 7 }),
			/Invalid message event/,
		);
	});

	test("a send as a hosted session names it in the frame", async () => {
		const { client, frames } = hostingClient({ min: 1, max: 3 }, (frame) => ({
			type: "delivered",
			messageId: (frame as WrittenFrame & { message: { id: string } }).message.id,
			attemptId: (frame as WrittenFrame & { attemptId: string }).attemptId,
		}));
		const sent = await client.send("asker", { text: "answer", hostedSender: "stage-1" });
		assert.equal(sent.delivered, true);
		assert.equal(frames[0]?.hostedSender, "stage-1");
		await client.send("asker", { text: "own" });
		assert.equal(Object.hasOwn(frames[1]!, "hostedSender"), false);
	});

	test("a malformed hosted_sessions_ack is a protocol error", () => {
		const { internals } = hostingClient({ min: 1, max: 3 });
		const malformed: JsonWireValue[] = [
			{ type: "hosted_sessions_ack" },
			{ type: "hosted_sessions_ack", requestId: "r", refusal: { code: "nope" } },
			{ type: "hosted_sessions_ack", requestId: "r", sessions: [{ key: "a" }] },
		];
		for (const ack of malformed) {
			assert.throws(() => internals.handleBrokerMessage(ack), /Invalid hosted_sessions_ack message/);
		}
	});
});

interface PendingInternals {
	readonly pendingHostedSessionRequests: Map<string, object>;
	failPending(error: Error): void;
}

const pendingOf = (client: IntercomClient): PendingInternals => client as unknown as PendingInternals;

describe("hosted-session requests settle once and leave nothing behind (#4642)", () => {
	test("a client that never registered fails as not connected, before any protocol check", async () => {
		const client = new IntercomClient();
		for (const request of [() => client.hostSessions(items(1)), () => client.unhostSessions(["id-k0"])]) {
			await assert.rejects(request(), (error: Error) => {
				assert.notEqual(error.name, "IntercomBrokerProtocolError");
				assert.equal(error.message, "Not connected");
				return true;
			});
		}
	});

	test("a broker too old for hosting names the refused request", async () => {
		const { client } = hostingClient({ min: 1, max: 2 });
		for (const [feature, request] of [
			["host_sessions", () => client.hostSessions(items(1))],
			["unhost_sessions", () => client.unhostSessions(["id-k0"])],
		] as const) {
			await assert.rejects(request(), (error: Error & { feature?: string }) => error.feature === feature);
		}
	});

	test("exactly one frame's worth of sessions, or of removals, goes out as one frame", async () => {
		const { client, frames } = hostingClient({ min: 1, max: 3 }, (frame) =>
			frame.type === "host_sessions"
				? assignAll(frame)
				: { type: "hosted_sessions_ack", requestId: frame.requestId },
		);
		assert.equal((await client.hostSessions(items(HOSTED_SESSION_FRAME_MAX))).length, HOSTED_SESSION_FRAME_MAX);
		await client.unhostSessions(Array.from({ length: HOSTED_SESSION_FRAME_MAX }, (_, index) => `id-k${index}`));
		assert.deepEqual(
			frames.map((frame) => [frame.type, frame.sessions?.length ?? frame.sessionIds?.length]),
			[
				["host_sessions", HOSTED_SESSION_FRAME_MAX],
				["unhost_sessions", HOSTED_SESSION_FRAME_MAX],
			],
		);
	});

	test("an ack that assigns nothing resolves with no assignments, and one for no request is ignored", async () => {
		const { client, internals } = hostingClient({ min: 1, max: 3 }, (frame) => ({
			type: "hosted_sessions_ack",
			requestId: frame.requestId,
		}));
		assert.deepEqual(await client.hostSessions(items(1)), []);
		assert.doesNotThrow(() =>
			internals.handleBrokerMessage({ type: "hosted_sessions_ack", requestId: "unknown", sessions: [] }),
		);
		assert.equal(pendingOf(client).pendingHostedSessionRequests.size, 0);
	});

	test("an answered or refused request clears its timer and its pending entry", async () => {
		vi.useFakeTimers();
		try {
			const { client } = hostingClient({ min: 1, max: 3 }, (frame) =>
				frame.type === "host_sessions"
					? assignAll(frame)
					: {
							type: "hosted_sessions_ack",
							requestId: frame.requestId,
							refusal: { code: "not_hosted_by_connection", sessionId: "foreign" },
						},
			);
			await client.hostSessions(items(1));
			assert.equal(vi.getTimerCount(), 0);
			await assert.rejects(client.unhostSessions(["foreign"]), NotHostedSessionError);
			assert.equal(vi.getTimerCount(), 0);
			assert.equal(pendingOf(client).pendingHostedSessionRequests.size, 0);
		} finally {
			vi.useRealTimers();
		}
	});

	test("a request whose frame cannot be written fails with that error and leaves nothing pending", async () => {
		vi.useFakeTimers();
		try {
			const { client, internals } = hostingClient({ min: 1, max: 3 });
			const broken = new Error("socket write failed");
			internals.socket.write = () => {
				throw broken;
			};
			await assert.rejects(client.hostSessions(items(1)), (error: Error) => error === broken);
			assert.equal(vi.getTimerCount(), 0);
			assert.equal(pendingOf(client).pendingHostedSessionRequests.size, 0);
		} finally {
			vi.useRealTimers();
		}
	});

	test("a request still pending when the connection fails is rejected with the connection's failure", async () => {
		const { client } = hostingClient({ min: 1, max: 3 });
		const hosting = client.hostSessions(items(1));
		const gone = new Error("connection closed");
		pendingOf(client).failPending(gone);
		await assert.rejects(hosting, (error: Error) => error === gone);
		assert.equal(pendingOf(client).pendingHostedSessionRequests.size, 0);
	});

	test("a request the broker never answers fails as a broker timeout and is no longer pending", async () => {
		vi.useFakeTimers();
		try {
			const { client, internals } = hostingClient({ min: 1, max: 3 });
			Object.assign(internals.socket, { destroy() {} });
			const hosting = assert.rejects(client.hostSessions(items(1)), (error: Error) => {
				assert.ok(error instanceof IntercomBrokerTimeoutError);
				assert.ok(isIntercomHostedSessionTimeoutError(error));
				assert.ok(error.cause instanceof IntercomBrokerTimeoutError, "the failed health check is its cause");
				assert.equal(error.requestType, "host_sessions");
				return true;
			});
			await vi.advanceTimersByTimeAsync(10_000);
			await hosting;
			assert.equal(pendingOf(client).pendingHostedSessionRequests.size, 0);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("messages and delivery failures of hosted sessions (#4642)", () => {
	const from = { id: "asker", cwd: "/", model: "m", pid: 1, startedAt: 1, lastActivity: 1 };
	const message = { id: "m1", timestamp: 1, content: { text: "hi" } };

	test("a supervisor message is delivered with its channel; a malformed sender, message or channel is refused", () => {
		const { client, internals } = hostingClient({ min: 1, max: 3 });
		const channels: (string | undefined)[] = [];
		client.on("message", (_from: object, _message: object, channel?: string) => channels.push(channel));
		internals.handleBrokerMessage({ type: "message", from, message, channel: "supervisor" });
		assert.deepEqual(channels, ["supervisor"]);
		for (const malformed of [
			{ type: "message", from: { id: "asker" }, message },
			{ type: "message", from, message: { id: "m1" } },
			{ type: "message", from, message, channel: "other" },
		]) {
			assert.throws(() => internals.handleBrokerMessage(malformed as JsonWireValue), /Invalid message event/);
		}
		assert.deepEqual(channels, ["supervisor"]);
	});

	function failingSends(error?: JsonWireValue, reasonCode?: string) {
		return hostingClient({ min: 1, max: 3 }, (frame) => {
			const sent = frame as WrittenFrame & { message: { id: string }; attemptId: string };
			return {
				type: "delivery_failed",
				messageId: sent.message.id,
				attemptId: sent.attemptId,
				reason: "refused",
				...(reasonCode === undefined ? {} : { reasonCode }),
				...(error === undefined ? {} : { error }),
			};
		});
	}

	test("a send refused for its hosted sender fails with NotHostedSessionError", async () => {
		const wire: JsonWireValue = JSON.parse(
			JSON.stringify(serializeIntercomHostedSessionError(new NotHostedSessionError({ sessionId: "stage-1" }))),
		);
		const { client } = failingSends(wire, "not_hosted_by_connection");
		const sent = await client.send("asker", { text: "answer", hostedSender: "stage-1" });
		assert.equal(sent.delivered, false);
		assert.equal(sent.reasonCode, "not_hosted_by_connection");
		assert.ok(sent.error instanceof NotHostedSessionError);
		assert.equal(sent.error.sessionId, "stage-1");
	});

	test("a released-subagent refusal still arrives as its own typed error, and a failure without one has none", async () => {
		const fields = { messageId: "m", questionId: "q", childName: "child" };
		const wire: JsonWireValue = JSON.parse(
			JSON.stringify(serializeIntercomReleasedReplyError(new ReleasedReplyAnsweredError(fields))),
		);
		const answered = await failingSends(wire, "released_reply_answered").client.send("asker", { text: "late" });
		assert.ok(answered.error instanceof ReleasedReplyAnsweredError);
		assert.equal(answered.error.questionId, "q");

		const plain = await failingSends().client.send("asker", { text: "x" });
		assert.equal(plain.delivered, false);
		assert.equal(Object.hasOwn(plain, "error"), false);
	});
});

describe("a hosting request the broker never answers (#4642)", () => {
	const HOSTED_SESSION_REQUEST_TIMEOUT_MS = 5_000;

	test("fails with the typed timeout naming the request, its size and its bound, and recovers like any broker timeout", async () => {
		vi.useFakeTimers();
		try {
			const healthy = (frame: WrittenFrame): JsonWireValue | undefined =>
				frame.type === "list_groups" ? { type: "groups", requestId: frame.requestId, groups: [] } : undefined;
			const { client } = hostingClient({ min: 1, max: 3 }, healthy);
			const hosting = client.hostSessions(items(3));
			const removing = client.unhostSessions(["a", "b"]);
			const failures = Promise.allSettled([hosting, removing]);
			await vi.advanceTimersByTimeAsync(HOSTED_SESSION_REQUEST_TIMEOUT_MS);
			const [hostFailure, removeFailure] = await failures;

			assert.equal(hostFailure.status, "rejected");
			assert.equal(removeFailure.status, "rejected");
			const error = (hostFailure as PromiseRejectedResult).reason as IntercomHostedSessionTimeoutError;
			assert.ok(error instanceof IntercomHostedSessionTimeoutError);
			assert.ok(error instanceof IntercomBrokerTimeoutError);
			assert.ok(isIntercomHostedSessionTimeoutError(error));
			assert.equal(error.name, "IntercomHostedSessionTimeoutError");
			assert.equal(error.code, "hosted_session_timeout");
			assert.equal(error.phase, "hosted-session-request");
			assert.equal(error.retryable, true);
			assert.equal(error.requestType, "host_sessions");
			assert.equal(error.sessionCount, 3);
			assert.equal(error.timeoutMs, HOSTED_SESSION_REQUEST_TIMEOUT_MS);
			assert.equal(error.elapsedMs, HOSTED_SESSION_REQUEST_TIMEOUT_MS);
			assert.match(
				error.message,
				/host_sessions for 3 sessions, unanswered after 5000 ms of 5000 ms \(hosted_session_timeout\)/,
			);
			assert.match(error.hint, /atomic intercom restart/);
			const removal = (removeFailure as PromiseRejectedResult).reason as IntercomHostedSessionTimeoutError;
			assert.equal(removal.requestType, "unhost_sessions");
			assert.equal(removal.sessionCount, 2);
		} finally {
			vi.useRealTimers();
		}
	});

	test("the timeout shape is exported from the package", () => {
		assert.equal(intercom.IntercomHostedSessionTimeoutError, IntercomHostedSessionTimeoutError);
		assert.equal(intercom.isIntercomHostedSessionTimeoutError, isIntercomHostedSessionTimeoutError);
	});
});
