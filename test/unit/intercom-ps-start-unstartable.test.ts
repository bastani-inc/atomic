import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, onTestFinished, test, vi } from "vitest";
import { recordProcess, signalRecordedProcess, waitUntilGone } from "../helpers/recorded-process.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/**
 * macOS reads a broker's start with `ps` on the broker restart and upgrade paths. When `ps` cannot be started at all
 * (a sandbox that denies it, a busy executable), Node throws instead of reporting the failure to the callback. The read
 * then finds no start, so a restart and an upgrade go on as when a start cannot be read: no unhandled rejection, an
 * upgrade completes, and a broker that does not acknowledge a restart is still ended by its pid, as before.
 */
const ps = vi.hoisted(() => ({ starts: 0, startable: false }));
vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	execFile: (
		_file: string,
		_args: string[],
		_options: object,
		done: (error: Error | null, stdout: string) => void,
	) => {
		ps.starts += 1;
		if (!ps.startable) throw Object.assign(new Error("spawn ETXTBSY"), { code: "ETXTBSY" });
		setImmediate(() => done(null, "Sat Nov 21 19:13:10 2026\n"));
	},
}));

const { readPsProcessStart } = await import("../../packages/intercom/broker/broker-process.js");
const { restartIntercomBroker, upgradeIntercomBroker } = await import("../../packages/intercom/broker/control.js");
const { createMessageReader, writeMessage } = await import("../../packages/intercom/broker/framing.js");
const { getBrokerPidPath, getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");
const { BROKER_PROTOCOL } = await import("../../packages/intercom/broker/protocol-version.js");

/** How long an ended stand-in broker may take to be gone on a loaded machine. */
const GONE_WITHIN_MS = 15_000;

const root = makeTempDirectory("ps-unstartable-");
afterAll(() => removeTempDirectory(root));

const platform = Object.getOwnPropertyDescriptor(process, "platform");
const rejections: unknown[] = [];
const onRejection = (reason: unknown) => rejections.push(reason);
beforeAll(() => process.on("unhandledRejection", onRejection));
afterAll(() => process.off("unhandledRejection", onRejection));
afterEach(() => {
	if (platform !== undefined) Object.defineProperty(process, "platform", platform);
	ps.starts = 0;
	ps.startable = false;
});
function onMacOS(): void {
	Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
}

let directories = 0;
function agentDirectory(): string {
	const agentDir = join(root, `agent-${directories++}`);
	mkdirSync(join(agentDir, "intercom"), { recursive: true });
	return agentDir;
}

/** A stand-in broker process: it leaves on SIGTERM, as a broker that never answered a shutdown request does. */
async function brokerProcess(): Promise<ChildProcess> {
	const child = spawn(
		process.execPath,
		["-e", "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)"],
		{
			stdio: "ignore",
		},
	);
	await once(child, "spawn");
	assert.ok(child.pid !== undefined);
	const recorded = await recordProcess(child.pid);
	onTestFinished(async () => {
		await signalRecordedProcess(recorded);
	});
	return child;
}

/** A broker socket that answers `broker_status` with `report` and acknowledges `shutdown`, then runs `onShutdown`. */
async function brokerSocket(agentDir: string, report: object | undefined, onShutdown: () => void): Promise<void> {
	const server = net.createServer((socket) => {
		socket.on("error", () => {});
		socket.on(
			"data",
			createMessageReader(
				(frame) => {
					if (typeof frame !== "object" || frame === null || Array.isArray(frame)) return;
					if (report === undefined) {
						socket.destroy();
						return;
					}
					if (frame.type === "broker_status")
						writeMessage(socket, { type: "broker_status", requestId: frame.requestId, report });
					if (frame.type === "shutdown") {
						writeMessage(socket, { type: "shutdown_ack", requestId: frame.requestId });
						onShutdown();
					}
				},
				() => {},
			),
		);
	});
	await new Promise<void>((listening) => server.listen(getBrokerSocketPath(process.platform, agentDir), listening));
	onTestFinished(() => new Promise<void>((closed) => server.close(() => closed())));
}

describe.skipIf(process.platform === "win32")("when ps cannot be started", () => {
	test("a start read with ps reads none", async () => {
		assert.equal(await readPsProcessStart(process.pid), undefined);
	});

	test("a broker that did not acknowledge a restart is still ended by its pid, as before", async () => {
		onMacOS();
		const agentDir = agentDirectory();
		const broker = await brokerProcess();
		await brokerSocket(agentDir, undefined, () => {});
		writeFileSync(getBrokerPidPath(agentDir), String(broker.pid));
		const recorded = await recordProcess(broker.pid!);

		const outcome = await restartIntercomBroker(agentDir, { stopTimeoutMs: GONE_WITHIN_MS, reconnectTimeoutMs: 200 });

		assert.equal(outcome.status, "stopped");
		assert.equal(await waitUntilGone(recorded, GONE_WITHIN_MS), true);
		assert.deepEqual(rejections, []);
	});

	test("an upgrade stops an older broker with no session connected", async () => {
		onMacOS();
		const agentDir = agentDirectory();
		const broker = await brokerProcess();
		const report = {
			pid: broker.pid,
			sessions: 0,
			protocol: { min: 1, max: BROKER_PROTOCOL.max - 1 },
			multiNode: { status: "off" },
		};
		await brokerSocket(agentDir, report, () => broker.kill("SIGTERM"));

		const outcome = await upgradeIntercomBroker(agentDir, { stopTimeoutMs: GONE_WITHIN_MS });

		assert.equal(outcome.status, "stopped");
		assert.deepEqual(rejections, []);
	});
});

/** Long enough for an upgrade wait to poll the stopped broker's pid many times before it exits. */
const EXIT_AFTER_MS = 500;

describe.skipIf(process.platform === "win32")("an upgrade wait where reading a start starts a process", () => {
	test("reads the broker's start once, when it finds it, and never on a poll", async () => {
		onMacOS();
		ps.startable = true;
		const agentDir = agentDirectory();
		const broker = await brokerProcess();
		const report = {
			pid: broker.pid,
			sessions: 0,
			protocol: { min: 1, max: BROKER_PROTOCOL.max - 1 },
			multiNode: { status: "off" },
		};
		await brokerSocket(agentDir, report, () => setTimeout(() => broker.kill("SIGTERM"), EXIT_AFTER_MS));

		const outcome = await upgradeIntercomBroker(agentDir, { stopTimeoutMs: GONE_WITHIN_MS });

		assert.equal(outcome.status, "stopped");
		assert.equal(ps.starts, 1);
	});
});
