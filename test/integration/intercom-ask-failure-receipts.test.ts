import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, test, vi } from "vitest";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";
import { sleep } from "../helpers/runtime.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const brokerFixture = new IntercomBrokerFixture(mkdtempSync(join(tmpdir(), "ask-failure-receipts-")));
brokerFixture.overrideAgentDir();
const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");
const { getJitiCliPath } = await import("../../packages/intercom/broker/spawn.js");
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");

type Client = InstanceType<typeof IntercomClient>;
type Message = import("../../packages/intercom/types.js").Message;
type ReleasedChildReply = import("../../packages/intercom/broker/client.js").ReleasedChildReply;

/** Spawning the real broker child is the structural cost of this suite. */
const REAL_BROKER_TEST_TIMEOUT_MS = 60_000;
const WAIT = { timeout: 10_000, interval: 20 };
/**
 * Structural: the broker child compiles its TypeScript through jiti before it answers, which took longer than
 * {@link WAIT} on a loaded Windows host (#5252).
 */
const BROKER_START_WAIT_MS = 90_000;
/** Starting the broker waits for it, then has room to fail with its own message. */
const BROKER_START_HOOK_TIMEOUT_MS = BROKER_START_WAIT_MS + 5_000;
/** Long enough for a frame the broker wrote to arrive, so its absence means none was written. */
const SETTLE_MS = 300;

let broker: ChildProcess | undefined;

async function startBroker(): Promise<void> {
	const extensionDir = join(repoRoot, "packages/intercom");
	broker = spawn(process.execPath, [getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")], {
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: brokerFixture.agentDir },
		stdio: "ignore",
	});
	brokerFixture.trackBroker(broker);
	// A broker retires once no session has been connected for 5 s since it listened. Under load the suite can spend that
	// long before its own sessions register, so the fixture holds a session for this broker until cleanup.
	await brokerFixture.holdSession(getBrokerSocketPath(process.platform, brokerFixture.agentDir), BROKER_START_WAIT_MS);
}

interface Session {
	readonly client: Client;
	/** Every message that arrived, whether or not it was confirmed. */
	readonly received: Message[];
	/** Asks whose recipient the broker said disconnected (the notice an old client gets). */
	readonly peerGone: string[];
}

/**
 * A real client. `confirms`: it confirms each save, as a session does; without it, it receives frames but never
 * confirms one, as an asker that crashes before saving. `acknowledgesReceipt: false` is a client from before #3761.
 */
async function connect(
	name: string,
	options: {
		returnAddress: string;
		preferredSessionId?: string;
		confirms?: boolean;
		acknowledgesReceipt?: boolean;
		ownerToken?: string;
		supervisor?: { capability: string; supervisorSessionId: string };
	},
): Promise<Session> {
	const client = new IntercomClient(options.returnAddress, {
		...(options.acknowledgesReceipt === false ? {} : { acknowledgesReceipt: true }),
		...(options.preferredSessionId === undefined ? {} : { preferredSessionId: options.preferredSessionId }),
	});
	const received: Message[] = [];
	const peerGone: string[] = [];
	client.on("message", (_from: object, message: Message) => {
		received.push(message);
		if (options.confirms !== false && options.acknowledgesReceipt !== false) client.acknowledgeReceived(message.id);
	});
	client.on("peer_disconnected", (notice: { replyTo: string }) => peerGone.push(notice.replyTo));
	client.on("error", () => {});
	await client.connect(
		{
			name,
			model: "test-model",
			cwd: repoRoot,
			pid: process.pid,
			status: "idle",
			startedAt: Date.now(),
			lastActivity: Date.now(),
		},
		options.supervisor,
		options.ownerToken,
	);
	brokerFixture.onCleanup(() => client.disconnect().catch(() => undefined));
	return { client, received, peerGone };
}

function idOf(client: Client): string {
	const id = client.sessionId;
	assert.ok(id);
	return id;
}

/** The failures of `questionId` that reached the session, however they arrived. */
function failuresOf(session: Session, questionId: string): string[] {
	return [
		...session.received
			.filter((message) => message.replyTo === questionId && message.replyError !== undefined)
			.map((message) => message.id),
		...session.peerGone.filter((replyTo) => replyTo === questionId).map(() => "peer_disconnected"),
	];
}

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

