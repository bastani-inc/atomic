/**
 * #5096: `forget` is a durable SQLite DELETE. While another connection holds the
 * write lock it throws "database is locked" after the busy timeout. In the broker's
 * settle, ack-timeout and disconnect paths that throw must neither end the broker
 * nor swallow the sender's outcome, and the reservation must still go once the
 * lock is released so the sender's retry is not refused as uncertain.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, test } from "vitest";
import { getBrokerDeliveredMessagesPath, getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import { getJitiCliPath } from "../../packages/intercom/broker/spawn.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const extensionDir = join(repoRoot, "packages/intercom");
const agentDir = mkdtempSync(join(tmpdir(), "intercom-forget-lock-"));
const socketPath = getBrokerSocketPath(process.platform, agentDir);
/** Makes one forwarded live-stage write fail on demand; see the fixture. */
const forwardWriteFault = pathToFileURL(join(repoRoot, "test/fixtures/intercom-broker-forward-write-fault.mjs")).href;
/** The broker's ordinary SQLite busy timeout; the lock is held longer than this. */
const DATABASE_BUSY_TIMEOUT_MS = 5_000;
/** How soon the sender must hear `delivery_failed` once its recipient left, while the lock is held. */
const OUTCOME_BOUND_MS = 2_000;
/** How long another session's round-trip may take while the lock is held. */
const ROUND_TRIP_BOUND_MS = 1_000;
const originalAtomicAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
delete process.env.PI_CODING_AGENT_DIR;
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
type Client = InstanceType<typeof IntercomClient>;

let broker: ChildProcess | undefined;
let brokerOutput = "";
let clients: Client[] = [];
let lock: DatabaseSync | undefined;

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

