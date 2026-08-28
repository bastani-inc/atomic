import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import type { PendingStageMessageRequest } from "../../packages/intercom/broker/client.js";
import { createMessageReader, writeMessage } from "../../packages/intercom/broker/framing.js";
import { getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import { getJitiCliPath } from "../../packages/intercom/broker/spawn.js";
import type { BrokerMessage, ClientMessage, Message } from "../../packages/intercom/types.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const extensionDir = join(repoRoot, "packages/intercom");
const agentDir = mkdtempSync(join(tmpdir(), "icr-"));
const socketPath = getBrokerSocketPath(process.platform, agentDir);
const RUN_ID = "4ac72924-c452-4e5f-9e63-2435722109f7";
const TARGET = `${RUN_ID}:reviewer`;
const VICTIM_GROUP = `workflow:${RUN_ID}`;
const ROUTE_CAPABILITY = "victim-workflow-route-capability";
const originalAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
const clients = new Set<WireClient>();
const realClients = new Set<InstanceType<typeof IntercomClient>>();
let broker: ChildProcess | undefined;
let brokerOutput = "";

class WireClient {
	readonly received: BrokerMessage[] = [];
	readonly rejectionLifecycle: string[] = [];
	readonly socket = net.createConnection(socketPath);
	readonly closed: Promise<void>;
	closeHadError: boolean | undefined;
	private consumed = new Set<number>();

	constructor() {
		clients.add(this);
		this.closed = new Promise((resolveClosed) => {
			this.socket.once("close", (hadError) => {
				this.closeHadError = hadError;
				this.rejectionLifecycle.push("close");
				resolveClosed();
			});
		});
		this.socket.once("end", () => this.rejectionLifecycle.push("end"));
		this.socket.on(
			"data",
			createMessageReader(
				(message) => {
					const brokerMessage = message as BrokerMessage;
					if (brokerMessage.type === "registration_failed") this.rejectionLifecycle.push("registration_failed");
					this.received.push(brokerMessage);
				},
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

	sendBatch(messages: readonly unknown[]): void {
		const frames = messages.map((message) => {
			const payload = Buffer.from(JSON.stringify(message), "utf8");
			const header = Buffer.alloc(4);
			header.writeUInt32BE(payload.length);
			return Buffer.concat([header, payload]);
		});
		this.socket.write(Buffer.concat(frames));
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
	throw new Error(`Broker socket did not become ready: ${brokerOutput}`);
}

async function register(
	client: WireClient,
	name: string | undefined,
	group: string,
	returnAddress?: string,
): Promise<string> {
	await client.connected();
	client.send({
		type: "register",
		session: {
			...(name === undefined ? {} : { name }),
			group,
			cwd: "/repo",
			model: "test",
			pid: 1,
			startedAt: 1,
			lastActivity: 1,
		},
		...(returnAddress === undefined ? {} : { returnAddress }),
	});
	return (await client.next("registered")).sessionId;
}

async function registrationOutcome(client: WireClient, requestId: string): Promise<"closed" | "acknowledged"> {
	client.send({ type: "list", requestId });
	return await Promise.race([
		client.closed.then(() => "closed" as const),
		client.next("sessions", (frame) => frame.requestId === requestId).then(() => "acknowledged" as const),
	]);
}

async function forwardNextLiveMessage(owner: WireClient): Promise<BrokerMessage & { type: "pending_stage_message" }> {
	const request = await owner.next("pending_stage_message", (frame) => frame.live === true);
	owner.send({ type: "pending_stage_message_result", requestId: request.requestId, outcome: "forward" });
	return request;
}

async function startBroker(): Promise<void> {
	brokerOutput = "";
	broker = spawn(process.execPath, [getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")], {
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: undefined },
		stdio: ["ignore", "pipe", "pipe"],
	});
	broker.stdout?.on("data", (data) => {
		brokerOutput += String(data);
	});
	broker.stderr?.on("data", (data) => {
		brokerOutput += String(data);
	});
	await waitForBroker();
}

async function stopBroker(): Promise<void> {
	if (broker?.exitCode === null) {
		const stopped = new Promise<void>((resolveExit) => broker?.once("exit", () => resolveExit()));
		broker.kill("SIGTERM");
		await stopped;
	}
	broker = undefined;
}

beforeAll(startBroker);

afterAll(async () => {
	for (const client of realClients) await client.disconnect();
	for (const client of clients) client.socket.destroy();
	await stopBroker();
	if (originalAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = originalAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});
test("broker flushes registration_failed before an orderly close and ignores later pipelined frames", async () => {
	const runId = "892588e7-bf6c-4e44-bba8-bb298794a9c4";
	const group = `workflow:${runId}`;
	const owner = new WireClient();
	const attacker = new WireClient();
	const observer = new WireClient();
	await register(owner, "rejection-owner", group);
	await register(attacker, "rejection-attacker", group);
	await register(observer, "rejection-observer", group);
	owner.send({
		type: "register_pending_stage_route",
		runId,
		group,
		capability: "rejection-owner-capability",
	});
	assert.equal(await registrationOutcome(owner, "rejection-owner-processed"), "acknowledged");

	attacker.sendBatch([
		{
			type: "register_pending_stage_route",
			runId,
			group,
			capability: "different-capability",
		},
		{ type: "list", requestId: "must-not-run-after-rejection" },
	]);
	assert.deepEqual(await attacker.next("registration_failed"), {
		type: "registration_failed",
		reason: "Pending-stage route is not authorized",
	});
	await attacker.closed;
	assert.deepEqual(attacker.rejectionLifecycle, ["registration_failed", "end", "close"]);
	assert.equal(attacker.closeHadError, false);
	assert.equal(
		attacker.received.some(
			(frame) => frame.type === "sessions" && frame.requestId === "must-not-run-after-rejection",
		),
		false,
	);

	const missingCapability = new WireClient();
	await register(missingCapability, "missing-capability-attacker", group);
	missingCapability.sendBatch([
		{ type: "register_pending_stage_route", runId, group },
		{ type: "list", requestId: "must-not-run-after-invalid-registration" },
	]);
	await missingCapability.closed;
	assert.equal(
		missingCapability.received.some(
			(frame) => frame.type === "sessions" && frame.requestId === "must-not-run-after-invalid-registration",
		),
		false,
	);

	observer.send({ type: "list", requestId: "rejection-log-barrier" });
	await observer.next("sessions", (frame) => frame.requestId === "rejection-log-barrier");
	assert.equal(brokerOutput.includes("write after end"), false, brokerOutput);
});

function productionRegistration(name: string | undefined, group: string) {
	return {
		...(name === undefined ? {} : { name }),
		group,
		cwd: "/repo",
		model: "test",
		pid: 1,
		startedAt: 1,
		lastActivity: 1,
	};
}

test("production clients keep the pending owner and live stage connected when a shared capability replays", async () => {
	const runId = "13ec4058-3528-413e-84c4-87a43e5037a2";
	const group = `workflow:${runId}`;
	const capability = "production-shared-owner-stage-capability";
	const owner = new IntercomClient();
	const stage = new IntercomClient();
	const sender = new IntercomClient();
	for (const client of [owner, stage, sender]) {
		realClients.add(client);
		client.on("error", () => {});
	}
	await owner.connect(productionRegistration("workflow-owner", group));
	await stage.connect(productionRegistration("workflow-stage", group));
	await sender.connect(productionRegistration("workflow-sender", group));

	owner.registerPendingStageRoute(runId, group, capability);
	await owner.listSessions();
	stage.registerPendingStageRoute(runId, group, capability);
	await stage.listSessions();

	const pendingRequest = new Promise<PendingStageMessageRequest>((resolveRequest) => {
		owner.once("pending_stage_message", resolveRequest);
	});
	const pendingSend = sender.send(`${runId}:pending-stage`, { text: "queue before stage startup" });
	const request = await pendingRequest;
	assert.equal(request.message.content.text, "queue before stage startup");
	owner.respondPendingStageMessage(request.requestId, { outcome: "queued", position: 1 });
	const pendingResult = await pendingSend;
	assert.deepEqual(pendingResult, {
		id: pendingResult.id,
		delivered: false,
		queued: true,
		runId,
		stageKey: "pending-stage",
		position: 1,
	});

	for (const target of ["ordinary-unknown", "2ca70520-338b-4740-a94c-d814b08b4155:reviewer"]) {
		const unknownResult = await sender.send(target, { text: "ordinary miss" });
		assert.deepEqual(unknownResult, {
			id: unknownResult.id,
			delivered: false,
			reason: "Session not found",
		});
	}
	for (const [stageKey, reason] of [
		[
			"still-pending",
			"Cannot ask a workflow stage whose session has not initialized. Use send; Atomic will queue the message until the stage session initializes.",
		],
		["unknown-stage", "Session not found"],
		["completed-stage", "Session not found"],
		["late-stage", "Session not found"],
		["closed-stage", "Session not found"],
	] as const) {
		const ownerValidation = new Promise<PendingStageMessageRequest>((resolveRequest) => {
			owner.once("pending_stage_message", resolveRequest);
		});
		const ask = sender.send(`${runId}:${stageKey}`, {
			text: `blocking question for ${stageKey}`,
			expectsReply: true,
		});
		const request = await ownerValidation;
		assert.equal(request.stageKey, stageKey);
		owner.respondPendingStageMessage(request.requestId, { outcome: "refused", reason });
		const refusal = await ask;
		assert.equal(refusal.delivered, false);
		assert.equal(refusal.reason, reason);
	}

	await stage.registerLiveWorkflowStageRoute(runId, ["reviewer-id", "reviewer"], capability);
	const liveMessage = new Promise<Message>((resolveMessage) => {
		stage.once("message", (_from, message) => resolveMessage(message));
	});
	const liveValidation = new Promise<PendingStageMessageRequest>((resolveRequest) => {
		owner.once("pending_stage_message", resolveRequest);
	});
	const liveSendPromise = sender.send(`${runId}:reviewer`, { text: "deliver to live composite" });
	const liveRequest = await liveValidation;
	assert.equal(liveRequest.live, true);
	owner.respondPendingStageMessage(liveRequest.requestId, { outcome: "forward" });
	assert.equal((await liveSendPromise).delivered, true);
	assert.equal((await liveMessage).content.text, "deliver to live composite");
	const liveAskMessage = new Promise<Message>((resolveMessage) => {
		stage.once("message", (_from, message) => resolveMessage(message));
	});
	const liveAskValidation = new Promise<PendingStageMessageRequest>((resolveRequest) => {
		owner.once("pending_stage_message", resolveRequest);
	});
	const liveAskPromise = sender.send(`${runId}:reviewer-id`, { text: "live blocking question", expectsReply: true });
	const liveAskRequest = await liveAskValidation;
	assert.equal(liveAskRequest.live, true);
	owner.respondPendingStageMessage(liveAskRequest.requestId, { outcome: "forward" });
	assert.equal((await liveAskPromise).delivered, true);
	assert.equal((await liveAskMessage).content.text, "live blocking question");

	assert.equal(owner.isConnected(), true);
	assert.equal(stage.isConnected(), true);
	assert.equal(sender.isConnected(), true);
	await Promise.all([owner.listSessions(), stage.listSessions(), sender.listSessions()]);
	assert.equal(brokerOutput.includes("write after end"), false);
});

test("pending-stage notifications prefer an exact live UUID and fail closed across reconnect alias trust controls", async () => {
	const runId = "a366bf54-90e2-4238-8013-62324967aa85";
	const group = `workflow:${runId}`;
	const capability = "notification-route-capability";
	const owner = new IntercomClient();
	const original = new IntercomClient();
	const crossGroup = new IntercomClient();
	const joinedFromAnotherGroup = new IntercomClient();
	const mutableName = new IntercomClient();
	const duplicateA = new IntercomClient();
	const duplicateB = new IntercomClient();
	const unauthorized = new IntercomClient();
	const scenarioClients = [
		owner,
		original,
		crossGroup,
		joinedFromAnotherGroup,
		mutableName,
		duplicateA,
		duplicateB,
		unauthorized,
	];
	for (const client of scenarioClients) {
		realClients.add(client);
		client.on("error", () => {});
	}
	await owner.connect(productionRegistration("notification-owner", group));
	owner.registerPendingStageRoute(runId, group, capability);
	await owner.listSessions();

	const visible = new Map<InstanceType<typeof IntercomClient>, Message[]>();
	const acknowledge = (client: InstanceType<typeof IntercomClient>): void => {
		visible.set(client, []);
		client.on("pending_stage_notification", (request: { requestId: string; message: Message }) => {
			visible.get(client)?.push(request.message);
			client.respondPendingStageNotification(request.requestId, true);
		});
	};
	for (const client of scenarioClients.slice(1)) acknowledge(client);

	await original.connect(productionRegistration("exact-original", group));
	assert.equal(
		(
			await owner.sendPendingStageNotification(
				runId,
				capability,
				original.sessionId ?? "missing",
				"ignored-alias-while-exact-is-live",
				{ text: "exact path", messageId: "notification-exact" },
			)
		).delivered,
		true,
	);
	assert.equal(visible.get(original)?.length, 1);

	await crossGroup.connect(productionRegistration("planner", "other-workflow-group"));
	const crossGroupResult = await owner.sendPendingStageNotification(
		runId,
		capability,
		"obsolete-cross-group-id",
		"planner",
		{ text: "must stay in workflow group", messageId: "notification-cross-group" },
	);
	assert.equal(crossGroupResult.delivered, false);
	assert.equal(crossGroupResult.reason, "Session not found");
	assert.equal(visible.get(crossGroup)?.length, 0);

	await joinedFromAnotherGroup.connect(productionRegistration("joined-planner", "outside-at-registration"));
	assert.equal(await joinedFromAnotherGroup.updatePresenceAcked({ group }), group);
	const joinedResult = await owner.sendPendingStageNotification(
		runId,
		capability,
		"obsolete-joined-id",
		"joined-planner",
		{ text: "mutable group is not authority", messageId: "notification-joined-group" },
	);
	assert.equal(joinedResult.delivered, false);
	assert.equal(visible.get(joinedFromAnotherGroup)?.length, 0);

	await mutableName.connect(productionRegistration("different-registration-name", group));
	assert.equal(mutableName.updatePresence({ name: "mutated-planner" }), true);
	await mutableName.listSessions();
	const mutableNameResult = await owner.sendPendingStageNotification(
		runId,
		capability,
		"obsolete-mutated-name-id",
		"mutated-planner",
		{ text: "mutable name is not authority", messageId: "notification-mutated-name" },
	);
	assert.equal(mutableNameResult.delivered, false);
	assert.equal(visible.get(mutableName)?.length, 0);

	await duplicateA.connect(productionRegistration("duplicate-planner", group));
	await duplicateB.connect(productionRegistration("duplicate-planner", group));
	const ambiguousResult = await owner.sendPendingStageNotification(
		runId,
		capability,
		"obsolete-ambiguous-id",
		"duplicate-planner",
		{ text: "ambiguous aliases fail closed", messageId: "notification-ambiguous" },
	);
	assert.equal(ambiguousResult.delivered, false);
	assert.equal(visible.get(duplicateA)?.length, 0);
	assert.equal(visible.get(duplicateB)?.length, 0);

	assert.equal(await duplicateB.updatePresenceAcked({ group: "presence-moved-out" }), "presence-moved-out");
	const stillAmbiguousResult = await owner.sendPendingStageNotification(
		runId,
		capability,
		"obsolete-still-ambiguous-id",
		"duplicate-planner",
		{ text: "mutable group cannot resolve immutable ambiguity", messageId: "notification-still-ambiguous" },
	);
	assert.equal(stillAmbiguousResult.delivered, false);
	assert.equal(visible.get(duplicateA)?.length, 0);
	assert.equal(visible.get(duplicateB)?.length, 0);

	await unauthorized.connect(productionRegistration("unauthorized-notifier", group));
	const unauthorizedResult = await unauthorized.sendPendingStageNotification(
		runId,
		capability,
		original.sessionId ?? "missing",
		"exact-original",
		{ text: "only the route owner may notify", messageId: "notification-unauthorized" },
	);
	assert.equal(unauthorizedResult.delivered, false);
	assert.equal(unauthorizedResult.reason, "Pending-stage notification is not authorized");
	assert.equal(visible.get(original)?.length, 1);
});

test("a recipient disconnect before notification admission leaves the stable delivery retryable", async () => {
	const runId = "ee635682-0de7-4e0a-8750-957b3efbeb76";
	const group = `workflow:${runId}`;
	const capability = "notification-crash-capability";
	const crashReturnAddress = "host-session-crash-planner";
	const owner = new IntercomClient();
	const crashingRecipient = new IntercomClient(crashReturnAddress);
	for (const client of [owner, crashingRecipient]) {
		realClients.add(client);
		client.on("error", () => {});
	}
	await owner.connect(productionRegistration("notification-crash-owner", group));
	owner.registerPendingStageRoute(runId, group, capability);
	await owner.listSessions();
	await crashingRecipient.connect(productionRegistration("crash-planner", group));
	crashingRecipient.once("pending_stage_notification", () => {
		void crashingRecipient.disconnect();
	});
	const notification = {
		text: "correlated terminal failure",
		replyTo: "queued-message-before-crash",
		replyError: "stage skipped before startup",
		messageId: "stable-notification-after-crash",
	};
	const failedAttempt = await owner.sendPendingStageNotification(
		runId,
		capability,
		"obsolete-before-crash",
		"crash-planner",
		notification,
		crashReturnAddress,
	);
	assert.equal(failedAttempt.delivered, false);
	assert.equal(failedAttempt.reason, "Recipient disconnected before acknowledging the pending-stage notification");

	const restartedRecipient = new IntercomClient(crashReturnAddress);
	realClients.add(restartedRecipient);
	restartedRecipient.on("error", () => {});
	const visibleIds: string[] = [];
	restartedRecipient.on("pending_stage_notification", (request: { requestId: string; message: Message }) => {
		visibleIds.push(request.message.id);
		restartedRecipient.respondPendingStageNotification(request.requestId, true);
	});
	await restartedRecipient.connect(productionRegistration("crash-planner", group));
	const deliveredRetry = await owner.sendPendingStageNotification(
		runId,
		capability,
		"obsolete-before-crash",
		"crash-planner",
		notification,
		crashReturnAddress,
	);
	assert.equal(deliveredRetry.delivered, true);
	assert.deepEqual(visibleIds, [notification.messageId]);

	const acknowledgedReplay = await owner.sendPendingStageNotification(
		runId,
		capability,
		"obsolete-before-crash",
		"crash-planner",
		notification,
		crashReturnAddress,
	);
	assert.equal(acknowledgedReplay.delivered, true);
	assert.deepEqual(visibleIds, [notification.messageId]);
});

test("stable return addresses restore nameless and duplicate-name recipients across broker restart", async () => {
	const runId = "99cce476-8f65-4d40-b188-f47b78132257";
	const group = `workflow:${runId}`;
	const capability = "return-address-route-capability";
	const addresses = {
		nameless: "host-session-nameless",
		duplicateA: "host-session-duplicate-a",
		duplicateB: "host-session-duplicate-b",
	} as const;
	const ownerBefore = new IntercomClient("host-session-owner-before");
	const beforeRecipients = [
		{ key: "nameless", name: undefined, client: new IntercomClient(addresses.nameless) },
		{ key: "duplicateA", name: "duplicate-planner", client: new IntercomClient(addresses.duplicateA) },
		{ key: "duplicateB", name: "duplicate-planner", client: new IntercomClient(addresses.duplicateB) },
	] as const;
	for (const client of [ownerBefore, ...beforeRecipients.map(({ client }) => client)]) {
		realClients.add(client);
		client.on("error", () => {});
	}
	await ownerBefore.connect(productionRegistration("return-address-owner", group));
	ownerBefore.registerPendingStageRoute(runId, group, capability);
	await ownerBefore.listSessions();
	for (const recipient of beforeRecipients)
		await recipient.client.connect(productionRegistration(recipient.name, group));

	const durableRequests: PendingStageMessageRequest[] = [];
	for (const recipient of beforeRecipients) {
		const pendingRequest = new Promise<PendingStageMessageRequest>((resolveRequest) => {
			ownerBefore.once("pending_stage_message", resolveRequest);
		});
		const send = recipient.client.send(`${runId}:reviewer`, {
			text: `queued by ${recipient.key}`,
			messageId: `return-address-${recipient.key}`,
		});
		const request = await pendingRequest;
		ownerBefore.respondPendingStageMessage(request.requestId, {
			outcome: "queued",
			position: durableRequests.length + 1,
		});
		assert.equal((await send).queued, true);
		durableRequests.push(request);
	}
	assert.deepEqual(
		durableRequests.map(({ senderReturnAddress, senderRegistrationName }) => ({
			senderReturnAddress,
			senderRegistrationName,
		})),
		[
			{ senderReturnAddress: addresses.nameless, senderRegistrationName: undefined },
			{ senderReturnAddress: addresses.duplicateA, senderRegistrationName: "duplicate-planner" },
			{ senderReturnAddress: addresses.duplicateB, senderRegistrationName: "duplicate-planner" },
		],
	);

	await stopBroker();
	await startBroker();
	const ownerAfter = new IntercomClient("host-session-owner-after");
	const afterRecipients = [
		{ key: "nameless", name: undefined, address: addresses.nameless, client: new IntercomClient(addresses.nameless) },
		{
			key: "duplicateA",
			name: "duplicate-planner",
			address: addresses.duplicateA,
			client: new IntercomClient(addresses.duplicateA),
		},
		{
			key: "duplicateB",
			name: "duplicate-planner",
			address: addresses.duplicateB,
			client: new IntercomClient(addresses.duplicateB),
		},
	] as const;
	for (const client of [ownerAfter, ...afterRecipients.map(({ client }) => client)]) {
		realClients.add(client);
		client.on("error", () => {});
	}
	await ownerAfter.connect(productionRegistration("return-address-owner", group));
	ownerAfter.registerPendingStageRoute(runId, group, capability);
	await ownerAfter.listSessions();

	const visible = new Map<string, string[]>();
	for (const recipient of afterRecipients) {
		visible.set(recipient.key, []);
		recipient.client.on("pending_stage_notification", (request: { requestId: string; message: Message }) => {
			visible.get(recipient.key)?.push(request.message.id);
			recipient.client.respondPendingStageNotification(request.requestId, true);
		});
		await recipient.client.connect(productionRegistration(recipient.name, group));
	}

	const rawNameless = new WireClient();
	const rawSameName = new WireClient();
	const rawPresence = new WireClient();
	const rawCrossGroup = new WireClient();
	await register(rawNameless, undefined, group);
	await register(rawSameName, "duplicate-planner", group);
	await register(rawPresence, "different-registration-name", group);
	rawPresence.sendBatch([
		{
			type: "presence",
			name: "duplicate-planner",
			returnAddress: addresses.duplicateB,
			requestId: "return-address-presence",
		},
	]);
	await rawPresence.next("presence_ack", (frame) => frame.requestId === "return-address-presence");
	await register(rawCrossGroup, "duplicate-planner", "other-workflow-group", addresses.duplicateA);

	const ambiguous = new IntercomClient(addresses.nameless);
	realClients.add(ambiguous);
	ambiguous.on("error", () => {});
	await ambiguous.connect(productionRegistration(undefined, group));
	const ambiguousResult = await ownerAfter.sendPendingStageNotification(
		runId,
		capability,
		durableRequests[0]?.from.id ?? "missing",
		undefined,
		{ text: "ambiguous capability", messageId: "return-address-ambiguous" },
		addresses.nameless,
	);
	assert.equal(ambiguousResult.delivered, false);
	assert.equal(ambiguousResult.reason, "Session not found");
	assert.deepEqual(visible.get("nameless"), []);
	await ambiguous.disconnect();
	await ownerAfter.listSessions();

	for (const [index, request] of durableRequests.entries()) {
		const notification = {
			text: `terminal notice for ${request.message.id}`,
			replyTo: request.message.id,
			replyError: "stage skipped before startup",
			messageId: `notice-${request.message.id}`,
		};
		const delivered = await ownerAfter.sendPendingStageNotification(
			runId,
			capability,
			request.from.id,
			request.senderRegistrationName,
			notification,
			request.senderReturnAddress,
		);
		assert.equal(delivered.delivered, true);
		const recipient = afterRecipients[index]!;
		assert.deepEqual(visible.get(recipient.key), [notification.messageId]);
		const replay = await ownerAfter.sendPendingStageNotification(
			runId,
			capability,
			request.from.id,
			request.senderRegistrationName,
			notification,
			request.senderReturnAddress,
		);
		assert.equal(replay.delivered, true);
		assert.deepEqual(visible.get(recipient.key), [notification.messageId]);
	}
	for (const hostile of [rawNameless, rawSameName, rawPresence, rawCrossGroup]) {
		assert.equal(
			hostile.received.some((frame) => frame.type === "pending_stage_notification"),
			false,
		);
	}
});

test("immutable workflow authority rejects a default-group attacker that presence-switches before attacker-first pending/live registration", async () => {
	const runId = "6d04b37d-9d67-463f-8b2a-0ed184671b2d";
	const group = `workflow:${runId}`;
	const attacker = new WireClient();
	const sender = new WireClient();
	await register(attacker, "mutable-presence-attacker", "default");
	await register(sender, "mutable-presence-sender", group);

	attacker.send({ type: "presence", group, requestId: "attacker-presence-switch" });
	assert.equal((await attacker.next("presence_ack")).group, group);
	attacker.sendBatch([
		{
			type: "register_pending_stage_route",
			runId,
			group,
			capability: "attacker-chosen-route-capability",
		},
		{
			type: "register_live_workflow_stage_route",
			requestId: "attacker-first-live-route",
			runId,
			stageKeys: ["reviewer"],
			capability: "attacker-chosen-route-capability",
		},
	]);
	assert.equal(await registrationOutcome(attacker, "attacker-first-pipeline-processed"), "closed");

	sender.send({
		type: "send",
		to: `${runId}:reviewer`,
		message: { id: "after-attacker-first-rejection", timestamp: 1, content: { text: "not attacker-owned" } },
	});
	assert.deepEqual(await sender.next("delivery_failed"), {
		type: "delivery_failed",
		messageId: "after-attacker-first-rejection",
		reason: "Session not found",
	});

	const legitimateOwner = new WireClient();
	const legitimateStage = new WireClient();
	await register(legitimateOwner, "legitimate-owner-after-presence-attack", group);
	await register(legitimateStage, "legitimate-stage-after-presence-attack", group);
	legitimateOwner.send({
		type: "register_pending_stage_route",
		runId,
		group,
		capability: "legitimate-route-capability",
	});
	assert.equal(await registrationOutcome(legitimateOwner, "legitimate-owner-processed"), "acknowledged");
	legitimateStage.send({
		type: "register_live_workflow_stage_route",
		requestId: "legitimate-live-route",
		runId,
		stageKeys: ["reviewer"],
		capability: "legitimate-route-capability",
	});
	await legitimateStage.next(
		"live_workflow_stage_route_registered",
		(frame) => frame.requestId === "legitimate-live-route",
	);

	const legitimateValidation = forwardNextLiveMessage(legitimateOwner);
	sender.send({
		type: "send",
		to: `${runId}:reviewer`,
		message: { id: "after-legitimate-registration", timestamp: 2, content: { text: "legitimate owner only" } },
	});
	assert.equal((await legitimateValidation).message.id, "after-legitimate-registration");
	assert.equal((await sender.next("delivered")).messageId, "after-legitimate-registration");
	assert.equal((await legitimateStage.next("message")).message.content.text, "legitimate owner only");
});

test("broker rejects cross-group pending-route impersonation before route mutation", async () => {
	const attacker = new WireClient();
	const sender = new WireClient();
	await register(attacker, "attacker", "attacker-group");
	await register(sender, "victim-sender", VICTIM_GROUP);

	attacker.send({
		type: "register_pending_stage_route",
		runId: RUN_ID,
		group: VICTIM_GROUP,
		capability: "attacker-capability",
	});
	assert.equal(await registrationOutcome(attacker, "attacker-route-processed"), "closed");

	const canary = "cross-group-security-canary-content";
	sender.send({
		type: "send",
		to: TARGET,
		message: {
			id: "cross-group-impersonation",
			timestamp: 1,
			content: { text: canary, attachments: [{ type: "context", name: "secret", content: canary }] },
		},
	});
	assert.deepEqual(await sender.next("delivery_failed"), {
		type: "delivery_failed",
		messageId: "cross-group-impersonation",
		reason: "Session not found",
	});
	assert.equal(
		attacker.received.some((frame) => frame.type === "pending_stage_message"),
		false,
	);
	assert.equal(brokerOutput.includes(canary), false);
});

test("broker rejects same-group replacement of an active pending route owner", async () => {
	const runId = "eaf2d23d-e52f-44a4-95b0-91c2109cbf34";
	const group = `workflow:${runId}`;
	const target = `${runId}:reviewer`;
	const legitimate = new WireClient();
	const attacker = new WireClient();
	const sender = new WireClient();
	await register(legitimate, "legitimate-owner", group);
	await register(attacker, "same-group-pending-attacker", group);
	await register(sender, "same-group-pending-sender", group);

	legitimate.send({
		type: "register_pending_stage_route",
		runId,
		group,
		capability: "pending-owner-route-capability",
	});
	assert.equal(await registrationOutcome(legitimate, "legitimate-pending-owner-processed"), "acknowledged");
	legitimate.send({
		type: "register_pending_stage_route",
		runId,
		group,
		capability: "pending-owner-route-capability",
	});
	assert.equal(await registrationOutcome(legitimate, "legitimate-pending-owner-repeat"), "acknowledged");
	attacker.send({
		type: "register_pending_stage_route",
		runId,
		group,
		capability: "same-group-attacker-capability",
	});
	assert.equal(await registrationOutcome(attacker, "pending-takeover-processed"), "closed");

	const canary = "pending-route-takeover-security-canary";
	sender.send({
		type: "send",
		to: target,
		message: { id: "after-pending-takeover", timestamp: 2, content: { text: canary } },
	});
	const request = await legitimate.next("pending_stage_message");
	assert.equal(request.message.content.text, canary);
	legitimate.send({
		type: "pending_stage_message_result",
		requestId: request.requestId,
		outcome: "queued",
		position: 1,
	});
	assert.equal((await sender.next("queued")).messageId, "after-pending-takeover");
	assert.equal(
		attacker.received.some((frame) => frame.type === "pending_stage_message"),
		false,
	);
	assert.equal(brokerOutput.includes(canary), false);
});

test("broker rejects an attacker-first live route without the workflow capability", async () => {
	const runId = "78c47adc-8cab-466f-a902-5d9ca2521c2c";
	const group = `workflow:${runId}`;
	const target = `${runId}:reviewer`;
	const owner = new WireClient();
	const attacker = new WireClient();
	const legitimate = new WireClient();
	const sender = new WireClient();
	await register(owner, "workflow-owner", group);
	await register(attacker, "attacker-first-stage", group);
	await register(legitimate, "legitimate-stage-after-attacker", group);
	await register(sender, "attacker-first-sender", group);
	owner.send({
		type: "register_pending_stage_route",
		runId,
		group,
		capability: "attacker-first-owner-capability",
	});
	assert.equal(await registrationOutcome(owner, "capability-owner-processed"), "acknowledged");

	attacker.send({
		type: "register_live_workflow_stage_route",
		requestId: "attacker-first-route",
		runId,
		stageKeys: ["reviewer"],
		capability: "attacker-live-capability",
	});
	assert.equal(await registrationOutcome(attacker, "attacker-first-route-processed"), "closed");
	legitimate.send({
		type: "register_live_workflow_stage_route",
		requestId: "legitimate-after-attacker-route",
		runId,
		stageKeys: ["reviewer", "reviewer-id"],
		capability: "attacker-first-owner-capability",
	});
	await legitimate.next(
		"live_workflow_stage_route_registered",
		(frame) => frame.requestId === "legitimate-after-attacker-route",
	);
	const attackerFirstValidation = forwardNextLiveMessage(owner);
	sender.send({
		type: "send",
		to: target,
		message: { id: "attacker-first-live-send", timestamp: 3, content: { text: "legitimate recipient only" } },
	});
	assert.equal((await attackerFirstValidation).message.id, "attacker-first-live-send");
	assert.equal((await sender.next("delivered")).messageId, "attacker-first-live-send");
	assert.equal((await legitimate.next("message")).message.content.text, "legitimate recipient only");
	assert.equal(
		attacker.received.some((frame) => frame.type === "message"),
		false,
	);
});
test("broker rejects a different active session taking over a live composite route", async () => {
	const owner = new WireClient();
	const legitimate = new WireClient();
	const attacker = new WireClient();
	const sender = new WireClient();
	await register(owner, "live-route-owner", VICTIM_GROUP);
	await register(legitimate, "legitimate-stage", VICTIM_GROUP);
	await register(attacker, "same-group-attacker", VICTIM_GROUP);
	await register(sender, "same-group-sender", VICTIM_GROUP);
	owner.send({
		type: "register_pending_stage_route",
		runId: RUN_ID,
		group: VICTIM_GROUP,
		capability: ROUTE_CAPABILITY,
	});
	assert.equal(await registrationOutcome(owner, "live-route-owner-processed"), "acknowledged");

	legitimate.send({
		type: "register_live_workflow_stage_route",
		requestId: "legitimate-route",
		runId: RUN_ID,
		stageKeys: ["reviewer", "reviewer-id"],
		capability: ROUTE_CAPABILITY,
	});
	await legitimate.next("live_workflow_stage_route_registered", (frame) => frame.requestId === "legitimate-route");
	legitimate.send({
		type: "register_live_workflow_stage_route",
		requestId: "legitimate-route-repeat",
		runId: RUN_ID,
		stageKeys: ["reviewer-id", "reviewer"],
		capability: ROUTE_CAPABILITY,
	});
	await legitimate.next(
		"live_workflow_stage_route_registered",
		(frame) => frame.requestId === "legitimate-route-repeat",
	);

	attacker.send({
		type: "register_live_workflow_stage_route",
		requestId: "takeover-route",
		runId: RUN_ID,
		stageKeys: ["reviewer"],
		capability: ROUTE_CAPABILITY,
	});
	assert.equal(await registrationOutcome(attacker, "takeover-route-processed"), "closed");

	const takeoverValidation = forwardNextLiveMessage(owner);
	const canary = "live-route-takeover-security-canary";
	sender.send({
		type: "send",
		to: TARGET,
		message: { id: "after-takeover", timestamp: 2, content: { text: canary } },
	});
	assert.equal((await takeoverValidation).message.id, "after-takeover");
	assert.deepEqual(await sender.next("delivered"), {
		type: "delivered",
		messageId: "after-takeover",
	});
	assert.equal((await legitimate.next("message")).message.content.text, canary);
	assert.equal(
		attacker.received.some((frame) => frame.type === "message"),
		false,
	);
	assert.equal(brokerOutput.includes(canary), false);
});

test("live composite route replacement requires the old owner to disconnect", async () => {
	const transitionRunId = "7f684570-74ec-4f17-a09f-2df742f1c911";
	const transitionGroup = `workflow:${transitionRunId}`;
	const owner = new WireClient();
	const oldOwner = new WireClient();
	const nextAttempt = new WireClient();
	const sender = new WireClient();
	await register(owner, "transition-owner", transitionGroup);
	const oldOwnerId = await register(oldOwner, "stage-attempt-1", transitionGroup);
	await register(nextAttempt, "stage-attempt-2", transitionGroup);
	await register(sender, "transition-sender", transitionGroup);
	owner.send({
		type: "register_pending_stage_route",
		runId: transitionRunId,
		group: transitionGroup,
		capability: "transition-route-capability",
	});
	assert.equal(await registrationOutcome(owner, "transition-owner-processed"), "acknowledged");

	oldOwner.send({
		type: "register_live_workflow_stage_route",
		requestId: "old-attempt-route",
		runId: transitionRunId,
		stageKeys: ["reviewer", "reviewer-id"],
		capability: "transition-route-capability",
	});
	await oldOwner.next("live_workflow_stage_route_registered", (frame) => frame.requestId === "old-attempt-route");
	oldOwner.socket.destroy();
	await sender.next("session_left", (frame) => frame.sessionId === oldOwnerId);

	nextAttempt.send({
		type: "register_live_workflow_stage_route",
		requestId: "next-attempt-route",
		runId: transitionRunId,
		stageKeys: ["reviewer-id", "reviewer"],
		capability: "transition-route-capability",
	});
	await nextAttempt.next("live_workflow_stage_route_registered", (frame) => frame.requestId === "next-attempt-route");
	const attemptTransitionValidation = forwardNextLiveMessage(owner);
	sender.send({
		type: "send",
		to: `${transitionRunId}:reviewer`,
		message: { id: "stage-attempt-transition", timestamp: 3, content: { text: "transition message" } },
	});
	assert.equal((await attemptTransitionValidation).message.id, "stage-attempt-transition");
	await sender.next("delivered", (frame) => frame.messageId === "stage-attempt-transition");
	assert.equal((await nextAttempt.next("message")).message.content.text, "transition message");
});
