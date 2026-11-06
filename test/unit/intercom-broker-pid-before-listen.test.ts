import assert from "node:assert/strict";
import net from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, test } from "vitest";
import {
	getBrokerPidPath,
	getBrokerSocketPath,
	getBrokerSocketReplacementLockPath,
	getIntercomDirPath,
} from "../../packages/intercom/broker/paths.js";
import { isSocketAnswering } from "../../packages/intercom/broker/socket-liveness.js";
import { getJitiCliPath } from "../../packages/intercom/broker/spawn.js";
import {
	fileExistsSync,
	makeDirectorySync,
	makeTempDirectory,
	moduleDir,
	readStreamText,
	readTextSync,
	removeTempDirectory,
	type SpawnedProcess,
	sleep,
	spawnProcess,
	writeTextSync,
} from "../helpers/runtime.js";

/**
 * Issue #4409: the broker wrote its pid file only once its socket listened, so a client that had already connected
 * could find no pid file. A preload holds the broker inside that write until the test opens a gate, so the moment the
 * write is in progress is observed by construction rather than by timing.
 */

const extensionDir = join(moduleDir(import.meta.url), "../../packages/intercom");

/** One real broker start (node, jiti and module loading) is far below this even under load. */
const BROKER_BUDGET_MS = 10_000;

const POLL_INTERVAL_MS = 20;

const unixOnly = process.platform === "win32" ? test.skip : test;

interface Fixture {
	readonly agentDir: string;
	readonly pidPath: string;
	readonly socketPath: string;
	readonly startupLockPath: string;
	/** Written by the held broker once it is inside its pid-file write. */
	readonly heldMarker: string;
	/** Created by the test to let the held pid-file write go ahead. */
	readonly gate: string;
	readonly preload: string;
}

/** One test's broker directory plus every process and server it started there. */
interface Scenario {
	readonly fixture: Fixture;
	readonly brokers: SpawnedProcess[];
	readonly servers: net.Server[];
}

const scenarios: Scenario[] = [];

afterEach(async () => {
	for (const { fixture, brokers, servers } of scenarios.splice(0)) {
		writeTextSync(fixture.gate, "");
		for (const broker of brokers) {
			if (broker.exitCode === null) broker.kill("SIGKILL");
			await broker.exited;
		}
		for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
		removeTempDirectory(fixture.agentDir);
	}
});

/** Replaces `fs.writeFileSync` before any broker code loads; only the write to the pid file is held. */
function holdPidFileWritePreload(fixture: Omit<Fixture, "preload">): string {
	return [
		'import fs from "node:fs";',
		'import { syncBuiltinESMExports } from "node:module";',
		"const writeFileSync = fs.writeFileSync;",
		"const pause = new Int32Array(new SharedArrayBuffer(4));",
		"fs.writeFileSync = function (path, ...rest) {",
		`  if (path === ${JSON.stringify(fixture.pidPath)}) {`,
		`    writeFileSync(${JSON.stringify(fixture.heldMarker)}, "");`,
		`    while (!fs.existsSync(${JSON.stringify(fixture.gate)})) Atomics.wait(pause, 0, 0, ${POLL_INTERVAL_MS});`,
		"  }",
		"  return writeFileSync.call(this, path, ...rest);",
		"};",
		"syncBuiltinESMExports();",
		"",
	].join("\n");
}

function newScenario(): Scenario {
	const agentDir = makeTempDirectory("ic4409-");
	const paths = {
		agentDir,
		pidPath: getBrokerPidPath(agentDir),
		socketPath: getBrokerSocketPath(process.platform, agentDir),
		startupLockPath: getBrokerSocketReplacementLockPath(agentDir),
		heldMarker: join(agentDir, "held-in-pid-write"),
		gate: join(agentDir, "release-pid-write"),
	};
	const fixture = { ...paths, preload: join(agentDir, "hold-pid-write.mjs") };
	writeTextSync(fixture.preload, holdPidFileWritePreload(paths));
	const scenario: Scenario = { fixture, brokers: [], servers: [] };
	scenarios.push(scenario);
	return scenario;
}

function spawnBroker(scenario: Scenario, { holdPidFileWrite }: { holdPidFileWrite: boolean }) {
	const preload = holdPidFileWrite ? ["--import", pathToFileURL(scenario.fixture.preload).href] : [];
	const broker = spawnProcess(
		[process.execPath, ...preload, getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")],
		{
			env: { ...process.env, ATOMIC_CODING_AGENT_DIR: scenario.fixture.agentDir, PI_CODING_AGENT_DIR: undefined },
			stdout: "ignore",
			stderr: "pipe",
		},
	);
	scenario.brokers.push(broker);
	return { broker, stderr: readStreamText(broker.stderr) };
}

function listenOnBrokerSocket(scenario: Scenario): Promise<net.Server> {
	makeDirectorySync(getIntercomDirPath(scenario.fixture.agentDir), { recursive: true });
	const server = net.createServer((socket) => socket.on("error", () => {}));
	scenario.servers.push(server);
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(scenario.fixture.socketPath, () => resolve(server));
	});
}

