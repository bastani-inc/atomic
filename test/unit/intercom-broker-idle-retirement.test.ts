import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
/** How much earlier than its window a timer may fire, as the broker measures it. */
const TIMER_EARLY_FIRE_TOLERANCE_MS = 50;
/** Unix unlink-and-rebind is the only eviction path; a live Windows named pipe returns EADDRINUSE. */
const unixEvictionTest = process.platform === "win32" ? test.skip : test;

const fixtures: Array<{ agentDir: string; broker: ChildProcess }> = [];
/** Each broker's stdout so far: it logs that it started only once its socket listens. */
const brokerStdout = new Map<ChildProcess, string>();

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
		brokerStdout.delete(fixture.broker);
	}
});

/** Reports which timeout windows the broker asked for, when they fire (see the helper). */
const TIMER_DELAY_PROBE = join(repoRoot, "test/helpers/timer-delay-probe.cjs");

function spawnBroker(agentDir: string): ChildProcess {
	const broker = spawn(
		process.execPath,
		["--require", TIMER_DELAY_PROBE, getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")],
		{
			env: { ...process.env, ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: undefined },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	brokerStdout.set(broker, "");
	broker.stdout?.on("data", (chunk: Buffer) => {
		brokerStdout.set(broker, `${brokerStdout.get(broker) ?? ""}${chunk.toString()}`);
	});
	fixtures.push({ agentDir, broker });
	return broker;
}

/** Resolves once `broker`'s stdout satisfies `ready`, checked on every chunk; rejects if it exits first. */
function waitForOutput(broker: ChildProcess, ready: (stdout: string) => boolean, awaited: string): Promise<void> {
	return new Promise((resolveReady, reject) => {
		const check = () => {
			if (!ready(brokerStdout.get(broker) ?? "")) return;
			broker.off("exit", onExit);
			broker.stdout?.off("data", check);
			resolveReady();
		};
		const onExit = () => {
			broker.stdout?.off("data", check);
			reject(new Error(`Broker exited with code ${broker.exitCode} signal ${broker.signalCode} before ${awaited}`));
		};
		broker.once("exit", onExit);
		broker.stdout?.on("data", check);
		check();
		if (broker.exitCode !== null || broker.signalCode !== null) {
			broker.off("exit", onExit);
			onExit();
		}
	});
}

/**
 * The pid file is written before the socket listens (#4409), and the broker logs that it started only once its socket
 * listens, so the broker is ready once it has logged it. No clock decides: a broker that does not start exits.
 */
async function waitForBrokerPid(agentDir: string, broker: ChildProcess): Promise<number> {
	await waitForOutput(broker, (stdout) => stdout.includes("Intercom broker started"), "it started");
	const pid = Number.parseInt(readFileSync(getBrokerPidPath(agentDir), "utf8").trim(), 10);
	assert.equal(pid, broker.pid);
	return pid;
}

/** Resolves with the broker's exit code once it exits; the test's own timeout bounds the wait. */
function waitForExit(broker: ChildProcess): Promise<number | null> {
	if (broker.exitCode !== null || broker.signalCode !== null) {
		return Promise.resolve(broker.exitCode);
	}
	return new Promise((resolveExit) => broker.once("exit", (code: number | null) => resolveExit(code)));
}

/**
 * What the broker reported when it retired idle: the timeout window it had asked for (reported by the timer probe as
 * that timer fired, just before the broker logged its retirement), and the idle time its own clock measured from its
 * last connection, or from when it listened. Neither depends on how late a loaded machine ran the timer or reported
 * the exit.
 */
function reportedRetirement(broker: ChildProcess): { readonly windowMs: number; readonly idleMs: number } {
	const stdout = brokerStdout.get(broker) ?? "";
	const retired = /No sessions connected for (\d+)ms since the last connection/.exec(stdout);
	assert.ok(retired, `broker did not report its idle retirement:\n${stdout}`);
	const fired = [
		...stdout.slice(0, retired.index).matchAll(new RegExp(`\\[timer-probe ${broker.pid}\\] fired (\\d+)`, "g")),
	];
	const window = fired.at(-1);
	assert.ok(window, `no timeout fired before the broker retired:\n${stdout}`);
	return { windowMs: Number(window[1]), idleMs: Number(retired[1]) };
}

/** The broker retired when its idle window of five seconds ran out, and not before. */
async function assertRetiredWhenIdle(broker: ChildProcess): Promise<void> {
	assert.equal(await waitForExit(broker), 0);
	const stdout = broker.stdout;
	if (stdout && !stdout.readableEnded) await new Promise((resolveEnded) => stdout.once("end", resolveEnded));
	const { windowMs, idleMs } = reportedRetirement(broker);
	assert.equal(windowMs, BROKER_IDLE_SHUTDOWN_MS, "the broker retired on another timer than its idle window");
	assert.ok(
		idleMs >= BROKER_IDLE_SHUTDOWN_MS - TIMER_EARLY_FIRE_TOLERANCE_MS,
		`broker retired ${idleMs}ms after its last connection, inside the ${BROKER_IDLE_SHUTDOWN_MS}ms idle window`,
	);
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
		const reader = createMessageReader(
			(message) => {
				if (typeof message === "object" && message !== null && "type" in message && message.type === "registered") {
					socket.off("close", onClose);
					resolveRegistered();
				}
			},
			(error) => reject(error),
		);
		const onClose = () => reject(new Error("the connection closed before it registered"));
		socket.once("close", onClose);
		socket.on("data", reader);
	});
}

// #2765
test(
	"a broker that receives no client connection exits despite watchdog probes (#3862)",
	async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "intercom-idle-none-"));
		const broker = spawnBroker(agentDir);
		await waitForBrokerPid(agentDir, broker);

		await assertRetiredWhenIdle(broker);
	},
	REAL_BROKER_IDLE_RETIREMENT_TIMEOUT_MS,
);

