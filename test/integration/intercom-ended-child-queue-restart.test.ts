import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, test, vi } from "vitest";
import { EndedQueueMemory } from "../../packages/intercom/broker/client.js";
import {
	BROKER_CRASH_AT_ENV,
	ENDED_QUEUE_HANDED_OVER,
	ENDED_QUEUE_KEPT,
	ENDED_QUEUE_RECEIVED,
} from "../../packages/intercom/broker/crash-points.js";
import {
	PAUSED_RECIPIENT_TARGET,
	RESUMING_RECIPIENT_TARGET,
} from "../../packages/intercom/broker/ended-child-wakes.js";
import { getBrokerEndedChildQueuePath } from "../../packages/intercom/broker/paths.js";
import { sleep } from "../helpers/runtime.js";
import {
	again,
	cleanupEndedQueueRestartFixtures,
	connect,
	endedChild,
	Host,
	heldMessage,
	markEnded,
	owner,
	requestShutdown,
	resume,
	SETTLE_MS,
	texts,
	WAIT,
} from "./intercom-ended-child-queue-restart-helpers.js";

/**
 * #5999 durable wake queue: messages queued for a subagent that finished (to be resumed) or was paused (to be continued)
 * survive the broker being killed. Each test runs its own real broker processes on an agent directory of its own, kills
 * them with SIGKILL, and starts the next one, as a crash or a machine restart would; the sessions register again as
 * their extensions do (same return address, same Intercom id), and the owner reports its ended children again.
 */

/** Real broker processes, killed and started again: their start, registration and restore are the structural cost. */
const RESTART_TEST_TIMEOUT_MS = 120_000;

afterEach(cleanupEndedQueueRestartFixtures);
afterAll(cleanupEndedQueueRestartFixtures);

/**
 * The scenario both storage modes run: messages queued for a completed subagent and for a paused one, the broker killed,
 * the next broker started, every session back. `start` starts (or restarts) the mode's broker.
 */
async function survivesRestart(host: Host, start: () => Promise<void>): Promise<void> {
	await start();
	const ownerBefore = await owner(host, "restart");
	await endedChild(host, ownerBefore, "subagent-worker-done-1", "completed");
	await endedChild(host, ownerBefore, "subagent-worker-paused-1", "stopped");
	const memory = new EndedQueueMemory();
	const senderBefore = await connect(host, "restart-sender", { memory });
	const askId = randomUUID();
	const answers = [
		await senderBefore.client.send("subagent-worker-done-1", { text: "first", wakeEndedRecipient: true }),
		await senderBefore.client.send("subagent-worker-done-1", {
			text: "what did you find?",
			messageId: askId,
			expectsReply: true,
			wakeEndedRecipient: true,
		}),
		await senderBefore.client.send("subagent-worker-done-1", { text: "third", wakeEndedRecipient: true }),
		await senderBefore.client.send("subagent-worker-paused-1", {
			text: "when you are back",
			wakeEndedRecipient: true,
		}),
	];
	assert.deepEqual(
		answers.map((answer) => [answer.queued, answer.target]),
		[
			[true, RESUMING_RECIPIENT_TARGET],
			[true, RESUMING_RECIPIENT_TARGET],
			[true, RESUMING_RECIPIENT_TARGET],
			[true, PAUSED_RECIPIENT_TARGET],
		],
	);
	// Its owner was asked to resume the finished one, and the broker is killed before it did.
	await vi.waitFor(() => assert.equal(ownerBefore.wakes.length, 1), WAIT);
	await host.kill();

	await start();
	const ownerAfter = await owner(host, "restart", ownerBefore);
	const sender = await again(host, "restart-sender", senderBefore, { memory });
	assert.equal(sender.sessionId, senderBefore.sessionId);
	assert.equal(ownerAfter.sessionId, ownerBefore.sessionId);
	// It reports its ended children again, as its extension does on every connection.
	await markEnded(ownerAfter, "subagent-worker-done-1", "completed");
	await markEnded(ownerAfter, "subagent-worker-paused-1", "stopped");

	// The finished subagent is woken again, once, and resumed: it gets each message once, in its sender's order.
	await vi.waitFor(() => assert.equal(ownerAfter.wakes.length, 1), WAIT);
	const [wake] = ownerAfter.wakes;
	assert.equal(wake!.childName, "subagent-worker-done-1");
	assert.notEqual(wake!.wakeId, ownerBefore.wakes[0]!.wakeId, "a new wake, never the lost broker's");
	assert.equal(ownerAfter.client.answerEndedChildWake("subagent-worker-done-1", wake!.wakeId, true), true);
	const done = await resume(host, ownerAfter, "subagent-worker-done-1");
	await vi.waitFor(() => assert.equal(done.received.length, 3), WAIT);
	assert.deepEqual(texts(done), ["first", "what did you find?", "third"]);
	assert.equal(done.received[1]!.message.id, askId);
	assert.equal(done.received[1]!.message.expectsReply, true);

	// The ask gets its reply.
	const replied = await done.client.send(done.received[1]!.from.id, {
		text: "three bugs",
		replyTo: askId,
		requirePendingReply: true,
	});
	assert.equal(replied.delivered, true, replied.reason);
	await vi.waitFor(
		() =>
			assert.deepEqual(
				sender.received
					.filter(({ message }) => message.replyTo === askId)
					.map(({ message }) => message.content.text),
				["three bugs"],
			),
		WAIT,
	);

	// The paused subagent is not woken: its message waits until it is continued, then reaches it once.
	await sleep(SETTLE_MS);
	assert.equal(ownerAfter.wakes.length, 1, "the paused subagent is never woken");
	const paused = await resume(host, ownerAfter, "subagent-worker-paused-1");
	await vi.waitFor(() => assert.equal(paused.received.length, 1), WAIT);
	assert.equal(paused.received[0]!.message.content.text, "when you are back");
	assert.equal(paused.received[0]!.message.heldWhilePaused, true);

	await sleep(SETTLE_MS);
	assert.deepEqual(texts(done), ["first", "what did you find?", "third"], "nothing twice");
	assert.equal(paused.received.length, 1, "nothing twice");
	assert.deepEqual(sender.lost, [], "the sender is told nothing was lost: nothing was");
	assert.deepEqual(
		sender.received.filter(({ message }) => message.replyError !== undefined),
		[],
		"no message failed",
	);
	assert.equal((await sender.client.brokerStatus())?.queuedBytes, 0, "nothing is left queued");
}

