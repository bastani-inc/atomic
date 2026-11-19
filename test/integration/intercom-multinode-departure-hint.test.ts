import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, test, vi } from "vitest";
import { BROKER_LEASE_STALE_AFTER_MS } from "../../packages/intercom/broker/multinode-state-store.js";
import {
	TwoBrokerHarness,
	type TwoBrokerHarnessOptions,
	twoBrokerHarnessStartTimeoutMs,
} from "../helpers/intercom-two-broker-harness.js";

/**
 * #5607: with multi-node routing, a session that ends tells its askers on other brokers, and an away asker's failure is
 * queued for when it is back. Telling the asker's broker about that queued failure is only a hint: a slow answer of the
 * shared database to it must not hold up the ended session's departure, so other brokers stop listing it at once.
 */

const HARNESS_OPTIONS: TwoBrokerHarnessOptions = { parkablePresenceRead: "b" };
/** Spawning two real broker processes is the structural cost of this suite. */
const REAL_BROKERS_HOOK_TIMEOUT_MS = twoBrokerHarnessStartTimeoutMs(HARNESS_OPTIONS);
/** Well before its presence would go stale (and drop from the list anyway) had its broker never given it up. */
const DEPARTED_WITHIN_MS = BROKER_LEASE_STALE_AFTER_MS / 3;
const WAIT = { timeout: 15_000, interval: 25 };
const TEST_TIMEOUT_MS = 90_000;

let harness: TwoBrokerHarness;

// Each broker parks its first matching presence read only.
beforeEach(async () => {
	harness = await TwoBrokerHarness.start(HARNESS_OPTIONS);
}, REAL_BROKERS_HOOK_TIMEOUT_MS);
afterEach(() => harness?.cleanup(), REAL_BROKERS_HOOK_TIMEOUT_MS);

const unique = (label: string): string => `${label}-${randomUUID().slice(0, 8)}`;

test(
	"a recipient that ends while its away asker's broker is slow to answer is no longer listed on other brokers at once (#5607)",
	async ({ annotate }) => {
		if (!harness.multiNodeRouting) {
			await annotate("multi-node routing not advertised: nothing crosses brokers");
			return;
		}
		const group = unique("departure-hint");
		const asker = await harness.connect("a", unique("asker"), { group });
		const watcher = await harness.connect("a", unique("watcher"), { group });
		const recipient = await harness.connect("b", unique("recipient"), { group });
		const recipientId = recipient.sessionId;
		const listed = async (id: string) => (await watcher.client.listSessions()).some((session) => session.id === id);
		const askId = randomUUID();
		const sent = await asker.client.send(recipientId, { messageId: askId, text: "which port?", expectsReply: true });
		assert.equal(sent.delivered, true, sent.reason);

		// The asker is only away (its Atomic session restarts), and the recipient's broker has seen it go.
		const askerId = asker.sessionId;
		await asker.client.disconnect({ resumable: true });
		asker.disconnected = true;
		await vi.waitFor(
			async () =>
				assert.equal(
					(await recipient.client.listSessions()).some((session) => session.id === askerId),
					false,
				),
			WAIT,
		);
		assert.equal(await listed(recipientId), true);

		harness.holdPresenceRead(asker.returnAddress);
		try {
			// The recipient ends: its broker queues the away asker's failure, and the shared database is slow to say which
			// broker the asker is on.
			await harness.disconnect(recipient);
			await harness.presenceReadParked(asker.returnAddress);

			await vi.waitFor(async () => assert.equal(await listed(recipientId), false, "the ended recipient is listed"), {
				timeout: DEPARTED_WITHIN_MS,
				interval: 25,
			});
		} finally {
			harness.releasePresenceRead();
		}

		// The asker still gets its failure once it is back.
		const back = await harness.connect("a", asker.name, {
			group,
			returnAddress: asker.returnAddress,
			preferredSessionId: askerId,
		});
		await vi.waitFor(() => {
			const failure = back.received.find((frame) => frame.message.replyTo === askId);
			assert.equal(failure?.message.replyError, `Session "${recipient.name}" ended before replying`);
		}, WAIT);
	},
	TEST_TIMEOUT_MS,
);

test(
	"a queued reply to an away asker does not delay a reply to a live asker or the replier's departure (#5607)",
	async () => {
		assert.equal(harness.multiNodeRouting, true);
		const group = unique("queued-reply");
		const away = await harness.connect("a", unique("away"), { group });
		const live = await harness.connect("a", unique("live"), { group });
		const replier = await harness.connect("b", unique("replier"), { group });
		const awayId = away.sessionId;
		const replierId = replier.sessionId;
		const firstAsk = randomUUID();
		const secondAsk = randomUUID();
		for (const [asker, messageId] of [
			[away, firstAsk],
			[live, secondAsk],
		] as const) {
			const sent = await asker.client.send(replierId, { messageId, text: "which port?", expectsReply: true });
			assert.equal(sent.delivered, true, sent.reason);
		}
		await away.client.disconnect({ resumable: true });
		away.disconnected = true;
		await vi.waitFor(async () => {
			const peers = await replier.client.listSessions();
			assert.equal(
				peers.some((session) => session.id === awayId),
				false,
			);
		}, WAIT);

		harness.holdPresenceRead(away.returnAddress);
		try {
			const first = await replier.client.send(awayId, {
				replyTo: firstAsk,
				text: "3000",
				requirePendingReply: true,
			});
			assert.equal(first.queued, true, first.reason);

			const replyId = randomUUID();
			const second = await replier.client.send(live.sessionId, {
				messageId: replyId,
				replyTo: secondAsk,
				text: "4000",
				requirePendingReply: true,
			});
			assert.equal(second.delivered, true, second.reason);
			assert.equal(live.messagesWithId(replyId).length, 1);

			const listed = async () => (await live.client.listSessions()).some((session) => session.id === replierId);
			assert.equal(await listed(), true);
			await harness.disconnect(replier);
			await vi.waitFor(async () => assert.equal(await listed(), false), {
				timeout: DEPARTED_WITHIN_MS,
				interval: 25,
			});
		} finally {
			harness.releasePresenceRead();
		}
	},
	TEST_TIMEOUT_MS,
);
