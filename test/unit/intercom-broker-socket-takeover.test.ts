import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { statSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, onTestFinished, test } from "vitest";
import { isSocketAnswering } from "../../packages/intercom/broker/socket-liveness.js";
import { acquireSocketReplacementLock } from "../../packages/intercom/broker/socket-replacement-lock.js";
import * as staleLockFile from "../../packages/intercom/broker/stale-lock-file.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";
import { type BrokerProcessControl, createBrokerProcessControl } from "../helpers/broker-process-control.js";
import { keepProcessPid, keptExitedPid } from "../helpers/exited-process.js";
import {
	type ByteStream,
	decodeStream,
	fileExistsSync,
	makeDirectorySync,
	makeTempDirectory,
	moduleDir,
	readStreamText,
	readTextSync,
	removePathSync,
	removeTempDirectory,
	type SpawnedProcess,
	sleep,
	spawnProcess,
	spawnSyncCollect,
	writeTextSync,
} from "../helpers/runtime.js";

/**
 * Issue #3505: a broker that was slow to start unlinked the socket of a broker that had started
 * meanwhile and rebound it, leaving the session registered on a broker no path led to. These tests
 * pin the two halves of the fix: a starting broker never takes over a socket a live broker answers
 * on, and a spawner whose broker is still starting keeps the spawn lock instead of letting another
 * spawner start a second broker.
 */

const extensionDir = join(moduleDir(import.meta.url), "../../packages/intercom");

/** The first spawn attempt gives up this quickly, standing in for the production 5 s wait. */
const FIRST_SPAWN_READY_TIMEOUT_MS = 300;

/**
 * How long one real broker process may take to start, bind or exit. Each start runs node and jiti and transforms the
 * broker sources; on a loaded machine one start has taken more than 10 s, so this leaves several times that.
 */
const BROKER_BUDGET_MS = 60_000;

/** The later spawn attempt, standing in for a reconnect, waits as long as one broker start may take. */
const LATER_SPAWN_READY_TIMEOUT_MS = BROKER_BUDGET_MS;

/** A test that starts brokers waits on a few of them in sequence, each within BROKER_BUDGET_MS. */
const BROKER_TEST_TIMEOUT_MS = 4 * BROKER_BUDGET_MS;

/** How long a second broker is given to appear, if the spawn logic were to start one, while the first is held. */
const SECOND_BROKER_GRACE_MS = 1_500;

/** The spawner may notice the answering socket before the exit; repeating makes the exit-first order near certain. */
const YIELD_ATTEMPTS = 8;

const POLL_INTERVAL_MS = 20;

const STILL_WRITING_MS = 1_500;

/** Long enough for the lock's 20 ms poll to retry many times, while a live holder still holds it. */
const LIVE_HOLDER_OBSERVATION_MS = 300;
/** Far above taking a free lock (milliseconds), which a holder that is gone leaves it as. */
const REUSED_PID_TAKEOVER_MS = 10_000;

/** Windows releases a dead broker's inherited log handle a moment after the process exits. */
const CLEANUP_RETRIES = { maxRetries: 20, retryDelay: 50 } as const;

const agentDir = makeTempDirectory("ic3505-");
const previousAgentDirEnv = {
	atomic: process.env.ATOMIC_CODING_AGENT_DIR,
	pi: process.env.PI_CODING_AGENT_DIR,
} as const;
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
delete process.env.PI_CODING_AGENT_DIR;

const gateDir = join(agentDir, "gate");
const startsFile = join(gateDir, "starts");
const firstStartMarker = join(gateDir, "first");
const gateFile = join(gateDir, "open");
const preloadFile = join(gateDir, "hold-first-broker.mjs");

/** Runs before any broker code, like the preload that reproduces the issue: the first process to start waits for the gate. */
function holdFirstBrokerPreload(): string {
	return [
		'import { appendFileSync, existsSync, writeFileSync } from "node:fs";',
		`appendFileSync(${JSON.stringify(startsFile)}, process.pid + "\\n");`,
		"let first = false;",
		`try { writeFileSync(${JSON.stringify(firstStartMarker)}, "", { flag: "wx" }); first = true; } catch {}`,
		`while (first && !existsSync(${JSON.stringify(gateFile)})) await new Promise((resolve) => setTimeout(resolve, ${POLL_INTERVAL_MS}));`,
		"",
	].join("\n");
}

