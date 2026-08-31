import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "vitest";
import { createMessageReader, writeMessage } from "../../packages/intercom/broker/framing.js";
import { getBrokerPidPath, getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import { getJitiCliPath } from "../../packages/intercom/broker/spawn.js";
import { sleep } from "../helpers/runtime.ts";

const repoRoot = resolve(import.meta.dirname, "../..");
const extensionDir = join(repoRoot, "packages/intercom");
/** Documented idle window before a broker with no registered sessions exits. */
const BROKER_IDLE_SHUTDOWN_MS = 5_000;
const BROKER_IDLE_SHUTDOWN_GRACE_MS = 2_000;
const BROKER_IDLE_SHUTDOWN_WINDOW_MS = BROKER_IDLE_SHUTDOWN_MS + BROKER_IDLE_SHUTDOWN_GRACE_MS;
/** Real broker child, jiti startup, and the idle shutdown window. */
const REAL_BROKER_IDLE_RETIREMENT_TIMEOUT_MS = 30_000;
const BROKER_STARTUP_MS = 10_000;
/** Unix unlink-and-rebind is the only eviction path; a live Windows named pipe returns EADDRINUSE. */
const unixEvictionTest = process.platform === "win32" ? test.skip : test;

const fixtures: Array<{ agentDir: string; broker: ChildProcess }> = [];

afterEach(async () => {
	while (fixtures.length > 0) {
		const fixture = fixtures.pop();
		if (!fixture) continue;
		if (fixture.broker.exitCode === null && fixture.broker.signalCode === null) {
			const exited = new Promise<void>((resolveExit) => {
				fixture.broker.once("exit", () => resolveExit());
			});
			fixture.broker.kill("SIGTERM");
			await Promise.race([exited, sleep(1_000)]);
		}
		rmSync(fixture.agentDir, { recursive: true, force: true });
	}
});

function spawnBroker(agentDir: string): ChildProcess {
	const broker = spawn(process.execPath, [getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")], {
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: undefined },
		stdio: ["ignore", "pipe", "pipe"],
	});
	fixtures.push({ agentDir, broker });
	return broker;
}

async function waitForBrokerPid(agentDir: string, broker: ChildProcess): Promise<number> {
	const pidPath = getBrokerPidPath(agentDir);
	const deadline = Date.now() + BROKER_STARTUP_MS;
	while (Date.now() < deadline) {
		if (broker.exitCode !== null || broker.signalCode !== null) {
			throw new Error(`Broker exited during startup with code ${broker.exitCode} signal ${broker.signalCode}`);
		}
		if (existsSync(pidPath) && broker.pid !== undefined) {
			const pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
			if (pid === broker.pid) return pid;
		}
		await sleep(20);
	}
	throw new Error("Broker pid file did not appear");
}

function waitForExit(broker: ChildProcess, timeoutMs: number): Promise<number | null> {
	if (broker.exitCode !== null || broker.signalCode !== null) {
		return Promise.resolve(broker.exitCode);
	}
	return new Promise((resolveExit, reject) => {
		const timer = setTimeout(() => {
			broker.off("exit", onExit);
			reject(new Error(`Broker did not exit within ${timeoutMs}ms`));
		}, timeoutMs);
		const onExit = (code: number | null) => {
			clearTimeout(timer);
			resolveExit(code);
		};
		broker.once("exit", onExit);
	});
}

function isBrokerAlive(broker: ChildProcess): boolean {
	return broker.exitCode === null && broker.signalCode === null;
}

async function connect(agentDir: string): Promise<net.Socket> {
	const socketPath = getBrokerSocketPath(process.platform, agentDir);
	const socket = net.createConnection(socketPath);
	socket.on("error", () => {});
	if (!socket.connecting) return socket;
	await new Promise<void>((resolveConnected, reject) => {
		socket.once("connect", () => resolveConnected());
		socket.once("error", reject);
	});
	return socket;
}

