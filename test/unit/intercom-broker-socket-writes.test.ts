/**
 * Regression: the broker must not write to a socket whose writable side has
 * already ended, and it must never report such a skipped write as a delivery.
 *
 * `socket.write()` after `end()` throws nothing. It returns `false`, hands
 * `ERR_STREAM_WRITE_AFTER_END` to the write callback, destroys the socket
 * *synchronously*, and only then emits `'error'` — which is how a single
 * departing peer turned into a cascade of broker log noise and destroyed
 * sockets. A caller-side `try`/`catch` cannot see it, and a writability
 * snapshot taken anywhere but immediately before the write can go stale.
 *
 * These tests use real sockets on both sides, so they exercise Node's actual
 * stream semantics rather than a double that agrees with the fix. The first
 * group pins the guard itself, including a control that reproduces the raw
 * failure the guard prevents. The second group drives the production
 * `handleBrokerSend` entry point through the real `writeMessageIfOpen`, with
 * the target's socket ended while its session is still in the broker's map —
 * exactly the window in which the broker used to fabricate a `delivered` ack
 * and burn the message id.
 */

import assert from "node:assert/strict";
import net from "node:net";
import { setImmediate as tick } from "node:timers/promises";
import { afterEach, describe, test } from "vitest";
import { DeliveredMessageCache } from "../../packages/intercom/broker/delivered-message-cache.js";
import { createMessageReader, writeMessage } from "../../packages/intercom/broker/framing.js";
import { PendingQuestionIndex } from "../../packages/intercom/broker/pending-question-index.js";
import { type BrokerConnectedSession, handleBrokerSend } from "../../packages/intercom/broker/send-handler.js";
import { buildMessageSendSignature } from "../../packages/intercom/broker/send-signature.js";
import {
	isSocketOpenForWrite,
	writeMessageIfOpen,
	writeMessageWithOutcome,
} from "../../packages/intercom/broker/socket-writes.js";
import type { BrokerMessage, Message, SessionInfo } from "../../packages/intercom/types.js";

interface Pair {
	/** The broker-side socket: the one the broker writes to. */
	readonly server: net.Socket;
	/** The peer-side socket, and everything it has read. */
	readonly client: net.Socket;
	readonly received: BrokerMessage[];
	/** Socket `'error'` events observed on the broker side. */
	readonly serverErrors: Error[];
}

const openPairs: Array<{ pair: Pair; server: net.Server }> = [];

/**
 * A real connected pair, both ends half-open tolerant.
 *
 * `allowHalfOpen` on both sides is what makes the stale-socket state reachable
 * and stable: without it Node auto-ends and destroys the far side the moment it
 * sees FIN, and the socket under test would be `destroyed` for a second reason
 * before the assertions could distinguish them.
 */
async function connectedPair(): Promise<Pair> {
	const listener = net.createServer({ allowHalfOpen: true });
	await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
	const address = listener.address();
	if (address === null || typeof address === "string") throw new Error("expected a TCP address");

	const accepted = new Promise<net.Socket>((resolve) => listener.once("connection", resolve));
	const client = net.connect({ port: address.port, host: "127.0.0.1", allowHalfOpen: true });
	await new Promise<void>((resolve, reject) => client.once("connect", resolve).once("error", reject));
	const server = await accepted;

	const received: BrokerMessage[] = [];
	client.on(
		"data",
		createMessageReader(
			(message) => received.push(message as BrokerMessage),
			(error) => client.destroy(error),
		),
	);
	client.on("error", () => {});
	const serverErrors: Error[] = [];
	server.on("error", (error: Error) => serverErrors.push(error));

	const pair: Pair = { server, client, received, serverErrors };
	openPairs.push({ pair, server: listener });
	return pair;
}

/** Let the event loop deliver socket data, `'error'` and `'close'` before asserting. */
async function settle(): Promise<void> {
	for (let turn = 0; turn < 5; turn += 1) await tick();
}

/**
 * Errnos a peer's RST can surface as on the broker's socket.
 *
 * The same `resetAndDestroy()` is reported as `EPIPE` on Darwin and
 * `ECONNRESET` on Linux and Windows — verified on Node v26.8.1 on both
 * darwin/arm64 and linux/arm64. Pinning one of them is what made this suite
 * pass locally and fail on every CI runner, so the set is named here and the
 * platform's choice within it is not the test's business. What the assertion
 * still refuses is `ERR_STREAM_WRITE_AFTER_END`: that is the guarded path, not
 * an in-flight reset, and seeing it here would mean the test stopped
 * exercising the race it exists for.
 */
const RESET_ERROR_CODES = ["EPIPE", "ECONNRESET", "ECONNABORTED"];