test(
	"messages for a completed and a paused subagent survive a broker killed with SIGKILL, in the default local store (#5999)",
	async () => {
		const host = new Host();
		await survivesRestart(host, () => host.start());
	},
	RESTART_TEST_TIMEOUT_MS,
);

test(
	"messages for a completed and a paused subagent survive a broker killed with SIGKILL, in the shared database (#5999)",
	async () => {
		const shared = join(mkdtempSync(join(tmpdir(), "ecq-shared-")), "shared.sqlite");
		const host = new Host(shared);
		await survivesRestart(host, () => host.start());
		// Kept in the shared database, under its prefix; nothing in the local file.
		const { openNodeSqliteDatabase } = await import("@bastani/atomic/storage");
		const database = await openNodeSqliteDatabase(shared);
		try {
			const tables = await database.all<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ecq_intercom_ended_child_%' ORDER BY name",
			);
			assert.deepEqual(
				tables.map((table) => table.name),
				[
					"ecq_intercom_ended_child_bodies",
					"ecq_intercom_ended_child_meta",
					"ecq_intercom_ended_child_queue",
					"ecq_intercom_ended_child_wakes",
				],
			);
		} finally {
			await database.close();
		}
		assert.equal(existsSync(getBrokerEndedChildQueuePath(host.agentDir)), false);
	},
	RESTART_TEST_TIMEOUT_MS,
);

test(
	"messages for a completed and a paused subagent survive a broker killed with SIGKILL, in a shared database that opens only after the store's own open wait (#5999)",
	async () => {
		const directory = mkdtempSync(join(tmpdir(), "ecq-slow-"));
		const host = new Host(join(directory, "shared.sqlite"), join(directory, "open-gate"));
		await survivesRestart(host, () => host.startSlowly());
	},
	RESTART_TEST_TIMEOUT_MS,
);

