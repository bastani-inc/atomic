/**
 * Regression: a session whose socket the broker itself ended must be retired,
 * not left in the fan-out map.
 *
 * Observed in `~/.atomic/agent/intercom/broker.log`: repeated
 * `ERR_STREAM_WRITE_AFTER_END` raised in `writeMessage`, called from
 * `IntercomBroker.broadcastToMemberships`, from both `handleMessage` and
 * `disconnectSession`. The broker removed a session only on the socket
 * `'close'` event, so a peer that half-closes — or one the broker itself ended
 * after refusing a registration — stayed in `this.sessions` indefinitely. Every
 * later broadcast, ack and delivery then targeted a socket whose writable side
 * was gone, and the failing write destroyed that socket synchronously, turning
 * one refused registration into a cascade of further broadcasts and errors.
 *
 * The same window made the broker lie about delivery: `intercom list` still
 * advertised the stale session, a `send` to it was answered `delivered`, and the
 * fabricated `deliveredMessages` record then refused the honest retry with
 * `message_id_conflict` — leaving the message permanently undeliverable under
 * its stable id.
 *
 * This suite drives the shipped broker as a real child process over its real
 * socket, using the production framing, and reads its real stderr log. Like
 * `intercom-broker-startup-log.test.ts` it uses `node:child_process` with an
 * `openSync`'d descriptor rather than `test/helpers/runtime.ts`, because the
 * descriptor is the whole point: the broker's stderr is what carries the
 * write-after-end traces being asserted about.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { createMessageReader, writeMessage } from "../../packages/intercom/broker/framing.js";
import { getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import { getJitiCliPath } from "../../packages/intercom/broker/spawn.js";
import type { BrokerMessage, ClientMessage } from "../../packages/intercom/types.js";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";

const BROKER_PROBE_TIMEOUT_MS = 250;
/**
 * How long the broker may take to listen. It runs from TypeScript source, which it compiles first: on a loaded machine
 * that alone takes many seconds. A broker that exits meanwhile fails the wait at once.
 */
const BROKER_START_TIMEOUT_MS = 50_000;
/** Structural cost of the suite's setup: a real broker process started from source, within its start budget. */
const BROKER_SETUP_TIMEOUT_MS = BROKER_START_TIMEOUT_MS + 10_000;
/**
 * How long a client waits for a frame the broker answers with: most of a test's budget, so only a frame the broker
 * never sends reaches it, whatever turns a loaded machine gives the broker process.
 */
const FRAME_TIMEOUT_MS = 20_000;

const repoRoot = resolve(import.meta.dirname, "../..");
const extensionDir = join(repoRoot, "packages/intercom");
const agentDir = mkdtempSync(join(tmpdir(), "intercom-stale-"));
const socketPath = getBrokerSocketPath(process.platform, agentDir);
const brokerLogPath = join(agentDir, "intercom", "broker.log");
const fixture = new IntercomBrokerFixture(agentDir);

class WireClient {
	readonly received: BrokerMessage[] = [];
	readonly socket: net.Socket;
	private consumed = new Set<number>();
	/** Wakes the frame waits whenever a frame arrives. */
	private arrived = Promise.withResolvers<void>();

