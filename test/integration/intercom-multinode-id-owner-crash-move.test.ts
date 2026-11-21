import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, test, vi } from "vitest";
import { BROKER_CONNECT_TIMEOUT_MS, type IntercomIdHandoff } from "../../packages/intercom/broker/client.js";
import { SESSION_ID_OWNER_SAFE_MS } from "../../packages/intercom/broker/multinode-router.js";
import { BROKER_LEASE_STALE_AFTER_MS } from "../../packages/intercom/broker/multinode-state-store.js";
import {
	type TwoBrokerClient,
	TwoBrokerHarness,
	twoBrokerHarnessStartTimeoutMs,
} from "../helpers/intercom-two-broker-harness.js";
import { type RecordedProcess, recordProcess, signalRecordedProcess } from "../helpers/recorded-process.js";
import { sleep } from "../helpers/runtime.js";

/**
 * #5607: broker "a" stops (its process is stopped, so no broker can tell it apart from one on another machine that
 * crashed) while it holds a session's id. The session registers on broker "b" half a second later and gets a fresh id
 * while "a" still holds the one it asked for. Once that hold lapses, "b" takes the id back for it: sends to the id reach
 * the session throughout, and the fresh id stays an alias of it. Asks it got under the fresh id are answered from the id
 * after the move, as from the fresh id, and sends from its own broker reach it by either id while that broker's shared
 * storage is down. A session that registers on "b" after the hold lapsed gets its id at once.
 */

const HARNESS = { nodes: ["a", "b", "c"], storageOutageNodes: ["b"] } as const;
const REAL_BROKERS_HOOK_TIMEOUT_MS = twoBrokerHarnessStartTimeoutMs(HARNESS);
/** The stopped broker's hold lapses only after the owner lease's stale age: the structural cost of this test. */
const AFTER_THE_HOLD_LAPSES_MS = BROKER_LEASE_STALE_AFTER_MS + 10_000;
/** A storage outage long enough that the broker's owners went unconfirmed past their safe window. */
const OUTAGE_MS = SESSION_ID_OWNER_SAFE_MS + 2_000;
const TEST_TIMEOUT_MS = AFTER_THE_HOLD_LAPSES_MS + OUTAGE_MS + 60_000;
const WAIT = { timeout: 20_000, interval: 50 };

let harness: TwoBrokerHarness;
let stopped: RecordedProcess | undefined;

beforeAll(async () => {
	harness = await TwoBrokerHarness.start(HARNESS);
}, REAL_BROKERS_HOOK_TIMEOUT_MS);
afterAll(async () => {
	if (stopped !== undefined) await signalRecordedProcess(stopped, "SIGCONT");
	await harness?.cleanup();
}, REAL_BROKERS_HOOK_TIMEOUT_MS);

const unique = (label: string): string => `${label}-${randomUUID().slice(0, 8)}`;

function textsOf(client: TwoBrokerClient): string[] {
	return client.received.flatMap((frame) => {
		const text = (frame.message.content as { text?: unknown }).text;
		return typeof text === "string" ? [text] : [];
	});
}

/**
 * `from` answers `to`'s ask `replyTo` as the reply tool does, with one message id, sent again while it is refused as
 * retryable (as while its route cannot be read yet). Returns that message id.
 */
async function answerOnce(
	from: TwoBrokerClient,
	to: TwoBrokerClient,
	replyTo: string,
	text: string,
	messageId: string = randomUUID(),
): Promise<string> {
	const deadline = performance.now() + WAIT.timeout;
	for (;;) {
		const result = await from.client.send(to.sessionId, {
			messageId,
			text,
			replyTo,
			requirePendingReply: true,
			expectedRecipientId: to.sessionId,
			logicalTarget: to.sessionId,
		});
		if (result.delivered) return messageId;
		assert.equal(result.reasonCode, "route_unavailable", JSON.stringify(result));
		assert.ok(performance.now() < deadline, `still refused as retryable: ${JSON.stringify(result)}`);
		await sleep(250);
	}
}

/** The answers `asker` got to its ask `question`: who each came from and what it said. */
function answersTo(asker: TwoBrokerClient, question: string): unknown[][] {
	return asker.received
		.filter((frame) => frame.message.replyTo === question)
		.map((frame) => [frame.from.id, frame.message.id, (frame.message.content as { text?: unknown }).text]);
}

function disconnectedOnce(client: TwoBrokerClient): Promise<void> {
	return new Promise((resolve) => client.client.once("disconnected", () => resolve()));
}

