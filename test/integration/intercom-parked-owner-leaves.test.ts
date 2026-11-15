import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, test, vi } from "vitest";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";
import { sleep } from "../helpers/runtime.js";

/**
 * #4992: an ask to a subagent that was then released ends when the subagent's owner leaves, and its asker is told
 * exactly once: connected or away, and also after the broker restarted or crashed in between.
 */

const repoRoot = resolve(import.meta.dirname, "../..");
const brokerFixture = new IntercomBrokerFixture(mkdtempSync(join(tmpdir(), "parked-owner-")));
brokerFixture.overrideAgentDir();
const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");
const { getJitiCliPath } = await import("../../packages/intercom/broker/spawn.js");
const { requestBrokerShutdown } = await import("../../packages/intercom/broker/broker-stop.js");
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");

type Client = InstanceType<typeof IntercomClient>;
type Message = import("../../packages/intercom/types.js").Message;

/** Spawning, and restarting, the real broker child is the structural cost of this suite. */
const REAL_BROKER_TEST_TIMEOUT_MS = 60_000;
const WAIT = { timeout: 10_000, interval: 20 };
/** Long enough for a failure that must not arrive twice to arrive. */
const SETTLE_MS = 500;

let broker: ChildProcess | undefined;

async function startBroker(): Promise<void> {
	const extensionDir = join(repoRoot, "packages/intercom");
	broker = spawn(process.execPath, [getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")], {
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: brokerFixture.agentDir },
		stdio: "ignore",
	});
	brokerFixture.trackBroker(broker);
	await vi.waitFor(async () => {
		brokerFixture.assertRunning();
		const connected = await new Promise<boolean>((resolveConnected) => {
			const socket = net.createConnection(getBrokerSocketPath(process.platform, brokerFixture.agentDir));
			socket.once("connect", () => {
				socket.destroy();
				resolveConnected(true);
			});
			socket.once("error", () => resolveConnected(false));
		});
		assert.ok(connected);
	}, WAIT);
}

/** `atomic intercom restart`, or a crash. */
async function restartBroker(how: "restart" | "crash"): Promise<void> {
	const running = broker;
	assert.ok(running !== undefined && running.exitCode === null && running.signalCode === null);
	const exited = new Promise<void>((resolveExit) => running.once("exit", () => resolveExit()));
	if (how === "crash") running.kill("SIGKILL");
	else
		assert.equal(
			await requestBrokerShutdown(getBrokerSocketPath(process.platform, brokerFixture.agentDir)),
			"acknowledged",
		);
	await exited;
	await startBroker();
}

interface Session {
	readonly client: Client;
	/** Every way this session was told an ask ended: a failed-ask message or a `peer_disconnected` notice. */
	readonly failures: string[];
}

interface Identity {
	readonly name: string;
	readonly returnAddress: string;
	readonly ownerToken?: string;
	readonly preferredSessionId?: string;
	readonly supervisor?: { capability: string; supervisorSessionId: string };
	/** `legacy`: a client that never confirms saves; `unsaved`: one that confirms, but does not save this time. */
	readonly saves?: "legacy" | "unsaved";
}

/** A real client that confirms each save, as a session does. */
async function connect(identity: Identity): Promise<Session> {
	const client = new IntercomClient(identity.returnAddress, {
		...(identity.saves === "legacy" ? {} : { acknowledgesReceipt: true as const }),
		...(identity.preferredSessionId === undefined ? {} : { preferredSessionId: identity.preferredSessionId }),
	});
	const failures: string[] = [];
	client.on("message", (_from: object, message: Message) => {
		if (message.replyTo !== undefined && message.replyError !== undefined) failures.push(message.replyTo);
		if (identity.saves === undefined) client.acknowledgeReceived(message.id);
	});
	client.on("peer_disconnected", (notice: { replyTo: string }) => failures.push(notice.replyTo));
	client.on("error", () => {});
	await client.connect(
		{
			name: identity.name,
			model: "test-model",
			cwd: repoRoot,
			pid: process.pid,
			status: "idle",
			startedAt: Date.now(),
			lastActivity: Date.now(),
		},
		identity.supervisor,
		identity.ownerToken,
	);
	brokerFixture.onCleanup(() => client.disconnect().catch(() => undefined));
	return { client, failures };
}

function idOf(client: Client): string {
	const id = client.sessionId;
	assert.ok(id);
	return id;
}

/** Wait until the broker has handled `sessionId`'s departure (on Windows `disconnect()` can resolve before). */
async function untilDeparted(observer: Client, sessionId: string): Promise<void> {
	await vi.waitFor(
		async () => assert.ok(!(await observer.listSessions()).some((session) => session.id === sessionId)),
		WAIT,
	);
}

