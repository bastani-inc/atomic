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
import { afterAll, afterEach, beforeAll, test } from "vitest";
import { getBrokerDeliveredMessagesPath, getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import { getJitiCliPath } from "../../packages/intercom/broker/spawn.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const extensionDir = join(repoRoot, "packages/intercom");
const agentDir = mkdtempSync(join(tmpdir(), "intercom-forget-lock-"));
const socketPath = getBrokerSocketPath(process.platform, agentDir);
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

/** Whether the broker's durable delivered-message authority still holds a record for `messageId`. */
function deliveredRecordExists(messageId: string): boolean {
	const database = new DatabaseSync(getBrokerDeliveredMessagesPath(agentDir));
	try {
		return database.prepare("SELECT 1 FROM delivered_messages WHERE message_id = ?").get(messageId) !== undefined;
	} finally {
		database.close();
	}
}

async function assertBrokerAlive(): Promise<void> {
	assert.equal(broker?.exitCode, null, `the broker stays up: ${brokerOutput}`);
	const probe = new IntercomClient("forget-lock-probe");
	probe.on("error", () => {});
	clients.push(probe);
	await probe.connect({ cwd: "/tmp/probe", model: "test", pid: process.pid, startedAt: 1, lastActivity: 1 });
	assert.ok(Array.isArray(await probe.listSessions()));
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

test("a recipient that disconnects while its delete is locked does not end the broker (#5096)", async () => {
	const { recipient, send } = await connectedPair("disconnect");
	recipient.on("pending_stage_notification", () => {
		holdWriteLock();
		void recipient.disconnect();
	});

	const result = await send("disconnect-notice");
	assert.equal(result.delivered, false);
	assert.match(result.reason ?? "", /disconnected/);
	assert.match(brokerOutput, /could not forget delivered message disconnect-notice/);
	assert.equal(deliveredRecordExists("disconnect-notice"), true, "the locked delete has not landed yet");
	releaseLock();
	await assertBrokerAlive();
	// Nothing retries this message ID, so the broker's own retry removes the stale reservation.
	const deadline = Date.now() + 15_000;
	while (deliveredRecordExists("disconnect-notice") && Date.now() < deadline) {
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
	}
	assert.equal(deliveredRecordExists("disconnect-notice"), false, "the failed delete is retried until it lands");
}, 60_000);

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