/*
 * Imported after ATOMIC_CODING_AGENT_DIR is set, at the top level rather than in a hook: spawn.ts and client.ts load
 * all of @bastani/atomic, which a loaded machine can take minutes to transform. A hook would time out and skip every
 * test; collecting the file has no timeout, and a failed import fails the file.
 */
const pathsModule = await import("../../packages/intercom/broker/paths.js");
const spawnModule = await import("../../packages/intercom/broker/spawn.js");
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
const socketPath = pathsModule.getBrokerSocketPath();
const intercomDir = pathsModule.getIntercomDirPath();
const pidPath = pathsModule.getBrokerPidPath();

const directBrokers = new Map<number, SpawnedProcess>();
const liveClients: InstanceType<typeof IntercomClient>[] = [];
let brokerControl: BrokerProcessControl;
let finishControlSetup: (() => void) | undefined;

beforeAll(() => {
	makeDirectorySync(gateDir, { recursive: true });
	writeTextSync(preloadFile, holdFirstBrokerPreload());
});

beforeEach(async () => {
	let finished = false;
	finishControlSetup = () => {
		finished = true;
	};
	const control = await createBrokerProcessControl(gateDir, BROKER_BUDGET_MS);
	if (finished) {
		await control.close();
		throw new Error("broker control setup completed after test cleanup");
	}
	brokerControl = control;
});

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function startedBrokerPids(): number[] {
	if (!fileExistsSync(startsFile)) return [];
	return readTextSync(startsFile, "utf8")
		.split("\n")
		.filter((line) => line !== "")
		.map(Number);
}

function recordedBrokerPid(): number | undefined {
	if (!fileExistsSync(pidPath)) return undefined;
	const pid = Number.parseInt(readTextSync(pidPath, "utf8").trim(), 10);
	return Number.isFinite(pid) ? pid : undefined;
}

async function waitUntil(condition: () => boolean, budgetMs: number): Promise<boolean> {
	const deadline = Date.now() + budgetMs;
	while (!condition()) {
		if (Date.now() >= deadline) return false;
		await sleep(POLL_INTERVAL_MS);
	}
	return true;
}

async function waitUntilAnswering(budgetMs: number): Promise<boolean> {
	const deadline = Date.now() + budgetMs;
	while (!(await isSocketAnswering(socketPath))) {
		if (Date.now() >= deadline) return false;
		await sleep(POLL_INTERVAL_MS);
	}
	return true;
}

async function terminateDirectBroker(broker: SpawnedProcess): Promise<void> {
	const hasExited = () => broker.exitCode !== null || broker.signalCode !== null;
	if (hasExited()) {
		await broker.exited;
		return;
	}
	try {
		broker.kill("SIGTERM");
	} catch {
		return;
	}
	if (await waitUntil(hasExited, BROKER_BUDGET_MS)) {
		await broker.exited;
		return;
	}
	try {
		broker.kill("SIGKILL");
	} catch {}
	if (await waitUntil(hasExited, BROKER_BUDGET_MS)) {
		await broker.exited;
	}
}

// Terminating each broker left running waits for it within BROKER_BUDGET_MS.
afterEach(async () => {
	finishControlSetup?.();
	for (const client of liveClients.splice(0)) {
		try {
			await client.disconnect();
		} catch {
			// The broker may already be gone.
		}
	}
	await brokerControl?.close();
	// Closing the control connection makes each controlled broker kill itself, but not at once. One still running
	// keeps its socket: on Windows the named pipe stays taken, and the next test cannot listen on it (EADDRINUSE).
	const controlled = startedBrokerPids();
	assert.ok(
		await waitUntil(() => controlled.every((pid) => !isAlive(pid)), BROKER_BUDGET_MS),
		`brokers still running after the test: ${controlled.filter(isAlive).join(", ")}`,
	);
	for (const broker of directBrokers.values()) await terminateDirectBroker(broker);
	directBrokers.clear();
	removePathSync(intercomDir, { recursive: true, force: true, ...CLEANUP_RETRIES });
	for (const file of [startsFile, firstStartMarker, gateFile]) removePathSync(file, { force: true });
}, BROKER_TEST_TIMEOUT_MS);

