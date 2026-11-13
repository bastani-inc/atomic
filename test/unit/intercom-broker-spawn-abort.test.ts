import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { isProcessAlive } from "../../packages/intercom/broker/broker-stop.js";
import { createMessageReader, writeMessage } from "../../packages/intercom/broker/framing.js";
import {
	getBrokerSocketPath,
	getBrokerSpawnLockPath,
	getIntercomDirPath,
} from "../../packages/intercom/broker/paths.js";
import { spawnBrokerIfNeeded, upgradeBroker } from "../../packages/intercom/broker/spawn.js";
import { sleep } from "../helpers/runtime.ts";

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

function killIfAlive(pid: number): void {
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// Already gone.
	}
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
		`require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, String(process.pid)); setInterval(() => {}, 1000);`,
	];
}

async function waitUntilGone(pid: number): Promise<boolean> {
	const deadline = Date.now() + BROKER_GONE_WAIT_MS;
	while (isProcessAlive(pid)) {
		if (Date.now() >= deadline) return false;
		await sleep(20);
	}
	return true;
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

		await assert.rejects(
			upgradeBroker(
				process.execPath,
				neverReadyBrokerCommand(markerPath),
				NEVER_READY_TIMEOUT_MS,
				undefined,
				undefined,
				undefined,
				controller.signal,
			),
		);
		const replacementPid = Number(readFileSync(markerPath, "utf8"));
		cleanups.push(() => killIfAlive(replacementPid));
		assert.equal(
			await waitUntilGone(replacementPid),
			true,
			"the replacement broker is still starting after the upgrade settled",
		);
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
	while (!existsSync(markerPath)) await sleep(10);
	const brokerPid = Number(readFileSync(markerPath, "utf8"));
	cleanups.push(() => killIfAlive(brokerPid));
	controller.abort(new Error("session disposed"));

	await assert.rejects(start);
	assert.equal(await waitUntilGone(brokerPid), true, "the wrapped broker is still running after the start settled");
});
