import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, test, vi } from "vitest";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";
import { sleep } from "../helpers/runtime.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const brokerFixture = new IntercomBrokerFixture(mkdtempSync(join(tmpdir(), "live-asks-restart-")));
brokerFixture.overrideAgentDir();
const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");
const { getJitiCliPath } = await import("../../packages/intercom/broker/spawn.js");
const { requestBrokerShutdown } = await import("../../packages/intercom/broker/broker-stop.js");
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
const { queryIntercomBroker } = await import("../../packages/intercom/broker/control.js");
const { HELD_FOR_AWAY_ASKER_TARGET } = await import("../../packages/intercom/broker/held-reply-targets.js");
const { UNCERTAIN_RECEIPT_REASON } = await import("../../packages/intercom/broker/recipient-receipts.js");
const { BROKER_CRASH_AT_ENV, DEPARTURE_ASKS_TAKEN, DEPARTURE_ASKS_TO_IT_FAILED, DEPARTURE_ASKS_TO_IT_TAKEN } =
	await import("../../packages/intercom/broker/crash-points.js");

type Client = InstanceType<typeof IntercomClient>;
type Message = import("../../packages/intercom/types.js").Message;

/** Spawning, and restarting, the real broker child is the structural cost of this suite. */
const REAL_BROKER_TEST_TIMEOUT_MS = 120_000;
const WAIT = { timeout: 10_000, interval: 20 };
/** The broker child compiles its TypeScript as it starts, which takes longer than {@link WAIT} on a loaded machine. */
const BROKER_START_WAIT_MS = 40_000;
/** Long enough for a frame the broker wrote to arrive, so its absence means none was written. */
const SETTLE_MS = 300;

let broker: ChildProcess | undefined;

/** `crashAt`: the broker crashes at this point of its work instead of carrying on (see the broker's crash points). */
async function startBroker(options: { crashAt?: string } = {}): Promise<void> {
	const extensionDir = join(repoRoot, "packages/intercom");
	broker = spawn(process.execPath, [getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")], {
		env: {
			...process.env,
			ATOMIC_CODING_AGENT_DIR: brokerFixture.agentDir,
			...(options.crashAt === undefined ? {} : { [BROKER_CRASH_AT_ENV]: options.crashAt }),
		},
		stdio: "ignore",
	});
	brokerFixture.trackBroker(broker);
	// A broker retires once no session has been connected for 5 s since it listened. Under load the test can spend that
	// long before its own sessions register, so the fixture holds a session for this broker until cleanup.
	await brokerFixture.holdSession(getBrokerSocketPath(process.platform, brokerFixture.agentDir), BROKER_START_WAIT_MS);
}

/** How the broker goes away while both peers of an ask are connected. */
const RESTARTS = [
	{
		how: "`atomic intercom restart`",
		stop: async (): Promise<void> => {
			const answer = await requestBrokerShutdown(getBrokerSocketPath(process.platform, brokerFixture.agentDir));
			assert.equal(answer, "acknowledged");
		},
	},
	{
		how: "a broker crash",
		stop: async (running: ChildProcess): Promise<void> => {
			running.kill("SIGKILL");
		},
	},
] as const;

async function restartBroker(
	stop: (running: ChildProcess) => Promise<void>,
	options: { crashAt?: string } = {},
): Promise<void> {
	const running = broker;
	assert.ok(running !== undefined && running.exitCode === null && running.signalCode === null);
	const exited = new Promise<void>((resolveExit) => running.once("exit", () => resolveExit()));
	await stop(running);
	await exited;
	await startBroker(options);
}

