import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { createMessageReader, writeMessage } from "../../packages/intercom/broker/framing.js";
import { getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import { getJitiCliPath } from "../../packages/intercom/broker/spawn.js";
import { type PeerDisconnectNotice, routePeerDisconnect } from "../../packages/intercom/peer-disconnect-routing.js";
import { ReplyWaiterRegistry } from "../../packages/intercom/reply-waiter.js";
import type { BrokerMessage, ClientMessage } from "../../packages/intercom/types.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const extensionDir = join(repoRoot, "packages/intercom");
const agentDir = mkdtempSync(join(tmpdir(), "intercom-peer-disconnect-"));
const socketPath = getBrokerSocketPath(process.platform, agentDir);
const originalAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
let broker: ChildProcess | undefined;

class WireClient {
	readonly received: BrokerMessage[] = [];
	readonly socket = net.createConnection(socketPath);
	private consumed = new Set<number>();

	constructor() {
		this.socket.on(
			"data",
			createMessageReader(
				(message) => this.received.push(message as BrokerMessage),
				(error) => this.socket.destroy(error),
			),
		);
		this.socket.on("error", () => {});
	}

	async connected(): Promise<void> {
		if (!this.socket.connecting) return;
		await new Promise<void>((resolveConnected, reject) => {
			this.socket.once("connect", resolveConnected).once("error", reject);
		});
	}

	send(message: ClientMessage): void {
		writeMessage(this.socket, message);
	}

	async next<T extends BrokerMessage["type"]>(
		type: T,
		matches: (message: Extract<BrokerMessage, { type: T }>) => boolean = () => true,
	): Promise<Extract<BrokerMessage, { type: T }>> {
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			const index = this.received.findIndex((message, candidate) => {
				if (this.consumed.has(candidate) || message.type !== type) return false;
				return matches(message as Extract<BrokerMessage, { type: T }>);
			});
			if (index >= 0) {
				this.consumed.add(index);
				return this.received[index] as Extract<BrokerMessage, { type: T }>;
			}
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
		}
		throw new Error(`Timed out waiting for broker frame ${type}`);
	}
}

async function waitForBroker(): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const connected = await new Promise<boolean>((resolveConnected) => {
			const probe = net.createConnection(socketPath);
			probe.once("connect", () => {
				probe.destroy();
				resolveConnected(true);
			});
			probe.once("error", () => resolveConnected(false));
		});
		if (connected) return;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
	}
	throw new Error("Broker socket did not become ready");
}

const session = { cwd: "/tmp/exact", model: "test-model", pid: 42, startedAt: 1, lastActivity: 1 };

async function register(client: WireClient, name?: string): Promise<string> {
	await client.connected();
	client.send({ type: "register", session: { ...session, ...(name === undefined ? {} : { name }) } });
	return (await client.next("registered")).sessionId;
}

function sendQuestion(client: WireClient, to: string, id: string, timestamp: number): void {
	client.send({ type: "send", to, message: { id, timestamp, expectsReply: true, content: { text: "question" } } });
}

const disconnected = (replyTo: string, peerSessionId: string, peerName?: string) => ({
	type: "peer_disconnected" as const,
	replyTo,
	peerSessionId,
	...(peerName === undefined ? {} : { peerName }),
});

beforeAll(async () => {
	broker = spawn(process.execPath, [getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")], {
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: undefined },
		stdio: "ignore",
	});
	await waitForBroker();
});

