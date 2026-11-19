import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";

import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, test } from "vitest";

import type { BrokerMessage } from "../../packages/intercom/types.js";

const GROUP = "registration-group";

const BROKER_FRAME_TIMEOUT_MS = 5_000;
const BROKER_STARTUP_TIMEOUT_MS = 10_000;
const BROKER_SHUTDOWN_TIMEOUT_MS = 5_000;

const repoRoot = resolve(import.meta.dirname, "../..");
const extensionDir = join(repoRoot, "packages/intercom");
const agentDir = mkdtempSync(join(tmpdir(), "pending-stage-"));
const previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const previousLegacyAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
delete process.env.PI_CODING_AGENT_DIR;

const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");
const { createMessageReader, writeMessage } = await import("../../packages/intercom/broker/framing.js");
const { getJitiCliPath } = await import("../../packages/intercom/broker/spawn.js");

const { IntercomClient } = await import("../../packages/intercom/broker/client.js");

async function waitForBroker(child: ChildProcess): Promise<void> {
	await new Promise<void>((resolveReady, rejectReady) => {
		let stdout = "";
		const finish = (error?: Error): void => {
			clearTimeout(timer);
			child.stdout?.off("data", onStdout);
			child.off("exit", onExit);
			if (error === undefined) resolveReady();
			else rejectReady(error);
		};
		const onStdout = (chunk: Buffer | string): void => {
			stdout += chunk.toString();
			if (stdout.includes("Intercom broker started")) finish();
		};
		const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
			finish(new Error(`Intercom broker exited before readiness (code=${String(code)}, signal=${String(signal)})`));
		};
		const timer = setTimeout(
			() => finish(new Error(`Intercom broker did not become ready within ${BROKER_STARTUP_TIMEOUT_MS}ms`)),
			BROKER_STARTUP_TIMEOUT_MS,
		);
		child.stdout?.on("data", onStdout);
		child.once("exit", onExit);
	});
}

interface BrokerFrameWaiter {
	readonly type?: BrokerMessage["type"];
	readonly matches: (message: BrokerMessage) => boolean;
	readonly resolve: (message: BrokerMessage) => void;
	readonly reject: (error: Error) => void;
	readonly timer: NodeJS.Timeout;
}

class RawBrokerClient {
	readonly socket = net.createConnection(getBrokerSocketPath());
	readonly received: BrokerMessage[] = [];
	private readonly consumed = new Set<number>();
	private readonly waiters = new Set<BrokerFrameWaiter>();

	constructor() {
		this.socket.on(
			"data",
			createMessageReader(
				(message) => {
					this.received.push(message as BrokerMessage);
					this.resolveWaiters();
				},
				(error) => this.socket.destroy(error),
			),
		);
		this.socket.on("error", (error) => this.rejectWaiters(error));
		this.socket.on("close", () => this.rejectWaiters(new Error("Broker client closed")));
	}

	async register(name: string, group: string): Promise<void> {
		if (this.socket.connecting) await new Promise<void>((resolve) => this.socket.once("connect", resolve));
		writeMessage(this.socket, {
			type: "register",
			session: { name, group, cwd: repoRoot, model: "test", pid: 1, startedAt: 1, lastActivity: 1 },
		});
		await this.next("registered");
	}

	send(message: unknown): void {
		writeMessage(this.socket, message as never);
	}

