/**
 * A subagent's supervisor capability that the broker refuses: real broker child process, the real Intercom extension
 * in a subagent child, a real supervisor client. A refusal that only lasts until the supervisor is back (it left before
 * the child registered, or a broker restart let the child reconnect first) ends with the child reaching its supervisor
 * through contact_supervisor.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, test, vi } from "vitest";
import { sleep } from "../helpers/runtime.js";
import {
	childPolicy,
	createSupervisorRefusalHarness,
	REAL_BROKER_REFUSAL_TIMEOUT_MS,
	registration,
} from "./intercom-supervisor-refusal-recovery-helpers.js";

const { fixture, IntercomClient, supervisor, startChild } = await createSupervisorRefusalHarness("supervisor-refusal-");

beforeAll(async () => {
	await fixture.startSourceBroker(20_000);
});
afterAll(() => fixture.cleanup());

test(
	"A: supervisor left before the child registered; child starts, then contact_supervisor after the supervisor is back",
	async () => {
		const childName = `subagent-worker-a${randomUUID().slice(0, 6)}-1`;
		const sup = await supervisor("refusal-supervisor-a");
		const supId = sup.client.sessionId!;
		const authorization = await sup.client.authorizeSupervisorChild(childName);
		await sup.client.disconnect();
		const child = startChild(childPolicy(childName, supId, authorization.capability, supId));
		const reported = await child.emit({ type: "session_start", reason: "startup" });
		assert.deepEqual(reported, [], "a refused capability never fails the child's start");
		// The supervisor's session reopens under its id and restores the capability, as a reopened stage does.
		const back = await supervisor("refusal-supervisor-a", sup.atomicId, supId, sup.ownerToken);
		await back.client.authorizeSupervisorChild(childName, authorization.capability);
		const text = await child.contactSupervisor("A-progress");
		await sleep(500);
		assert.ok(
			back.received.some((received) => received.includes("A-progress")),
			`contact_supervisor: ${text}`,
		);
	},
	REAL_BROKER_REFUSAL_TIMEOUT_MS,
);

test(
	"B: broker restart; the child reconnects before its supervisor restores the capability",
	async () => {
		const childName = `subagent-worker-b${randomUUID().slice(0, 6)}-1`;
		const sup = await supervisor("refusal-supervisor-b");
		const supId = sup.client.sessionId!;
		const authorization = await sup.client.authorizeSupervisorChild(childName);
		const child = startChild(childPolicy(childName, supId, authorization.capability, supId));
		const reported = await child.emit({ type: "session_start", reason: "startup" });
		assert.deepEqual(reported, []);
		const before = await child.contactSupervisor("B-before-restart");
		await sleep(300);
		assert.ok(
			sup.received.some((received) => received.includes("B-before-restart")),
			before,
		);

		// Broker restart: the broker dies; the supervisor stays away until the child has reconnected.
		const { stopDetachedBroker } = await import("../helpers/detached-broker.js");
		await fixture.stopBroker();
		await stopDetachedBroker(fixture.agentDir).catch(() => undefined);
		await sleep(200);
		// The child reconnects on its own backoff and spawns a successor broker; the supervisor stays away meanwhile.
		await sleep(6_000);
		const probe = new IntercomClient(randomUUID());
		await vi.waitFor(async () => probe.connect(registration(`refusal-probe-${randomUUID().slice(0, 4)}`)), {
			timeout: 20_000,
			interval: 250,
		});
		const back = await supervisor("refusal-supervisor-b", sup.atomicId, supId, sup.ownerToken);
		await back.client.authorizeSupervisorChild(childName, authorization.capability);
		// Give the child's own reconnect backoff time to try again with its capability.
		await sleep(15_000);
		const after = await child.contactSupervisor("B-after-restart");
		await sleep(500);
		await probe.disconnect().catch(() => undefined);
		assert.ok(
			back.received.some((received) => received.includes("B-after-restart")),
			`contact_supervisor: ${after}`,
		);
	},
	REAL_BROKER_REFUSAL_TIMEOUT_MS,
);