async function waitUntil(condition: () => boolean, budgetMs: number): Promise<boolean> {
	const deadline = performance.now() + budgetMs;
	while (!condition()) {
		if (performance.now() >= deadline) return false;
		await sleep(POLL_INTERVAL_MS);
	}
	return true;
}

function exitCodeWithin(broker: SpawnedProcess, budgetMs: number): Promise<number | "still running"> {
	return Promise.race([broker.exited, sleep(budgetMs).then(() => "still running" as const)]);
}

type Observation = { readonly connected: false } | { readonly connected: true; readonly pid: number | undefined };

/** One connection attempt; when the broker accepts it, what its pid file says at that moment. */
function connectAndReadPidFile(fixture: Fixture): Promise<Observation> {
	return new Promise((resolve) => {
		const socket = net.connect(fixture.socketPath);
		socket.once("connect", () => {
			const pid = fileExistsSync(fixture.pidPath)
				? Number.parseInt(readTextSync(fixture.pidPath, "utf8"), 10)
				: undefined;
			socket.destroy();
			resolve({ connected: true, pid });
		});
		socket.once("error", () => {
			socket.destroy();
			resolve({ connected: false });
		});
	});
}

async function firstConnection(fixture: Fixture): Promise<Observation> {
	const deadline = performance.now() + BROKER_BUDGET_MS;
	for (;;) {
		const observation = await connectAndReadPidFile(fixture);
		if (observation.connected || performance.now() >= deadline) return observation;
		await sleep(POLL_INTERVAL_MS);
	}
}

test("a client that connects to a starting broker always finds the pid file naming it (#4409)", async () => {
	const scenario = newScenario();
	const { broker } = spawnBroker(scenario, { holdPidFileWrite: true });
	assert.ok(
		await waitUntil(() => fileExistsSync(scenario.fixture.heldMarker) || broker.exitCode !== null, BROKER_BUDGET_MS),
		"the broker never reached its pid-file write",
	);
	assert.equal(broker.exitCode, null, "the broker exited before writing its pid file");

	const whileWriting = await connectAndReadPidFile(scenario.fixture);
	const lockHeldWhileWriting = fileExistsSync(scenario.fixture.startupLockPath);
	writeTextSync(scenario.fixture.gate, "");
	const onceAnswering = await firstConnection(scenario.fixture);

	assert.deepEqual(whileWriting, { connected: false }, "the broker accepted a connection before its pid file existed");
	assert.equal(lockHeldWhileWriting, true, "the broker wrote its pid file without holding the startup lock");
	assert.deepEqual(onceAnswering, { connected: true, pid: broker.pid });
	assert.ok(
		await waitUntil(() => !fileExistsSync(scenario.fixture.startupLockPath), BROKER_BUDGET_MS),
		"the broker kept the startup lock after it started listening",
	);
});

test("a broker that finds a live broker on the socket after writing its pid file removes it and yields (#4409)", async () => {
	const scenario = newScenario();
	const { broker, stderr } = spawnBroker(scenario, { holdPidFileWrite: true });
	assert.ok(
		await waitUntil(() => fileExistsSync(scenario.fixture.heldMarker) || broker.exitCode !== null, BROKER_BUDGET_MS),
		"the broker never reached its pid-file write",
	);
	await listenOnBrokerSocket(scenario);
	writeTextSync(scenario.fixture.gate, "");

	const exitCode = await exitCodeWithin(broker, BROKER_BUDGET_MS);
	const output = exitCode === "still running" ? "" : await stderr;
	assert.equal(exitCode, 0, `the broker did not yield to the live socket owner:\n${output}`);
	assert.match(output, /a live broker already answers/u);
	assert.deepEqual(
		{
			pidFile: fileExistsSync(scenario.fixture.pidPath),
			startupLock: fileExistsSync(scenario.fixture.startupLockPath),
			liveBrokerAnswers: await isSocketAnswering(scenario.fixture.socketPath),
		},
		{ pidFile: false, startupLock: false, liveBrokerAnswers: true },
	);
});

unixOnly(
	"a broker that cannot listen removes the pid file it wrote and releases the startup lock (#4409)",
	async () => {
		const scenario = newScenario();
		makeDirectorySync(scenario.fixture.socketPath, { recursive: true });
		const { broker, stderr } = spawnBroker(scenario, { holdPidFileWrite: false });

		const exitCode = await exitCodeWithin(broker, BROKER_BUDGET_MS);
		const output = exitCode === "still running" ? "" : await stderr;
		assert.equal(exitCode, 1, `the broker did not give up listening:\n${output}`);
		assert.match(output, /could not listen on/u);
		assert.deepEqual(
			{
				pidFile: fileExistsSync(scenario.fixture.pidPath),
				startupLock: fileExistsSync(scenario.fixture.startupLockPath),
			},
			{ pidFile: false, startupLock: false },
		);
	},
);