test(
	"a launching session that goes away keeps its subagents' messages waiting; back, it resumes the finished one; ended, they fail once (#5999)",
	async () => {
		const host = new Host();
		await host.start();
		const ownerBefore = await owner(host, "away");
		await endedChild(host, ownerBefore, "subagent-worker-away-1", "completed");
		await endedChild(host, ownerBefore, "subagent-worker-away-paused-1", "stopped");
		const sender = await connect(host, "away-sender");
		const first = await sender.client.send("subagent-worker-away-1", {
			text: "before it left",
			wakeEndedRecipient: true,
		});
		assert.equal(first.queued, true, first.reason);
		await vi.waitFor(() => assert.equal(ownerBefore.wakes.length, 1), WAIT);
		// It goes away without ending (its process exits; `atomic -c` brings it back), before it answered the wake.
		await ownerBefore.client.disconnect({ resumable: true });
		await sleep(SETTLE_MS);
		const meanwhile = await sender.client.send("subagent-worker-away-1", {
			text: "while it was away",
			wakeEndedRecipient: true,
		});
		assert.equal(meanwhile.queued, true, meanwhile.reason);
		assert.equal(meanwhile.target, RESUMING_RECIPIENT_TARGET);
		const paused = await sender.client.send("subagent-worker-away-paused-1", {
			text: "held",
			wakeEndedRecipient: true,
		});
		assert.equal(paused.queued, true, paused.reason);
		assert.deepEqual(
			sender.received.filter(({ message }) => message.replyError !== undefined),
			[],
			"nothing fails while it may come back",
		);

		const ownerBack = await owner(host, "away", ownerBefore);
		await markEnded(ownerBack, "subagent-worker-away-1", "completed");
		await markEnded(ownerBack, "subagent-worker-away-paused-1", "stopped");
		await vi.waitFor(() => assert.equal(ownerBack.wakes.length, 1), WAIT);
		ownerBack.client.answerEndedChildWake("subagent-worker-away-1", ownerBack.wakes[0]!.wakeId, true);
		const resumed = await resume(host, ownerBack, "subagent-worker-away-1");
		await vi.waitFor(() => assert.deepEqual(texts(resumed), ["before it left", "while it was away"]), WAIT);

		// It ends for good: nothing can continue its paused subagent, whose message fails once.
		await ownerBack.client.disconnect();
		await vi.waitFor(
			() =>
				assert.deepEqual(
					sender.received
						.filter(({ message }) => message.replyError !== undefined)
						.map(({ message }) => message.replyError),
					[
						`Subagent "subagent-worker-away-paused-1" is paused and the session that launched it ended, so nothing can continue it now. The message was not delivered; send it again if it is still needed.`,
					],
				),
			WAIT,
		);
		await sleep(SETTLE_MS);
		assert.equal(sender.received.filter(({ message }) => message.replyError !== undefined).length, 1, "once");
	},
	RESTART_TEST_TIMEOUT_MS,
);

test(
	"an ask that waited in the queue is answered when it reaches the subagent, also when its asker is away by then (#5999)",
	async () => {
		const host = new Host();
		await host.start();
		const ownerSession = await owner(host, "away-asker");
		await endedChild(host, ownerSession, "subagent-worker-away-asker-1", "completed");
		const askerBefore = await connect(host, "away-asker");
		const askId = randomUUID();
		const asked = await askerBefore.client.send("subagent-worker-away-asker-1", {
			text: "anything new?",
			messageId: askId,
			expectsReply: true,
			wakeEndedRecipient: true,
		});
		assert.equal(asked.queued, true, asked.reason);
		// The asker's session closes (it can be resumed) before the subagent is resumed and gets the ask.
		await askerBefore.client.disconnect({ resumable: true });
		await vi.waitFor(() => assert.equal(ownerSession.wakes.length, 1), WAIT);
		ownerSession.client.answerEndedChildWake("subagent-worker-away-asker-1", ownerSession.wakes[0]!.wakeId, true);
		const child = await resume(host, ownerSession, "subagent-worker-away-asker-1");
		await vi.waitFor(
			() =>
				assert.deepEqual(
					child.received.map(({ message }) => message.id),
					[askId],
				),
			WAIT,
		);
		const replied = await child.client.send(child.received[0]!.from.id, {
			text: "nothing new",
			replyTo: askId,
			requirePendingReply: true,
		});
		assert.ok(replied.delivered === true || replied.queued === true, replied.reason);
		// Back, the asker gets the reply.
		const asker = await again(host, "away-asker", askerBefore);
		await vi.waitFor(
			() =>
				assert.deepEqual(
					asker.received
						.filter(({ message }) => message.replyTo === askId)
						.map(({ message }) => message.content.text),
					["nothing new"],
				),
			WAIT,
		);
	},
	RESTART_TEST_TIMEOUT_MS,
);