	async next<T extends BrokerMessage["type"]>(
		type: T,
		matches: (message: Extract<BrokerMessage, { type: T }>) => boolean = () => true,
	): Promise<Extract<BrokerMessage, { type: T }>> {
		const buffered = this.consume(type, (message) => matches(message as Extract<BrokerMessage, { type: T }>));
		if (buffered !== undefined) return buffered as Extract<BrokerMessage, { type: T }>;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiters.delete(waiter);
				reject(new Error(`Timed out waiting for broker frame ${type}`));
			}, BROKER_FRAME_TIMEOUT_MS);
			const waiter: BrokerFrameWaiter = {
				type,
				matches: (message) => matches(message as Extract<BrokerMessage, { type: T }>),
				resolve: (message) => resolve(message as Extract<BrokerMessage, { type: T }>),
				reject,
				timer,
			};
			this.waiters.add(waiter);
			this.resolveWaiters();
		});
	}

	async nextDeliveryAcknowledgment(
		messageId: string,
	): Promise<Extract<BrokerMessage, { type: "delivered" | "queued" | "delivery_failed" }>> {
		const matches = (message: BrokerMessage): boolean =>
			(message.type === "delivered" || message.type === "queued" || message.type === "delivery_failed") &&
			message.messageId === messageId;
		const buffered = this.consume(undefined, matches);
		if (buffered !== undefined) {
			return buffered as Extract<BrokerMessage, { type: "delivered" | "queued" | "delivery_failed" }>;
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiters.delete(waiter);
				reject(new Error(`Timed out waiting for broker delivery acknowledgment ${messageId}`));
			}, BROKER_FRAME_TIMEOUT_MS);
			const waiter: BrokerFrameWaiter = {
				matches,
				resolve: (message) =>
					resolve(message as Extract<BrokerMessage, { type: "delivered" | "queued" | "delivery_failed" }>),
				reject,
				timer,
			};
			this.waiters.add(waiter);
			this.resolveWaiters();
		});
	}

	async close(): Promise<void> {
		if (this.socket.destroyed) return;
		await new Promise<void>((resolve) => {
			this.socket.once("close", resolve);
			this.socket.destroy();
		});
	}

	private consume(
		type: BrokerMessage["type"] | undefined,
		matches: (message: BrokerMessage) => boolean,
	): BrokerMessage | undefined {
		const index = this.received.findIndex(
			(message, candidate) =>
				!this.consumed.has(candidate) && (type === undefined || message.type === type) && matches(message),
		);
		if (index < 0) return undefined;
		this.consumed.add(index);
		return this.received[index];
	}

	private resolveWaiters(): void {
		for (const waiter of this.waiters) {
			const message = this.consume(waiter.type, waiter.matches);
			if (message === undefined) continue;
			this.waiters.delete(waiter);
			clearTimeout(waiter.timer);
			waiter.resolve(message);
		}
	}

	private rejectWaiters(error: Error): void {
		for (const waiter of this.waiters) {
			clearTimeout(waiter.timer);
			waiter.reject(error);
		}
		this.waiters.clear();
	}
}

const rawClients = new Set<RawBrokerClient>();
let broker: ChildProcess | undefined;

async function startBroker(): Promise<void> {
	assert.equal(broker, undefined, "broker fixture must be stopped before restart");
	broker = spawn(process.execPath, [getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")], {
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: undefined },
		stdio: ["ignore", "pipe", "pipe"],
	});
	await waitForBroker(broker);
}

async function stopBroker(): Promise<void> {
	const activeBroker = broker;
	if (activeBroker === undefined) return;
	broker = undefined;
	if (activeBroker.exitCode !== null) return;
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`Broker did not exit within ${BROKER_SHUTDOWN_TIMEOUT_MS}ms after SIGTERM`)),
			BROKER_SHUTDOWN_TIMEOUT_MS,
		);
		activeBroker.once("exit", () => {
			clearTimeout(timer);
			resolve();
		});
		if (!activeBroker.kill("SIGTERM")) {
			clearTimeout(timer);
			reject(new Error("Broker rejected SIGTERM"));
		}
	});
}

beforeAll(startBroker);

