import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, test, vi } from "vitest";
import { sleep } from "../helpers/runtime.js";
import {
	BROKER_START_HOOK_TIMEOUT_MS,
	type Client,
	createAskFailureReceiptsHarness,
	failuresOf,
	idOf,
	REAL_BROKER_TEST_TIMEOUT_MS,
	type ReleasedChildReply,
	SETTLE_MS,
	type Session,
	WAIT,
} from "./intercom-ask-failure-receipts-helpers.js";

const harness = await createAskFailureReceiptsHarness("ask-failure-receipts-");
const { connect, runAskerDiesScenario } = harness;

/** How a connected recipient stops being able to answer. */
const RECIPIENT_FAILURES = [
	{ how: "ends", reason: /ended before replying/, fail: (client: Client) => client.disconnect() },
	{
		how: "becomes terminal",
		reason: /./,
		fail: async (client: Client) => {
			client.updatePresence({ replyCapability: "terminal" });
		},
	},
] as const;

/** An asker asks a connected recipient twice, which then fails both asks while the asker is connected. */
async function askThenFail(
	label: string,
	asker: { confirms?: boolean; acknowledgesReceipt?: boolean; returnAddress?: string },
	fail: (client: Client) => Promise<void>,
) {
	const askerAddress = { name: `asker-${label}`, returnAddress: asker.returnAddress ?? randomUUID() };
	const first = await connect(askerAddress.name, { ...asker, ...askerAddress });
	const askerId = idOf(first.client);
	const recipient = await connect(`recipient-${label}`, { returnAddress: randomUUID() });
	const questionIds = [randomUUID(), randomUUID()] as const;
	for (const messageId of questionIds) {
		const asked = await first.client.send(`recipient-${label}`, {
			messageId,
			text: "which port?",
			expectsReply: true,
		});
		assert.equal(asked.delivered, true, asked.reason);
	}
	await vi.waitFor(
		() => assert.ok(questionIds.every((id) => recipient.received.some((message) => message.id === id))),
		WAIT,
	);
	await fail(recipient.client);
	await vi.waitFor(() => {
		for (const id of questionIds) assert.equal(failuresOf(first, id).length, 1);
	}, WAIT);
	return { askerAddress, askerId, first, questionId: questionIds[0], otherQuestionId: questionIds[1] };
}

beforeAll(() => harness.startBroker(), BROKER_START_HOOK_TIMEOUT_MS);
afterAll(() => harness.cleanup());

for (const { how, reason, fail } of RECIPIENT_FAILURES) {
	test(
		`an asker that drops before saving the failure of an ask whose recipient ${how} gets it again once it is back, once (#5004)`,
		async () => {
			const label = `unsaved-${how.replace(/\W/g, "-")}-5004`;
			const { askerAddress, askerId, first, questionId, otherQuestionId } = await askThenFail(
				label,
				{ confirms: false },
				fail,
			);
			const [failureId] = failuresOf(first, questionId);
			const [otherFailureId] = failuresOf(first, otherQuestionId);
			assert.notEqual(failureId, "peer_disconnected", "a receipt-confirming asker is sent a failure it can confirm");

			// The asker crashes before saving it: its connection drops without confirming, and its session comes back.
			await first.client.disconnect({ resumable: true });
			await sleep(SETTLE_MS);
			const back = await connect(askerAddress.name, { ...askerAddress, preferredSessionId: askerId });
			assert.equal(idOf(back.client), askerId);
			// Each ask's failure comes back, once.
			await vi.waitFor(() => {
				assert.deepEqual(failuresOf(back, questionId), [failureId]);
				assert.deepEqual(failuresOf(back, otherQuestionId), [otherFailureId]);
			}, WAIT);
			assert.match(back.received.find((message) => message.id === failureId)?.replyError ?? "", reason);

			// Saved this time: it is not sent again.
			await back.client.disconnect({ resumable: true });
			await sleep(SETTLE_MS);
			const again = await connect(askerAddress.name, { ...askerAddress, preferredSessionId: askerId });
			await sleep(SETTLE_MS);
			assert.deepEqual(failuresOf(again, questionId), [], "a saved failure is delivered once");
		},
		REAL_BROKER_TEST_TIMEOUT_MS,
	);

	test(
		`an asker that saved the failure of an ask whose recipient ${how} is not sent it again (#5004)`,
		async () => {
			const label = `saved-${how.replace(/\W/g, "-")}-5004`;
			const { askerAddress, askerId, first, questionId } = await askThenFail(label, {}, fail);
			await sleep(SETTLE_MS);
			await first.client.disconnect({ resumable: true });
			await sleep(SETTLE_MS);
			const back = await connect(askerAddress.name, { ...askerAddress, preferredSessionId: askerId });
			await sleep(SETTLE_MS);
			assert.deepEqual(failuresOf(back, questionId), []);
		},
		REAL_BROKER_TEST_TIMEOUT_MS,
	);
}

