import assert from "node:assert/strict";
// `statSync` and `utimesSync` have no equivalent in test/helpers/runtime.ts: the socket file is read directly and abandoned lock files are backdated.
import { statSync, utimesSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, test } from "vitest";
import { isSocketAnswering } from "../../packages/intercom/broker/socket-liveness.js";
import { acquireSocketReplacementLock } from "../../packages/intercom/broker/socket-replacement-lock.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";
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

/** The later spawn attempt, standing in for a reconnect, outlasts the whole scenario. */
const LATER_SPAWN_READY_TIMEOUT_MS = 20_000;

/** How long a second broker is given to appear, if the spawn logic were to start one, while the first is held. */
const SECOND_BROKER_GRACE_MS = 1_500;

/** One real broker start (node, jiti and module loading) is far below this even under load. */
const BROKER_BUDGET_MS = 10_000;

/** Time for a spawned child to be running before the socket it should yield to starts answering. */
const CHILD_RUNNING_MS = 250;

/** The spawner may notice the answering socket before the exit; repeating makes the exit-first order near certain. */
const YIELD_ATTEMPTS = 8;

const POLL_INTERVAL_MS = 20;

/** Older than the 1 s after which an unreadable lock or takeover token counts as left by a crashed broker. */
const ABANDONED_FILE_AGE_MS = 10_000;

/** Long enough for the lock's 20 ms poll to retry many times, while a live holder still holds it. */
const LIVE_HOLDER_OBSERVATION_MS = 300;

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

type SpawnModule = typeof import("../../packages/intercom/broker/spawn.js");
type PathsModule = typeof import("../../packages/intercom/broker/paths.js");
type ClientModule = typeof import("../../packages/intercom/broker/client.js");

let spawnModule: SpawnModule;
let pathsModule: PathsModule;
let IntercomClient: ClientModule["IntercomClient"];
let socketPath: string;
let intercomDir: string;
let pidPath: string;

const directBrokerPids: number[] = [];
const liveClients: InstanceType<ClientModule["IntercomClient"]>[] = [];

beforeAll(async () => {
	// Imported after ATOMIC_CODING_AGENT_DIR is set: these modules resolve their paths on load.
	pathsModule = await import("../../packages/intercom/broker/paths.js");
	spawnModule = await import("../../packages/intercom/broker/spawn.js");
	({ IntercomClient } = await import("../../packages/intercom/broker/client.js"));
	socketPath = pathsModule.getBrokerSocketPath();
	intercomDir = pathsModule.getIntercomDirPath();
	pidPath = pathsModule.getBrokerPidPath();
	makeDirectorySync(gateDir, { recursive: true });
	writeTextSync(preloadFile, holdFirstBrokerPreload());
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

async function terminate(pid: number): Promise<void> {
	if (!isAlive(pid)) return;
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		return;
	}
	if (await waitUntil(() => !isAlive(pid), BROKER_BUDGET_MS)) return;
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// Exited between the last check and the kill.
	}
	await waitUntil(() => !isAlive(pid), BROKER_BUDGET_MS);
}

afterEach(async () => {
	for (const client of liveClients.splice(0)) {
		try {
			await client.disconnect();
		} catch {
			// The broker may already be gone.
		}
	}
	const pids = new Set([...startedBrokerPids(), ...directBrokerPids.splice(0)]);
	const recorded = recordedBrokerPid();
	if (recorded !== undefined) pids.add(recorded);
	for (const pid of pids) await terminate(pid);
	removePathSync(intercomDir, { recursive: true, force: true, ...CLEANUP_RETRIES });
	for (const file of [startsFile, firstStartMarker, gateFile]) removePathSync(file, { force: true });
});

