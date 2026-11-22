import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test, vi } from "vitest";
import { createMessageReader, writeMessage } from "../../packages/intercom/broker/framing.js";
import { getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import { getJitiCliPath } from "../../packages/intercom/broker/spawn.js";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";

/**
 * A broker keeps its state in the Intercom directory it created as it started. Once that directory is removed (the
 * user deleted the agent directory, or a test cleaned it up) while the broker still runs, the broker must not create it
 * again: what it keeps from then on stays in memory, and the next broker a live session starts creates its own.
 */

/** A broker start from source, readiness and one registration: far above a healthy run (1-3 s). */
const BROKER_WAIT_MS = 60_000;
const SCENARIO_TIMEOUT_MS = 120_000;
/**
 * How long the directory is watched after the registration answered: the broker opens what it keeps for sessions as
 * the first one registers, and the store of messages for subagents that ended after its code loaded.
 */
const WATCH_MS = 3_000;

const repoRoot = resolve(import.meta.dirname, "../..");
const extensionDir = join(repoRoot, "packages/intercom");
const roots: string[] = [];
const fixtures: IntercomBrokerFixture[] = [];

afterEach(async () => {
	for (const fixture of fixtures.splice(0).reverse()) await fixture.cleanup();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function connected(socketPath: string): Promise<net.Socket> {
	return new Promise((resolveConnected, reject) => {
		const socket = net.connect(socketPath);
		socket.once("connect", () => resolveConnected(socket));
		socket.once("error", reject);
	});
}

function registered(socket: net.Socket): Promise<void> {
	return new Promise((resolveRegistered, reject) => {
		socket.on(
			"data",
			createMessageReader((message) => {
				if (typeof message !== "object" || message === null || Array.isArray(message)) return;
				if (message.type === "registered") resolveRegistered();
				if (message.type === "registration_failed") reject(new Error(JSON.stringify(message)));
			}, reject),
		);
		socket.once("close", () =>
			reject(new Error("the broker closed the connection before it registered the session")),
		);
	});
}

/**
 * The broker's answer to a health request: a connection is accepted as soon as the socket listens, before the broker
 * has finished starting (it still renames and removes its startup lock files in the directory).
 */
function healthy(socket: net.Socket): Promise<void> {
	return new Promise((resolveHealthy, reject) => {
		const requestId = randomUUID();
		const onData = createMessageReader((message) => {
			if (typeof message !== "object" || message === null || Array.isArray(message)) return;
			if (message.type !== "health" || message.requestId !== requestId) return;
			socket.off("data", onData);
			resolveHealthy();
		}, reject);
		socket.on("data", onData);
		writeMessage(socket, { type: "health", requestId });
	});
}

async function startBrokerThenRemoveItsDirectory(): Promise<{ root: string; agentDir: string; socket: net.Socket }> {
	// Short root: a Unix socket path must fit in about 104 bytes.
	const root = mkdtempSync(join(tmpdir(), "icrm-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	mkdirSync(join(agentDir, "intercom"), { recursive: true });
	const fixture = new IntercomBrokerFixture(agentDir);
	fixtures.push(fixture);
	const broker: ChildProcess = spawn(
		process.execPath,
		[getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")],
		{
			env: {
				...process.env,
				ATOMIC_CODING_AGENT_DIR: agentDir,
				PI_CODING_AGENT_DIR: undefined,
				ATOMIC_STORAGE: undefined,
			},
			stdio: "ignore",
		},
	);
	fixture.trackBroker(broker);
	const socketPath = getBrokerSocketPath(process.platform, agentDir);
	const socket = await vi.waitFor(
		async () => {
			fixture.assertRunning();
			return connected(socketPath);
		},
		{ timeout: BROKER_WAIT_MS, interval: 20 },
	);
	fixture.onCleanup(() => {
		socket.destroy();
	});
	await healthy(socket);
	// The agent directory goes while the broker runs, before any session registered.
	rmSync(agentDir, { recursive: true, force: true });
	assert.equal(existsSync(agentDir), false, "the agent directory was removed");
	return { root, agentDir, socket };
}

async function register(socket: net.Socket, cwd: string): Promise<void> {
	const answered = registered(socket);
	const now = Date.now();
	writeMessage(socket, {
		type: "register",
		session: { name: "late", cwd, model: "test/model", pid: process.pid, startedAt: now, lastActivity: now },
	});
	await answered;
}

test(
	"a broker whose agent directory was removed while it ran does not create it again when a session registers",
	async () => {
		const { root, agentDir, socket } = await startBrokerThenRemoveItsDirectory();

		await register(socket, root);

		for (const deadline = performance.now() + WATCH_MS; performance.now() < deadline; ) {
			assert.equal(existsSync(agentDir), false, "the broker created its removed agent directory again");
			await new Promise((resolveWait) => setTimeout(resolveWait, 50));
		}
	},
	SCENARIO_TIMEOUT_MS,
);

test(
	"a broker whose Intercom directory was removed while it ran writes nothing into the one created after it",
	async () => {
		const { root, agentDir, socket } = await startBrokerThenRemoveItsDirectory();
		// The directory a later broker would create for a live session, under the same path.
		const later = join(agentDir, "intercom");
		mkdirSync(later, { recursive: true });

		await register(socket, root);

		for (const deadline = performance.now() + WATCH_MS; performance.now() < deadline; ) {
			assert.deepEqual(readdirSync(later), [], "the broker wrote into a directory it did not create");
			await new Promise((resolveWait) => setTimeout(resolveWait, 50));
		}
	},
	SCENARIO_TIMEOUT_MS,
);