afterAll(async () => {
	await Promise.all([...rawClients].map((client) => client.close()));
	await stopBroker();

	if (previousAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDir;
	if (previousLegacyAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousLegacyAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

test("control purpose survives presence and membership changes without discovery events or counts", async () => {
	const group = "recipient-purpose-group";
	const observer = new RawBrokerClient();
	const control = new RawBrokerClient();
	rawClients.add(observer);
	rawClients.add(control);
	try {
		await observer.register("purpose-observer", group);
		control.send({
			type: "register",
			session: {
				recipientPurpose: "control",
				name: "control-name",
				group,
				cwd: repoRoot,
				model: "test",
				pid: 1,
				startedAt: 1,
				lastActivity: 1,
			},
		});
		const controlId = (await control.next("registered")).sessionId;
		control.send({
			type: "presence",
			recipientPurpose: "agent",
			name: "renamed-control",
			status: "idle",
			requestId: "control-presence",
		});
		await control.next("presence_ack");
		control.send({ type: "join_group", group: "control-only", requestId: "control-join" });
		await control.next("membership_ack");
		observer.send({ type: "list_groups", requestId: "purpose-groups" });
		const groups = await observer.next("groups");
		assert.deepEqual(
			groups.groups.filter((entry) => entry.group === group || entry.group === "control-only"),
			[{ group, sessionCount: 1, member: true }],
		);
		for (const to of [controlId, "RENAMED-CONTROL"]) {
			for (const expectsReply of [false, true]) {
				const id = `control-${to}-${expectsReply}`;
				observer.send({
					type: "send",
					to,
					message: { id, timestamp: 1, expectsReply, content: { text: "no delivery" } },
				});
				assert.equal((await observer.nextDeliveryAcknowledgment(id)).type, "delivery_failed");
			}
		}
		control.send({ type: "list", requestId: "control-barrier" });
		await control.next("sessions");
		assert.equal(
			control.received.some((frame) => frame.type === "message"),
			false,
		);
		await control.close();
		observer.send({ type: "list", requestId: "observer-barrier" });
		await observer.next("sessions");
		assert.deepEqual(
			observer.received.filter((frame) =>
				frame.type === "session_joined" || frame.type === "presence_update"
					? frame.session.id === controlId
					: frame.type === "session_left"
						? frame.sessionId === controlId
						: frame.type === "peer_disconnected",
			),
			[],
		);
	} finally {
		await control.close();
		await observer.close();
	}
});

test.each(["agnt", "", null, 7, true, [], {}].map((recipientPurpose) => ({ recipientPurpose })))(
	"rejects invalid registration recipientPurpose $recipientPurpose on the wire",
	async ({ recipientPurpose }) => {
		const raw = new RawBrokerClient();
		rawClients.add(raw);
		try {
			const registered = raw.next("registered").then(
				() => true,
				(error: Error) => {
					if (!raw.socket.destroyed) throw error;
					return false;
				},
			);
			raw.send({
				type: "register",
				session: {
					name: "bad-purpose",
					group: GROUP,
					cwd: repoRoot,
					model: "test",
					pid: 1,
					startedAt: 0,
					lastActivity: 0,
					recipientPurpose,
				},
			});
			assert.equal(await registered, false, "malformed purpose must not be silently admitted as a control");
			assert.equal(raw.socket.destroyed, true);
		} finally {
			await raw.close();
		}
	},
);

test.each([undefined, "agent", "control"] as const)(
	"accepts recipientPurpose %s and preserves legacy wire behavior",
	async (recipientPurpose) => {
		// PR #2895 / Greptile 3945411533: omission is an agent, and purpose is immutable after registration.
		const raw = new RawBrokerClient();
		rawClients.add(raw);
		const observer = new IntercomClient();
		try {
			raw.send({
				type: "register",
				session: {
					name: "purpose-peer",
					group: GROUP,
					cwd: repoRoot,
					model: "test",
					pid: 1,
					startedAt: 0,
					lastActivity: 0,
					...(recipientPurpose === undefined ? {} : { recipientPurpose }),
				},
			});
			const { sessionId } = await raw.next("registered");
			await observer.connect({
				name: "purpose-observer",
				group: GROUP,
				cwd: repoRoot,
				model: "test",
				pid: 1,
				startedAt: 0,
				lastActivity: 0,
			});
			raw.send({ type: "presence", recipientPurpose: recipientPurpose === "control" ? "agent" : "control" });
			raw.send({ type: "list", requestId: "valid-purpose-fence" });
			const directory = await raw.next("sessions", (frame) => frame.requestId === "valid-purpose-fence");
			const isAgent = recipientPurpose !== "control";
			assert.equal(
				directory.sessions.some((session) => session.id === sessionId),
				isAgent,
			);
			for (const expectsReply of [false, true]) {
				const sent = await observer.send(sessionId, { text: "purpose check", expectsReply });
				assert.equal(sent.delivered, isAgent);
				if (isAgent) {
					const received = await raw.next("message");
					assert.equal(received.message.expectsReply, expectsReply);
				} else assert.match(sent.reason ?? "", /non-agent/);
			}
		} finally {
			await raw.close();
			await observer.disconnect();
		}
	},
);