afterAll(() => {
	broker?.kill("SIGTERM");
	if (originalAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = originalAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

test("broker emits exact idempotent peer_disconnected frames for graceful and abrupt target exits", async () => {
	const gracefulAsker = new WireClient();
	const secondAsker = new WireClient();
	const gracefulTarget = new WireClient();
	const gracefulAskerId = await register(gracefulAsker, "graceful-asker");
	await register(secondAsker, "second-asker");
	const gracefulTargetId = await register(gracefulTarget, "graceful-target-exact");

	for (const [asker, questionId] of [
		[gracefulAsker, "graceful-question-1"],
		[gracefulAsker, "graceful-question-2"],
		[secondAsker, "second-question-exact"],
		[gracefulAsker, "answered-question-exact"],
	] as const) {
		sendQuestion(asker, gracefulTargetId, questionId, 1);
		await asker.next("delivered");
		await gracefulTarget.next("message");
	}
	gracefulTarget.send({
		type: "send",
		to: gracefulAskerId,
		message: { id: "answer-exact", timestamp: 2, replyTo: "answered-question-exact", content: { text: "answer" } },
	});
	await gracefulTarget.next("delivered");
	await gracefulAsker.next("message");
	gracefulTarget.send({ type: "unregister" });
	gracefulTarget.socket.end();
	assert.deepEqual(
		await gracefulAsker.next("peer_disconnected"),
		disconnected("graceful-question-1", gracefulTargetId, "graceful-target-exact"),
	);
	assert.deepEqual(
		await gracefulAsker.next("peer_disconnected"),
		disconnected("graceful-question-2", gracefulTargetId, "graceful-target-exact"),
	);
	assert.deepEqual(
		await secondAsker.next("peer_disconnected"),
		disconnected("second-question-exact", gracefulTargetId, "graceful-target-exact"),
	);
	await gracefulAsker.next("session_left", (frame) => frame.sessionId === gracefulTargetId);
	await secondAsker.next("session_left", (frame) => frame.sessionId === gracefulTargetId);

	const abruptAsker = new WireClient();
	const abruptTarget = new WireClient();
	await register(abruptAsker, "abrupt-asker");
	const abruptTargetId = await register(abruptTarget);
	for (const [asker, questionId] of [
		[abruptAsker, "abrupt-question-exact"],
		[gracefulAsker, "mixed-target-question"],
	] as const) {
		sendQuestion(asker, abruptTargetId, questionId, 3);
		await asker.next("delivered");
		await abruptTarget.next("message");
	}
	abruptTarget.socket.destroy();
	assert.deepEqual(await abruptAsker.next("peer_disconnected"), disconnected("abrupt-question-exact", abruptTargetId));
	assert.deepEqual(
		await gracefulAsker.next("peer_disconnected"),
		disconnected("mixed-target-question", abruptTargetId),
	);
	await abruptAsker.next("session_left", (frame) => frame.sessionId === abruptTargetId);
	await gracefulAsker.next("session_left", (frame) => frame.sessionId === abruptTargetId);

	const gracefulDepartedAsker = new WireClient();
	const abruptDepartedAsker = new WireClient();
	const survivingAsker = new WireClient();
	const scopedTarget = new WireClient();
	const gracefulDepartedId = await register(gracefulDepartedAsker, "graceful-departed-asker");
	const abruptDepartedId = await register(abruptDepartedAsker, "abrupt-departed-asker");
	await register(survivingAsker, "surviving-asker");
	const scopedTargetId = await register(scopedTarget, "scoped-target");
	for (const [asker, questionId] of [
		[gracefulDepartedAsker, "gracefully-pruned-question"],
		[abruptDepartedAsker, "abruptly-pruned-question"],
		[survivingAsker, "surviving-question"],
	] as const) {
		sendQuestion(asker, scopedTargetId, questionId, 4);
		await asker.next("delivered");
		await scopedTarget.next("message");
	}
	gracefulDepartedAsker.send({ type: "unregister" });
	gracefulDepartedAsker.socket.end();
	await scopedTarget.next("session_left", (frame) => frame.sessionId === gracefulDepartedId);
	abruptDepartedAsker.socket.destroy();
	await scopedTarget.next("session_left", (frame) => frame.sessionId === abruptDepartedId);
	scopedTarget.socket.destroy();
	assert.deepEqual(
		await survivingAsker.next("peer_disconnected"),
		disconnected("surviving-question", scopedTargetId, "scoped-target"),
	);
	await survivingAsker.next("session_left", (frame) => frame.sessionId === scopedTargetId);
	for (const client of [gracefulAsker, secondAsker, abruptAsker]) {
		await client.next("session_left", (frame) => frame.sessionId === scopedTargetId);
	}
	const notices = (client: WireClient) => client.received.filter((frame) => frame.type === "peer_disconnected");
	assert.deepEqual(
		notices(gracefulAsker).map((frame) => frame.replyTo),
		["graceful-question-1", "graceful-question-2", "mixed-target-question"],
	);
	assert.deepEqual(
		notices(secondAsker).map((frame) => frame.replyTo),
		["second-question-exact"],
	);
	assert.deepEqual(
		notices(abruptAsker).map((frame) => frame.replyTo),
		["abrupt-question-exact"],
	);
	assert.deepEqual(notices(survivingAsker), [disconnected("surviving-question", scopedTargetId, "scoped-target")]);
	for (const client of [gracefulAsker, secondAsker, abruptAsker, survivingAsker]) client.socket.destroy();
});

test("real client stays connected when a pending peer disconnects", async () => {
	const asker = new IntercomClient();
	const target = new WireClient();
	const errors: Error[] = [];
	asker.on("error", (error: Error) => errors.push(error));
	await asker.connect({ ...session, name: "real-asker" });
	const targetId = await register(target, "real-target");
	assert.deepEqual(await asker.send(targetId, { text: "question", expectsReply: true, messageId: "real-question" }), {
		id: "real-question",
		delivered: true,
	});
	await target.next("message");
	const departed = new Promise<void>((resolveDeparted) => {
		asker.once("error", resolveDeparted);
		asker.once("session_left", resolveDeparted);
	});
	target.socket.destroy();
	await departed;
	assert.equal(asker.isConnected(), true);
	assert.deepEqual(errors, []);
	assert.deepEqual(
		(await asker.listSessions()).map((session) => session.id),
		[asker.sessionId],
	);
	await asker.disconnect();
});

test("real client rejects the exact waiter when its target disconnects", async () => {
	const asker = new IntercomClient();
	const target = new WireClient();
	const slot = new ReplyWaiterRegistry();
	const targetName = "waiter-release-target";
	const questionId = "waiter-release-question";
	asker.on("peer_disconnected", (notice: PeerDisconnectNotice) => {
		routePeerDisconnect(slot.pending(), notice);
	});
	await asker.connect({ ...session, name: "waiter-release-asker" });
	const targetId = await register(target, targetName);
	const admission = slot.begin(targetName, questionId);
	assert.equal(admission.ok, true);
	if (!admission.ok) throw new Error("Reply waiter admission failed");
	assert.deepEqual(await asker.send(targetId, { text: "question", expectsReply: true, messageId: questionId }), {
		id: questionId,
		delivered: true,
	});
	await target.next("message");

	target.socket.destroy();
	await assert.rejects(admission.wait.promise, {
		message: `Session "${targetName}" disconnected before replying`,
	});
	await asker.disconnect();
});

test("broker joins several groups, routes through each, and lists every group", async () => {
	const bridge = new WireClient();
	const alpha = new WireClient();
	const beta = new WireClient();
	const outside = new WireClient();
	const bridgeId = await register(bridge, "multi-group-bridge");
	const alphaId = await register(alpha, "multi-group-alpha");
	const betaId = await register(beta, "multi-group-beta");
	const outsideId = await register(outside, "multi-group-outside");

	alpha.send({ type: "presence", group: "alpha", requestId: "alpha-group" });
	await alpha.next("presence_ack", (frame) => frame.requestId === "alpha-group");
	beta.send({ type: "presence", group: "beta", requestId: "beta-group" });
	await beta.next("presence_ack", (frame) => frame.requestId === "beta-group");
	outside.send({ type: "presence", group: "outside", requestId: "outside-group" });
	await outside.next("presence_ack", (frame) => frame.requestId === "outside-group");

	bridge.send({ type: "join_group", group: "alpha", requestId: "join-alpha" });
	assert.deepEqual(await bridge.next("membership_ack", (frame) => frame.requestId === "join-alpha"), {
		type: "membership_ack",
		requestId: "join-alpha",
		groups: ["default", "alpha"],
	});
	bridge.send({ type: "join_group", group: "beta", requestId: "join-beta" });
	assert.deepEqual(await bridge.next("membership_ack", (frame) => frame.requestId === "join-beta"), {
		type: "membership_ack",
		requestId: "join-beta",
		groups: ["default", "alpha", "beta"],
	});

	bridge.send({ type: "list", requestId: "visible-sessions" });
	const visibleIds = (await bridge.next("sessions", (frame) => frame.requestId === "visible-sessions")).sessions.map(
		({ id }) => id,
	);
	assert.equal(visibleIds.includes(alphaId), true);
	assert.equal(visibleIds.includes(betaId), true);
	assert.equal(visibleIds.includes(bridgeId), true);
	assert.equal(visibleIds.includes(outsideId), false);

	bridge.send({ type: "list_groups", requestId: "all-groups" });
	const summaries = (await bridge.next("groups", (frame) => frame.requestId === "all-groups")).groups;
	assert.deepEqual(
		summaries.filter(({ group }) => ["alpha", "beta", "outside"].includes(group)),
		[
			{ group: "alpha", sessionCount: 2, member: true },
			{ group: "beta", sessionCount: 2, member: true },
			{ group: "outside", sessionCount: 1, member: false },
		],
	);

	bridge.send({
		type: "send",
		to: alphaId,
		message: { id: "bridge-alpha", timestamp: 1, content: { text: "alpha" } },
	});
	await bridge.next("delivered", (frame) => frame.messageId === "bridge-alpha");
	await alpha.next("message", (frame) => frame.from.id === bridgeId);
	bridge.send({ type: "send", to: betaId, message: { id: "bridge-beta", timestamp: 2, content: { text: "beta" } } });
	await bridge.next("delivered", (frame) => frame.messageId === "bridge-beta");
	await beta.next("message", (frame) => frame.from.id === bridgeId);

	bridge.send({ type: "leave_group", group: "alpha", requestId: "leave-alpha" });
	assert.deepEqual((await bridge.next("membership_ack", (frame) => frame.requestId === "leave-alpha")).groups, [
		"default",
		"beta",
	]);
	bridge.send({ type: "leave_group", requestId: "leave-home" });
	assert.deepEqual((await bridge.next("membership_ack", (frame) => frame.requestId === "leave-home")).groups, [
		"default",
	]);
});
