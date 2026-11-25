/**
 * A subagent's forged or foreign supervisor capability stays refused, never claims held sends, and never fails the
 * child's start: real broker child process, the real Intercom extension in a subagent child, a real supervisor client.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, test } from "vitest";
import { sleep } from "../helpers/runtime.js";
import {
	childPolicy,
	createSupervisorRefusalHarness,
	REAL_BROKER_REFUSAL_TIMEOUT_MS,
} from "./intercom-supervisor-refusal-recovery-helpers.js";

const { fixture, supervisor, startChild } = await createSupervisorRefusalHarness("supervisor-refusal-f-");

beforeAll(async () => {
	await fixture.startSourceBroker(20_000);
});
afterAll(() => fixture.cleanup());

test(
	"C: a forged or foreign capability is still refused: no supervisor channel, no held sends, no startup crash",
	async () => {
		const childName = `subagent-worker-c${randomUUID().slice(0, 6)}-1`;
		const otherName = `subagent-worker-o${randomUUID().slice(0, 6)}-1`;
		const sup = await supervisor("refusal-supervisor-c");
		const supId = sup.client.sessionId!;
		const authorization = await sup.client.authorizeSupervisorChild(childName);
		// The real child's starting hold, as holdStartingChild makes it.
		await sup.client.reserveRestoringRecipient(authorization.capability, { group: "default", holdMs: 600_000 });
		const peer = await supervisor("refusal-peer-c");
		let heldOutcome: unknown;
		const held = peer.client.send(childName, { text: "C-held-for-the-real-child" }).then((result) => {
			heldOutcome = result;
			return result;
		});
		await sleep(300);
		// A forged capability under the real child's name, and a foreign one (issued for another child).
		const forger = startChild(childPolicy(childName, supId, `${randomUUID()}.AAAAforgedmacAAAA`, supId));
		const forgedStart = await forger.emit({ type: "session_start", reason: "startup" });
		const foreignAuth = await sup.client.authorizeSupervisorChild(otherName);
		const foreign = startChild(childPolicy(childName, supId, foreignAuth.capability, supId));
		const foreignStart = await foreign.emit({ type: "session_start", reason: "startup" });
		await sleep(500);
		const forgedContact = await forger.contactSupervisor("C-forged");
		const foreignContact = await foreign.contactSupervisor("C-foreign");
		await sleep(300);
		assert.deepEqual(forgedStart, []);
		assert.deepEqual(foreignStart, []);
		assert.match(forgedContact, /Supervisor channel is not authorized/);
		assert.match(foreignContact, /Supervisor channel is not authorized/);
		assert.equal(heldOutcome, undefined, "the held send was not handed to a session that proved nothing");
		assert.deepEqual(sup.received, []);
		await sup.client
			.releaseRestoringRecipient(authorization.capability, { refusal: "audit cleanup" })
			.catch(() => undefined);
		await held.catch(() => undefined);
	},
	REAL_BROKER_REFUSAL_TIMEOUT_MS,
);
