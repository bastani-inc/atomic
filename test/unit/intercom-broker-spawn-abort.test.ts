import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { readProcessCreationTime } from "../../packages/coding-agent/src/core/process-start-token.js";
import { createMessageReader, writeMessage } from "../../packages/intercom/broker/framing.js";
import {
	getBrokerSocketPath,
	getBrokerSpawnLockPath,
	getIntercomDirPath,
} from "../../packages/intercom/broker/paths.js";
import { spawnBrokerIfNeeded, upgradeBroker } from "../../packages/intercom/broker/spawn.js";
import { removeTempRootReleasingBroker } from "../helpers/detached-broker.js";
import {
	type RecordedProcess,
	recordProcess,
	signalRecordedProcess,
	stillRuns,
	waitUntilGone,
} from "../helpers/recorded-process.js";
import { sleep } from "../helpers/runtime.ts";

/** The programs this process starts, as `spawn` is called with them. */
const started = vi.hoisted(() => [] as string[]);

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const spawn = ((...start: Parameters<typeof actual.spawn>) => {
		started.push(String(start[0]));
		return Reflect.apply(actual.spawn, actual, start);
	}) as typeof actual.spawn;
	return { ...actual, spawn, default: { ...actual, spawn } };
});

/** Far longer than an aborted wait may take, so a wait that ignores its signal fails the test instead of passing late. */
const READY_TIMEOUT_MS = 20_000;
const ABORTED_WAIT_BOUND_MS = 2_000;

/** Startup budget for a replacement broker that never listens: short, so the test reaches the timeout quickly. */
const NEVER_READY_TIMEOUT_MS = 1_000;
/** How long a killed broker may take to be gone before the test calls it still running. */
const BROKER_GONE_WAIT_MS = 5_000;

let agentDir: string;
const originalAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const cleanups: Array<() => void | Promise<void>> = [];

beforeEach(() => {
	// Short root: a Unix socket path must fit in about 104 bytes.
	agentDir = join(mkdtempSync(join(tmpdir(), "icab-")), "agent");
	process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	if (originalAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = originalAgentDir;
	rmSync(join(agentDir, ".."), { recursive: true, force: true });
});

/**
 * The process that records its pid in `markerPath`, and when it started, read the moment it has recorded itself, while
 * it still runs. Rejects once `settled` settles with nothing recorded.
 */
async function recordedProcess(markerPath: string, settled: Promise<unknown>): Promise<RecordedProcess> {
	let done = false;
	settled.then(
		() => {
			done = true;
		},
		() => {
			done = true;
		},
	);
	for (;;) {
		const pid = existsSync(markerPath) ? Number(readFileSync(markerPath, "utf8")) : 0;
		if (Number.isInteger(pid) && pid > 0) return recordProcess(pid);
		if (done) throw new Error(`No broker recorded its pid in ${markerPath}`);
		await sleep(10);
	}
}

/**
 * Kills `recorded` if it still runs. By the time a cleanup runs, the start under test has usually stopped it already,
 * and Windows gives a stopped process's pid to a new process within seconds: a kill by pid alone would end whatever
 * holds that pid by then, such as another test's or another job's broker. So the pid is killed only while it still
 * names the process that started then.
 */
async function killIfStillRunning(recorded: RecordedProcess): Promise<void> {
	await signalRecordedProcess(recorded);
}

/**
 * An older broker on the socket: it reports protocol 1 so a session of this version replaces it, and on `shutdown` it
 * acknowledges, closes and ends `process`, which stands in for its pid. `onShutdown` runs once it has acknowledged.
 */
async function startOlderBroker(onShutdown: () => void): Promise<void> {
	const older: ChildProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	cleanups.push(() => {
		older.kill("SIGKILL");
	});
	mkdirSync(getIntercomDirPath(), { recursive: true });
	const server = net.createServer((socket) => {
		socket.on("error", () => {});
		socket.on(
			"data",
			createMessageReader(
				(message) => {
					if (typeof message !== "object" || message === null || Array.isArray(message)) return;
					if (message.type === "broker_status") {
						writeMessage(socket, {
							type: "broker_status",
							requestId: message.requestId ?? null,
							report: {
								pid: older.pid ?? 0,
								sessions: 0,
								protocol: { min: 1, max: 1 },
								multiNode: { status: "off" },
							},
						});
					} else if (message.type === "shutdown") {
						writeMessage(socket, { type: "shutdown_ack", requestId: message.requestId ?? null });
						server.close();
						older.kill("SIGKILL");
						onShutdown();
					}
				},
				() => socket.destroy(),
			),
		);
	});
	cleanups.push(() => {
		server.close();
	});
	await new Promise<void>((resolve) => server.listen(getBrokerSocketPath(), resolve));
}

/** A broker command that records its pid and then never listens. */
function neverReadyBrokerCommand(markerPath: string): string[] {
	return [
		"-e",
		'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);',
		markerPath,
	];
}

function isBrokerAnswering(): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.connect(getBrokerSocketPath());
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
	});
}