beforeAll(startBroker, BROKER_START_HOOK_TIMEOUT_MS);
afterAll(() => brokerFixture.cleanup());

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

/** The recipient answers `questionId` on the ask's own reply route, as the `reply` action does. */
function replyTo(recipient: Session, askerId: string, questionId: string) {
	return recipient.client.send(askerId, {
		text: "port 8080",
		replyTo: questionId,
		requirePendingReply: true,
		expectedRecipientId: askerId,
	});
}

/** The replies to `questionId` that reached the session. */
function repliesTo(session: Session, questionId: string): Message[] {
	return session.received.filter((message) => message.replyTo === questionId && message.replyError === undefined);
}

/** How many times the recipient replies and ends at once: the race lost about half the time before the fix. */
const REPLY_THEN_END_ITERATIONS = 30;

test(
	"an asker whose recipient replies and ends at once gets only the reply, every time (#5095)",
	async () => {
		const outcomes: string[] = [];
		for (let iteration = 0; iteration < REPLY_THEN_END_ITERATIONS; iteration++) {
			const label = `reply-then-end-${iteration}-5095`;
			const asker = await connect(`asker-${label}`, { returnAddress: randomUUID() });
			const askerId = idOf(asker.client);
			const recipient = await connect(`recipient-${label}`, { returnAddress: randomUUID() });
			const questionId = randomUUID();
			const asked = await asker.client.send(`recipient-${label}`, {
				messageId: questionId,
				text: "which port?",
				expectsReply: true,
			});
			assert.equal(asked.delivered, true, asked.reason);
			await vi.waitFor(() => assert.ok(recipient.received.some((message) => message.id === questionId)), WAIT);

			// The recipient replies and ends without waiting for the reply to be confirmed.
			const replying = replyTo(recipient, askerId, questionId).catch(() => undefined);
			void recipient.client.disconnect();
			await replying;
			await vi.waitFor(() => assert.equal(repliesTo(asker, questionId).length, 1), WAIT);
			await sleep(SETTLE_MS);
			outcomes.push(
				`#${iteration}: replies=${repliesTo(asker, questionId).length} failures=${failuresOf(asker, questionId).length}`,
			);
			await asker.client.disconnect();
		}
		assert.deepEqual(
			outcomes,
			outcomes.map((_, iteration) => `#${iteration}: replies=1 failures=0`),
			"each ask has exactly one outcome: its reply",
		);
	},
	REAL_BROKER_TEST_TIMEOUT_MS * 3,
);

