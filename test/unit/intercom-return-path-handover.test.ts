import assert from "node:assert/strict";
import type net from "node:net";
import { test } from "vitest";
import { DeliveredMessageCache } from "../../packages/intercom/broker/delivered-message-cache.js";
import { PendingQuestionIndex } from "../../packages/intercom/broker/pending-question-index.js";
import {
	RETURN_PATH_MESSAGE_LIMIT,
	ReturnPaths,
	returnPathClosedReason,
} from "../../packages/intercom/broker/return-paths.js";
import {
	type BrokerConnectedSession,
	createReturnPathAuthority,
	handleBrokerSend,
} from "../../packages/intercom/broker/send-handler.js";
import { SupervisorChannelCache } from "../../packages/intercom/broker/supervisor-channel.js";
import { createReachPolicy, type IntercomReachPolicy } from "../../packages/intercom/reach-policy.js";
import type { BrokerMessage } from "../../packages/intercom/types.js";

function session(id: string, group: string, reach?: IntercomReachPolicy, name = id): BrokerConnectedSession {
	return {
		socket: { id } as unknown as net.Socket,
		info: {
			id,
			name,
			group,
			groups: [group],
			cwd: "/repo",
			model: "test",
			pid: 1,
			startedAt: 1,
			lastActivity: 1,
		},
		registrationGroup: group,
		registrationReturnAddress: `host:${id}`,
		...(reach === undefined ? {} : { reach }),
	};
}

/**
 * A broker's send path whose writes to `held` complete only when the test says so, as a socket write whose callback the
 * broker has not run yet. Every other write completes at once.
 */
function brokerHoldingWritesTo(
	held: string,
	members: readonly BrokerConnectedSession[],
	paths: ReturnPaths = new ReturnPaths(),
) {
	const sessions = new Map(members.map((member) => [member.info.id, member]));
	const authority = createReturnPathAuthority(paths, sessions);
	const delivered = new DeliveredMessageCache();
	const pending = new PendingQuestionIndex();
	const supervisor = new SupervisorChannelCache();
	const pendingWrites: Array<(written: boolean) => void> = [];
	const outcomes = new Map<string, BrokerMessage>();
	const send = (
		from: string,
		to: string,
		id: string,
		extra?: { readonly broadcastId?: string },
	): BrokerMessage | undefined => {
		const sender = sessions.get(from)!;
		handleBrokerSend(
			sender.socket,
			{
				type: "send",
				to,
				message: {
					id,
					timestamp: 1,
					content: { text: id },
					...(extra?.broadcastId === undefined ? {} : { broadcastId: extra.broadcastId }),
				},
			},
			from,
			sessions,
			delivered,
			(socket, frame) => {
				if (
					socket === sender.socket &&
					(frame.type === "delivered" || frame.type === "delivery_failed" || frame.type === "queued")
				) {
					outcomes.set(frame.messageId, frame);
				}
				return true;
			},
			supervisor,
			pending,
			(socket, _frame, done) => {
				if (socket === sessions.get(held)?.socket) pendingWrites.push(done);
				else done(true);
			},
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			authority,
		);
		return outcomes.get(id);
	};
	return {
		paths,
		send,
		outcome: (id: string) => outcomes.get(id),
		/** The broker runs the callbacks of every pending write to `held` with `written`. */
		completeWrites: (written = true) => {
			for (const complete of pendingWrites.splice(0)) complete(written);
		},
		/** The broker runs the callback of the oldest pending write to `held` with `written`. */
		completeNextWrite: (written = true) => {
			const next = pendingWrites.shift();
			assert.ok(next !== undefined, "expected a pending write to complete");
			next(written);
		},
	};
}