/**
 * Resolve once the broker-side socket has surfaced its transport error.
 *
 * How many event-loop turns the RST takes to arrive is the platform's
 * business, so this waits on the event instead of on a fixed turn count.
 * The `'error'` listener installed by `connectedPair` runs first, so the
 * array is already populated when this resolves.
 */
async function awaitServerErrors(pair: Pair): Promise<Error[]> {
	if (pair.serverErrors.length === 0) {
		await new Promise<void>((resolve) => pair.server.once("error", () => resolve()));
	}
	return pair.serverErrors;
}

afterEach(() => {
	for (const { pair, server } of openPairs.splice(0)) {
		pair.client.destroy();
		pair.server.destroy();
		server.close();
	}
});

const frame = (text: string): BrokerMessage => ({ type: "session_left", sessionId: text });

describe("writeMessageIfOpen", () => {
	test("hands the frame to an open socket and reports that it did", async () => {
		const pair = await connectedPair();

		assert.equal(isSocketOpenForWrite(pair.server), true);
		assert.equal(writeMessageIfOpen(pair.server, frame("delivered-to-peer")), true);
		await settle();

		assert.deepEqual(pair.received, [frame("delivered-to-peer")]);
		assert.deepEqual(pair.serverErrors, []);
	});

	test("reports false and writes nothing once the writable side has ended", async () => {
		const pair = await connectedPair();
		writeMessageIfOpen(pair.server, frame("before-end"));
		pair.server.end();
		await settle();

		assert.equal(pair.server.writableEnded, true);
		assert.equal(pair.server.destroyed, false);
		assert.equal(isSocketOpenForWrite(pair.server), false);

		assert.equal(writeMessageIfOpen(pair.server, frame("after-end")), false);
		// Synchronously after the skipped write: an unguarded write would already
		// have destroyed the socket by this line.
		assert.equal(pair.server.destroyed, false);
		await settle();

		assert.deepEqual(pair.received, [frame("before-end")]);
		assert.deepEqual(pair.serverErrors, []);
		assert.equal(pair.server.destroyed, false);
	});

	test("reports false for an already destroyed socket", async () => {
		const pair = await connectedPair();
		pair.server.destroy();
		await settle();

		assert.equal(isSocketOpenForWrite(pair.server), false);
		assert.equal(writeMessageIfOpen(pair.server, frame("after-destroy")), false);
		assert.deepEqual(pair.received, []);
	});

	test("control: the unguarded write is what produces ERR_STREAM_WRITE_AFTER_END and destroys the socket", async () => {
		const pair = await connectedPair();
		pair.server.end();
		await settle();
		assert.equal(pair.server.destroyed, false);

		writeMessage(pair.server, frame("unguarded"));

		// The destroy is synchronous, which is why the departing peer's socket is
		// torn down before anything buffered for it can drain.
		assert.equal(pair.server.destroyed, true);
		await settle();
		assert.equal(pair.serverErrors.length, 1);
		assert.equal((pair.serverErrors[0] as NodeJS.ErrnoException).code, "ERR_STREAM_WRITE_AFTER_END");
	});
});

const sessionInfo = (id: string, name: string): SessionInfo => ({
	id,
	name,
	cwd: "/tmp/socket-writes",
	model: "test-model",
	pid: 1,
	startedAt: 1,
	lastActivity: 1,
	group: "default",
	groups: ["default"],
});

const question = (id: string, text: string): Message => ({
	id,
	timestamp: 1,
	expectsReply: true,
	content: { text },
});

interface SendHarness {
	readonly sender: Pair;
	readonly target: Pair;
	readonly sessions: Map<string, BrokerConnectedSession>;
	readonly cache: DeliveredMessageCache;
	readonly pendingQuestions: PendingQuestionIndex;
}

async function sendHarness(): Promise<SendHarness> {
	const sender = await connectedPair();
	const target = await connectedPair();
	const sessions = new Map<string, BrokerConnectedSession>([
		["sender-id", { socket: sender.server, info: sessionInfo("sender-id", "sender"), registrationGroup: "default" }],
		["target-id", { socket: target.server, info: sessionInfo("target-id", "target"), registrationGroup: "default" }],
	]);
	return {
		sender,
		target,
		sessions,
		cache: new DeliveredMessageCache(),
		pendingQuestions: new PendingQuestionIndex(),
	};
}

/** Drive the production send path with the production write, exactly as broker.ts wires it. */
function runSend(harness: SendHarness, message: Message): void {
	handleBrokerSend(
		harness.sender.server,
		{ type: "send", to: "target-id", message },
		"sender-id",
		harness.sessions,
		harness.cache,
		writeMessageIfOpen,
		undefined,
		harness.pendingQuestions,
		undefined,
		undefined,
		undefined,
		undefined,
		writeMessageWithOutcome,
	);
}