/** Whether `recorded` is gone within {@link BROKER_GONE_WAIT_MS}; a later process given its pid is not it. */
function gone(recorded: RecordedProcess): Promise<boolean> {
	return waitUntilGone(recorded, BROKER_GONE_WAIT_MS);
}

test("an aborted broker start writes nothing into the agent directory (#4727)", async () => {
	const controller = new AbortController();
	const reason = new Error("session disposed");
	controller.abort(reason);

	await assert.rejects(spawnBrokerIfNeeded("never-run", [], READY_TIMEOUT_MS, undefined, controller.signal), reason);
	assert.equal(existsSync(agentDir), false);
});

test("a broker start waiting for another spawner's broker stops when aborted (#4727)", async () => {
	mkdirSync(getIntercomDirPath(), { recursive: true });
	// A live spawner (this process) holds the lock, so this start waits for that spawner's broker.
	writeFileSync(getBrokerSpawnLockPath(), `${process.pid}\n${Date.now()}\n`);
	const controller = new AbortController();
	const reason = new Error("session disposed");
	const started = performance.now();
	const pending = spawnBrokerIfNeeded("never-run", [], READY_TIMEOUT_MS, undefined, controller.signal);
	controller.abort(reason);

	await assert.rejects(pending, reason);
	assert.ok(performance.now() - started < ABORTED_WAIT_BOUND_MS, "the aborted start kept waiting for the broker");
	assert.deepEqual(readdirSync(getIntercomDirPath()), ["broker.spawn.lock"]);
});

// Windows launches a custom broker command through the hidden launcher, which hides the pid this test records.
const directSpawnTest = process.platform === "win32" ? test.skip : test;

directSpawnTest(
	"an upgrade disposed after it stopped the older broker stops a replacement that never starts (#4727)",
	async () => {
		const markerPath = join(agentDir, "..", "replacement.pid");
		const controller = new AbortController();
		await startOlderBroker(() => controller.abort(new Error("session disposed")));

		const upgrade = upgradeBroker(
			process.execPath,
			neverReadyBrokerCommand(markerPath),
			NEVER_READY_TIMEOUT_MS,
			undefined,
			undefined,
			undefined,
			controller.signal,
		);
		const replacement = await recordedProcess(markerPath, upgrade);
		cleanups.push(() => killIfStillRunning(replacement));

		await assert.rejects(upgrade);
		assert.equal(await gone(replacement), true, "the replacement broker is still starting after the upgrade settled");
	},
);

test("an upgrade waiting for another spawner's lock stops when aborted (#4727)", async () => {
	mkdirSync(getIntercomDirPath(), { recursive: true });
	// A live spawner (this process) holds the lock, so the upgrade waits for it.
	writeFileSync(getBrokerSpawnLockPath(), `${process.pid}\n${Date.now()}\n`);
	const controller = new AbortController();
	const reason = new Error("session disposed");
	const started = performance.now();
	const pending = upgradeBroker("never-run", [], 3_000, undefined, undefined, 1_000, controller.signal);
	controller.abort(reason);

	await assert.rejects(pending, reason);
	assert.ok(performance.now() - started < ABORTED_WAIT_BOUND_MS, "the aborted upgrade kept waiting for the lock");
});