test("an answer the broker reads before a newer message's delivery completes counts toward that message's budget", () => {
	const broker = brokerHoldingWritesTo("stage", [
		session("launcher", "launch", createReachPolicy("launch", ["stages"])),
		session("stage", "stages"),
	]);
	broker.send("launcher", "stage", "first-note");
	broker.completeWrites();
	// The second note is handed to the stage, which reads it and answers before the broker runs the write's callback.
	broker.send("launcher", "stage", "second-note");
	assert.equal(broker.send("stage", "launcher", "answer-1")?.type, "delivered");
	broker.completeWrites();

	for (let index = 2; index <= RETURN_PATH_MESSAGE_LIMIT; index++)
		assert.equal(broker.send("stage", "launcher", `answer-${index}`)?.type, "delivered");
	const over = broker.send("stage", "launcher", "answer-over");
	assert.deepEqual(over?.type === "delivery_failed" ? [over.type, over.reason] : [over?.type], [
		"delivery_failed",
		returnPathClosedReason("launcher"),
	]);
});

test("answers counted before a newer message was handed over stay with the older message's budget", () => {
	const broker = brokerHoldingWritesTo("stage", [
		session("launcher", "launch", createReachPolicy("launch", ["stages"])),
		session("stage", "stages"),
	]);
	broker.send("launcher", "stage", "first-note");
	broker.completeWrites();
	assert.equal(broker.send("stage", "launcher", "answer-to-first")?.type, "delivered");
	broker.send("launcher", "stage", "second-note");
	broker.completeWrites();

	for (let index = 1; index <= RETURN_PATH_MESSAGE_LIMIT; index++)
		assert.equal(broker.send("stage", "launcher", `answer-${index}`)?.type, "delivered");
	assert.equal(broker.send("stage", "launcher", "answer-over")?.type, "delivery_failed");
});

test("a retried answer keeps the time it was first counted, so a newer message handed over before the retry still allows its own answers", () => {
	const broker = brokerHoldingWritesTo("stage", [
		session("launcher", "launch", createReachPolicy("launch", ["stages"])),
		session("stage", "stages"),
	]);
	broker.send("launcher", "stage", "first-note");
	broker.completeWrites();
	assert.equal(broker.send("stage", "launcher", "answer-to-first")?.type, "delivered");
	broker.send("launcher", "stage", "second-note");
	// The answer to the first note is sent again before the second note's delivery completes: the same answer.
	assert.equal(broker.send("stage", "launcher", "answer-to-first")?.type, "delivered");
	broker.completeWrites();

	for (let index = 1; index <= RETURN_PATH_MESSAGE_LIMIT; index++)
		assert.equal(broker.send("stage", "launcher", `answer-${index}`)?.type, "delivered");
	assert.equal(broker.send("stage", "launcher", "answer-over")?.type, "delivery_failed");
});

test("answers read before the first message's write completes succeed by id and by name once that write settles", () => {
	const broker = brokerHoldingWritesTo("stage", [
		session("launcher-id", "launch", createReachPolicy("launch", ["stages"]), "launcher-name"),
		session("stage", "stages"),
	]);
	broker.send("launcher-id", "stage", "first-note");
	// Stage read first-note from the pipe and answered before the broker's socket write callback ran.
	assert.equal(broker.send("stage", "launcher-id", "ans-by-id"), undefined);
	assert.equal(broker.send("stage", "launcher-name", "ans-by-name"), undefined);
	broker.completeWrites(true);

	assert.equal(broker.outcome("ans-by-id")?.type, "delivered");
	assert.equal(broker.outcome("ans-by-name")?.type, "delivered");
	assert.equal(broker.send("stage", "launcher-name", "ans-3")?.type, "delivered");
	const over = broker.send("stage", "launcher-name", "ans-over");
	assert.deepEqual(over?.type === "delivery_failed" ? [over.type, over.reason] : [over?.type], [
		"delivery_failed",
		returnPathClosedReason("launcher-name"),
	]);
});