test(
	"a broker killed after keeping a message and before answering it: the retry with its id is answered queued, and it arrives once (#5999)",
	async () => {
		const host = new Host();
		await host.start({ [BROKER_CRASH_AT_ENV]: ENDED_QUEUE_KEPT });
		const ownerBefore = await owner(host, "kept");
		await endedChild(host, ownerBefore, "subagent-worker-kept-1", "completed");
		const memory = new EndedQueueMemory();
		const senderBefore = await connect(host, "kept-sender", { memory });
		const messageId = randomUUID();
		// The broker keeps it and dies before it answers: the client never hears `queued`.
		const cut = senderBefore.client
			.send("subagent-worker-kept-1", { text: "only once", messageId, wakeEndedRecipient: true })
			.catch((error: Error) => ({ delivered: false, queued: undefined, reason: error.message }));
		await host.exited();
		const unanswered = await cut;
		assert.notEqual(unanswered.queued, true, "the crash came before the answer");

		await host.start();
		const ownerAfter = await owner(host, "kept", ownerBefore);
		const sender = await again(host, "kept-sender", senderBefore, { memory });
		// The tool sends it again with the same id, before the owner reported the subagent again.
		const retried = await sender.client.send("subagent-worker-kept-1", {
			text: "only once",
			messageId,
			wakeEndedRecipient: true,
		});
		assert.equal(retried.queued, true, retried.reason);
		assert.equal(retried.target, RESUMING_RECIPIENT_TARGET);
		await markEnded(ownerAfter, "subagent-worker-kept-1", "completed");
		await vi.waitFor(() => assert.equal(ownerAfter.wakes.length, 1), WAIT);
		ownerAfter.client.answerEndedChildWake("subagent-worker-kept-1", ownerAfter.wakes[0]!.wakeId, true);
		const child = await resume(host, ownerAfter, "subagent-worker-kept-1");
		await vi.waitFor(() => assert.equal(child.received.length, 1), WAIT);
		await sleep(SETTLE_MS);
		assert.deepEqual(
			child.received.map(({ message }) => message.id),
			[messageId],
			"one row, one delivery",
		);
		assert.equal(ownerAfter.wakes.length, 1, "one wake");
	},
	RESTART_TEST_TIMEOUT_MS,
);

test(
	"a broker killed after the subagent saved a message and before its row was deleted delivers nothing twice and wakes nobody (#5999)",
	async () => {
		const host = new Host();
		await host.start({ [BROKER_CRASH_AT_ENV]: ENDED_QUEUE_RECEIVED });
		const ownerBefore = await owner(host, "received");
		await endedChild(host, ownerBefore, "subagent-worker-received-1", "completed");
		const memory = new EndedQueueMemory();
		const senderBefore = await connect(host, "received-sender", { memory });
		const queued = await senderBefore.client.send("subagent-worker-received-1", {
			text: "saved once",
			wakeEndedRecipient: true,
		});
		assert.equal(queued.queued, true, queued.reason);
		await vi.waitFor(() => assert.equal(ownerBefore.wakes.length, 1), WAIT);
		ownerBefore.client.answerEndedChildWake("subagent-worker-received-1", ownerBefore.wakes[0]!.wakeId, true);
		// The resumed subagent saves it and confirms; the broker dies before it deletes the row.
		const childBefore = await resume(host, ownerBefore, "subagent-worker-received-1");
		await host.exited();
		assert.deepEqual(texts(childBefore), ["saved once"]);

		await host.start();
		const ownerAfter = await owner(host, "received", ownerBefore);
		const sender = await again(host, "received-sender", senderBefore, { memory });
		// Its run ended meanwhile; its owner reports it again.
		await markEnded(ownerAfter, "subagent-worker-received-1", "completed");
		await sleep(SETTLE_MS * 2);
		assert.deepEqual(ownerAfter.wakes, [], "nothing is left to wake it for");
		assert.deepEqual(sender.lost, []);
		assert.deepEqual(
			sender.received.filter(({ message }) => message.replyError !== undefined),
			[],
			"it is not told it failed: it was delivered",
		);
		assert.equal((await sender.client.brokerStatus())?.queuedBytes, 0);
	},
	RESTART_TEST_TIMEOUT_MS,
);

