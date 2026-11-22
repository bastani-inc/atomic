import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, vi } from "vitest";
import {
	TWO_BROKER_STORAGE_PREFIX,
	type TwoBrokerClient,
	TwoBrokerHarness,
	type TwoBrokerHarnessOptions,
	twoBrokerHarnessStartTimeoutMs,
} from "./intercom-two-broker-harness.js";

/**
 * #4997: with multi-node routing, an ask between two sessions on one broker moves to the shared state when one of them
 * leaves without ending. With a slow shared database that move takes a while: an ask answered, or whose broker crashes,
 * while it is under way still gets exactly one outcome.
 *
 * The scenarios are split by topic into `test/integration/intercom-multinode-away-routes-slow-store-*.test.ts`, each
 * file with two brokers of its own, so the files run beside each other instead of one after another in one worker.
 */

/** Every shared database call waits this long, as a remote database would, so the move is still under way. */
const DATABASE_CALL_DELAY_MS = 250;
const HARNESS_OPTIONS: TwoBrokerHarnessOptions = { databaseCallDelayMs: DATABASE_CALL_DELAY_MS };
/** Spawning two real broker processes is the structural cost of this suite. */
const REAL_BROKERS_HOOK_TIMEOUT_MS = twoBrokerHarnessStartTimeoutMs(HARNESS_OPTIONS);
/** A restart of broker b on the slow database, then the scenario's own moves, sends and waits. */
export const REAL_BROKERS_TEST_TIMEOUT_MS =
	twoBrokerHarnessStartTimeoutMs({ ...HARNESS_OPTIONS, nodes: ["b"] }) + 60_000;
export const WAIT = { timeout: 30_000, interval: 25 };
/** How long an outcome that must not arrive, or must not arrive twice, is given to show up. */
const SETTLE_MS = 2_000;

/** The calling file's two brokers over one slow shared database, started by `useSlowStoreBrokers`. */
export let harness: TwoBrokerHarness;

/** Start the calling file's two brokers before its first test, restart a stopped one before each test, and clean up. */
export function useSlowStoreBrokers(): void {
	beforeAll(async () => {
		harness = await TwoBrokerHarness.start(HARNESS_OPTIONS);
	}, REAL_BROKERS_HOOK_TIMEOUT_MS);
	afterAll(() => harness?.cleanup(), REAL_BROKERS_HOOK_TIMEOUT_MS);
	beforeEach(() => harness.ensureBrokersRunning(), REAL_BROKERS_HOOK_TIMEOUT_MS);
}

export const unique = (label: string): string => `${label}-${randomUUID().slice(0, 8)}`;
export const settle = () => new Promise((resolveDelay) => setTimeout(resolveDelay, SETTLE_MS));

/** Every outcome the asker's connections saw for one ask: replies, failed-ask replies, and peer disconnects. */
export function outcomeLog(askId: string) {
	const outcomes: string[] = [];
	return {
		outcomes,
		watch(client: TwoBrokerClient) {
			client.client.on("message", (_from: unknown, message: { replyTo?: string; replyError?: string }) => {
				if (message.replyTo === askId) outcomes.push(message.replyError === undefined ? "reply" : "failed");
			});
			client.client.on("peer_disconnected", (notice: { replyTo?: string }) => {
				if (notice.replyTo === askId) outcomes.push("peer_disconnected");
			});
		},
	};
}

/** An asker and a recipient on node b, and an ask the recipient has. */
export async function askOnOneBroker(log: ReturnType<typeof outcomeLog>, askId: string) {
	const group = unique("g");
	const asker = await harness.connect("b", unique("asker"), { group, beforeConnect: (client) => log.watch(client) });
	const recipient = await harness.connect("b", unique("recipient"), { group });
	const sent = await asker.client.send(recipient.sessionId, { messageId: askId, text: "q?", expectsReply: true });
	assert.equal(sent.delivered, true, sent.reason);
	await vi.waitFor(() => assert.equal(recipient.messagesWithId(askId).length, 1), WAIT);
	return { asker, recipient };
}

/**
 * Gives back the ids that crashed broker b still owns, as broker a does when a claim finds one held by a broker that
 * exited on its host. On this database that retirement and the claim around it take four round trips: a claim that
 * finds the id held waits about 2.5 s here, past its bound on a loaded machine, and the session then comes back under
 * a fresh id. Given back first, a claim binds the id in one.
 */
export async function retireCrashedOwners(...sessionIds: readonly string[]): Promise<void> {
	const shared = await harness.openSharedStorage("a");
	await shared.run(
		`UPDATE ${TWO_BROKER_STORAGE_PREFIX}intercom_session_bindings
		 SET owner_token = NULL, owner_broker = NULL, owner_renewed_at = NULL
		 WHERE intercom_session_id IN (${sessionIds.map(() => "?").join(", ")})`,
		...sessionIds,
	);
}

/** The session leaves without ending, so it may resume. */
export async function leaveResumably(session: TwoBrokerClient): Promise<void> {
	await session.client.disconnect({ resumable: true });
	session.disconnected = true;
}

/** The session connects to node b again under the same identity. */
export function rejoin(session: TwoBrokerClient, sessionId: string, beforeConnect?: (client: TwoBrokerClient) => void) {
	return harness.connect("b", session.name, {
		group: session.group,
		returnAddress: session.returnAddress,
		preferredSessionId: sessionId,
		...(beforeConnect === undefined ? {} : { beforeConnect }),
	});
}

export function reply(from: TwoBrokerClient, askerId: string, askId: string) {
	return from.client.send(askerId, {
		text: "answer",
		replyTo: askId,
		requirePendingReply: true,
		expectedRecipientId: askerId,
	});
}
