import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import {
	type ReceivedFrame,
	TWO_BROKER_HARNESS_START_TIMEOUT_MS,
	type TwoBrokerClient,
} from "../helpers/intercom-two-broker-harness.js";

/** Spawning two real broker processes (and restarting them) is the structural cost of this suite. */
export const REAL_BROKERS_HOOK_TIMEOUT_MS = TWO_BROKER_HARNESS_START_TIMEOUT_MS;
/** Headroom on top of the lease, claim and poll windows a cross-node recovery has to wait out. */
export const RECOVERY_MARGIN_MS = 30_000;
export const DELIVERY_WAIT_MS = 15_000;

export const unique = (label: string): string => `${label}-${randomUUID().slice(0, 8)}`;

export async function waitForMessage(
	client: TwoBrokerClient,
	id: string,
	timeout = DELIVERY_WAIT_MS,
): Promise<ReceivedFrame> {
	return vi.waitFor(
		() => {
			const [frame] = client.messagesWithId(id);
			assert.ok(frame, `${client.name} has not received ${id}`);
			return frame;
		},
		{ timeout, interval: 25 },
	);
}

/** Without advertised routing, a session on the other broker is unknown and nothing crosses nodes. */
export async function assertUnrouted(from: TwoBrokerClient, to: TwoBrokerClient): Promise<void> {
	const result = await from.client.send(to.sessionId, { text: "single-node probe" });
	assert.equal(result.delivered, false);
	assert.equal(result.queued, undefined);
	assert.equal(result.reason, "Session not found");
	assert.deepEqual(to.received, []);
}

/** The same-id retry is answered from the outbox row, so it settles once the row is delivered (spec §6). */
export async function confirmDelivered(
	sender: TwoBrokerClient,
	to: string,
	text: string,
	messageId: string,
	timeout: number,
): Promise<void> {
	await vi.waitFor(
		async () => {
			const result = await sender.client.send(to, { text, messageId });
			assert.equal(result.delivered, true, JSON.stringify(result));
		},
		{ timeout, interval: 500 },
	);
}
