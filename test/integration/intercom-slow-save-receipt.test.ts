import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, test } from "vitest";
import { getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import { getJitiCliPath } from "../../packages/intercom/broker/spawn.js";
import {
	RECIPIENT_RECEIPT_TIMEOUT_MS,
	RECIPIENT_SAVING_REPORT_INTERVAL_MS,
	SEND_RESPONSE_TIMEOUT_MS,
} from "../../packages/intercom/retry-policy.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const extensionDir = join(repoRoot, "packages/intercom");
const agentDir = mkdtempSync(join(tmpdir(), "intercom-slow-save-"));
const socketPath = getBrokerSocketPath(process.platform, agentDir);
const originalAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "intercom"), { recursive: true });
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");

/** The save is held past both the broker's receipt wait and the sender's own response wait. */
const HELD_SAVE_MS = SEND_RESPONSE_TIMEOUT_MS + RECIPIENT_RECEIPT_TIMEOUT_MS;
const SLOW_SAVE_TEST_TIMEOUT_MS = 4 * HELD_SAVE_MS;

const session = { cwd: "/tmp/slow-save", model: "test", pid: process.pid, startedAt: 1, lastActivity: 1 };
let broker: ChildProcess | undefined;

async function startBroker(): Promise<void> {
	broker = spawn(process.execPath, [getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")], {
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: agentDir },
		stdio: "ignore",
	});
	for (;;) {
		const connected = await new Promise<boolean>((resolveConnected) => {
			const probe = net.createConnection(socketPath);
			probe.once("connect", () => {
				probe.destroy();
				resolveConnected(true);
			});
			probe.once("error", () => resolveConnected(false));
		});
		if (connected) return;
		if (broker.exitCode !== null) throw new Error("Broker exited before its socket was ready");
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
	}
}

/** Waits for the broker to exit: Windows cannot remove its database files while the process still holds them. */
async function stopBroker(): Promise<void> {
	const running = broker;
	if (running === undefined || running.exitCode !== null || running.signalCode !== null) return;
	await new Promise<void>((resolveExit) => {
		running.once("exit", () => resolveExit());
		running.kill("SIGTERM");
	});
}

afterAll(async () => {
	await stopBroker();
	if (originalAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = originalAgentDir;
	rmSync(agentDir, { recursive: true, force: true, maxRetries: 5 });
});

async function client(name: string, acknowledgesReceipt: boolean) {
	const instance = acknowledgesReceipt
		? new IntercomClient(`${name}-home`, { acknowledgesReceipt: true })
		: new IntercomClient();
	instance.on("error", () => {});
	await instance.connect({ ...session, name });
	return instance;
}

test(
	"a send to a recipient whose save waits behind a busy journal is delivered, not reported uncertain (#3983)",
	async () => {
		await startBroker();
		const sender = await client("sender", false);
		const recipient = await client("recipient", true);
		// The recipient saves each message behind a gate (a pooled stage's journal commit waiting behind other
		// writers) and, like the Intercom extension, reports progress while the save is in flight.
		let release!: () => void;
		const gate = new Promise<void>((resolveGate) => {
			release = resolveGate;
		});
		const arrived = new Promise<string>((resolveArrived) => {
			recipient.on("message", (_from: SessionInfo, message: Message) => {
				resolveArrived(message.id);
				const saving = setInterval(() => recipient.reportSaving(message.id), RECIPIENT_SAVING_REPORT_INTERVAL_MS);
				void gate.then(() => {
					clearInterval(saving);
					recipient.acknowledgeReceived(message.id);
				});
			});
		});
		try {
			const sent = sender.send(recipient.sessionId!, { text: "held behind a busy journal" });
			await arrived;
			// Hold the save until both waits would have ended without progress reports.
			await new Promise((resolveHold) => setTimeout(resolveHold, HELD_SAVE_MS));
			release();
			const result = await sent;
			assert.equal(result.delivered, true, JSON.stringify(result));
		} finally {
			release();
			await sender.disconnect();
			await recipient.disconnect();
		}
	},
	SLOW_SAVE_TEST_TIMEOUT_MS,
);
