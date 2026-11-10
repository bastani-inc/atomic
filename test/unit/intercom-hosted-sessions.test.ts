import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { IntercomClient } from "../../packages/intercom/broker/client.js";
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
import * as intercom from "../../packages/intercom/index.js";

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