beforeAll(async () => {
	broker = spawn(
		process.execPath,
		["--import", forwardWriteFault, getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")],
		{
			env: { ...process.env, ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: undefined },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	broker.stdout?.on("data", (data) => {
		brokerOutput += String(data);
	});
	broker.stderr?.on("data", (data) => {
		brokerOutput += String(data);
	});
	await waitForBroker();
});

afterEach(async () => {
	releaseLock();
	for (const client of clients) await client.disconnect().catch(() => {});
	clients = [];
});

afterAll(async () => {
	if (broker?.exitCode === null) {
		await new Promise<void>((resolveExit) => {
			broker?.once("exit", () => resolveExit());
			broker?.kill("SIGTERM");
		});
	}
	if (originalAtomicAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = originalAtomicAgentDir;
	if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

/** Another writer, such as a second broker during an upgrade hand-over, holds the write lock. */
function holdWriteLock(): void {
	lock = new DatabaseSync(getBrokerDeliveredMessagesPath(agentDir));
	lock.exec("PRAGMA busy_timeout = 0");
	lock.exec("BEGIN IMMEDIATE");
}

function releaseLock(): void {
	if (lock === undefined) return;
	lock.exec("ROLLBACK");
	lock.close();
	lock = undefined;
}

async function connectedPair(label: string) {
	const runId = crypto.randomUUID();
	const group = `workflow:${runId}`;
	const capability = `${label}-capability`;
	const owner = new IntercomClient(`${label}-owner`);
	const recipient = new IntercomClient(`${label}-recipient`);
	clients.push(owner, recipient);
	for (const client of [owner, recipient]) client.on("error", () => {});
	const registration = { cwd: `/tmp/${label}`, model: "test", pid: process.pid, startedAt: 1, lastActivity: 1, group };
	await owner.connect({ ...registration, name: "owner" });
	await recipient.connect({ ...registration, name: "recipient" });
	owner.registerPendingStageRoute(runId, group, capability);
	await owner.listSessions();
	const send = (messageId: string) =>
		owner.sendPendingStageNotification(
			runId,
			capability,
			recipient.sessionId ?? "missing",
			"recipient",
			{ text: "pending-stage notice", messageId },
			`${label}-recipient`,
		);
	return { owner, recipient, send };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for the expected condition: ${brokerOutput}`);
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
	}
}

/** Whether the broker's durable delivered-message authority still holds a record for `messageId`. */
function deliveredRecordExists(messageId: string): boolean {
	const database = new DatabaseSync(getBrokerDeliveredMessagesPath(agentDir));
	try {
		return database.prepare("SELECT 1 FROM delivered_messages WHERE message_id = ?").get(messageId) !== undefined;
	} finally {
		database.close();
	}
}

async function connectedProbe(): Promise<Client> {
	const probe = new IntercomClient("forget-lock-probe");
	probe.on("error", () => {});
	clients.push(probe);
	await probe.connect({ cwd: "/tmp/probe", model: "test", pid: process.pid, startedAt: 1, lastActivity: 1 });
	return probe;
}

async function assertBrokerAlive(): Promise<void> {
	assert.equal(broker?.exitCode, null, `the broker stays up: ${brokerOutput}`);
	assert.ok(Array.isArray(await (await connectedProbe()).listSessions()));
}

/** Another session's request and its answer complete within `ROUND_TRIP_BOUND_MS`. */
async function assertServesAnotherSession(probe: Client): Promise<void> {
	const started = Date.now();
	await probe.listSessions();
	const elapsed = Date.now() - started;
	assert.ok(elapsed < ROUND_TRIP_BOUND_MS, `another session waited ${elapsed} ms for the broker`);
}

test("a refused pending-stage notice still fails to the sender while its delete is locked, and its retry is delivered (#5096)", async () => {
	const { recipient, send } = await connectedPair("settle");
	let admit = false;
	recipient.on("pending_stage_notification", (request) => {
		if (!admit) holdWriteLock();
		recipient.respondPendingStageNotification(request.requestId, admit);
	});

	const refused = await send("settle-notice");
	assert.equal(refused.delivered, false);
	assert.match(refused.reason ?? "", /did not admit/);
	await assertBrokerAlive();

	releaseLock();
	admit = true;
	const retried = await send("settle-notice");
	assert.equal(
		retried.delivered,
		true,
		`the stale reservation was forgotten once the lock was released: ${retried.reason}`,
	);
});

test("a recipient that disconnects while its delete is locked fails to the sender at once, and the broker keeps serving (#5096)", async () => {
	const { recipient, send } = await connectedPair("disconnect");
	const probe = await connectedProbe();
	let lockedAt = 0;
	recipient.on("pending_stage_notification", () => {
		holdWriteLock();
		lockedAt = Date.now();
		void recipient.disconnect();
	});

	const result = await send("disconnect-notice");
	const outcomeAfter = Date.now() - lockedAt;
	assert.equal(result.delivered, false);
	assert.match(result.reason ?? "", /disconnected/);
	assert.ok(outcomeAfter < OUTCOME_BOUND_MS, `the sender waited ${outcomeAfter} ms for delivery_failed`);
	assert.match(brokerOutput, /could not forget delivered message disconnect-notice/);

	// The lock outlasts the ordinary busy timeout while the broker retries the delete.
	while (Date.now() - lockedAt < DATABASE_BUSY_TIMEOUT_MS + 1_000) {
		await assertServesAnotherSession(probe);
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
	}
	assert.equal(deliveredRecordExists("disconnect-notice"), true, "the locked delete has not landed yet");
	releaseLock();
	await assertBrokerAlive();
	// Nothing retries this message ID, so the broker's own retry removes the stale reservation.
	await waitUntil(() => !deliveredRecordExists("disconnect-notice"));
}, 60_000);

test("a route owner that leaves before its notice is acknowledged removes the notice's reservation (#5096)", async () => {
	const { owner, recipient, send } = await connectedPair("owner-departure");
	const notified = Promise.withResolvers<void>();
	recipient.on("pending_stage_notification", () => notified.resolve());

	const sent = send("owner-departure-notice").catch(() => undefined);
	await notified.promise;
	assert.equal(deliveredRecordExists("owner-departure-notice"), true);
	await owner.disconnect();
	await sent;

	await waitUntil(() => !deliveredRecordExists("owner-departure-notice"));
	await assertBrokerAlive();
});

test("a live-stage forward whose write to the stage fails reports Session not found and forgets the reservation (#5096)", async () => {
	const runId = crypto.randomUUID();
	const invocationGroup = `workflow:${runId}`;
	const stageGroup = `${invocationGroup}/reviewers`;
	const capability = "forward-fault-capability";
	const target = `workflow:${runId}/reviewer`;
	const owner = new IntercomClient("forward-fault-owner");
	const stage = new IntercomClient("forward-fault-stage");
	const sender = new IntercomClient("forward-fault-sender");
	for (const client of [owner, stage, sender]) {
		client.on("error", () => {});
		clients.push(client);
	}
	const session = { cwd: "/tmp/forward-fault", model: "test", pid: process.pid, startedAt: 1, lastActivity: 1 };
	await owner.connect({ ...session, name: "forward-fault-owner", group: invocationGroup });
	// The fixture treats the socket that registered this name as the stage whose write fails.
	await stage.connect({ ...session, name: "forward-fault-target", group: stageGroup });
	await sender.connect({ ...session, name: "forward-fault-sender", group: "default" });
	await sender.joinGroup(invocationGroup);
	owner.registerPendingStageRoute(runId, invocationGroup, capability, [
		{
			stageId: "reviewer",
			stageName: "reviewer",
			target,
			lifecycle: "running",
			routeEligible: true,
			group: stageGroup,
		},
	]);
	await owner.listSessions();
	await stage.registerLiveWorkflowStageRoute(runId, ["reviewer"], capability);
	owner.on("pending_stage_message", (request) => {
		owner.respondPendingStageMessage(request.requestId, { outcome: "forward", target });
	});
	const received: string[] = [];
	stage.on("message", (_from: unknown, message: { text: string }) => received.push(message.text));

	const text = "ARM-FORWARD-WRITE-FAULT, then deliver on retry";
	const failed = await sender.send(target, { text, messageId: "forward-fault-message" });
	assert.equal(failed.delivered, false);
	assert.equal(failed.reason, "Session not found");
	assert.match(brokerOutput, /forward write fault injected/);
	assert.deepEqual(received, []);

	const retried = await sender.send(target, { text, messageId: "forward-fault-message" });
	assert.equal(retried.delivered, true, `the retry is not refused as uncertain: ${retried.reason}`);
	await waitUntil(() => received.length === 1);
});

test("an acknowledgment timeout whose delete is locked does not end the broker (#5096)", async () => {
	const { recipient, send } = await connectedPair("timeout");
	recipient.on("pending_stage_notification", () => holdWriteLock());

	// The broker's 10 s acknowledgment timer and the client's own 10 s response
	// timeout race, so either outcome is a refusal; what matters is the broker.
	const result = await send("timeout-notice").catch((error: Error) => ({ delivered: false, reason: error.message }));
	assert.equal(result.delivered, false);
	await new Promise((resolveDelay) => setTimeout(resolveDelay, 7_000));
	releaseLock();
	await assertBrokerAlive();
}, 60_000);

test("a retried forward to a receipt-confirming stage whose write fails keeps the earlier attempt's reservation (#5096)", async () => {
	const runId = crypto.randomUUID();
	const invocationGroup = `workflow:${runId}`;
	const stageGroup = `${invocationGroup}/reviewers`;
	const capability = "retry-fault-capability";
	const target = `workflow:${runId}/reviewer`;
	const owner = new IntercomClient("retry-fault-owner");
	const stage = new IntercomClient("retry-fault-stage", { acknowledgesReceipt: true });
	const sender = new IntercomClient("retry-fault-sender");
	for (const client of [owner, stage, sender]) {
		client.on("error", () => {});
		clients.push(client);
	}
	const session = { cwd: "/tmp/retry-fault", model: "test", pid: process.pid, startedAt: 1, lastActivity: 1 };
	await owner.connect({ ...session, name: "retry-fault-owner", group: invocationGroup });
	// The fixture treats the socket that registered a name containing "forward-fault-target" as a faultable stage.
	await stage.connect({ ...session, name: "forward-fault-target-receipts", group: stageGroup });
	await sender.connect({ ...session, name: "retry-fault-sender", group: "default" });
	await sender.joinGroup(invocationGroup);
	owner.registerPendingStageRoute(runId, invocationGroup, capability, [
		{
			stageId: "reviewer",
			stageName: "reviewer",
			target,
			lifecycle: "running",
			routeEligible: true,
			group: stageGroup,
		},
	]);
	await owner.listSessions();
	await stage.registerLiveWorkflowStageRoute(runId, ["reviewer"], capability);
	owner.on("pending_stage_message", (request) => {
		owner.respondPendingStageMessage(request.requestId, { outcome: "forward", target });
	});
	// The stage receives the message but never confirms it saved it, so the first attempt stays uncertain.
	let received = 0;
	stage.on("message", () => {
		received += 1;
	});

	const messageId = "retry-fault-message";
	const text = "RETRY-FORWARD-WRITE-FAULT: the retry's forward write fails";
	const first = await sender
		.send(target, { text, messageId })
		.catch((error: Error) => ({ delivered: false, reason: error.message }));
	assert.equal(first.delivered, false, "an unconfirmed save is not reported delivered");
	assert.equal(received, 1, "the stage received the first attempt");
	assert.equal(deliveredRecordExists(messageId), true, "the first attempt left its reservation");

	const retried = await sender.send(target, { text, messageId });
	assert.equal(retried.delivered, false);
	assert.equal(retried.reason, "Session not found");
	assert.match(brokerOutput, /forward write fault injected/);
	// The broker writes the outcome before it would delete, so give a wrong delete time to land.
	await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
	assert.equal(
		deliveredRecordExists(messageId),
		true,
		"a failed retry does not forget the reservation the earlier attempt may have delivered",
	);
}, 60_000);