test(
	"an asker that does not confirm saves gets the recipient-ended notice it always got, once (#5004)",
	async () => {
		const label = "old-client-5004";
		const { askerAddress, askerId, first, questionId } = await askThenFail(
			label,
			{ acknowledgesReceipt: false },
			(client) => client.disconnect(),
		);
		assert.deepEqual(failuresOf(first, questionId), ["peer_disconnected"]);
		await first.client.disconnect({ resumable: true });
		await sleep(SETTLE_MS);
		const back = await connect(askerAddress.name, {
			...askerAddress,
			preferredSessionId: askerId,
			acknowledgesReceipt: false,
		});
		await sleep(SETTLE_MS);
		assert.deepEqual(failuresOf(back, questionId), []);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a woken released subagent that drops before saving its held failed ask gets it again once it is back, once (#5004)",
	async () => {
		const childName = "subagent-unsaved-failure-5004";
		const owner = await connect("owner-unsaved-failure-5004", {
			returnAddress: randomUUID(),
			ownerToken: randomUUID(),
		});
		const child = { name: childName, returnAddress: randomUUID() };
		const childFirst = await connect(childName, {
			...child,
			supervisor: await owner.client.authorizeSupervisorChild(childName),
		});
		const childId = idOf(childFirst.client);
		const recipient = await connect("recipient-unsaved-failure-5004", { returnAddress: randomUUID() });
		const questionId = randomUUID();
		const asked = await childFirst.client.send("recipient-unsaved-failure-5004", {
			messageId: questionId,
			text: "which port?",
			expectsReply: true,
		});
		assert.equal(asked.delivered, true, asked.reason);
		await vi.waitFor(() => assert.ok(recipient.received.some((message) => message.id === questionId)), WAIT);

		// The child is released; its owner hands the failure back to it when the recipient ends, and wakes it.
		await owner.client.reserveReleasedChildren([{ childName, wake: true }]);
		await childFirst.client.disconnect();
		owner.client.on("released_child_reply", (notice: ReleasedChildReply) => {
			owner.client.acknowledgeReleasedChildReply(notice, false, true);
		});
		const wakes: string[] = [];
		owner.client.on("restoring_recipient_wake", (notice: { childName: string }) => wakes.push(notice.childName));
		await recipient.client.disconnect();
		await vi.waitFor(() => assert.deepEqual(wakes, [childName]), WAIT);

		// The woken child gets the failure, then dies before saving it.
		const woken = await connect(childName, {
			...child,
			preferredSessionId: childId,
			confirms: false,
			supervisor: await owner.client.authorizeSupervisorChild(childName),
		});
		await vi.waitFor(() => assert.equal(failuresOf(woken, questionId).length, 1), WAIT);
		const [failureId] = failuresOf(woken, questionId);
		await woken.client.disconnect({ resumable: true });
		await sleep(SETTLE_MS);

		// Back again, it gets the failure once more; saved this time, never again.
		const back = await connect(childName, {
			...child,
			preferredSessionId: childId,
			supervisor: await owner.client.authorizeSupervisorChild(childName),
		});
		await vi.waitFor(() => assert.deepEqual(failuresOf(back, questionId), [failureId]), WAIT);
		assert.match(
			back.received.find((message) => message.id === failureId)?.replyError ?? "",
			/ended before replying/,
		);
		await back.client.disconnect({ resumable: true });
		await sleep(SETTLE_MS);
		const again = await connect(childName, {
			...child,
			preferredSessionId: childId,
			supervisor: await owner.client.authorizeSupervisorChild(childName),
		});
		await sleep(SETTLE_MS);
		assert.deepEqual(failuresOf(again, questionId), [], "a saved failure is delivered once");
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"an asker that drops before saving the failure of its ask to a released subagent whose owner ended gets it again once it is back, once (#5004)",
	async () => {
		const childName = "subagent-parked-owner-ends-5004";
		const owner = await connect("owner-parked-owner-ends-5004", {
			returnAddress: randomUUID(),
			ownerToken: randomUUID(),
		});
		const child = await connect(childName, {
			returnAddress: randomUUID(),
			supervisor: await owner.client.authorizeSupervisorChild(childName),
		});
		const childId = idOf(child.client);
		const askerAddress = { name: "asker-parked-owner-ends-5004", returnAddress: randomUUID() };
		const first = await connect(askerAddress.name, { ...askerAddress, confirms: false });
		const askerId = idOf(first.client);
		const questionId = randomUUID();
		const asked = await first.client.send(childName, {
			messageId: questionId,
			text: "which port?",
			expectsReply: true,
		});
		assert.equal(asked.delivered, true, asked.reason);
		await vi.waitFor(() => assert.ok(child.received.some((message) => message.id === questionId)), WAIT);

		// The subagent is released with the ask open, then its owner ends for good: the ask can never be answered.
		await owner.client.reserveReleasedChildren([{ childName, wake: false }]);
		await child.client.disconnect();
		await vi.waitFor(
			async () => assert.ok(!(await owner.client.listSessions()).some((session) => session.id === childId)),
			WAIT,
		);
		await owner.client.disconnect();
		await vi.waitFor(() => assert.equal(failuresOf(first, questionId).length, 1), WAIT);
		const [failureId] = failuresOf(first, questionId);
		assert.equal(
			first.received.find((message) => message.id === failureId)?.replyError,
			`Session "${childId}" ended before replying`,
		);

		// The asker crashes before saving it, and comes back.
		await first.client.disconnect({ resumable: true });
		await sleep(SETTLE_MS);
		const back = await connect(askerAddress.name, { ...askerAddress, preferredSessionId: askerId });
		await vi.waitFor(() => assert.deepEqual(failuresOf(back, questionId), [failureId]), WAIT);
		await back.client.disconnect({ resumable: true });
		await sleep(SETTLE_MS);
		const again = await connect(askerAddress.name, { ...askerAddress, preferredSessionId: askerId });
		await sleep(SETTLE_MS);
		assert.deepEqual(failuresOf(again, questionId), [], "a saved failure is delivered once");
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

/** A subagent asked while it runs, released by its owner, gone, and then dropped by its owner: its ask is parked. */
async function askReleasedSubagentThenDropIt(
	label: string,
	asker: Session,
): Promise<{ childName: string; questionId: string }> {
	const childName = `subagent-${label}`;
	const owner = await connect(`owner-${label}`, { returnAddress: randomUUID(), ownerToken: randomUUID() });
	const child = await connect(childName, {
		returnAddress: randomUUID(),
		supervisor: await owner.client.authorizeSupervisorChild(childName),
	});
	const childId = idOf(child.client);
	const questionId = randomUUID();
	const asked = await asker.client.send(childName, { messageId: questionId, text: "which port?", expectsReply: true });
	assert.equal(asked.delivered, true, asked.reason);
	await vi.waitFor(() => assert.ok(child.received.some((message) => message.id === questionId)), WAIT);
	await owner.client.reserveReleasedChildren([{ childName, wake: false }]);
	await child.client.disconnect();
	await vi.waitFor(
		async () => assert.ok(!(await owner.client.listSessions()).some((session) => session.id === childId)),
		WAIT,
	);
	await owner.client.dropReleasedChildren([childName], { gone: "its session file was deleted" });
	return { childName, questionId };
}

test(
	"an asker whose ask to a released subagent ends when the owner drops the subagent gets one failure naming it, and stays connected (#6131)",
	async () => {
		const label = "dropped-parked-6131";
		const askerAddress = { name: `asker-${label}`, returnAddress: randomUUID() };
		const asker = await connect(askerAddress.name, askerAddress);
		const askerId = idOf(asker.client);
		const protocolErrors: string[] = [];
		asker.client.on("error", (error: Error) => protocolErrors.push(error.message));
		const { childName, questionId } = await askReleasedSubagentThenDropIt(label, asker);

		await vi.waitFor(() => assert.equal(failuresOf(asker, questionId).length, 1), WAIT);
		const [failureId] = failuresOf(asker, questionId);
		assert.equal(
			asker.received.find((message) => message.id === failureId)?.replyError,
			`Session "${childName}" ended before replying`,
		);
		await sleep(SETTLE_MS);
		assert.deepEqual(protocolErrors, []);
		assert.equal(asker.client.sessionId, askerId, "the asker is still registered");

		// It was saved: back again, the asker is not sent it again.
		await asker.client.disconnect({ resumable: true });
		await sleep(SETTLE_MS);
		const back = await connect(askerAddress.name, { ...askerAddress, preferredSessionId: askerId });
		await sleep(SETTLE_MS);
		assert.deepEqual(failuresOf(back, questionId), []);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"an asker that does not confirm saves is told the dropped released subagent it asked has gone, by name (#6131)",
	async () => {
		const label = "dropped-parked-old-client-6131";
		const asker = await connect(`asker-${label}`, { returnAddress: randomUUID(), acknowledgesReceipt: false });
		const notices: { replyTo: string; peerName?: string }[] = [];
		asker.client.on("peer_disconnected", (notice: { replyTo: string; peerName?: string }) => notices.push(notice));
		const { childName, questionId } = await askReleasedSubagentThenDropIt(label, asker);

		await vi.waitFor(() => assert.deepEqual(failuresOf(asker, questionId), ["peer_disconnected"]), WAIT);
		assert.deepEqual(
			notices.map((notice) => ({ replyTo: notice.replyTo, peerName: notice.peerName })),
			[{ replyTo: questionId, peerName: childName }],
		);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"an asker whose connection dies before the reply while its recipient ends gets one outcome once it is back, every time (#5095)",
	async () => {
		await runAskerDiesScenario(0, "before the reply");
	},
	REAL_BROKER_TEST_TIMEOUT_MS * 3,
);