describe("handleBrokerSend against a target socket that stopped accepting frames", () => {
	test("fails truthfully, records nothing, and leaves the message id retryable", async () => {
		const harness = await sendHarness();
		const message = question("race-message", "hello");
		const signature = buildMessageSendSignature("target-id", message, "sender-id");

		// The window this test exists for: the session is still in the broker's map,
		// but its socket's writable side is gone.
		harness.target.server.end();
		await settle();
		assert.equal(harness.sessions.has("target-id"), true);

		runSend(harness, message);
		await settle();

		assert.deepEqual(harness.sender.received, [
			{ type: "delivery_failed", messageId: "race-message", reason: "Session not found" },
		]);
		// No fabricated ack, no poisoned dedupe cache, no reply authorization for a
		// conversation that never happened.
		assert.equal(harness.cache.lookup("race-message", signature), "miss");
		assert.equal(harness.pendingQuestions.matchesReply("target-id", "sender-id", "race-message"), false);
		assert.deepEqual(harness.target.received, []);
		// The skipped write did not destroy the target socket or raise write-after-end.
		assert.equal(harness.target.server.destroyed, false);
		assert.deepEqual(harness.target.serverErrors, []);

		// The honest retry of the same id and payload is not refused as a conflict and
		// is not answered `delivered` from a cache entry the failed send never earned.
		runSend(harness, message);
		await settle();
		assert.deepEqual(harness.sender.received, [
			{ type: "delivery_failed", messageId: "race-message", reason: "Session not found" },
			{ type: "delivery_failed", messageId: "race-message", reason: "Session not found" },
		]);

		// A retry that changes the payload is likewise not a conflict, because the id
		// was never burned by the delivery that did not happen.
		runSend(harness, question("race-message", "hello again"));
		await settle();
		const reasonCodes = harness.sender.received.map((received) =>
			received.type === "delivery_failed" ? received.reasonCode : "not-a-failure",
		);
		assert.deepEqual(reasonCodes, [undefined, undefined, undefined]);
	});

	test("does not acknowledge an immediate peer reset before the write callback reports the failure", async () => {
		const harness = await sendHarness();
		const message = question("reset-race-message", "hello");
		const signature = buildMessageSendSignature("target-id", message, "sender-id");

		assert.equal(isSocketOpenForWrite(harness.target.server), true);
		harness.target.client.resetAndDestroy();
		// The window this test exists for, and the reason the delivery path needs
		// `writeMessageWithOutcome` rather than `writeMessageIfOpen`: the RST has
		// not been observed locally yet, so the pre-write guard still reports the
		// socket as writable and cannot refuse this send. Only the write callback
		// can, and it answers asynchronously.
		assert.equal(isSocketOpenForWrite(harness.target.server), true);
		runSend(harness, message);
		await settle();

		assert.deepEqual(harness.sender.received, [
			{ type: "delivery_failed", messageId: "reset-race-message", reason: "Session not found" },
		]);
		assert.equal(harness.cache.lookup(message.id, signature), "miss");
		assert.equal(harness.pendingQuestions.matchesReply("target-id", "sender-id", message.id), false);
		assert.deepEqual(harness.target.received, []);

		// The frame really was handed to the socket and really did fail in flight,
		// which is what separates this from the write-after-end case above.
		const observed = await awaitServerErrors(harness.target);
		const codes = observed.map((error) => (error as NodeJS.ErrnoException).code);
		assert.equal(
			codes.every((code) => code !== undefined && RESET_ERROR_CODES.includes(code)),
			true,
			`expected only reset errnos on the broker socket, saw ${JSON.stringify(codes)}`,
		);
		assert.equal(harness.target.server.destroyed, true);
	});

	test("control: an open target still delivers, records, and authorizes the reply", async () => {
		const harness = await sendHarness();
		const message = question("healthy-message", "hello");
		const signature = buildMessageSendSignature("target-id", message, "sender-id");

		runSend(harness, message);
		await settle();

		assert.deepEqual(harness.sender.received, [{ type: "delivered", messageId: "healthy-message" }]);
		assert.deepEqual(harness.target.received, [
			{ type: "message", from: harness.sessions.get("sender-id")?.info, message },
		]);
		assert.equal(harness.cache.lookup("healthy-message", signature), "match");
		assert.equal(harness.pendingQuestions.matchesReply("target-id", "sender-id", "healthy-message"), true);
	});
});