/**
 * Owner O launches subagent C; asker A asks C, and C saves the ask. `askerAway`: A goes away (it can be resumed)
 * before or after O releases C; otherwise A stays connected. C then leaves, released, so its ask is parked for O.
 */
async function parkedAsk(label: string, askerAway?: "before-release" | "after-release") {
	// Connected first, so it is the first session the broker looks at: it is told nothing.
	const bystander = await connect({ name: `bystander-${label}`, returnAddress: randomUUID() });
	const owner: Identity = { name: `owner-${label}`, returnAddress: randomUUID(), ownerToken: randomUUID() };
	const ownerSession = await connect(owner);
	const childName = `child-${label}`;
	const child = await connect({
		name: childName,
		returnAddress: randomUUID(),
		supervisor: await ownerSession.client.authorizeSupervisorChild(childName),
	});
	const childId = idOf(child.client);
	const asker: Identity = { name: `asker-${label}`, returnAddress: randomUUID() };
	const askerSession = await connect(asker);
	const askerId = idOf(askerSession.client);
	const askId = randomUUID();
	const received: string[] = [];
	child.client.on("message", (_from: object, message: Message) => received.push(message.id));
	const asked = await askerSession.client.send(childName, { messageId: askId, text: "ready?", expectsReply: true });
	assert.equal(asked.delivered, true, asked.reason);
	await vi.waitFor(() => assert.ok(received.includes(askId)), WAIT);

	const askerLeaves = async () => {
		await askerSession.client.disconnect({ resumable: true });
		await untilDeparted(ownerSession.client, askerId);
	};
	if (askerAway === "before-release") await askerLeaves();
	await ownerSession.client.reserveReleasedChildren([{ childName, wake: true }]);
	await child.client.disconnect({ resumable: true });
	await untilDeparted(ownerSession.client, childId);
	if (askerAway === "after-release") await askerLeaves();
	assert.deepEqual(askerSession.failures, [], "a released subagent's ask is still open");
	return {
		bystander,
		askId,
		childName,
		owner: { ...owner, preferredSessionId: idOf(ownerSession.client) },
		ownerSession,
		asker: { ...asker, preferredSessionId: askerId },
		askerSession,
	};
}

async function toldOnce(asker: Session, askId: string): Promise<void> {
	await vi.waitFor(() => assert.deepEqual(asker.failures, [askId]), WAIT);
	await sleep(SETTLE_MS);
	assert.deepEqual(asker.failures, [askId], "told once");
}

beforeAll(startBroker, REAL_BROKER_TEST_TIMEOUT_MS);
afterAll(() => brokerFixture.cleanup());