/** A real client that records what arrives and confirms each save, as a session does. */
async function connect(
	name: string,
	options: {
		returnAddress: string;
		preferredSessionId?: string;
		ownerToken?: string;
		supervisor?: { capability: string; supervisorSessionId: string };
	},
): Promise<{ client: Client; received: Message[]; peerGone: string[] }> {
	const client = new IntercomClient(options.returnAddress, {
		acknowledgesReceipt: true,
		...(options.preferredSessionId === undefined ? {} : { preferredSessionId: options.preferredSessionId }),
	});
	const received: Message[] = [];
	client.on("message", (_from: object, message: Message) => {
		received.push(message);
		client.acknowledgeReceived(message.id);
	});
	// A connected asker learns its recipient ended from this notice; its session tells the agent the ask failed.
	const peerGone: string[] = [];
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

/** Wait until the broker has handled `sessionId`'s departure, as the session's listing shows. */
async function untilDeparted(observer: Client, sessionId: string): Promise<void> {
	await vi.waitFor(
		async () => assert.ok(!(await observer.listSessions()).some((session) => session.id === sessionId)),
		WAIT,
	);
}

function idOf(client: Client): string {
	const id = client.sessionId;
	assert.ok(id);
	return id;
}

interface Peer {
	readonly name: string;
	readonly returnAddress: string;
	readonly id: string;
}

/** An asker asks a recipient while both stay connected: the ask's route is live, not kept for an away session. */
async function askBetweenConnected(label: string): Promise<{ asker: Peer; recipient: Peer; questionId: string }> {
	const asker = { name: `asker-${label}`, returnAddress: randomUUID() };
	const recipient = { name: `recipient-${label}`, returnAddress: randomUUID() };
	const askerSession = await connect(asker.name, asker);
	const recipientSession = await connect(recipient.name, recipient);
	const questionId = randomUUID();
	const asked = await askerSession.client.send(recipient.name, {
		messageId: questionId,
		text: "which port?",
		expectsReply: true,
	});
	assert.equal(asked.delivered, true, asked.reason);
	await vi.waitFor(() => assert.ok(recipientSession.received.some((message) => message.id === questionId)), WAIT);
	return {
		asker: { ...asker, id: idOf(askerSession.client) },
		recipient: { ...recipient, id: idOf(recipientSession.client) },
		questionId,
	};
}

/** The session comes back to the new broker under the id peers know, proving itself by its return address. */
async function reconnect(peer: Peer): ReturnType<typeof connect> {
	const back = await connect(peer.name, { returnAddress: peer.returnAddress, preferredSessionId: peer.id });
	assert.equal(idOf(back.client), peer.id);
	return back;
}

/** Every answer or failure the asker was told of for its ask, however it arrived. */
function outcomes(session: { received: readonly Message[]; peerGone: readonly string[] }, questionId: string) {
	return [
		...session.received
			.filter((message) => message.replyTo === questionId)
			.map((message) => ({ id: message.id, failed: message.replyError !== undefined })),
		...session.peerGone
			.filter((replyTo) => replyTo === questionId)
			.map(() => ({ id: "peer_disconnected", failed: true })),
	];
}

beforeAll(() => startBroker(), REAL_BROKER_TEST_TIMEOUT_MS);
afterAll(() => brokerFixture.cleanup());

for (const restart of RESTARTS) {
	test(
		`a live ask between connected sessions is answered once after ${restart.how} (#4829)`,
		async () => {
			const label = `answered-${randomUUID().slice(0, 8)}`;
			const { asker, recipient, questionId } = await askBetweenConnected(label);
			await restartBroker(restart.stop);

			const askerBack = await reconnect(asker);
			const recipientBack = await reconnect(recipient);
			const replyId = randomUUID();
			const replied = await recipientBack.client.send(asker.id, {
				messageId: replyId,
				text: "port 8080",
				replyTo: questionId,
				requirePendingReply: true,
				expectedRecipientId: asker.id,
			});
			assert.equal(replied.delivered, true, replied.reason);
			await vi.waitFor(() => assert.equal(outcomes(askerBack, questionId).length, 1), WAIT);
			// The answered ask is settled: the recipient's end later fails nothing.
			await recipientBack.client.disconnect();
			await sleep(SETTLE_MS);
			assert.deepEqual(outcomes(askerBack, questionId), [{ id: replyId, failed: false }]);
		},
		REAL_BROKER_TEST_TIMEOUT_MS,
	);

	test(
		`a live ask fails once when its recipient ends after ${restart.how} (#4829)`,
		async () => {
			const label = `ended-${randomUUID().slice(0, 8)}`;
			const { asker, recipient, questionId } = await askBetweenConnected(label);
			await restartBroker(restart.stop);

			const askerBack = await reconnect(asker);
			const recipientBack = await reconnect(recipient);
			await recipientBack.client.disconnect();
			await vi.waitFor(() => assert.equal(outcomes(askerBack, questionId).length, 1), WAIT);
			await sleep(SETTLE_MS);
			assert.deepEqual(
				outcomes(askerBack, questionId),
				// #5004: an asker that confirms saves is sent a failure it confirms, as it would a reply.
				[{ id: `ended:${questionId}`, failed: true }],
				"the asker is told once that its recipient is gone",
			);
		},
		REAL_BROKER_TEST_TIMEOUT_MS,
	);

	test(
		`a live ask whose recipient ends before its asker is back after ${restart.how} fails once for that asker (#4829)`,
		async () => {
			const label = `ended-first-${randomUUID().slice(0, 8)}`;
			const { asker, recipient, questionId } = await askBetweenConnected(label);
			await restartBroker(restart.stop);

			const recipientBack = await reconnect(recipient);
			await recipientBack.client.disconnect();
			const askerBack = await reconnect(asker);
			await vi.waitFor(() => assert.equal(outcomes(askerBack, questionId).length, 1), WAIT);
			await sleep(SETTLE_MS);
			const [failure] = askerBack.received.filter((message) => message.replyTo === questionId);
			assert.match(failure?.replyError ?? "", /ended before replying/);
			assert.equal(outcomes(askerBack, questionId).length, 1, "the asker is told once");
		},
		REAL_BROKER_TEST_TIMEOUT_MS,
	);
}

/**
 * The recipient of a live ask between connected sessions closes, to be resumed, and the broker crashes while it handles
 * that departure: after it took the ask off its live routes and before it kept it for the recipient's return.
 */
async function recipientDepartsIntoACrash(label: string) {
	await restartBroker(RESTARTS[0].stop, { crashAt: DEPARTURE_ASKS_TO_IT_TAKEN });
	const crashing = broker;
	assert.ok(crashing !== undefined);
	const crashed = new Promise<void>((resolveExit) => crashing.once("exit", () => resolveExit()));
	const asker = { name: `asker-${label}`, returnAddress: randomUUID() };
	const recipient = { name: `recipient-${label}`, returnAddress: randomUUID() };
	const askerFirst = await connect(asker.name, asker);
	const recipientFirst = await connect(recipient.name, recipient);
	const askerId = idOf(askerFirst.client);
	const recipientId = idOf(recipientFirst.client);
	const questionId = randomUUID();
	const asked = await askerFirst.client.send(recipient.name, {
		messageId: questionId,
		text: "which port?",
		expectsReply: true,
	});
	assert.equal(asked.delivered, true, asked.reason);
	await vi.waitFor(() => assert.ok(recipientFirst.received.some((message) => message.id === questionId)), WAIT);
	await recipientFirst.client.disconnect({ resumable: true });
	await crashed;
	await startBroker();
	return {
		asker: { ...asker, id: askerId },
		recipient: { ...recipient, id: recipientId },
		askerFirst,
		questionId,
	};
}

test(
	"a live ask whose recipient departs into a broker crash is answered once when both are back",
	async () => {
		const { asker, recipient, askerFirst, questionId } = await recipientDepartsIntoACrash(
			`answered-mid-departure-${randomUUID().slice(0, 8)}`,
		);
		const askerBack = await reconnect(asker);
		const recipientBack = await reconnect(recipient);
		const replyId = randomUUID();
		const replied = await recipientBack.client.send(asker.id, {
			messageId: replyId,
			text: "port 8080",
			replyTo: questionId,
			requirePendingReply: true,
			expectedRecipientId: asker.id,
		});
		assert.equal(replied.delivered, true, replied.reason);
		await vi.waitFor(() => assert.equal(outcomes(askerBack, questionId).length, 1), WAIT);
		await recipientBack.client.disconnect();
		await sleep(SETTLE_MS);
		assert.deepEqual(
			[...outcomes(askerFirst, questionId), ...outcomes(askerBack, questionId)],
			[{ id: replyId, failed: false }],
		);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a live ask whose recipient departs into a broker crash fails once when that recipient ends",
	async () => {
		const { asker, recipient, askerFirst, questionId } = await recipientDepartsIntoACrash(
			`ended-mid-departure-${randomUUID().slice(0, 8)}`,
		);
		const askerBack = await reconnect(asker);
		const recipientBack = await reconnect(recipient);
		await recipientBack.client.disconnect();
		await vi.waitFor(() => assert.equal(outcomes(askerBack, questionId).length, 1), WAIT);
		await sleep(SETTLE_MS);
		assert.equal(
			[...outcomes(askerFirst, questionId), ...outcomes(askerBack, questionId)].length,
			1,
			"the asker is told once",
		);
		assert.equal(outcomes(askerBack, questionId)[0]?.failed, true);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a recipient that ends into a broker crash sends its connected asker nothing the crash undoes: the asker gets one outcome (#4996)",
	async () => {
		await restartBroker(RESTARTS[0].stop, { crashAt: DEPARTURE_ASKS_TO_IT_FAILED });
		const crashing = broker;
		assert.ok(crashing !== undefined);
		const crashed = new Promise<void>((resolveExit) => crashing.once("exit", () => resolveExit()));
		const label = `ended-into-crash-${randomUUID().slice(0, 8)}`;
		const asker = { name: `asker-${label}`, returnAddress: randomUUID() };
		const recipient = { name: `recipient-${label}`, returnAddress: randomUUID() };
		const askerFirst = await connect(asker.name, asker);
		const recipientFirst = await connect(recipient.name, recipient);
		const askerId = idOf(askerFirst.client);
		const recipientId = idOf(recipientFirst.client);
		const questionId = randomUUID();
		const asked = await askerFirst.client.send(recipient.name, {
			messageId: questionId,
			text: "which port?",
			expectsReply: true,
		});
		assert.equal(asked.delivered, true, asked.reason);
		await vi.waitFor(() => assert.ok(recipientFirst.received.some((message) => message.id === questionId)), WAIT);
		// The recipient ends; the broker crashes after deciding the ask failed, before that decision is saved.
		await recipientFirst.client.disconnect();
		await crashed;
		await startBroker();

		// The next broker never learned the recipient ended: it is away, and back, it answers.
		const askerBack = await reconnect({ ...asker, id: askerId });
		const recipientBack = await reconnect({ ...recipient, id: recipientId });
		const replyId = randomUUID();
		const replied = await recipientBack.client.send(askerId, {
			messageId: replyId,
			text: "port 8080",
			replyTo: questionId,
			requirePendingReply: true,
			expectedRecipientId: askerId,
		});
		assert.equal(replied.delivered, true, replied.reason);
		await vi.waitFor(() => assert.equal(outcomes(askerBack, questionId).length, 1), WAIT);
		await sleep(SETTLE_MS);
		assert.deepEqual(
			[...outcomes(askerFirst, questionId), ...outcomes(askerBack, questionId)],
			[{ id: replyId, failed: false }],
			"the asker was not told of a failure the crash undid",
		);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a replier whose reply waits on an owner that ends into a broker crash is not told it failed (#4996)",
	async () => {
		await restartBroker(RESTARTS[0].stop, { crashAt: DEPARTURE_ASKS_TO_IT_FAILED });
		const crashing = broker;
		assert.ok(crashing !== undefined);
		const crashed = new Promise<void>((resolveExit) => crashing.once("exit", () => resolveExit()));
		const { child, recipientSession, ownerSession, questionId } = await releasedSubagentAsks(
			`owner-ends-into-crash-${randomUUID().slice(0, 8)}`,
		);
		// The owner is handed the reply for its released subagent and has not confirmed saving it when it ends.
		const handedOff: string[] = [];
		ownerSession.client.on("released_child_reply", (notice: { replyTo: string }) => handedOff.push(notice.replyTo));
		const reply = recipientSession.client
			.send(child.id, {
				messageId: randomUUID(),
				text: "port 8080",
				replyTo: questionId,
				requirePendingReply: true,
				expectedRecipientId: child.id,
			})
			.then(
				(result) => result.reason ?? "",
				(error: Error) => error.message,
			);
		await vi.waitFor(() => assert.deepEqual(handedOff, [questionId]), WAIT);
		// Its departure would tell the replier the reply's receipt is uncertain; the broker crashes before saving it.
		await ownerSession.client.disconnect();
		await crashed;
		assert.doesNotMatch(
			await reply,
			new RegExp(UNCERTAIN_RECEIPT_REASON.slice(0, 40)),
			"told of a failure the crash undid",
		);
		await startBroker();
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a session holding a live ask's recipient id after a restart can neither answer nor fail it (#4829)",
	async () => {
		const label = `impostor-${randomUUID().slice(0, 8)}`;
		const { asker, recipient, questionId } = await askBetweenConnected(label);
		await restartBroker(RESTARTS[0].stop);

		// The restarted broker remembers no session, so another session can take the recipient's free id.
		const impostor = await connect(recipient.name, { returnAddress: randomUUID(), preferredSessionId: recipient.id });
		assert.equal(idOf(impostor.client), recipient.id);
		const forge = () =>
			impostor.client.send(asker.id, {
				messageId: randomUUID(),
				text: "port 1",
				replyTo: questionId,
				requirePendingReply: true,
				expectedRecipientId: asker.id,
			});
		// Neither held for the asker while it is away, nor delivered once it is back.
		const heldForged = await forge();
		assert.equal(heldForged.delivered || heldForged.queued === true, false, "only the recipient answers its ask");
		const askerBack = await reconnect(asker);
		const forged = await forge();
		assert.equal(forged.delivered, false, "only the recipient answers its ask");
		await impostor.client.disconnect();
		await sleep(SETTLE_MS);
		assert.deepEqual(outcomes(askerBack, questionId), [], "nor does its end fail the ask");
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a reply that raced the restart reaches its asker once, and its recipient's end then fails nothing (#4829)",
	async () => {
		const label = `raced-${randomUUID().slice(0, 8)}`;
		const asker = { name: `asker-${label}`, returnAddress: randomUUID() };
		const recipient = { name: `recipient-${label}`, returnAddress: randomUUID() };
		const askerFirst = await connect(asker.name, asker);
		const recipientFirst = await connect(recipient.name, recipient);
		const askerId = idOf(askerFirst.client);
		const recipientId = idOf(recipientFirst.client);
		const questionId = randomUUID();
		const asked = await askerFirst.client.send(recipient.name, {
			messageId: questionId,
			text: "which port?",
			expectsReply: true,
		});
		assert.equal(asked.delivered, true, asked.reason);
		await vi.waitFor(() => assert.ok(recipientFirst.received.some((message) => message.id === questionId)), WAIT);
		const reply = {
			messageId: randomUUID(),
			text: "port 8080",
			replyTo: questionId,
			requirePendingReply: true as const,
			expectedRecipientId: askerId,
		};
		// The reply is delivered and saved just before the broker goes; its replier never learns the outcome and sends it
		// again to the new broker.
		const first = await recipientFirst.client.send(askerId, reply);
		assert.equal(first.delivered, true, first.reason);
		await vi.waitFor(() => assert.equal(outcomes(askerFirst, questionId).length, 1), WAIT);
		await restartBroker(RESTARTS[1].stop);

		const askerBack = await reconnect({ ...asker, id: askerId });
		const recipientBack = await reconnect({ ...recipient, id: recipientId });
		await recipientBack.client.send(askerId, reply).catch(() => undefined);
		await recipientBack.client.disconnect();
		await sleep(SETTLE_MS);
		assert.deepEqual(
			[...outcomes(askerFirst, questionId), ...outcomes(askerBack, questionId)],
			[{ id: reply.messageId, failed: false }],
			"the asker gets its answer once and no failure",
		);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

/**
 * A subagent asks a connected recipient, then its owner releases it between turns: the ask's route waits for the
 * subagent, kept by its owner, while both the subagent and the broker are away.
 */
async function releasedSubagentAsks(label: string, options: { departure?: "handled" | "unhandled" } = {}) {
	const owner = { name: `owner-${label}`, returnAddress: randomUUID(), ownerToken: randomUUID() };
	const ownerFirst = await connect(owner.name, owner);
	const child = { name: `subagent-${label}`, returnAddress: randomUUID() };
	const childFirst = await connect(child.name, {
		...child,
		supervisor: await ownerFirst.client.authorizeSupervisorChild(child.name),
	});
	const recipient = { name: `recipient-${label}`, returnAddress: randomUUID() };
	const recipientFirst = await connect(recipient.name, recipient);
	const questionId = randomUUID();
	const asked = await childFirst.client.send(recipient.name, {
		messageId: questionId,
		text: "which port, when you know?",
		expectsReply: true,
	});
	assert.equal(asked.delivered, true, asked.reason);
	await vi.waitFor(() => assert.ok(recipientFirst.received.some((message) => message.id === questionId)), WAIT);
	const childId = idOf(childFirst.client);
	// Read before the departure: a broker that crashes in it leaves the recipient's client without an id.
	const recipientId = idOf(recipientFirst.client);
	await ownerFirst.client.reserveReleasedChildren([{ childName: child.name, wake: true }]);
	await childFirst.client.disconnect({ resumable: true });
	// On Windows `disconnect()` can resolve before the broker has handled the subagent's goodbye (#4894): a pipe has no
	// half-close. A crash before then is a different case (the test above), so wait until the broker no longer lists it.
	if (options.departure !== "unhandled") await untilDeparted(ownerFirst.client, childId);
	return {
		owner,
		child: { ...child, id: childId },
		recipient: { ...recipient, id: recipientId },
		recipientSession: recipientFirst,
		ownerSession: ownerFirst,
		questionId,
	};
}

/** The owner is back, and restores its subagent under its own session. */
/**
 * Runs `step`, a send to `target` or a wait for what it brings: one that fails says how long it ran, what the broker
 * reports (its sessions, the recipients it is restoring and the sends it holds for them), how `lister`'s connection sees
 * the sessions, and what `received` holds, so a failure on a loaded runner can be told apart from a send nothing routes.
 */
async function explained<T>(
	step: () => Promise<T>,
	observed: { readonly lister: Client; readonly received: readonly Message[]; readonly target: string },
): Promise<T> {
	const started = performance.now();
	try {
		return await step();
	} catch (error) {
		const elapsedMs = Math.round(performance.now() - started);
		const unreadable = (read: Error) => `(unreadable: ${read.message})`;
		const [broker, sessions] = await Promise.all([
			queryIntercomBroker(brokerFixture.agentDir).catch(unreadable),
			observed.lister
				.listSessions()
				.then((listed) =>
					listed.map(({ id, name, replyCapability }) => ({
						id,
						name,
						replyCapability,
						target: id === observed.target,
					})),
				)
				.catch(unreadable),
		]);
		const received = observed.received.map(({ id, replyTo, replyError }) => ({ id, replyTo, replyError }));
		if (error instanceof Error)
			error.message = `${error.message}\nafter ${elapsedMs} ms; broker: ${JSON.stringify(broker)}; sessions: ${JSON.stringify(sessions)}; received: ${JSON.stringify(received)}`;
		throw error;
	}
}

async function restoreSubagent(owner: { name: string; returnAddress: string; ownerToken: string }, child: Peer) {
	const ownerBack = await connect(owner.name, owner);
	return connect(child.name, {
		returnAddress: child.returnAddress,
		preferredSessionId: child.id,
		supervisor: await ownerBack.client.authorizeSupervisorChild(child.name),
	});
}

for (const restart of RESTARTS) {
	test(
		`a released subagent's ask is answered once after ${restart.how}, when the subagent is back (#4829, #4852)`,
		async () => {
			const { owner, child, recipient, questionId } = await releasedSubagentAsks(
				`answered-${randomUUID().slice(0, 8)}`,
			);
			await restartBroker(restart.stop);

			const recipientBack = await reconnect(recipient);
			const replyId = randomUUID();
			const replied = await recipientBack.client.send(child.id, {
				messageId: replyId,
				text: "port 8080",
				replyTo: questionId,
				requirePendingReply: true,
				expectedRecipientId: child.id,
			});
			assert.equal(replied.queued, true, JSON.stringify(replied));
			assert.equal(replied.target, HELD_FOR_AWAY_ASKER_TARGET);
			const childBack = await restoreSubagent(owner, child);
			await vi.waitFor(() => assert.equal(outcomes(childBack, questionId).length, 1), WAIT);
			// The answered ask is settled: the recipient's end later fails nothing.
			await recipientBack.client.disconnect();
			await sleep(SETTLE_MS);
			assert.deepEqual(outcomes(childBack, questionId), [{ id: replyId, failed: false }]);
		},
		REAL_BROKER_TEST_TIMEOUT_MS,
	);

	test(
		`a released subagent's ask fails once when its recipient ends after ${restart.how} (#4829, #4852)`,
		async () => {
			const { owner, child, recipient, questionId } = await releasedSubagentAsks(
				`ended-${randomUUID().slice(0, 8)}`,
			);
			await restartBroker(restart.stop);

			const recipientBack = await reconnect(recipient);
			await recipientBack.client.disconnect();
			const childBack = await restoreSubagent(owner, child);
			await vi.waitFor(() => assert.equal(outcomes(childBack, questionId).length, 1), WAIT);
			await sleep(SETTLE_MS);
			const [failure] = childBack.received.filter((message) => message.replyTo === questionId);
			assert.match(failure?.replyError ?? "", /ended before replying/);
			assert.equal(outcomes(childBack, questionId).length, 1, "the subagent is told once");
		},
		REAL_BROKER_TEST_TIMEOUT_MS,
	);
}

test(
	"a released subagent's ask survives a broker crash in the middle of its departure",
	async () => {
		// The broker crashes while it handles the subagent's departure, after it took the subagent's asks off its live
		// routes and before it kept them for the subagent's return.
		await restartBroker(RESTARTS[0].stop, { crashAt: DEPARTURE_ASKS_TAKEN });
		const crashing = broker;
		assert.ok(crashing !== undefined);
		const crashed = new Promise<void>((resolveExit) => crashing.once("exit", () => resolveExit()));
		const { owner, child, recipient, questionId } = await releasedSubagentAsks(
			`mid-departure-${randomUUID().slice(0, 8)}`,
			{ departure: "unhandled" },
		);
		await crashed;
		await startBroker();

		const recipientBack = await reconnect(recipient);
		const replyId = randomUUID();
		const replied = await recipientBack.client.send(child.id, {
			messageId: replyId,
			text: "port 8080",
			replyTo: questionId,
			requirePendingReply: true,
			expectedRecipientId: child.id,
		});
		assert.equal(replied.queued, true, JSON.stringify(replied));
		assert.equal(replied.target, HELD_FOR_AWAY_ASKER_TARGET);
		const childBack = await restoreSubagent(owner, child);
		await vi.waitFor(() => assert.deepEqual(outcomes(childBack, questionId), [{ id: replyId, failed: false }]), WAIT);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a released subagent back after a restart is answered directly by its recipient (#4829, #4852)",
	async () => {
		const { owner, child, recipient, questionId } = await releasedSubagentAsks(`back-${randomUUID().slice(0, 8)}`);
		await restartBroker(RESTARTS[1].stop);

		const recipientBack = await reconnect(recipient);
		const childBack = await restoreSubagent(owner, child);
		const replyId = randomUUID();
		const observed = { lister: recipientBack.client, received: childBack.received, target: child.id };
		const replied = await explained(
			() =>
				recipientBack.client.send(child.id, {
					messageId: replyId,
					text: "port 8080",
					replyTo: questionId,
					requirePendingReply: true,
					expectedRecipientId: child.id,
				}),
			observed,
		);
		assert.equal(replied.delivered, true, replied.reason);
		await explained(
			() =>
				vi.waitFor(() => assert.deepEqual(outcomes(childBack, questionId), [{ id: replyId, failed: false }]), WAIT),
			observed,
		);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a released subagent answered after it came back under a new id is not told the ask failed after a restart (#4829, #4852)",
	async () => {
		const { owner, child, recipient, recipientSession, ownerSession, questionId } = await releasedSubagentAsks(
			`new-id-${randomUUID().slice(0, 8)}`,
		);
		// Its owner restores it under a new Intercom id, and its recipient answers it there.
		const childBack = await connect(child.name, {
			returnAddress: child.returnAddress,
			supervisor: await ownerSession.client.authorizeSupervisorChild(child.name),
		});
		const backId = idOf(childBack.client);
		assert.notEqual(backId, child.id);
		const recipientFirst = recipientSession;
		const replyId = randomUUID();
		const replied = await recipientFirst.client.send(backId, {
			messageId: replyId,
			text: "port 8080",
			replyTo: questionId,
			requirePendingReply: true,
			expectedRecipientId: backId,
		});
		assert.equal(replied.delivered, true, replied.reason);
		await vi.waitFor(() => assert.equal(outcomes(childBack, questionId).length, 1), WAIT);

		await restartBroker(RESTARTS[1].stop);
		const childAgain = await connect(child.name, {
			returnAddress: child.returnAddress,
			preferredSessionId: backId,
			supervisor: await (await connect(owner.name, owner)).client.authorizeSupervisorChild(child.name),
		});
		const recipientBack = await reconnect(recipient);
		await recipientBack.client.disconnect();
		await sleep(SETTLE_MS);
		assert.deepEqual(outcomes(childAgain, questionId), [], "the answered ask fails nothing");
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);