test("answers read before a follow-up message's write completes succeed after the earlier return path closed", () => {
	const broker = brokerHoldingWritesTo("stage", [
		session("launcher-id", "launch", createReachPolicy("launch", ["stages"]), "launcher-name"),
		session("stage", "stages"),
	]);
	broker.send("launcher-id", "stage", "first-note");
	broker.completeWrites(true);
	for (let index = 1; index <= RETURN_PATH_MESSAGE_LIMIT; index++)
		assert.equal(broker.send("stage", "launcher-id", `first-${index}`)?.type, "delivered");
	assert.equal(broker.send("stage", "launcher-id", "first-over")?.type, "delivery_failed");

	broker.send("launcher-id", "stage", "follow-up");
	assert.equal(broker.send("stage", "launcher-name", "reopened-by-name"), undefined);
	assert.equal(broker.send("stage", "launcher-id", "reopened-by-id"), undefined);
	broker.completeWrites(true);

	assert.equal(broker.outcome("reopened-by-name")?.type, "delivered");
	assert.equal(broker.outcome("reopened-by-id")?.type, "delivered");
	assert.equal(broker.send("stage", "launcher-name", "reopened-3")?.type, "delivered");
	const over = broker.send("stage", "launcher-name", "reopened-over");
	assert.deepEqual(over?.type === "delivery_failed" ? [over.type, over.reason] : [over?.type], [
		"delivery_failed",
		returnPathClosedReason("launcher-name"),
	]);
});

test("answers that overflow a partially used path wait for the newer message's write and preserve the exact limit", () => {
	const broker = brokerHoldingWritesTo("stage", [
		session("launcher", "launch", createReachPolicy("launch", ["stages"])),
		session("stage", "stages"),
	]);
	broker.send("launcher", "stage", "first-note");
	broker.completeWrites(true);
	for (let index = 1; index < RETURN_PATH_MESSAGE_LIMIT; index++)
		assert.equal(broker.send("stage", "launcher", `old-${index}`)?.type, "delivered");

	broker.send("launcher", "stage", "second-note");
	// First new answer uses the remaining slot on the earlier path immediately; subsequent ones wait.
	assert.equal(broker.send("stage", "launcher", "new-1")?.type, "delivered");
	for (let index = 2; index <= RETURN_PATH_MESSAGE_LIMIT; index++)
		assert.equal(broker.send("stage", "launcher", `new-${index}`), undefined);
	assert.equal(broker.send("stage", "launcher", "new-over"), undefined);
	broker.completeWrites(true);

	for (let index = 2; index <= RETURN_PATH_MESSAGE_LIMIT; index++)
		assert.equal(broker.outcome(`new-${index}`)?.type, "delivered");
	const over = broker.outcome("new-over");
	assert.deepEqual(over?.type === "delivery_failed" ? [over.type, over.reason] : [over?.type], [
		"delivery_failed",
		returnPathClosedReason("launcher"),
	]);
});

test("a failed socket write never opens a return path and refuses waiting answers", () => {
	const broker = brokerHoldingWritesTo("stage", [
		session("launcher-id", "launch", createReachPolicy("launch", ["stages"]), "launcher-name"),
		session("stage", "stages"),
	]);
	broker.send("launcher-id", "stage", "failed-note");
	assert.equal(broker.send("stage", "launcher-id", "ans-by-id"), undefined);
	assert.equal(broker.send("stage", "launcher-name", "ans-by-name"), undefined);
	broker.completeWrites(false);

	assert.equal(broker.outcome("ans-by-id")?.type, "delivery_failed");
	assert.equal(broker.outcome("ans-by-name")?.type, "delivery_failed");
	assert.equal(broker.send("stage", "launcher-id", "ans-after")?.type, "delivery_failed");
});

test("same-group, unrelated and broadcast sends never wait on a pending return-path opening", () => {
	const broker = brokerHoldingWritesTo("stage", [
		session("launcher-id", "launch", createReachPolicy("launch", ["stages"]), "launcher-name"),
		session("stage", "stages"),
		session("peer", "stages"),
		session("outsider", "elsewhere"),
	]);
	broker.send("launcher-id", "stage", "first-note");
	assert.equal(broker.send("stage", "peer", "same-group")?.type, "delivered");
	assert.equal(broker.send("stage", "outsider", "unrelated-id")?.type, "delivery_failed");
	assert.equal(broker.send("stage", "nonexistent", "unrelated-name")?.type, "delivery_failed");
	assert.equal(
		broker.send("stage", "launcher-id", "broadcast-attempt", { broadcastId: "b1" })?.type,
		"delivery_failed",
	);
	broker.completeWrites(true);
});