	/**
	 * `halfOpen` keeps the client's read side alive after the broker sends FIN,
	 * which is what makes the stale-session state observable: without it Node
	 * closes the connection for us and the broker's `'close'` handler papers over
	 * the missing retirement.
	 */
	constructor(halfOpen = false) {
		this.socket = net.createConnection({ path: socketPath, allowHalfOpen: halfOpen });
		fixture.onCleanup(() => {
			this.socket.destroy();
		});
		this.socket.on(
			"data",
			createMessageReader(
				(message) => {
					this.received.push(message as BrokerMessage);
					this.wake();
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

	/** Wakes every frame wait, which then waits for the next frame. */
	private wake(): void {
		this.arrived.resolve();
		this.arrived = Promise.withResolvers<void>();
	}

	send(message: ClientMessage): void {
		writeMessage(this.socket, message);
	}

	/** Raw frame escape hatch for registrations `ClientMessage` does not model. */
	sendRaw(message: Record<string, unknown>): void {
		writeMessage(this.socket, message);
	}

	async next<T extends BrokerMessage["type"]>(
		type: T,
		matches: (message: Extract<BrokerMessage, { type: T }>) => boolean = () => true,
	): Promise<Extract<BrokerMessage, { type: T }>> {
		let timedOut = false;
		const bound = setTimeout(() => {
			timedOut = true;
			this.wake();
		}, FRAME_TIMEOUT_MS);
		try {
			while (!timedOut) {
				const index = this.received.findIndex((message, candidate) => {
					if (this.consumed.has(candidate) || message.type !== type) return false;
					return matches(message as Extract<BrokerMessage, { type: T }>);
				});
				if (index >= 0) {
					this.consumed.add(index);
					return this.received[index] as Extract<BrokerMessage, { type: T }>;
				}
				await this.arrived.promise;
			}
		} finally {
			clearTimeout(bound);
		}
		throw new Error(`Timed out waiting for broker frame ${type}`);
	}
}

async function waitForBroker(): Promise<void> {
	const deadline = Date.now() + BROKER_START_TIMEOUT_MS;
	while (Date.now() < deadline) {
		fixture.assertRunning();
		const connected = await new Promise<boolean>((resolveConnected) => {
			const probe = net.createConnection(socketPath);
			probe.setTimeout(BROKER_PROBE_TIMEOUT_MS, () => {
				probe.destroy();
				resolveConnected(false);
			});
			probe.once("connect", () => {
				probe.destroy();
				resolveConnected(true);
			});
			probe.once("error", () => {
				probe.destroy();
				resolveConnected(false);
			});
		});
		if (connected) return;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
	}
	throw new Error("Broker socket did not become ready");
}

const session = { cwd: "/tmp/stale", model: "test-model", pid: 7, startedAt: 1, lastActivity: 1 };

async function register(client: WireClient, name: string): Promise<string> {
	await client.connected();
	client.send({ type: "register", session: { ...session, name } });
	return (await client.next("registered")).sessionId;
}

/**
 * Register a session, then get its socket ended by the broker through a real
 * refusal path (a second registration whose reach policy the broker refuses,
 * which ends the registered session's connection).
 */
async function makeBrokerEndedSession(client: WireClient, name: string): Promise<string> {
	const id = await register(client, name);
	client.sendRaw({
		type: "register",
		registrationGroup: "not-the-home",
		reach: { home: "stale-home", reachable: [] },
		session: { ...session, name, group: "stale-home", groups: ["stale-home"] },
	});
	assert.match(
		(await client.next("registration_failed")).reason,
		/Intercom registration group not-the-home is not the reach policy's home group stale-home/,
	);
	return id;
}

function brokerLog(): string {
	try {
		return readFileSync(brokerLogPath, "utf8");
	} catch {
		return "";
	}
}

beforeAll(async () => {
	mkdirSync(join(agentDir, "intercom"), { recursive: true });
	const logFd = openSync(brokerLogPath, "w");
	try {
		const broker = spawn(process.execPath, [getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")], {
			env: { ...process.env, ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: undefined },
			stdio: ["ignore", "ignore", logFd],
		});
		fixture.trackBroker(broker);
	} finally {
		closeSync(logFd);
	}
	await waitForBroker();
}, BROKER_SETUP_TIMEOUT_MS);

afterAll(async () => {
	await fixture.cleanup();
});

test("a broker-ended session is retired, and healthy peers keep working without write-after-end", async () => {
	const observer = new WireClient();
	const observerId = await register(observer, "stale-observer");

	const zombie = new WireClient(true);
	const zombieId = await makeBrokerEndedSession(zombie, "stale-zombie");
	assert.notEqual(zombieId, observerId);

	// Trigger the broadcast that used to write into the refused peer's ended socket:
	// registering a new session fans `session_joined` out to every group member.
	const healthy = new WireClient();
	const healthyId = await register(healthy, "stale-healthy");
	await observer.next("session_joined", (frame) => frame.session.id === healthyId);

	// Retirement, observed from another session rather than from broker internals —
	// and it must have happened at the refusal, not as a side effect of a later
	// failed write. The ordering assertion is what separates the two: a departure
	// caused by a write-after-end destroy can only land after the broadcast that
	// destroyed it.
	const departure = await observer.next("session_left", (frame) => frame.sessionId === zombieId);
	const frameTypes = observer.received;
	assert.ok(
		frameTypes.indexOf(departure) <
			frameTypes.findIndex((frame) => frame.type === "session_joined" && frame.session.id === healthyId),
		`session_left arrived after the broadcast: ${JSON.stringify(frameTypes.map((frame) => frame.type))}`,
	);

	observer.send({ type: "list", requestId: "after-refusal" });
	const listed = (await observer.next("sessions", (frame) => frame.requestId === "after-refusal")).sessions.map(
		({ id }) => id,
	);
	assert.deepEqual(listed.sort(), [healthyId, observerId].sort());

	// The peer that half-closed never produced a 'close', so this is exactly the
	// state in which the old broker kept broadcasting into an ended socket.
	assert.equal(zombie.socket.destroyed, false);

	// The healthy peers keep working and stay connected.
	healthy.send({
		type: "send",
		to: observerId,
		message: { id: "healthy-1", timestamp: 2, content: { text: "hi" } },
	});
	await healthy.next("delivered", (frame) => frame.messageId === "healthy-1");
	await observer.next("message", (frame) => frame.message.id === "healthy-1");
	assert.equal(observer.socket.destroyed, false);
	assert.equal(healthy.socket.destroyed, false);

	assert.equal(brokerLog().includes("ERR_STREAM_WRITE_AFTER_END"), false, brokerLog());
	assert.equal(brokerLog().includes("Socket error"), false, brokerLog());

	for (const client of [observer, healthy, zombie]) client.socket.end();
});

test("a send to a broker-ended session fails truthfully and keeps the message id retryable", async () => {
	const sender = new WireClient();
	await register(sender, "truthful-sender");

	const zombie = new WireClient(true);
	const zombieId = await makeBrokerEndedSession(zombie, "truthful-zombie");
	// Deliberately no wait for `session_left` first: this is the window in which the
	// broker used to answer `delivered` for a peer that received nothing.

	const message = { id: "truthful-1", timestamp: 3, content: { text: "first" } };
	sender.send({ type: "send", to: zombieId, message });
	const first = await sender.next("delivery_failed", (frame) => frame.messageId === "truthful-1");
	assert.equal(first.reason, "Session not found");
	assert.equal(first.reasonCode, undefined);
	// Nothing was delivered, so the ack must not be `delivered`.
	assert.equal(
		sender.received.some((frame) => frame.type === "delivered" && frame.messageId === "truthful-1"),
		false,
	);
	// And the peer really did not get it, which is what makes `delivered` a lie.
	assert.equal(
		zombie.received.some((frame) => frame.type === "message"),
		false,
	);

	// The identical retry is refused the same way rather than answered `delivered`
	// out of a cache entry the failed send never earned.
	sender.send({ type: "send", to: zombieId, message });
	const retry = await sender.next("delivery_failed", (frame) => frame.messageId === "truthful-1" && frame !== first);
	assert.equal(retry.reason, "Session not found");
	assert.equal(retry.reasonCode, undefined);

	// A retry that changes the payload is not a conflict either: the id was never burned.
	sender.send({
		type: "send",
		to: zombieId,
		message: { id: "truthful-1", timestamp: 4, content: { text: "second" } },
	});
	await sender.next(
		"delivery_failed",
		(frame) => frame.messageId === "truthful-1" && frame !== first && frame !== retry,
	);
	assert.deepEqual(
		sender.received.filter((frame) => frame.type === "delivery_failed").map((frame) => frame.reasonCode),
		[undefined, undefined, undefined],
	);

	assert.equal(brokerLog().includes("ERR_STREAM_WRITE_AFTER_END"), false, brokerLog());

	for (const client of [sender, zombie]) client.socket.end();
});