directSpawnTest("a disposed start stops the broker a wrapper command runs as its own child (#4727)", async () => {
	const markerPath = join(agentDir, "..", "wrapped-broker.pid");
	// The wrapper runs the "broker" as a child, without exec, as a shell or launcher script may.
	const brokerScript = `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, String(process.pid)); setInterval(() => {}, 1000);`;
	const wrapper = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(brokerScript)}], { stdio: "ignore" }); setInterval(() => {}, 1000);`;
	const controller = new AbortController();
	const start = spawnBrokerIfNeeded(
		process.execPath,
		["-e", wrapper],
		NEVER_READY_TIMEOUT_MS,
		undefined,
		controller.signal,
	);
	const broker = await recordedProcess(markerPath, start);
	cleanups.push(() => killIfStillRunning(broker));
	controller.abort(new Error("session disposed"));

	await assert.rejects(start);
	assert.equal(await gone(broker), true, "the wrapped broker is still running after the start settled");
});

directSpawnTest("a disposed start stops waiting for a broker that never listens, and stops that broker", async () => {
	const markerPath = join(agentDir, "..", "hung-broker.pid");
	const controller = new AbortController();
	const start = spawnBrokerIfNeeded(
		process.execPath,
		neverReadyBrokerCommand(markerPath),
		READY_TIMEOUT_MS,
		undefined,
		controller.signal,
	);
	const broker = await recordedProcess(markerPath, start);
	cleanups.push(() => killIfStillRunning(broker));
	const aborted = performance.now();
	controller.abort(new Error("session disposed"));

	await assert.rejects(start);
	assert.ok(
		performance.now() - aborted < ABORTED_WAIT_BOUND_MS + BROKER_GONE_WAIT_MS,
		"the disposed start kept waiting for its broker to listen",
	);
	assert.equal(await gone(broker), true, "the broker is still running after the start settled");
});

/** Atomic's native module, which a stand-in broker loads by path to read when it was created, as a real broker does. */
const NATIVES_PATH = createRequire(import.meta.url).resolve("@bastani/atomic-natives");

/**
 * A broker command that records its pid, announces `announcedPid` (its own by default) and, unless `witness` is
 * `"none"`, when that process was created, as a real broker does when asked (so a Windows spawner can stop it); then it
 * never listens. `witness: "other"` announces a creation time that is not the announced process's. With `startsChild`
 * it first starts a process of its own and records that one's pid in `<markerPath>.child`. A script file rather than
 * `-e`: on Windows a custom command runs through a launcher's command line.
 */
function announcedNeverReadyBrokerCommand(
	markerPath: string,
	{
		announcedPid,
		witness = "own",
		startsChild = false,
	}: {
		readonly announcedPid?: number;
		readonly witness?: "own" | "other" | "none";
		readonly startsChild?: boolean;
	} = {},
): string[] {
	const script = join(agentDir, "..", "never-ready-broker.cjs");
	writeFileSync(
		script,
		`const fs = require("node:fs");
if (${startsChild}) {
	const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	fs.writeFileSync(process.argv[2] + ".child", String(child.pid));
}
const path = process.env.ATOMIC_INTERCOM_BROKER_ANNOUNCE_PATH;
const token = process.env.ATOMIC_INTERCOM_BROKER_ANNOUNCE_TOKEN;
const announcedPid = ${announcedPid ?? "process.pid"};
const witness = ${JSON.stringify(witness)};
let started = null;
if (witness !== "none" && process.env.ATOMIC_INTERCOM_BROKER_ANNOUNCE_START === "1" && process.platform === "win32") {
	started = require(${JSON.stringify(NATIVES_PATH)}).processCreationTime(announcedPid);
	if (started !== null && witness === "other") started = String(BigInt(started) + 1n);
}
if (path && token) fs.writeFileSync(path, token + " " + announcedPid + (started === null ? "" : " " + started) + "\\n");
fs.writeFileSync(process.argv[2], String(process.pid));
setInterval(() => {}, 1000);
`,
	);
	return [script, markerPath];
}

test(
	"a start waiting for another spawner's broker starts the broker itself when that spawner is cancelled",
	async () => {
		const markerPath = join(agentDir, "..", "cancelled-broker.pid");
		const owner = new AbortController();
		const first = spawnBrokerIfNeeded(
			process.execPath,
			announcedNeverReadyBrokerCommand(markerPath),
			READY_TIMEOUT_MS,
			undefined,
			owner.signal,
		);
		const cancelled = await recordedProcess(markerPath, first);
		cleanups.push(() => killIfStillRunning(cancelled));
		// Stops the broker this test starts and removes its files once Windows has let go of the broker log.
		cleanups.push(() => removeTempRootReleasingBroker(join(agentDir, ".."), agentDir));
		const waiting = spawnBrokerIfNeeded("npx", ["--no-install", "tsx"], READY_TIMEOUT_MS);
		await sleep(200);
		owner.abort(new Error("session disposed"));
		await assert.rejects(first);

		await waiting;
		assert.equal(await isBrokerAnswering(), true, "no broker answers");
	},
	2 * READY_TIMEOUT_MS,
);

// #6133: only a broker behind the Windows launcher is found by the pid it announced.
const windowsLauncherTest = process.platform === "win32" ? test : test.skip;

/** A process that is no broker, as a later process given an exited broker's pid is; this test holds its handle. */
function startUnrelatedProcess(): ChildProcess {
	const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	cleanups.push(() => {
		unrelated.kill("SIGKILL");
	});
	return unrelated;
}

/**
 * Starts a broker with `command`, waits until it has recorded its pid, runs `beforeAbort` with it, and disposes of the
 * start.
 */
async function abandonAnnouncedStart(
	markerPath: string,
	command: string[],
	beforeAbort: (broker: RecordedProcess) => Promise<void> = async () => {},
): Promise<RecordedProcess> {
	// Runs after the broker is stopped: removes its files once Windows has let go of the broker log.
	cleanups.push(() => removeTempRootReleasingBroker(join(agentDir, ".."), agentDir));
	const controller = new AbortController();
	const start = spawnBrokerIfNeeded(process.execPath, command, READY_TIMEOUT_MS, undefined, controller.signal);
	const broker = await recordedProcess(markerPath, start);
	cleanups.push(() => killIfStillRunning(broker));
	await beforeAbort(broker);
	controller.abort(new Error("session disposed"));
	await assert.rejects(start);
	return broker;
}

for (const witness of ["none", "other"] as const) {
	windowsLauncherTest(
		`a disposed start never stops another process its broker announced, ${witness === "none" ? "without a creation time" : "with another creation time"} (#6133)`,
		async () => {
			const markerPath = join(agentDir, "..", "lying-broker.pid");
			const unrelated = startUnrelatedProcess();
			const announcedPid = unrelated.pid;
			assert.ok(announcedPid !== undefined);
			const started = await readProcessCreationTime(announcedPid);
			assert.ok(started !== undefined, "the unrelated process's creation time cannot be read");

			await abandonAnnouncedStart(
				markerPath,
				announcedNeverReadyBrokerCommand(markerPath, { announcedPid, witness }),
			);

			assert.equal(unrelated.exitCode, null, "the disposed start stopped a process that is not its broker");
			assert.equal(await readProcessCreationTime(announcedPid), started);
		},
		2 * READY_TIMEOUT_MS,
	);
}

