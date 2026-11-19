import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
	BROKER_LEASE_STALE_AFTER_MS,
	KNOWN_SESSION_RETENTION_MS,
} from "../../packages/intercom/broker/multinode-state-store.js";
import { openSqlOutboxStore } from "../../packages/intercom/broker/sql-outbox-store.js";
import { DELIVERED_MESSAGE_TTL_MS } from "../../packages/intercom/retry-policy.js";
import {
	TWO_BROKER_STORAGE_PREFIX,
	type TwoBrokerClient,
	TwoBrokerHarness,
	type TwoBrokerHarnessOptions,
	twoBrokerHarnessStartTimeoutMs,
} from "../helpers/intercom-two-broker-harness.js";

const HARNESS_OPTIONS: TwoBrokerHarnessOptions = {
	parkablePresenceRead: "b",
	storageAdapter: resolve(import.meta.dirname, "../fixtures/intercom-queued-store-delay.ts"),
};
const REAL_BROKERS_HOOK_TIMEOUT_MS = twoBrokerHarnessStartTimeoutMs(HARNESS_OPTIONS);
/** Before the delayed SQL response, and well before an unreleased lease would age off the peer list. */
const DEPARTED_WITHIN_MS = BROKER_LEASE_STALE_AFTER_MS / 3;
const WAIT = { timeout: 15_000, interval: 25 };
let harness: TwoBrokerHarness;
beforeEach(async () => {
	harness = await TwoBrokerHarness.start(HARNESS_OPTIONS);
	assert.equal(harness.multiNodeRouting, true);
}, REAL_BROKERS_HOOK_TIMEOUT_MS);
afterEach(() => harness?.cleanup(), REAL_BROKERS_HOOK_TIMEOUT_MS);

async function listed(watcher: TwoBrokerClient, id: string): Promise<boolean> {
	return (await watcher.client.listSessions()).some((session) => session.id === id);
}

async function goAway(session: TwoBrokerClient, watcher: TwoBrokerClient): Promise<string> {
	const id = session.sessionId;
	await session.client.disconnect({ resumable: true });
	await vi.waitFor(async () => assert.equal(await listed(watcher, id), false), WAIT);
	return id;
}

async function ask(asker: TwoBrokerClient, replier: TwoBrokerClient): Promise<string> {
	const messageId = randomUUID();
	const sent = await asker.client.send(replier.sessionId, { messageId, text: "which port?", expectsReply: true });
	assert.equal(sent.delivered, true, sent.reason);
	return messageId;
}

async function queueAwayReply(away: TwoBrokerClient, replier: TwoBrokerClient): Promise<void> {
	const replyTo = await ask(away, replier);
	const awayId = await goAway(away, replier);
	harness.holdPresenceRead(away.returnAddress);
	const result = await replier.client.send(awayId, { replyTo, text: "3000", requirePendingReply: true });
	assert.equal(result.queued, true, result.reason);
}

test("an ended recipient disappears from the peer list and its away asker gets the failure when it returns (#5607)", async () => {
	const away = await harness.connect("a", "asker");
	const watcher = await harness.connect("a", "watcher");
	const recipient = await harness.connect("b", "recipient");
	const id = recipient.sessionId;
	const replyTo = await ask(away, recipient);
	const preferredSessionId = await goAway(away, recipient);
	assert.equal(await listed(watcher, id), true);
	harness.holdPresenceRead(away.returnAddress);
	await harness.disconnect(recipient);
	await vi.waitFor(async () => assert.equal(await listed(watcher, id), false), { timeout: DEPARTED_WITHIN_MS });
	const back = await harness.connect("a", away.name, { returnAddress: away.returnAddress, preferredSessionId });
	await vi.waitFor(() => {
		const failure = back.received.find((frame) => frame.message.replyTo === replyTo);
		assert.equal(failure?.message.replyError, `Session "${recipient.name}" ended before replying`);
	}, WAIT);
});

test("a queued reply to an away asker does not cost a live reply its acknowledgment (#5607)", async () => {
	const away = await harness.connect("a", "away");
	const live = await harness.connect("a", "live");
	const replier = await harness.connect("b", "replier");
	const replyTo = await ask(live, replier);
	await queueAwayReply(away, replier);
	const messageId = randomUUID();
	const reply = await replier.client.send(live.sessionId, {
		messageId,
		replyTo,
		text: "4000",
		requirePendingReply: true,
	});
	assert.equal(reply.delivered, true, reply.reason);
	assert.equal(live.messagesWithId(messageId).length, 1);
});

test("a replier that disconnects immediately after queuing a reply stops appearing in peer lists (#5607)", async () => {
	const away = await harness.connect("a", "away");
	const watcher = await harness.connect("a", "watcher");
	const replier = await harness.connect("b", "replier");
	const id = replier.sessionId;
	await queueAwayReply(away, replier);
	assert.equal(await listed(watcher, id), true);
	await harness.disconnect(replier);
	await vi.waitFor(async () => assert.equal(await listed(watcher, id), false), { timeout: DEPARTED_WITHIN_MS });
});

test("a queued send reports position one when the row ahead expires after its commit (#5607)", async () => {
	const sender = await harness.connect("b", "sender");
	const target = await harness.connect("a", "target");
	const targetId = await goAway(target, sender);
	const firstId = randomUUID();
	const first = await sender.client.send(targetId, { messageId: firstId, text: "one" });
	assert.equal(first.position, 1);
	const db = await harness.openSharedStorage("a");
	const outbox = await openSqlOutboxStore({ database: db, prefix: TWO_BROKER_STORAGE_PREFIX });
	const secondId = randomUUID();
	const gate = `${harness.sharedDatabasePath}.hold-enqueue`;
	writeFileSync(gate, secondId);
	const sending = sender.client.send(targetId, { messageId: secondId, text: "two" });
	try {
		await vi.waitFor(() => assert.ok(existsSync(`${gate}.committed`)), WAIT);
		// The second row is committed. Move the older row past retention, then run the brokers' normal prune.
		const updated = await db.run(
			`UPDATE ${TWO_BROKER_STORAGE_PREFIX}intercom_outbox SET queued_at = queued_at - ? WHERE message_id = ?`,
			KNOWN_SESSION_RETENTION_MS + 1_000,
			firstId,
		);
		assert.equal(updated.changes, 1);
		await outbox.prune(DELIVERED_MESSAGE_TTL_MS, KNOWN_SESSION_RETENTION_MS);
		const firstRow = await outbox.read(firstId);
		assert.ok(firstRow.status === "found" && firstRow.row.state === "failed");
	} finally {
		rmSync(gate, { force: true });
		await sending;
	}
	const second = await sending;
	assert.equal(second.queued, true, second.reason);
	assert.equal(second.position, 1);
});