test("answers waiting on an earlier message keep their arrival order and do not consume a newer message's budget", () => {
	const broker = brokerHoldingWritesTo("stage", [
		session("launcher", "launch", createReachPolicy("launch", ["stages"])),
		session("stage", "stages"),
	]);
	broker.send("launcher", "stage", "first-note");
	for (let index = 1; index <= RETURN_PATH_MESSAGE_LIMIT; index++)
		assert.equal(broker.send("stage", "launcher", `a-${index}`), undefined);
	// A newer message starts while the first message and its answers are still waiting.
	broker.send("launcher", "stage", "second-note");
	broker.completeNextWrite(true);
	for (let index = 1; index <= RETURN_PATH_MESSAGE_LIMIT; index++)
		assert.equal(broker.outcome(`a-${index}`)?.type, "delivered");

	// Answers to the second note still get the full budget once the second note settles.
	assert.equal(broker.send("stage", "launcher", "b-1"), undefined);
	broker.completeNextWrite(true);
	assert.equal(broker.outcome("b-1")?.type, "delivered");
	for (let index = 2; index <= RETURN_PATH_MESSAGE_LIMIT; index++)
		assert.equal(broker.send("stage", "launcher", `b-${index}`)?.type, "delivered");
	const over = broker.send("stage", "launcher", "b-over");
	assert.deepEqual(over?.type === "delivery_failed" ? [over.type, over.reason] : [over?.type], [
		"delivery_failed",
		returnPathClosedReason("launcher"),
	]);
});

test("an answer waiting on a failed earlier message does not attach to a newer message handed over after it", () => {
	const broker = brokerHoldingWritesTo("stage", [
		session("launcher", "launch", createReachPolicy("launch", ["stages"])),
		session("stage", "stages"),
	]);
	broker.send("launcher", "stage", "first-note");
	assert.equal(broker.send("stage", "launcher", "stale-answer"), undefined);
	broker.send("launcher", "stage", "second-note");
	broker.completeNextWrite(false);

	assert.equal(broker.outcome("stale-answer")?.type, "delivery_failed");
	broker.completeNextWrite(true);
	for (let index = 1; index <= RETURN_PATH_MESSAGE_LIMIT; index++)
		assert.equal(broker.send("stage", "launcher", `fresh-${index}`)?.type, "delivered");
	assert.equal(broker.send("stage", "launcher", "fresh-over")?.type, "delivery_failed");
});

test("answers counted before a newer message in the same clock tick stay with the older message's budget", () => {
	const broker = brokerHoldingWritesTo(
		"stage",
		[session("launcher", "launch", createReachPolicy("launch", ["stages"])), session("stage", "stages")],
		new ReturnPaths(() => 1_000),
	);
	broker.send("launcher", "stage", "first-note");
	broker.completeWrites(true);
	assert.equal(broker.send("stage", "launcher", "answer-to-first")?.type, "delivered");
	broker.send("launcher", "stage", "second-note");
	broker.completeWrites(true);

	for (let index = 1; index <= RETURN_PATH_MESSAGE_LIMIT; index++)
		assert.equal(broker.send("stage", "launcher", `answer-${index}`)?.type, "delivered");
	assert.equal(broker.send("stage", "launcher", "answer-over")?.type, "delivery_failed");
});

test("a sender ending for good while its write is pending refuses waiting answers and opens nothing", () => {
	const launcher = session("launcher", "launch", createReachPolicy("launch", ["stages"]));
	const broker = brokerHoldingWritesTo("stage", [launcher, session("stage", "stages")]);
	broker.send("launcher", "stage", "first-note");
	assert.equal(broker.send("stage", "launcher", "ans-1"), undefined);
	broker.paths.revoke(`["return","host:launcher","launch"]`);
	broker.completeWrites(true);

	assert.equal(broker.outcome("ans-1")?.type, "delivery_failed");
	assert.equal(broker.send("stage", "launcher", "ans-2")?.type, "delivery_failed");
});