function assertOnlyReleasedMarker(agentDir: string): void {
	const intercomDir = join(agentDir, "intercom");
	const left = readdirSync(intercomDir);
	assert.equal(left.length, 1, `only the released marker is left: ${left.join(",")}`);
	const [marker] = left as [string];
	assert.match(marker, /^broker\.sock\.replace\.lock\.gen\d+$/);
	assert.deepEqual(readdirSync(join(intercomDir, marker)), ["owner"], "the marker holds only its record");
	assert.equal(readFileSync(join(intercomDir, marker, "owner"), "utf8"), "released\n");
}

const IDLE_OUT_CYCLES = 5;

test(
	"a broker that served no session leaves only the socket lock's released marker when it idles out (#4727, #5220)",
	async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "intercom-idle-clean-"));
		const broker = spawnBroker(agentDir);
		await waitForBrokerPid(agentDir, broker);

		assert.equal(await waitForExit(broker), 0);
		assertOnlyReleasedMarker(agentDir);
	},
	REAL_BROKER_IDLE_RETIREMENT_TIMEOUT_MS,
);

test(
	"brokers idling out one after another leave one released marker, never more (#5220)",
	async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "intercom-idle-cycles-"));
		for (let cycle = 0; cycle < IDLE_OUT_CYCLES; cycle++) {
			const broker = spawnBroker(agentDir);
			await waitForBrokerPid(agentDir, broker);
			assert.equal(await waitForExit(broker), 0);
			assertOnlyReleasedMarker(agentDir);
		}
	},
	IDLE_OUT_CYCLES * REAL_BROKER_IDLE_RETIREMENT_TIMEOUT_MS,
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

		await assertRetiredWhenIdle(broker);
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

test(
	"every liveness probe restarts the idle window so the client behind it can still connect",
	async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "intercom-idle-probe-"));
		const broker = spawnBroker(agentDir);
		await waitForBrokerPid(agentDir, broker);
		const probeIntervalMs = 500;
		const probeUntil = Date.now() + BROKER_IDLE_SHUTDOWN_MS + 1_000;
		let probesAccepted = 0;

		while (Date.now() < probeUntil && isBrokerAlive(broker)) {
			try {
				const probe = await connect(agentDir);
				await new Promise<void>((resolveClosed) => {
					probe.once("close", () => resolveClosed());
					probe.end();
				});
				probesAccepted += 1;
			} catch {
				break;
			}
			await sleep(probeIntervalMs);
		}
		assert.ok(probesAccepted > 0, "no liveness probe reached the broker");
		await assertRetiredWhenIdle(broker);
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
		// A starting broker no longer takes over a socket a live broker answers on (#3505), so the
		// incumbent is evicted by removing its socket path, which is what leaves a successor free to bind.
		rmSync(getBrokerSocketPath(process.platform, agentDir));
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

		const code = await waitForExit(incumbent);
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