test(
	"a broker killed after handing a message to its subagent and before it confirmed: no wake for it, and it is handed over again when the subagent is back (#5999)",
	async () => {
		const host = new Host();
		await host.start({ [BROKER_CRASH_AT_ENV]: ENDED_QUEUE_HANDED_OVER });
		const ownerBefore = await owner(host, "handed");
		await endedChild(host, ownerBefore, "subagent-worker-handed-1", "completed");
		const senderBefore = await connect(host, "handed-sender");
		const askId = randomUUID();
		const queued = await senderBefore.client.send("subagent-worker-handed-1", {
			text: "did you get this?",
			messageId: askId,
			expectsReply: true,
			wakeEndedRecipient: true,
		});
		assert.equal(queued.queued, true, queued.reason);
		await vi.waitFor(() => assert.equal(ownerBefore.wakes.length, 1), WAIT);
		ownerBefore.client.answerEndedChildWake("subagent-worker-handed-1", ownerBefore.wakes[0]!.wakeId, true);
		// The broker dies right after handing it to the resumed subagent, before it hears that the subagent saved it. (Whether
		// the frame left the dying broker's pipe depends on the platform: either way the subagent may have it.)
		await resume(host, ownerBefore, "subagent-worker-handed-1");
		await host.exited();

		await host.start();
		const ownerAfter = await owner(host, "handed", ownerBefore);
		const sender = await again(host, "handed-sender", senderBefore);
		// Its run ended meanwhile; its owner reports it again. It may have the message: nothing wakes it for it.
		await markEnded(ownerAfter, "subagent-worker-handed-1", "completed");
		await sleep(SETTLE_MS * 2);
		assert.deepEqual(ownerAfter.wakes, [], "no wake for a message it may already have");
		assert.deepEqual(
			sender.received.filter(({ message }) => message.replyError !== undefined),
			[],
			"nor is the sender told it was not delivered",
		);
		// Continued by its owner, it is handed over again (its inbox ignores a copy it saved), and nothing is left.
		const childAfter = await resume(host, ownerAfter, "subagent-worker-handed-1");
		await vi.waitFor(
			() =>
				assert.deepEqual(
					childAfter.received.map(({ message }) => message.id),
					[askId],
				),
			WAIT,
		);
		await vi.waitFor(async () => assert.equal((await sender.client.brokerStatus())?.queuedBytes, 0), WAIT);
	},
	RESTART_TEST_TIMEOUT_MS,
);

test(
	"a broker that exits in order keeps what it queued for the next one, as after a crash (#5999)",
	async () => {
		const host = new Host();
		await host.start();
		const memory = new EndedQueueMemory();
		const { ownerSession, childName, sender, messageId } = await heldMessage(host, "orderly", memory);
		await requestShutdown(host);
		await host.exited();
		await host.start();
		const ownerBack = await owner(host, "orderly", ownerSession);
		const senderBack = await again(host, "orderly-sender", sender, { memory });
		await markEnded(ownerBack, childName, "stopped");
		const continued = await resume(host, ownerBack, childName);
		await vi.waitFor(
			() =>
				assert.deepEqual(
					continued.received.map(({ message }) => message.id),
					[messageId],
				),
			WAIT,
		);
		assert.deepEqual(senderBack.lost, []);
	},
	RESTART_TEST_TIMEOUT_MS,
);

test(
	"a broker's orderly shutdown closes its store, so the Intercom directory can be removed at once (Windows locks open files) (#5999)",
	async () => {
		const host = new Host();
		await host.start();
		const ownerBefore = await owner(host, "closed");
		await endedChild(host, ownerBefore, "subagent-worker-closed-1", "stopped");
		const sender = await connect(host, "closed-sender");
		const queued = await sender.client.send("subagent-worker-closed-1", { text: "kept", wakeEndedRecipient: true });
		assert.equal(queued.queued, true, queued.reason);
		await sender.client.disconnect();
		await ownerBefore.client.disconnect();
		await requestShutdown(host);
		await host.exited();
		rmSync(getBrokerEndedChildQueuePath(host.agentDir), { force: true });
		rmSync(`${getBrokerEndedChildQueuePath(host.agentDir)}-wal`, { force: true });
		rmSync(`${getBrokerEndedChildQueuePath(host.agentDir)}-shm`, { force: true });
	},
	RESTART_TEST_TIMEOUT_MS,
);
