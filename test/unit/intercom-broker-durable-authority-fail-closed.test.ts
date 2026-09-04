import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, test } from "vitest";
import { getBrokerDeliveredMessagesPath, getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import { getJitiCliPath } from "../../packages/intercom/broker/spawn.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const extensionDir = join(repoRoot, "packages/intercom");
const agentDir = mkdtempSync(join(tmpdir(), "intercom-corrupt-authority-"));
const socketPath = getBrokerSocketPath(process.platform, agentDir);
const originalAtomicAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
delete process.env.PI_CODING_AGENT_DIR;
mkdirSync(join(agentDir, "intercom"), { recursive: true });
writeFileSync(getBrokerDeliveredMessagesPath(agentDir), "not-a-sqlite-database");
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");

let broker: ChildProcess | undefined;
let brokerOutput = "";
const clients: InstanceType<typeof IntercomClient>[] = [];

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
	if (broker?.exitCode !== null) return;
	await new Promise<void>((resolveExit) => {
		broker?.once("exit", () => resolveExit());
		broker?.kill("SIGTERM");
	});
	broker = undefined;
}

beforeAll(startBroker);

afterAll(async () => {
	for (const client of clients) await client.disconnect();
	await stopBroker();
	if (originalAtomicAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = originalAtomicAgentDir;
	if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

test("corrupt durable authority refuses pending-stage notification delivery", async () => {
	const runId = "86ec77fc-a8a0-4ecf-96f5-0ff8813c1cc8";
	const group = `workflow:${runId}`;
	const capability = "corrupt-authority-capability";
	const owner = new IntercomClient("corrupt-authority-owner");
	const recipient = new IntercomClient("corrupt-authority-recipient");
	clients.push(owner, recipient);
	for (const client of clients) client.on("error", () => {});
	const registration = {
		cwd: "/tmp/corrupt-authority",
		model: "test",
		pid: process.pid,
		startedAt: 1,
		lastActivity: 1,
		group,
	};
	await owner.connect({ ...registration, name: "owner" });
	await recipient.connect({ ...registration, name: "recipient" });
	owner.registerPendingStageRoute(runId, group, capability);
	await owner.listSessions();

	let received = 0;
	recipient.on("pending_stage_notification", (request) => {
		received += 1;
		recipient.respondPendingStageNotification(request.requestId, true);
	});
	const result = await owner.sendPendingStageNotification(
		runId,
		capability,
		recipient.sessionId ?? "missing",
		"recipient",
		{ text: "must not bypass corrupt authority", messageId: "corrupt-authority-notification" },
		"corrupt-authority-recipient",
	);

	assert.equal(result.delivered, false);
	assert.match(result.reason ?? "", /authority is invalid/);
	assert.equal(received, 0);
});

test("full durable authority refuses a pending-stage notification before delivery", async () => {
	for (const client of clients.splice(0)) await client.disconnect();
	await stopBroker();
	const authorityPath = getBrokerDeliveredMessagesPath(agentDir);
	for (const suffix of ["", "-shm", "-wal"]) rmSync(`${authorityPath}${suffix}`, { force: true });
	const database = new DatabaseSync(authorityPath);
	database.exec(`
		CREATE TABLE delivered_messages (
			state TEXT NOT NULL CHECK (state IN ('reserved', 'accepted')),
			message_id TEXT PRIMARY KEY NOT NULL,
			signature TEXT NOT NULL,
			delivered_at INTEGER NOT NULL,
			target_identity TEXT,
			question_target_session_id TEXT,
			question_sender_group_identity TEXT
		) STRICT;
	`);
	const insert = database.prepare(
		"INSERT INTO delivered_messages (state, message_id, signature, delivered_at) VALUES ('accepted', ?, ?, ?)",
	);
	const now = Date.now();
	database.exec("BEGIN");
	for (let index = 0; index < 10_000; index += 1) insert.run(`retained-${index}`, `signature-${index}`, now);
	database.exec("COMMIT");
	database.close();
	await startBroker();

	const runId = "99fd5a83-eb09-42bd-ae60-d9d828f9a91d";
	const group = `workflow:${runId}`;
	const capability = "full-authority-capability";
	const owner = new IntercomClient("full-authority-owner");
	const recipient = new IntercomClient("full-authority-recipient");
	clients.push(owner, recipient);
	for (const client of clients) client.on("error", () => {});
	const registration = {
		cwd: "/tmp/full-authority",
		model: "test",
		pid: process.pid,
		startedAt: 1,
		lastActivity: 1,
		group,
	};
	await owner.connect({ ...registration, name: "owner" });
	await recipient.connect({ ...registration, name: "recipient" });
	owner.registerPendingStageRoute(runId, group, capability);
	await owner.listSessions();

	let received = 0;
	recipient.on("pending_stage_notification", (request) => {
		received += 1;
		recipient.respondPendingStageNotification(request.requestId, true);
	});
	const result = await owner.sendPendingStageNotification(
		runId,
		capability,
		recipient.sessionId ?? "missing",
		"recipient",
		{ text: "must not bypass full authority", messageId: "full-authority-notification" },
		"full-authority-recipient",
	);

	assert.equal(result.delivered, false);
	assert.match(result.reason ?? "", /capacity is full/);
	assert.equal(received, 0);
});