afterAll(() => {
	if (previousAgentDirEnv.atomic === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDirEnv.atomic;
	if (previousAgentDirEnv.pi === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDirEnv.pi;
	removeTempDirectory(agentDir);
});

function newClient(): InstanceType<ClientModule["IntercomClient"]> {
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
	if (broker.pid !== undefined) directBrokerPids.push(broker.pid);
	return broker;
}

describe("a slow-starting broker beside a live one", () => {
	const unixOnly = process.platform === "win32" ? test.skip : test;

	test("(#3505) a session stays listed and reachable when a later spawn attempt runs while the first broker is still starting", async () => {
		const brokerArgs = ["--import", pathToFileURL(preloadFile).href, spawnModule.getJitiCliPath(extensionDir)];

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
		await waitUntil(() => received.length > 0, POLL_INTERVAL_MS * 50);

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

	unixOnly("(#3505) a first broker that dies while starting does not block the next spawn", async () => {
		const brokerArgs = ["--import", pathToFileURL(preloadFile).href, spawnModule.getJitiCliPath(extensionDir)];
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
		process.kill(firstBroker, "SIGKILL");
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
			await waitUntil(() => connections > connectionsBeforeProbe, POLL_INTERVAL_MS * 50);
			assert.ok(connections > connectionsBeforeProbe, "the socket path no longer leads to the live broker");
			assert.notEqual(recordedBrokerPid(), challenger.pid, "the yielding broker must not claim the pid file");
		} finally {
			await closeServer(liveBroker);
		}
	});

	unixOnly("(#3505) a spawn succeeds when its broker exits cleanly because a live broker answers", async () => {
		const handoffGate = join(gateDir, "handoff");
		const exitsOnGate = `const fs = require("fs"); setInterval(() => { if (fs.existsSync(${JSON.stringify(handoffGate)})) process.exit(0); }, 2);`;
		for (let attempt = 0; attempt < YIELD_ATTEMPTS; attempt++) {
			removePathSync(handoffGate, { force: true });
			const spawned = spawnModule.spawnBrokerIfNeeded(
				process.execPath,
				["-e", exitsOnGate],
				LATER_SPAWN_READY_TIMEOUT_MS,
			);
			await sleep(CHILD_RUNNING_MS);
			const liveBroker = await listenOnBrokerSocket();
			writeTextSync(handoffGate, "");
			try {
				await spawned;
			} finally {
				await closeServer(liveBroker);
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
		assert.ok(
			await waitUntil(() => recordedBrokerPid() === replacement.pid, BROKER_BUDGET_MS),
			"the replacement broker never bound the stale socket path",
		);
		assert.equal(await isSocketAnswering(socketPath), true);
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
			} finally {
				await closeServer(replacedBy);
			}
		},
	);

	unixOnly(
		"(#3505) a broker whose socket path was taken by another broker shuts down without removing it",
		async () => {
			const displaced = spawnBrokerDirectly();
			assert.ok(
				await waitUntil(() => recordedBrokerPid() === displaced.pid, BROKER_BUDGET_MS),
				"the broker never bound its socket",
			);
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
		const child = spawnProcess([process.execPath, "-e", ""], { stdout: "ignore" });
		await child.exited;
		assert.ok(child.pid !== undefined);
		return child.pid;
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

describe("socket replacement lock (#3505)", () => {
	let lockCount = 0;
	const lockPath = () => join(agentDir, `replace-lock-${lockCount++}`);

	async function deadPid(): Promise<number> {
		const child = spawnProcess([process.execPath, "-e", ""], { stdout: "ignore" });
		await child.exited;
		assert.ok(child.pid !== undefined);
		return child.pid;
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

	test("an unreadable lock and an unreadable takeover token left by crashed brokers are both recovered", async () => {
		const path = lockPath();
		const abandonedAt = new Date(Date.now() - ABANDONED_FILE_AGE_MS);
		writeTextSync(path, "");
		utimesSync(path, abandonedAt, abandonedAt);
		const token = `${path}.takeover-unreadable`;
		writeTextSync(token, "");
		utimesSync(token, abandonedAt, abandonedAt);

		const release = await acquireSocketReplacementLock(path);
		assert.equal(readTextSync(path, "utf8"), `${process.pid}\n`);
		assert.equal(fileExistsSync(token), false);
		release();
	});

	test("a dead holder's lock is taken over and released by its new holder", async () => {
		const path = lockPath();
		writeTextSync(path, `${await deadPid()}\n`);

		const release = await acquireSocketReplacementLock(path);
		assert.equal(readTextSync(path, "utf8"), `${process.pid}\n`);
		release();
		assert.equal(fileExistsSync(path), false);
	});
});