async function within(promise: Promise<void>, ms: number, what: string): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms`)), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

test.skipIf(process.platform === "win32")(
	"a session that moves to another broker while the stopped broker it left still holds its id gets that id back once the hold lapses, and sends to it reach the session throughout (#5607)",
	async () => {
		assert.equal(harness.multiNodeRouting, true);
		const sender = await harness.connect("c", unique("sender"));
		const moving = { id: randomUUID(), returnAddress: randomUUID(), name: unique("moving") };
		const late = { id: randomUUID(), returnAddress: randomUUID(), name: unique("late") };
		const first = await harness.connect("a", moving.name, {
			preferredSessionId: moving.id,
			returnAddress: moving.returnAddress,
		});
		assert.equal(first.sessionId, moving.id);
		const lateFirst = await harness.connect("a", late.name, {
			preferredSessionId: late.id,
			returnAddress: late.returnAddress,
		});
		assert.equal(lateFirst.sessionId, late.id);

		const pid = harness.brokerPid("a");
		assert.ok(pid !== undefined);
		stopped = await recordProcess(pid);
		assert.ok(await signalRecordedProcess(stopped, "SIGSTOP"));
		const stoppedAt = performance.now();
		await sleep(500);

		// While "a" still holds the id, the session gets a fresh one, and is told which id it awaits.
		const moved = await harness.connect("b", moving.name, {
			preferredSessionId: moving.id,
			returnAddress: moving.returnAddress,
			connectTimeoutMs: BROKER_CONNECT_TIMEOUT_MS,
			takesIdHandoff: true,
		});
		const fresh = moved.sessionId;
		assert.notEqual(fresh, moving.id);
		const awaited = moved.client.awaitedSessionId;
		// It registers again with the hand-over as soon as it is given it, as its client does.
		let idHandoff: IntercomIdHandoff | undefined;
		const registeredBack = new Promise<TwoBrokerClient>((resolve, reject) =>
			moved.client.once("id_handoff", (handoff: IntercomIdHandoff) => {
				idHandoff = handoff;
				harness
					.connect("b", moving.name, {
						returnAddress: moving.returnAddress,
						connectTimeoutMs: BROKER_CONNECT_TIMEOUT_MS,
						takesIdHandoff: true,
						idHandoff: handoff,
					})
					.then(resolve, reject);
			}),
		);
		const switched = disconnectedOnce(moved);

		await sleep(Math.max(0, stoppedAt + 5_000 - performance.now()));
		// A peer on another broker and one on its own ask the session under its fresh id; the one on its own asks twice.
		const nearby = await harness.connect("b", unique("nearby"));
		const askers = [sender, nearby, nearby];
		const questions = askers.map(() => randomUUID());
		const asked = askers.map((asker, index) =>
			asker.client.send(fresh, {
				messageId: questions[index],
				text: `question ${index} to the fresh id`,
				expectsReply: true,
			}),
		);
		// Each reaches the session once: under the fresh id, or, should the move back come first, under its id.
		let backNow: TwoBrokerClient | undefined;
		void registeredBack.then(
			(client) => {
				backNow = client;
			},
			() => {},
		);
		const holders = () => (backNow === undefined ? [moved] : [moved, backNow]);
		const holderOf = (text: string) => holders().find((client) => textsOf(client).includes(text));
		await vi.waitFor(
			() =>
				assert.deepEqual(
					questions.map((_, index) => holderOf(`question ${index} to the fresh id`) !== undefined),
					[true, true, true],
				),
			WAIT,
		);
		for (const result of await Promise.all(asked)) assert.notEqual(result.reason, "Session not found");

		// Queued for the session, as while its earlier broker still holds the id; never refused.
		const early = sender.client.send(moving.id, { text: "to the id at 5 s" });
		await vi.waitFor(() => assert.ok(holderOf("to the id at 5 s") !== undefined), WAIT);
		assert.notEqual((await early).reason, "Session not found");

		// Once the hold lapses, "b" takes the id back for the session and has it register again under it.
		await within(switched, AFTER_THE_HOLD_LAPSES_MS, "the move back to the id");
		assert.equal(awaited, moving.id, "it was told which id it awaited, so it asks for that one again");
		const back = await registeredBack;
		assert.equal(idHandoff?.sessionId, moving.id);
		assert.equal(back.sessionId, moving.id);

		// Back under its id, it answers the asks it got under the fresh one: each asker gets its answer once, from the id
		// the ask reached it under. A reply to an ask it never got is still refused.
		const reachedUnder = (index: number) =>
			holderOf(`question ${index} to the fresh id`) === moved ? fresh : moving.id;
		for (const index of [0, 1]) {
			const asker = askers[index]!;
			const answer = await answerOnce(back, asker, questions[index]!, `answer ${index} from the id`);
			await vi.waitFor(
				() =>
					assert.deepEqual(answersTo(asker, questions[index]!), [
						[reachedUnder(index), answer, `answer ${index} from the id`],
					]),
				WAIT,
			);
		}
		const unrelated = await back.client.send(sender.sessionId, {
			text: "a reply to no ask",
			replyTo: randomUUID(),
			requirePendingReply: true,
			expectedRecipientId: sender.sessionId,
		});
		assert.equal(unrelated.delivered, false, JSON.stringify(unrelated));

		// A session that moves only after the hold lapsed gets its id at once.
		await sleep(Math.max(0, stoppedAt + AFTER_THE_HOLD_LAPSES_MS - performance.now()));
		const lateMoved = await harness.connect("b", late.name, {
			preferredSessionId: late.id,
			returnAddress: late.returnAddress,
			connectTimeoutMs: BROKER_CONNECT_TIMEOUT_MS,
		});
		assert.equal(lateMoved.sessionId, late.id);

		const after = await sender.client.send(moving.id, { text: "to the id at 40 s" });
		assert.equal(after.delivered, true, JSON.stringify(after));
		await vi.waitFor(() => assert.ok(textsOf(back).includes("to the id at 40 s")), WAIT);
		// The id it had meanwhile still reaches it, from this broker and from another.
		const local = await harness.connect("b", unique("local"));
		const toFresh = await local.client.send(fresh, { text: "to the fresh id from b" });
		assert.equal(toFresh.delivered, true, JSON.stringify(toFresh));
		const remote = await sender.client.send(fresh, { text: "to the fresh id from c" });
		assert.equal(remote.delivered, true, JSON.stringify(remote));
		await vi.waitFor(
			() =>
				assert.deepEqual(
					["to the fresh id from b", "to the fresh id from c"].filter((text) => textsOf(back).includes(text)),
					["to the fresh id from b", "to the fresh id from c"],
				),
			WAIT,
		);
		assert.equal(textsOf(back).filter((text) => text === "to the id at 40 s").length, 1, "delivered once");

		// Its broker loses the shared storage for longer than its ids' safe window: a session on that broker still reaches
		// it by its id and by the fresh one, once each, as sends between sessions of one broker do.
		// An answer to the ask it got under the fresh id, whose route only the shared storage keeps, is refused as retryable
		// meanwhile, and sent again with the same message id once the storage is back, it arrives once.
		const pendingAnswer = randomUUID();
		harness.setStorageOutage("b", true);
		try {
			await sleep(OUTAGE_MS);
			const during = await Promise.all(
				[moving.id, fresh].map((to, index) => local.client.send(to, { text: `during the outage ${index}` })),
			);
			for (const result of during) assert.equal(result.delivered, true, JSON.stringify(result));
			const refused = await back.client.send(nearby.sessionId, {
				messageId: pendingAnswer,
				text: "answer 2 from the id",
				replyTo: questions[2],
				requirePendingReply: true,
				expectedRecipientId: nearby.sessionId,
				logicalTarget: nearby.sessionId,
			});
			// An ask that reached it under its own id has its route here, which needs no storage.
			if (reachedUnder(2) === fresh) {
				assert.equal(refused.delivered, false, JSON.stringify(refused));
				assert.equal(refused.reasonCode, "route_unavailable", JSON.stringify(refused));
			} else assert.equal(refused.delivered, true, JSON.stringify(refused));
		} finally {
			harness.setStorageOutage("b", false);
		}
		await answerOnce(back, nearby, questions[2]!, "answer 2 from the id", pendingAnswer);
		await vi.waitFor(
			() =>
				assert.deepEqual(answersTo(nearby, questions[2]!), [
					[reachedUnder(2), pendingAnswer, "answer 2 from the id"],
				]),
			WAIT,
		);
		await vi.waitFor(
			() =>
				assert.deepEqual(
					[0, 1].map((index) => textsOf(back).filter((text) => text === `during the outage ${index}`).length),
					[1, 1],
				),
			WAIT,
		);
	},
	TEST_TIMEOUT_MS,
);