async function waitRegistered(socket: net.Socket): Promise<void> {
	await new Promise<void>((resolveRegistered, reject) => {
		const timer = setTimeout(() => reject(new Error("timed out waiting for registered")), BROKER_STARTUP_MS);
		const reader = createMessageReader(
			(message) => {
				if (typeof message === "object" && message !== null && "type" in message && message.type === "registered") {
					clearTimeout(timer);
					resolveRegistered();
				}
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
		socket.on("data", reader);
	});
}

// #2765
test(
	"a broker that receives no connection exits within the idle shutdown window",
	async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "intercom-idle-none-"));
		const broker = spawnBroker(agentDir);
		await waitForBrokerPid(agentDir, broker);
		const armedAt = Date.now();

		const code = await waitForExit(broker, BROKER_IDLE_SHUTDOWN_WINDOW_MS);
		assert.equal(code, 0);
		assert.ok(
			Date.now() - armedAt <= BROKER_IDLE_SHUTDOWN_WINDOW_MS,
			"idle broker exceeded the shutdown window after listen armed the check",
		);
	},
	REAL_BROKER_IDLE_RETIREMENT_TIMEOUT_MS,
);

// #2765
test(
	"a connection that closes before register still retires the broker",
	async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "intercom-idle-prereg-"));
		const broker = spawnBroker(agentDir);
		await waitForBrokerPid(agentDir, broker);

		const socket = await connect(agentDir);
		await new Promise<void>((resolveClosed) => {
			socket.once("close", () => resolveClosed());
			socket.destroy();
		});

		const closedAt = Date.now();
		const code = await waitForExit(broker, BROKER_IDLE_SHUTDOWN_WINDOW_MS);
		assert.equal(code, 0);
		assert.ok(
			Date.now() - closedAt <= BROKER_IDLE_SHUTDOWN_WINDOW_MS,
			"pre-register disconnect exceeded the shutdown window",
		);
	},
	REAL_BROKER_IDLE_RETIREMENT_TIMEOUT_MS,
);

// #2765
test(
	"a registered live session is not retired during the idle shutdown window",
	async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "intercom-idle-live-"));
		const broker = spawnBroker(agentDir);
		await waitForBrokerPid(agentDir, broker);

		const socket = await connect(agentDir);
		writeMessage(socket, {
			type: "register",
			session: {
				cwd: agentDir,
				model: "test-model",
				pid: process.pid,
				startedAt: Date.now(),
				lastActivity: Date.now(),
				name: "idle-live",
			},
		});

		await sleep(BROKER_IDLE_SHUTDOWN_WINDOW_MS);
		assert.equal(isBrokerAlive(broker), true, "registered broker exited while a live session was still connected");
		socket.end();
	},
	REAL_BROKER_IDLE_RETIREMENT_TIMEOUT_MS,
);

// #2765
unixEvictionTest(
	"an evicted idle broker does not unlink a successor's socket or pid",
	async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "intercom-idle-evict-"));
		const incumbent = spawnBroker(agentDir);
		const incumbentPid = await waitForBrokerPid(agentDir, incumbent);
		const successor = spawnBroker(agentDir);
		const successorPid = await waitForBrokerPid(agentDir, successor);
		assert.notEqual(successorPid, incumbentPid);
		const live = await connect(agentDir);
		const registered = waitRegistered(live);
		writeMessage(live, {
			type: "register",
			session: {
				cwd: agentDir,
				model: "test-model",
				pid: process.pid,
				startedAt: 1,
				lastActivity: 1,
				name: "evict-live",
			},
		});
		await registered;

		const code = await waitForExit(incumbent, BROKER_IDLE_SHUTDOWN_WINDOW_MS);
		assert.equal(code, 0);
		assert.equal(isBrokerAlive(successor), true, "successor broker exited when the incumbent shut down");
		assert.equal(Number.parseInt(readFileSync(getBrokerPidPath(agentDir), "utf8").trim(), 10), successorPid);
		const socketPath = getBrokerSocketPath(process.platform, agentDir);
		assert.equal(existsSync(socketPath), true, "incumbent shutdown unlinked the successor socket");
		const probe = await connect(agentDir);
		probe.end();
		live.end();
	},
	REAL_BROKER_IDLE_RETIREMENT_TIMEOUT_MS,
);