afterAll(() => {
	if (previousAgentDirEnv.atomic === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDirEnv.atomic;
	if (previousAgentDirEnv.pi === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDirEnv.pi;
	removeTempDirectory(agentDir);
});

function newClient(): InstanceType<typeof IntercomClient> {
	const client = new IntercomClient();
	client.on("error", () => {});
	liveClients.push(client);
	return client;
}

function registration(name: string) {
	return { cwd: agentDir, model: "test-model", pid: process.pid, startedAt: 1, lastActivity: 1, name };
}

function listenOnBrokerSocket(onConnection: () => void = () => {}): Promise<net.Server> {
	makeDirectorySync(intercomDir, { recursive: true });
	const server = net.createServer(onConnection);
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => resolve(server));
	});
}

function closeServer(server: net.Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

/** The broker exactly as the spawner would run it, minus the spawner. */
function spawnBrokerDirectly() {
	const broker = spawnProcess(
		[process.execPath, spawnModule.getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")],
		{ env: { ...process.env, ATOMIC_CODING_AGENT_DIR: agentDir }, stdout: "ignore", stderr: "pipe" },
	);
	if (broker.pid !== undefined) directBrokers.set(broker.pid, broker);
	return broker;
}

describe("a slow-starting broker beside a live one", { timeout: BROKER_TEST_TIMEOUT_MS }, () => {
	const unixOnly = process.platform === "win32" ? test.skip : test;

	test("(#3505) a session stays listed and reachable when a later spawn attempt runs while the first broker is still starting", async () => {
		const brokerArgs = [
			"--import",
			brokerControl.preloadUrl,
			"--import",
			pathToFileURL(preloadFile).href,
			spawnModule.getJitiCliPath(extensionDir),
		];

		await assert.rejects(
			() => spawnModule.spawnBrokerIfNeeded(process.execPath, brokerArgs, FIRST_SPAWN_READY_TIMEOUT_MS),
			/Broker failed to start within timeout/u,
		);
		assert.ok(
			await waitUntil(() => startedBrokerPids().length === 1, BROKER_BUDGET_MS),
			"the first broker never started",
		);
		const [firstBroker] = startedBrokerPids();
		assert.ok(firstBroker !== undefined && isAlive(firstBroker), "the first broker must still be starting");

		const session = newClient();
		const received: Message[] = [];
		session.on("message", (_from: SessionInfo, message: Message) => received.push(message));
		const reconnect = spawnModule
			.spawnBrokerIfNeeded(process.execPath, brokerArgs, LATER_SPAWN_READY_TIMEOUT_MS)
			.then(() => session.connect(registration("slow-start-session")));
		reconnect.catch(() => {});

		const secondBrokerStarted = await waitUntil(() => startedBrokerPids().length > 1, SECOND_BROKER_GRACE_MS);
		if (secondBrokerStarted) await reconnect;

		writeTextSync(gateFile, "");
		await reconnect;
		assert.ok(
			await waitUntil(() => recordedBrokerPid() === firstBroker || !isAlive(firstBroker), BROKER_BUDGET_MS),
			"the first broker neither bound its socket nor exited",
		);

		const observer = newClient();
		await observer.connect(registration("observer"));
		const sessionListed = (await observer.listSessions()).some(({ id }) => id === session.sessionId);
		const payload = "delivered through broker.sock";
		const sendResult = await observer.send(session.sessionId ?? "", { text: payload });
		await waitUntil(() => received.length > 0, BROKER_BUDGET_MS);

		assert.deepEqual(
			{
				brokersStarted: startedBrokerPids().length,
				brokersAlive: startedBrokerPids().filter(isAlive).length,
				sessionListed,
				sendDelivered: sendResult.delivered,
				messageReceived: received.some((message) => message.content.text === payload),
			},
			{ brokersStarted: 1, brokersAlive: 1, sessionListed: true, sendDelivered: true, messageReceived: true },
		);
	});

	test("(#3505) a first broker that dies while starting does not block the next spawn", async () => {
		const brokerArgs = [
			"--import",
			brokerControl.preloadUrl,
			"--import",
			pathToFileURL(preloadFile).href,
			spawnModule.getJitiCliPath(extensionDir),
		];
		await assert.rejects(
			() => spawnModule.spawnBrokerIfNeeded(process.execPath, brokerArgs, FIRST_SPAWN_READY_TIMEOUT_MS),
			/Broker failed to start within timeout/u,
		);
		assert.ok(
			await waitUntil(() => startedBrokerPids().length === 1, BROKER_BUDGET_MS),
			"the first broker never started",
		);
		const [firstBroker] = startedBrokerPids();
		assert.ok(firstBroker !== undefined);
		await brokerControl.stop(firstBroker);
		assert.ok(await waitUntil(() => !isAlive(firstBroker), BROKER_BUDGET_MS), "the first broker did not die");

		await spawnModule.spawnBrokerIfNeeded(process.execPath, brokerArgs, LATER_SPAWN_READY_TIMEOUT_MS);

		assert.equal(startedBrokerPids().length, 2);
		assert.equal(await isSocketAnswering(socketPath), true);
	});

	test("(#3505) a broker started while a live broker answers on its socket exits and leaves that socket in place", async () => {
		let connections = 0;
		const liveBroker = await listenOnBrokerSocket(() => {
			connections += 1;
		});
		try {
			const challenger = spawnBrokerDirectly();
			const exited = challenger.exited;
			const [exitCode, stderr] = await Promise.all([
				Promise.race([exited, sleep(BROKER_BUDGET_MS).then(() => "still running" as const)]),
				readStreamText(challenger.stderr),
			]);

			assert.equal(exitCode, 0, `the broker did not yield to the live socket owner:\n${stderr}`);
			assert.match(stderr, /a live broker already answers/u);
			const connectionsBeforeProbe = connections;
			assert.equal(await isSocketAnswering(socketPath), true);
			await waitUntil(() => connections > connectionsBeforeProbe, BROKER_BUDGET_MS);
			assert.ok(connections > connectionsBeforeProbe, "the socket path no longer leads to the live broker");
			assert.notEqual(recordedBrokerPid(), challenger.pid, "the yielding broker must not claim the pid file");
		} finally {
			await closeServer(liveBroker);
		}
	});

	test("(#3505) a spawn succeeds when its broker exits cleanly because a live broker answers", async () => {
		const handoffGate = join(gateDir, "handoff");
		const childRunning = join(gateDir, "running");
		const exitsOnGate = `const fs = require("fs"); fs.writeFileSync(process.argv[1], String(process.pid)); setInterval(() => { if (fs.existsSync(process.argv[2])) process.exit(0); }, 2);`;
		for (let attempt = 0; attempt < YIELD_ATTEMPTS; attempt++) {
			removePathSync(handoffGate, { force: true });
			removePathSync(childRunning, { force: true });
			const spawned = spawnModule.spawnBrokerIfNeeded(
				process.execPath,
				["--import", brokerControl.preloadUrl, "-e", exitsOnGate, childRunning, handoffGate],
				LATER_SPAWN_READY_TIMEOUT_MS,
			);
			spawned.catch(() => {});
			let liveBroker: net.Server | undefined;
			try {
				// The socket the child yields to starts answering only once the child runs.
				assert.ok(
					await waitUntil(() => fileExistsSync(childRunning), BROKER_BUDGET_MS),
					"the spawned child never ran",
				);
				liveBroker = await listenOnBrokerSocket();
				writeTextSync(handoffGate, "");
				await spawned;
			} finally {
				try {
					try {
						writeTextSync(handoffGate, "");
					} catch {
						await brokerControl.close();
					}
					await spawned.catch(() => {});
					if (fileExistsSync(childRunning)) await brokerControl.exited(Number(readTextSync(childRunning, "utf8")));
				} finally {
					if (liveBroker !== undefined) await closeServer(liveBroker);
				}
			}
		}
	});

	unixOnly("(#3505) a broker replaces a socket file left behind by a dead broker", async () => {
		makeDirectorySync(intercomDir, { recursive: true });
		const leftBehind = spawnSyncCollect([
			process.execPath,
			"-e",
			`require("node:net").createServer().listen(process.argv[1], () => process.kill(process.pid, "SIGKILL"));`,
			socketPath,
		]);
		assert.equal(leftBehind.signalCode, "SIGKILL");
		assert.equal(fileExistsSync(socketPath), true, "the dead broker should leave its socket file behind");
		assert.equal(await isSocketAnswering(socketPath), false);
		assert.equal(statSync(socketPath).isSocket(), true);

		const replacement = spawnBrokerDirectly();
		assert.ok(await waitUntilAnswering(BROKER_BUDGET_MS), "the replacement broker never bound the stale socket path");
		assert.equal(recordedBrokerPid(), replacement.pid);
	});

	unixOnly(
		"(#3505) a broker that waited for another broker's stale-socket replacement yields to the socket it bound",
		async () => {
			makeDirectorySync(intercomDir, { recursive: true });
			spawnSyncCollect([
				process.execPath,
				"-e",
				`require("node:net").createServer().listen(process.argv[1], () => process.kill(process.pid, "SIGKILL"));`,
				socketPath,
			]);
			assert.equal(await isSocketAnswering(socketPath), false, "the dead broker should leave a stale socket behind");
			const replacementLock = pathsModule.getBrokerSocketReplacementLockPath();
			writeTextSync(replacementLock, `${process.pid}\n`);

			const waiter = spawnBrokerDirectly();
			const stderrLines = decodeStream(waiter.stderr as ByteStream).getReader();
			let stderr = "";
			const sawWait = await Promise.race([
				(async () => {
					while (!stderr.includes("waiting for another broker")) {
						const { done, value } = await stderrLines.read();
						if (done) return false;
						stderr += value;
					}
					return true;
				})(),
				sleep(BROKER_BUDGET_MS).then(() => false),
			]);
			assert.ok(sawWait, `the broker did not wait for the replacement lock:\n${stderr}`);

			removePathSync(socketPath, { force: true });
			const replacedBy = await listenOnBrokerSocket();
			const replacedByPid = String(process.pid);
			writeTextSync(pidPath, replacedByPid);
			try {
				removePathSync(replacementLock, { force: true });
				const exitCode = await Promise.race([
					waiter.exited,
					sleep(BROKER_BUDGET_MS).then(() => "still running" as const),
				]);
				for (;;) {
					const { done, value } = await stderrLines.read();
					if (done) break;
					stderr += value;
				}
				assert.equal(exitCode, 0, `the waiting broker did not yield:\n${stderr}`);
				assert.match(stderr, /a live broker already answers/u);
				assert.equal(
					await isSocketAnswering(socketPath),
					true,
					"the waiting broker removed the socket bound meanwhile",
				);
				assert.equal(readTextSync(pidPath, "utf8"), replacedByPid, "the waiting broker claimed the pid file");
				assert.equal(fileExistsSync(replacementLock), false, "the waiting broker kept the startup lock");
			} finally {
				removePathSync(pidPath, { force: true });
				await closeServer(replacedBy);
			}
		},
	);

	unixOnly(
		"(#3505) a broker whose socket path was taken by another broker shuts down without removing it",
		async () => {
			const displaced = spawnBrokerDirectly();
			assert.ok(await waitUntilAnswering(BROKER_BUDGET_MS), "the broker never bound its socket");
			assert.equal(recordedBrokerPid(), displaced.pid);
			const stranded = newClient();
			let disconnected = false;
			stranded.on("disconnected", () => {
				disconnected = true;
			});
			await stranded.connect(registration("stranded-session"));

			removePathSync(socketPath, { force: true });
			const successor = await listenOnBrokerSocket();
			try {
				const exitCode = await Promise.race([
					displaced.exited,
					sleep(BROKER_BUDGET_MS).then(() => "still running" as const),
				]);
				assert.equal(exitCode, 0, "the displaced broker kept running");
				assert.equal(
					await isSocketAnswering(socketPath),
					true,
					"the displaced broker removed its successor's socket",
				);
				assert.ok(
					await waitUntil(() => disconnected, BROKER_BUDGET_MS),
					"the stranded session was not told to reconnect",
				);
			} finally {
				await closeServer(successor);
			}
		},
	);
});

describe("spawn lock staleness (#3505)", () => {
	const NOW = 1_700_000_000_000;
	let lockCount = 0;

	function lockFile(contents: string): string {
		const path = join(agentDir, `spawn-lock-${lockCount++}`);
		writeTextSync(path, contents);
		return path;
	}

	async function deadPid(): Promise<number> {
		const exited = await keptExitedPid();
		onTestFinished(() => exited.release());
		return exited.pid;
	}

	test("without a recorded broker the lock lasts as long as its spawner", async () => {
		const spawnerGone = await deadPid();

		assert.equal(spawnModule.isSpawnLockStale(lockFile(`${process.pid}\n${NOW}\n`), NOW), false);
		assert.equal(spawnModule.isSpawnLockStale(lockFile(`${spawnerGone}\n${NOW}\n`), NOW), true);
	});

	test("with a recorded broker the lock lasts as long as that broker, whatever became of its spawner", async () => {
		const gone = await deadPid();

		assert.equal(spawnModule.isSpawnLockStale(lockFile(`${gone}\n${NOW}\n${process.pid}\n`), NOW), false);
		assert.equal(spawnModule.isSpawnLockStale(lockFile(`${process.pid}\n${NOW}\n${gone}\n`), NOW), true);
		assert.equal(spawnModule.isSpawnLockStale(lockFile(`${gone}\n${NOW}\n${gone}\n`), NOW), true);
	});

	test("a lock older than the backstop is stale even while its processes live", () => {
		const live = `${process.pid}\n`;
		const atBackstop = NOW - spawnModule.BROKER_SPAWN_LOCK_MAX_AGE_MS;

		assert.equal(spawnModule.isSpawnLockStale(lockFile(`${live}${atBackstop}\n${live}`), NOW), false);
		assert.equal(spawnModule.isSpawnLockStale(lockFile(`${live}${atBackstop - 1}\n${live}`), NOW), true);
	});

	test("an unreadable lock is stale and an absent one is not", () => {
		assert.equal(spawnModule.isSpawnLockStale(lockFile("not a lock"), NOW), true);
		assert.equal(spawnModule.isSpawnLockStale(join(agentDir, "absent-lock"), NOW), false);
	});

	test("releasing removes only the lock this spawner wrote, not one that replaced it", () => {
		const replaced = lockFile(`${process.pid}\n${NOW + 1}\n`);
		spawnModule.releaseSpawnLock(`${process.pid}\n${NOW}\n`, replaced);
		assert.equal(fileExistsSync(replaced), true);

		const own = lockFile(`${process.pid}\n${NOW}\n4242\n`);
		spawnModule.releaseSpawnLock(`${process.pid}\n${NOW}\n`, own);
		assert.equal(fileExistsSync(own), false);
	});
});

const lockFileSeams = staleLockFile as Partial<{
	hostIdentity: () => string;
	setUnknownHolderWaitForTesting: (ms: number | undefined) => void;
}>;
const hostIdentity = () => lockFileSeams.hostIdentity?.() ?? "unknown-host";
const setUnknownHolderWaitForTesting = (ms: number | undefined) => lockFileSeams.setUnknownHolderWaitForTesting?.(ms);

describe("socket replacement lock (#3505)", () => {
	let lockCount = 0;
	const lockPath = () => join(agentDir, `replace-lock-${lockCount++}`);

	async function deadPid(): Promise<number> {
		const exited = await keptExitedPid();
		onTestFinished(() => exited.release());
		return exited.pid;
	}

	test("a live holder's lock is never taken, however long it is held", async () => {
		const path = lockPath();
		const liveHolder = `${process.pid}\n`;
		writeTextSync(path, liveHolder);
		let waited = false;
		let acquired = false;
		const acquiring = acquireSocketReplacementLock(path, { onWait: () => (waited = true) }).then((release) => {
			acquired = true;
			return release;
		});

		await sleep(LIVE_HOLDER_OBSERVATION_MS);
		assert.equal(acquired, false);
		assert.equal(waited, true);
		assert.equal(readTextSync(path, "utf8"), liveHolder);

		removePathSync(path, { force: true });
		const release = await acquiring;
		release();
		assert.equal(fileExistsSync(path), false);
	});

	test("a lock still unreadable only briefly is waited on, not taken over (#5132)", async () => {
		const path = lockPath();
		const publish = `${path}.publish`;
		const writer = spawn(
			process.execPath,
			[
				"-e",
				`const { existsSync, openSync, writeSync, closeSync } = require("node:fs");
				const fd = openSync(${JSON.stringify(path)}, "wx");
				const publishing = setInterval(() => {
					if (!existsSync(${JSON.stringify(publish)})) return;
					clearInterval(publishing);
					writeSync(fd, process.pid + "\\n");
					closeSync(fd);
				}, ${POLL_INTERVAL_MS});
				setInterval(() => {}, 1000);`,
			],
			{ stdio: "ignore", windowsHide: true },
		);
		const writerExited = once(writer, "exit");
		onTestFinished(async () => {
			writer.kill();
			await writerExited;
		});
		await once(writer, "spawn");
		assert.ok(writer.pid !== undefined);
		onTestFinished(await keepProcessPid(writer));
		while (!fileExistsSync(path)) await sleep(POLL_INTERVAL_MS);
		let waits = 0;
		let noticed!: () => void;
		const waitNoticed = new Promise<void>((resolve) => (noticed = resolve));
		const acquiring = acquireSocketReplacementLock(path, {
			onWait: () => {
				waits++;
				noticed();
			},
		});

		const first = await Promise.race([waitNoticed.then(() => "waiting"), acquiring.then(() => "taken over")]);
		assert.equal(first, "waiting");
		await sleep(LIVE_HOLDER_OBSERVATION_MS);
		assert.equal(waits, 1, "the wait is announced once");
		assert.equal(readTextSync(path, "utf8"), "", "the lock still being written is left in place");
		writeTextSync(publish, "");
		while (readTextSync(path, "utf8") === "") await sleep(POLL_INTERVAL_MS);
		assert.equal(Number.parseInt(readTextSync(path, "utf8"), 10), writer.pid, "the writer's lock is left in place");

		writer.kill();
		await writerExited;
		const release = await acquiring;
		assert.equal(Number.parseInt(readTextSync(path, "utf8"), 10), process.pid, "once the writer is gone it is taken");
		release();
	});

	test("an empty lock with a dead bound marker is refused with advice, never taken (#5132, #5220)", async () => {
		const path = lockPath();
		writeTextSync(path, "");
		const file = statSync(path, { bigint: true });
		const marker = `${path}.writing.${await deadPid()}.x.${hostIdentity()}.0badc0de.${file.ino}-${file.birthtimeNs}`;
		writeTextSync(marker, "");
		setUnknownHolderWaitForTesting(0);
		try {
			await assert.rejects(
				() => acquireSocketReplacementLock(path),
				(error: Error) => error.message.includes(path) && error.message.includes("remove"),
			);
		} finally {
			setUnknownHolderWaitForTesting(undefined);
		}
		assert.equal(readTextSync(path, "utf8"), "", "the lock is left as it was");
	});

	test("an unreadable lock whose writer cannot be checked is refused with advice, never taken (#5220)", async () => {
		const path = lockPath();
		writeTextSync(path, "");
		setUnknownHolderWaitForTesting(0);
		try {
			await assert.rejects(
				() => acquireSocketReplacementLock(path),
				(error: Error) => error.message.includes(path) && error.message.includes("remove"),
			);
		} finally {
			setUnknownHolderWaitForTesting(undefined);
		}
		assert.equal(readTextSync(path, "utf8"), "", "the lock is left as it was");
	});

	test("an abandoned lock whose takeover token cannot be checked is refused with advice, and a live token yields to timers (#5220)", async () => {
		const dead = await deadPid();
		const unknownLock = lockPath();
		const unknownToken = `${unknownLock}.takeover-${dead}`;
		const unknownReady = `${unknownLock}.ready`;
		const unknownStarted = `${unknownLock}.started`;
		writeTextSync(unknownLock, `${dead}\n`);
		writeTextSync(unknownToken, "");
		const unstick = spawnProcess(
			[
				process.execPath,
				"-e",
				`const { existsSync, writeFileSync, rmSync } = require("node:fs");
				writeFileSync(${JSON.stringify(unknownReady)}, "");
				const poll = setInterval(() => {
					if (existsSync(${JSON.stringify(unknownStarted)})) {
						clearInterval(poll);
						setTimeout(() => {
							rmSync(${JSON.stringify(unknownToken)}, { force: true });
							rmSync(${JSON.stringify(unknownLock)}, { force: true });
							process.exit(0);
						}, ${STILL_WRITING_MS});
					}
				}, ${POLL_INTERVAL_MS});`,
			],
			{ stdout: "ignore" },
		);
		setUnknownHolderWaitForTesting(0);
		try {
			while (!fileExistsSync(unknownReady)) await sleep(POLL_INTERVAL_MS);
			writeTextSync(unknownStarted, "");
			await assert.rejects(
				() => acquireSocketReplacementLock(unknownLock),
				(error: Error) => error.message.includes(unknownToken) && error.message.includes("remove"),
			);
			assert.equal(readTextSync(unknownToken, "utf8"), "", "the takeover token is left as it was");
		} finally {
			setUnknownHolderWaitForTesting(undefined);
			unstick.kill();
			await unstick.exited;
			removePathSync(unknownReady, { force: true });
			removePathSync(unknownStarted, { force: true });
		}

		const liveLock = lockPath();
		const liveToken = `${liveLock}.takeover-${dead}`;
		const liveReady = `${liveLock}.ready`;
		const liveStarted = `${liveLock}.started`;
		const liveWaiting = `${liveLock}.waiting`;
		writeTextSync(liveLock, `${dead}\n`);
		writeTextSync(liveToken, `${process.pid}\n`);
		const releaser = spawnProcess(
			[
				process.execPath,
				"-e",
				`const { existsSync, writeFileSync, rmSync } = require("node:fs");
				writeFileSync(${JSON.stringify(liveReady)}, "");
				const clear = () => {
					rmSync(${JSON.stringify(liveLock)}, { force: true });
					rmSync(${JSON.stringify(liveToken)}, { force: true });
					process.exit(0);
				};
				let fallback;
				const poll = setInterval(() => {
					if (fallback === undefined && existsSync(${JSON.stringify(liveStarted)})) {
						fallback = setTimeout(clear, ${STILL_WRITING_MS});
					}
					if (existsSync(${JSON.stringify(liveWaiting)})) {
						clearInterval(poll);
						if (fallback !== undefined) clearTimeout(fallback);
						setTimeout(clear, ${LIVE_HOLDER_OBSERVATION_MS});
					}
				}, ${POLL_INTERVAL_MS});`,
			],
			{ stdout: "ignore" },
		);
		let ticks = 0;
		let timer: ReturnType<typeof setInterval> | undefined;
		let waited = false;
		try {
			while (!fileExistsSync(liveReady)) await sleep(POLL_INTERVAL_MS);
			timer = setInterval(() => {
				ticks++;
			}, POLL_INTERVAL_MS);
			writeTextSync(liveStarted, "");
			const release = await acquireSocketReplacementLock(liveLock, {
				onWait: () => {
					waited = true;
					writeTextSync(liveWaiting, "");
				},
			});
			assert.equal(Number.parseInt(readTextSync(liveLock, "utf8"), 10), process.pid, "the lock names this broker");
			release();
		} finally {
			if (timer !== undefined) clearInterval(timer);
			releaser.kill();
			await releaser.exited;
			removePathSync(liveReady, { force: true });
			removePathSync(liveStarted, { force: true });
			removePathSync(liveWaiting, { force: true });
		}
		assert.equal(waited, true, "waiting on a live takeover token is announced");
		assert.ok(ticks > 0, "timers keep firing while waiting on a live takeover token");
	});

	test("parked copies of the socket lock are removed by the next holder only when their holder is gone (#5220)", async () => {
		const path = lockPath();
		const parked = (owner: string) => {
			const file = `${path}.${Date.now()}.${randomUUID()}.stale`;
			writeTextSync(file, owner);
			return file;
		};
		const dead = parked(`${await deadPid()}\n`);
		const live = parked(`${process.pid}\n`);

		const release = await acquireSocketReplacementLock(path);
		release();
		assert.equal(fileExistsSync(dead), false, "a parked lock of a broker that is gone is removed");
		assert.equal(fileExistsSync(live), true, "a parked lock of a running broker is kept");
	});

	test("a dead holder's lock is taken over and released by its new holder", async () => {
		const path = lockPath();
		writeTextSync(path, `${await deadPid()}\n`);

		const release = await acquireSocketReplacementLock(path);
		assert.equal(Number.parseInt(readTextSync(path, "utf8"), 10), process.pid, "the lock names this broker");
		release();
		assert.equal(fileExistsSync(path), false);
	});

	// macOS has no start of a process another can read without starting a process, so a holder there is judged by its
	// pid alone, as before.
	const startReadable = process.platform === "darwin" ? test.skip : test;
	startReadable("a holder whose pid was given to a later process is taken over, not waited for", async () => {
		const path = lockPath();
		// The broker that took this generation died holding it, and its pid now names a live process that started later:
		// this one, whose start is not the one recorded. Windows gives the pid of an exited process to another within
		// seconds.
		const generation = `${path}.gen1`;
		makeDirectorySync(generation);
		writeTextSync(join(generation, "owner"), `${process.pid}\n1\n${hostIdentity()}\n`);

		const release = await Promise.race([
			acquireSocketReplacementLock(path),
			sleep(REUSED_PID_TAKEOVER_MS).then(() => undefined),
		]);
		assert.ok(release !== undefined, "a broker starting now waits for a holder that is gone");
		release();
	});
});