test(
	"a connected asker of a released subagent is told once when the subagent's owner ends (#4992)",
	async () => {
		const scene = await parkedAsk(`connected-${randomUUID().slice(0, 6)}`);
		await scene.ownerSession.client.disconnect();
		await toldOnce(scene.askerSession, scene.askId);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

for (const saves of ["legacy", "unsaved"] as const) {
	test(
		`a connected asker of a released subagent that ${saves === "legacy" ? "never confirms saves" : "did not save its failure"} is told ${saves === "legacy" ? "once" : "again when it is back"} (#4992)`,
		async () => {
			const scene = await parkedAsk(`saves-${saves}-${randomUUID().slice(0, 6)}`, "before-release");
			const asker = await connect({ ...scene.asker, saves });
			await scene.ownerSession.client.disconnect();
			await toldOnce(asker, scene.askId);
			await asker.client.disconnect({ resumable: true });
			const again = await connect(scene.asker);
			if (saves === "legacy") {
				await sleep(SETTLE_MS);
				assert.deepEqual(again.failures, [], "a client that cannot confirm is not told twice");
			} else await toldOnce(again, scene.askId);
		},
		REAL_BROKER_TEST_TIMEOUT_MS,
	);
}

for (const askerAway of ["before-release", "after-release"] as const) {
	test(
		`an asker of a released subagent that went away ${askerAway.replace("-", " ")} is told once when it is back after the owner ended (#4992)`,
		async () => {
			const scene = await parkedAsk(`away-${askerAway}-${randomUUID().slice(0, 6)}`, askerAway);
			await scene.ownerSession.client.disconnect();
			await untilDeparted(scene.bystander.client, scene.owner.preferredSessionId ?? "");
			const back = await connect(scene.asker);
			assert.equal(idOf(back.client), scene.asker.preferredSessionId);
			await toldOnce(back, scene.askId);
			await back.client.disconnect({ resumable: true });
			const again = await connect(scene.asker);
			await sleep(SETTLE_MS);
			assert.deepEqual(again.failures, [], "a saved failure is delivered once");
			assert.deepEqual(scene.bystander.failures, []);
		},
		REAL_BROKER_TEST_TIMEOUT_MS,
	);
}

for (const how of ["restart", "crash"] as const) {
	test(
		`an asker of a released subagent is told once when the owner ends after a broker ${how} (#4992)`,
		async () => {
			const scene = await parkedAsk(`${how}-${randomUUID().slice(0, 6)}`);
			await restartBroker(how);
			const bystander = await connect({ name: `bystander-again-${how}`, returnAddress: randomUUID() });
			const asker = await connect(scene.asker);
			assert.equal(idOf(asker.client), scene.asker.preferredSessionId);
			const owner = await connect(scene.owner);
			await owner.client.reserveReleasedChildren([{ childName: scene.childName, wake: true }]);
			await owner.client.disconnect();
			await toldOnce(asker, scene.askId);
			assert.deepEqual(scene.askerSession.failures, [], "the connection the broker closed was told nothing");
			assert.deepEqual(bystander.failures, []);
		},
		REAL_BROKER_TEST_TIMEOUT_MS,
	);
}

/**
 * Subagent C (owned by O) asks R and is released; the broker crashes; O reconnects and reserves C again. A reply from
 * R held for C, before or after O is back, wakes C through O, and C gets it once.
 */
for (const replied of ["before-owner-back", "after-owner-back"] as const) {
	test(
		`a reply held for a released subagent after a broker crash wakes it through its owner, ${replied.replaceAll("-", " ")} (#4992)`,
		async () => {
			const label = `wake-${replied}-${randomUUID().slice(0, 6)}`;
			const owner: Identity = { name: `owner-${label}`, returnAddress: randomUUID(), ownerToken: randomUUID() };
			const ownerFirst = await connect(owner);
			const ownerId = idOf(ownerFirst.client);
			const childName = `child-${label}`;
			const child: Identity = { name: childName, returnAddress: randomUUID() };
			const childFirst = await connect({
				...child,
				supervisor: await ownerFirst.client.authorizeSupervisorChild(childName),
			});
			const childId = idOf(childFirst.client);
			const recipient: Identity = { name: `recipient-${label}`, returnAddress: randomUUID() };
			const recipientFirst = await connect(recipient);
			const recipientId = idOf(recipientFirst.client);
			const asked: string[] = [];
			recipientFirst.client.on("message", (_from: object, message: Message) => asked.push(message.id));
			const questionId = randomUUID();
			const sent = await childFirst.client.send(recipient.name, {
				messageId: questionId,
				text: "q?",
				expectsReply: true,
			});
			assert.equal(sent.delivered, true, sent.reason);
			await vi.waitFor(() => assert.ok(asked.includes(questionId)), WAIT);
			await ownerFirst.client.reserveReleasedChildren([{ childName, wake: true }]);
			await childFirst.client.disconnect({ resumable: true });
			await untilDeparted(ownerFirst.client, childId);
			await restartBroker("crash");

			const recipientBack = await connect({ ...recipient, preferredSessionId: recipientId });
			const replyId = randomUUID();
			const reply = () =>
				recipientBack.client.send(childId, {
					messageId: replyId,
					text: "answer",
					replyTo: questionId,
					requirePendingReply: true,
					expectedRecipientId: childId,
				});
			if (replied === "before-owner-back") assert.equal((await reply()).queued, true);
			const wakes: string[] = [];
			const ownerBack = await connect({ ...owner, preferredSessionId: ownerId });
			ownerBack.client.on("restoring_recipient_wake", (notice: { childName: string }) =>
				wakes.push(notice.childName),
			);
			await ownerBack.client.reserveReleasedChildren([{ childName, wake: true }]);
			if (replied === "after-owner-back") assert.equal((await reply()).queued, true);
			await vi.waitFor(() => assert.ok(wakes.includes(childName)), WAIT);

			const replies: string[] = [];
			const childBack = new IntercomClient(child.returnAddress, {
				acknowledgesReceipt: true,
				preferredSessionId: childId,
			});
			childBack.on("message", (_from: object, message: Message) => {
				if (message.replyTo === questionId) replies.push(message.id);
				childBack.acknowledgeReceived(message.id);
			});
			childBack.on("error", () => {});
			await childBack.connect(
				{
					name: childName,
					model: "test-model",
					cwd: repoRoot,
					pid: process.pid,
					status: "idle",
					startedAt: Date.now(),
					lastActivity: Date.now(),
				},
				await ownerBack.client.authorizeSupervisorChild(childName),
			);
			brokerFixture.onCleanup(() => childBack.disconnect().catch(() => undefined));
			await vi.waitFor(() => assert.deepEqual(replies, [replyId]), WAIT);
			await sleep(SETTLE_MS);
			assert.deepEqual(replies, [replyId], "delivered once");
		},
		REAL_BROKER_TEST_TIMEOUT_MS,
	);
}