test(
	"a recipient that ends while its reply waits for the asker to save it fails only the ask it did not answer, once (#5095)",
	async () => {
		const label = "reply-unsaved-then-end-5095";
		// The asker saves nothing yet, so the reply is still on its way when the recipient ends.
		const asker = await connect(`asker-${label}`, { returnAddress: randomUUID(), confirms: false });
		const askerId = idOf(asker.client);
		const recipient = await connect(`recipient-${label}`, { returnAddress: randomUUID() });
		const [answered, unanswered] = [randomUUID(), randomUUID()] as const;
		for (const messageId of [answered, unanswered]) {
			const asked = await asker.client.send(`recipient-${label}`, {
				messageId,
				text: "which port?",
				expectsReply: true,
			});
			assert.equal(asked.delivered, true, asked.reason);
		}
		await vi.waitFor(() => assert.ok(recipient.received.some((message) => message.id === unanswered)), WAIT);

		const replying = replyTo(recipient, askerId, answered).catch(() => undefined);
		await vi.waitFor(() => assert.equal(repliesTo(asker, answered).length, 1), WAIT);
		await recipient.client.disconnect();
		await vi.waitFor(() => assert.equal(failuresOf(asker, unanswered).length, 1), WAIT);
		for (const message of asker.received) asker.client.acknowledgeReceived(message.id);
		await replying;
		await sleep(SETTLE_MS);

		assert.deepEqual(failuresOf(asker, answered), [], "an answered ask is not also failed");
		assert.equal(repliesTo(asker, answered).length, 1);
		assert.deepEqual(failuresOf(asker, unanswered), [`ended:${unanswered}`], "an unanswered ask still fails, once");
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

/** How the asker's connection dies around its recipient's reply. */
const ASKER_DIES = ["before the reply", "just after the reply", "as the reply is sent"] as const;
const ASKER_DIES_ITERATIONS = 30;
/** How long the asker takes to come back. */
const ASKER_RESTART_MS = 1_000;
/**
 * How long an ask's outcome may take to arrive once its asker is back. Generous, so a stalled CI machine shows up as
 * a slow outcome in the log rather than as a lost one; an outcome that never arrives still fails the test.
 */
const OUTCOME_WAIT = { timeout: 30_000, interval: 20 };

for (const [mode, when] of ASKER_DIES.entries()) {
	test(
		`an asker whose connection dies ${when} while its recipient ends gets one outcome once it is back, every time (#5095)`,
		async () => {
			const outcomes: string[] = [];
			const outcomeMsByIteration: number[] = [];
			// Sees which sessions the broker still lists, so the asker comes back only once both departures were handled.
			const observer = await connect(`observer-${mode}-5095`, { returnAddress: randomUUID() });
			for (let iteration = 0; iteration < ASKER_DIES_ITERATIONS; iteration++) {
				const label = `asker-dies-${mode}-${iteration}-5095`;
				const askerAddress = { name: `asker-${label}`, returnAddress: randomUUID() };
				const asker = await connect(askerAddress.name, askerAddress);
				const askerId = idOf(asker.client);
				const recipient = await connect(`recipient-${label}`, { returnAddress: randomUUID() });
				const recipientId = idOf(recipient.client);
				const questionId = randomUUID();
				const asked = await asker.client.send(`recipient-${label}`, {
					messageId: questionId,
					text: "which port?",
					expectsReply: true,
				});
				assert.equal(asked.delivered, true, asked.reason);
				await vi.waitFor(() => assert.ok(recipient.received.some((message) => message.id === questionId)), WAIT);

				// The asker's connection dies around the reply, as a crashing process's does; the recipient ends at once.
				const socket = (asker.client as unknown as { socket: net.Socket | null }).socket;
				if (mode === 0) socket?.destroy();
				const replying = replyTo(recipient, askerId, questionId).catch(() => undefined);
				if (mode === 1) await sleep(1);
				if (mode !== 0) socket?.destroy();
				void recipient.client.disconnect().catch(() => undefined);
				await replying;
				// Its process restarts, as p28 does, after both departures were handled: on a loaded host the broker can
				// take longer than the restart to handle them, so wait for it to list neither session.
				await vi.waitFor(async () => {
					const listed = (await observer.client.listSessions()).map((session) => session.id);
					assert.ok(!listed.includes(askerId) && !listed.includes(recipientId), "both departures were handled");
				}, WAIT);
				await sleep(ASKER_RESTART_MS);
				const back = await connect(askerAddress.name, { ...askerAddress, preferredSessionId: askerId });
				const backAt = Date.now();
				const seen = () =>
					new Set(
						[...asker.received, ...back.received]
							.filter((message) => message.replyTo === questionId)
							.map((message) => (message.replyError === undefined ? "reply" : "failure")),
					);
				await vi
					.waitFor(() => assert.ok(seen().size > 0, "the ask has an outcome"), OUTCOME_WAIT)
					.catch(() => undefined);
				const outcomeMs = Date.now() - backAt;
				await sleep(SETTLE_MS);
				const ids = new Set(
					[...asker.received, ...back.received].filter((m) => m.replyTo === questionId).map((m) => m.id),
				);
				outcomes.push(
					ids.size === 1
						? `#${iteration}: outcomes=1`
						: `#${iteration}: outcomes=${ids.size} after ${outcomeMs} ms before=${JSON.stringify(asker.received.filter((m) => m.replyTo === questionId).map((m) => m.id.slice(0, 12)))} back=${JSON.stringify(back.received.filter((m) => m.replyTo === questionId).map((m) => m.id.slice(0, 12)))}`,
				);
				outcomeMsByIteration.push(outcomeMs);
				await back.client.disconnect();
			}
			// How long each outcome took once the asker was back, so a slow one is visible in the log.
			process.stderr.write(`asker dies ${when}: outcome ms per iteration ${JSON.stringify(outcomeMsByIteration)}\n`);
			assert.deepEqual(
				outcomes,
				outcomes.map((_, iteration) => `#${iteration}: outcomes=1`),
				"each ask has exactly one outcome, the reply or the failure",
			);
		},
		REAL_BROKER_TEST_TIMEOUT_MS * 3,
	);
}

test(
	"an ask answered while its recipient was away cannot be answered again when that recipient is back (#5095)",
	async () => {
		const label = "answered-while-away-5095";
		const asker = await connect(`asker-${label}`, { returnAddress: randomUUID(), confirms: false });
		const askerId = idOf(asker.client);
		const recipientAddress = { name: `recipient-${label}`, returnAddress: randomUUID() };
		const recipient = await connect(recipientAddress.name, recipientAddress);
		const recipientId = idOf(recipient.client);
		const questionId = randomUUID();
		const asked = await asker.client.send(recipientAddress.name, {
			messageId: questionId,
			text: "which port?",
			expectsReply: true,
		});
		assert.equal(asked.delivered, true, asked.reason);
		await vi.waitFor(() => assert.ok(recipient.received.some((message) => message.id === questionId)), WAIT);

		// The recipient replies and goes away before the asker saves the reply; the asker saves it then.
		const replying = replyTo(recipient, askerId, questionId).catch(() => undefined);
		await vi.waitFor(() => assert.equal(repliesTo(asker, questionId).length, 1), WAIT);
		await recipient.client.disconnect({ resumable: true });
		await sleep(SETTLE_MS);
		asker.client.acknowledgeReceived(repliesTo(asker, questionId)[0]?.id ?? "");
		await replying;
		await sleep(SETTLE_MS);

		const back = await connect(recipientAddress.name, { ...recipientAddress, preferredSessionId: recipientId });
		assert.equal(idOf(back.client), recipientId);
		const again = await replyTo(back, askerId, questionId).catch((error: Error) => ({
			delivered: false,
			reason: error.message,
		}));
		assert.equal(again.delivered, false, "an answered ask is not answered again");
		await back.client.disconnect();
		await sleep(SETTLE_MS);
		assert.equal(repliesTo(asker, questionId).length, 1);
		assert.deepEqual(failuresOf(asker, questionId), []);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"an asker back to a resent reply whose recipient ended meanwhile gets only that reply, then and later (#5095)",
	async () => {
		const label = "resent-reply-5095";
		const askerAddress = { name: `asker-${label}`, returnAddress: randomUUID() };
		// It gets the reply but crashes before saving it.
		const first = await connect(askerAddress.name, { ...askerAddress, confirms: false });
		const askerId = idOf(first.client);
		const recipient = await connect(`recipient-${label}`, { returnAddress: randomUUID() });
		const questionId = randomUUID();
		const asked = await first.client.send(`recipient-${label}`, {
			messageId: questionId,
			text: "which port?",
			expectsReply: true,
		});
		assert.equal(asked.delivered, true, asked.reason);
		await vi.waitFor(() => assert.ok(recipient.received.some((message) => message.id === questionId)), WAIT);
		const replying = replyTo(recipient, askerId, questionId).catch(() => undefined);
		await vi.waitFor(() => assert.equal(repliesTo(first, questionId).length, 1), WAIT);
		const [reply] = repliesTo(first, questionId);
		await first.client.disconnect({ resumable: true });
		await sleep(SETTLE_MS);
		// The recipient ends while the asker is away, its reply still unsaved.
		await recipient.client.disconnect();
		await replying;
		await sleep(SETTLE_MS);

		const back = await connect(askerAddress.name, { ...askerAddress, preferredSessionId: askerId });
		await vi.waitFor(
			() =>
				assert.deepEqual(
					repliesTo(back, questionId).map((message) => message.id),
					[reply?.id],
				),
			WAIT,
		);
		await sleep(SETTLE_MS);
		assert.deepEqual(failuresOf(back, questionId), [], "the resent reply is the ask's one outcome");

		// Saved now: coming back again brings neither the reply nor a failure.
		await back.client.disconnect({ resumable: true });
		await sleep(SETTLE_MS);
		const again = await connect(askerAddress.name, { ...askerAddress, preferredSessionId: askerId });
		await sleep(SETTLE_MS);
		assert.deepEqual(failuresOf(again, questionId), []);
		assert.deepEqual(repliesTo(again, questionId), []);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);