windowsLauncherTest(
	"a disposed start leaves running a broker that announced no creation time (#6133)",
	async () => {
		const markerPath = join(agentDir, "..", "witnessless-broker.pid");
		// An older broker, or one that could not load the native module, announces only its token and pid.
		const broker = await abandonAnnouncedStart(
			markerPath,
			announcedNeverReadyBrokerCommand(markerPath, { witness: "none" }),
		);

		assert.equal(await stillRuns(broker), true, "the disposed start stopped a broker it could not identify");
	},
	2 * READY_TIMEOUT_MS,
);

windowsLauncherTest(
	"a disposed start stops the broker that announced when it was created at once, starting no process to stop it",
	async () => {
		const markerPath = join(agentDir, "..", "quickly-stopped-broker.pid");
		let disposedAt = 0;
		const broker = await abandonAnnouncedStart(
			markerPath,
			announcedNeverReadyBrokerCommand(markerPath, { startsChild: true }),
			async () => {
				started.length = 0;
				disposedAt = performance.now();
			},
		);
		const stoppingMs = Math.round(performance.now() - disposedAt);

		assert.deepEqual(
			started.filter((program) => /powershell/iu.test(program)),
			[],
			`stopping the broker started PowerShell and took ${stoppingMs} ms`,
		);
		assert.equal(await gone(broker), true, "the broker is still running after the start settled");
	},
	2 * READY_TIMEOUT_MS,
);

windowsLauncherTest(
	"a disposed start stops the broker that announced when it was created, and what it started (#6133)",
	async () => {
		const markerPath = join(agentDir, "..", "announced-broker.pid");
		let child: RecordedProcess | undefined;
		const broker = await abandonAnnouncedStart(
			markerPath,
			announcedNeverReadyBrokerCommand(markerPath, { startsChild: true }),
			async () => {
				// Written before the broker recorded its own pid, while that process waits to be stopped.
				child = await recordProcess(Number(readFileSync(`${markerPath}.child`, "utf8")));
				const recorded = child;
				cleanups.push(() => killIfStillRunning(recorded));
				assert.notEqual(recorded.started, undefined, "the broker's child is not running");
			},
		);

		assert.equal(await gone(broker), true, "the broker is still running after the start settled");
		assert.ok(child !== undefined);
		assert.equal(await gone(child), true, "the process the broker started is still running");
	},
	2 * READY_TIMEOUT_MS,
);
