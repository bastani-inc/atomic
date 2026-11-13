import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, test } from "vitest";
import {
	getBrokerDeliveredMessagesKeyPath,
	getBrokerDeliveredMessagesPath,
	getBrokerSocketPath,
} from "../../packages/intercom/broker/paths.js";
import { getJitiCliPath } from "../../packages/intercom/broker/spawn.js";
import type { Message } from "../../packages/intercom/types.js";
import { sleep } from "../helpers/runtime.ts";

/** Two real broker starts, two registrations each, and one SIGTERM shutdown. */
const BROKER_RESTART_SCENARIO_TIMEOUT_MS = 60_000;
const BROKER_READY_MS = 10_000;
/** Long enough for a duplicate forward to reach the recipient had the broker made one. */
const DUPLICATE_SETTLE_MS = 300;

const repoRoot = resolve(import.meta.dirname, "../..");
const extensionDir = join(repoRoot, "packages/intercom");
// Short root: a Unix socket path must fit in about 104 bytes.
const agentDir = mkdtempSync(join(tmpdir(), "iclazy-"));
const socketPath = getBrokerSocketPath(process.platform, agentDir);
const originalAtomicAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
delete process.env.PI_CODING_AGENT_DIR;
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
type Client = InstanceType<typeof IntercomClient>;

const clients: Client[] = [];
let broker: ChildProcess | undefined;

function socketAnswers(): Promise<boolean> {
	return new Promise((resolveAnswer) => {
		const probe = net.createConnection(socketPath);
		probe.once("connect", () => {
			probe.destroy();
			resolveAnswer(true);
		});
		probe.once("error", () => resolveAnswer(false));
	});
}

async function startBroker(): Promise<void> {
	broker = spawn(process.execPath, [getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")], {
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: undefined },
		stdio: "ignore",
	});
	const deadline = Date.now() + BROKER_READY_MS;
	while (!(await socketAnswers())) {
		assert.ok(Date.now() < deadline, "broker socket did not become ready");
		await sleep(20);
	}
}

async function stopBroker(): Promise<void> {
	const running = broker;
	if (running === undefined || running.exitCode !== null || running.signalCode !== null) return;
	await new Promise<void>((resolveExit) => {
		running.once("exit", () => resolveExit());
		running.kill("SIGTERM");
	});
}

async function connectClient(name: string): Promise<Client> {
	const client = new IntercomClient(`lazy-authority-${name}`);
	client.on("error", () => {});
	clients.push(client);
	await client.connect({ cwd: agentDir, model: "test", pid: process.pid, startedAt: 1, lastActivity: 1, name });
	return client;
}

afterAll(async () => {
	for (const client of clients) await client.disconnect().catch(() => {});
	await stopBroker();
	if (originalAtomicAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = originalAtomicAgentDir;
	if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

test(
	"a registered session opens the delivered-message authority and a restarted broker still deduplicates its retry (#4727)",
	async () => {
		const authorityPath = getBrokerDeliveredMessagesPath(agentDir);
		await startBroker();
		assert.equal(existsSync(authorityPath), false, "a broker with no session opened the authority");

		const received: Message[] = [];
		const recipient = await connectClient("recipient");
		recipient.on("message", (_from, message: Message) => received.push(message));
		assert.equal(existsSync(authorityPath), true, "the first registration did not open the authority");
		assert.equal(existsSync(getBrokerDeliveredMessagesKeyPath(agentDir)), true);
		const sender = await connectClient("sender");
		const operation = { text: "deliver once across a broker restart", messageId: "lazy-authority-operation" };
		const first = await sender.send("recipient", operation);
		assert.equal(first.delivered, true, first.reason);
		const deadline = Date.now() + BROKER_READY_MS;
		while (received.length === 0) {
			assert.ok(Date.now() < deadline, "the first send never reached the recipient");
			await sleep(10);
		}

		for (const client of clients.splice(0)) await client.disconnect();
		await stopBroker();
		await startBroker();
		const restartedRecipient = await connectClient("recipient");
		restartedRecipient.on("message", (_from, message: Message) => received.push(message));
		const restartedSender = await connectClient("sender");

		const retry = await restartedSender.send("recipient", operation);
		assert.equal(retry.delivered, true, JSON.stringify(retry));
		assert.equal(retry.id, operation.messageId);
		await sleep(DUPLICATE_SETTLE_MS);
		assert.equal(received.length, 1, "the restarted broker delivered an operation its predecessor accepted");
	},
	BROKER_RESTART_SCENARIO_TIMEOUT_MS,
);
