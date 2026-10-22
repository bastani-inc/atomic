import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openNodeSqliteDatabase } from "@bastani/atomic/storage";
import { afterAll, beforeAll, describe, test, vi } from "vitest";
import {
	expectedBrokerStorage,
	queryIntercomBroker,
	readLiveBrokers,
	restartIntercomBroker,
} from "../../packages/intercom/broker/control.js";
import { createMessageReader, writeMessage } from "../../packages/intercom/broker/framing.js";
import { getBrokerPidPath, getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import { getJitiCliPath } from "../../packages/intercom/broker/spawn.js";
import { registerIntercomTool } from "../../packages/intercom/intercom-tool.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";
import { ReplyWaiterRegistry } from "../../packages/intercom/reply-waiter.js";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";

/**
 * `atomic storage status` and `atomic intercom restart` (#3856, #3857) talk to real broker processes through
 * `broker/control.ts`; the broker answers `broker_status` and `shutdown` before any registration and writes a positive
 * multi-node line to `broker.log` either way.
 */

/** A broker start, readiness, shutdown and multi-node opening on a local SQLite file; far above a healthy run. */
const BROKER_WAIT_MS = 15_000;
/** Each scenario starts and stops real broker processes. */
const BROKER_SCENARIO_TIMEOUT_MS = 60_000;

const repoRoot = resolve(import.meta.dirname, "../..");
const extensionDir = join(repoRoot, "packages/intercom");
// Short root: a Unix socket path must fit in about 104 bytes.
const root = mkdtempSync(join(tmpdir(), "icctl-"));
const fixtures: IntercomBrokerFixture[] = [];

function agentDirectory(name: string, settings?: object): string {
	const agentDir = join(root, name);
	mkdirSync(join(agentDir, "intercom"), { recursive: true });
	if (settings !== undefined) writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
	return agentDir;
}

function fixtureFor(agentDir: string): IntercomBrokerFixture {
	const fixture = new IntercomBrokerFixture(agentDir);
	fixtures.push(fixture);
	return fixture;
}

function brokerLog(agentDir: string): string {
	try {
		return readFileSync(join(agentDir, "intercom", "broker.log"), "utf8");
	} catch {
		return "";
	}
}

function socketAnswers(agentDir: string): Promise<boolean> {
	return new Promise((resolveAnswer) => {
		const socket = net.connect(getBrokerSocketPath(process.platform, agentDir));
		socket.once("connect", () => {
			socket.destroy();
			resolveAnswer(true);
		});
		socket.once("error", () => resolveAnswer(false));
	});
}

/** Start the real broker for `agentDir`, its stderr in the agent directory's `broker.log`, as a session spawns it. */
async function startBroker(fixture: IntercomBrokerFixture): Promise<ChildProcess> {
	const logFd = openSync(join(fixture.agentDir, "intercom", "broker.log"), "w");
	let broker: ChildProcess;
	try {
		broker = spawn(process.execPath, [getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")], {
			env: {
				...process.env,
				ATOMIC_CODING_AGENT_DIR: fixture.agentDir,
				PI_CODING_AGENT_DIR: undefined,
				ATOMIC_STORAGE: undefined,
			},
			stdio: ["ignore", "ignore", logFd],
		});
		fixture.trackBroker(broker);
	} finally {
		closeSync(logFd);
	}
	await vi.waitFor(
		async () => {
			fixture.assertRunning();
			if (!(await socketAnswers(fixture.agentDir))) throw new Error("broker is not answering yet");
		},
		{ timeout: BROKER_WAIT_MS, interval: 20 },
	);
	return broker;
}

/** A registered session over the raw protocol; it keeps an idle broker from retiring until it closes. */
async function connectSession(agentDir: string, name: string): Promise<net.Socket> {
	const socket = net.connect(getBrokerSocketPath(process.platform, agentDir));
	socket.on("error", () => {});
	const registered = new Promise<void>((resolveRegistered, reject) => {
		socket.on(
			"data",
			createMessageReader((message) => {
				if (typeof message === "object" && message !== null && !Array.isArray(message)) {
					if (message.type === "registered") resolveRegistered();
				}
			}, reject),
		);
	});
	await new Promise<void>((resolveConnected) => socket.once("connect", () => resolveConnected()));
	const now = Date.now();
	writeMessage(socket, {
		type: "register",
		session: { name, cwd: root, model: "control-test", pid: process.pid, startedAt: now, lastActivity: now },
	});
	await registered;
	return socket;
}

function exited(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolveExit) => child.once("exit", () => resolveExit()));
}

afterAll(async () => {
	for (const fixture of fixtures.reverse()) await fixture.cleanup();
	rmSync(root, { recursive: true, force: true });
});

test(
	"a broker without shared storage logs and reports multi-node routing off (#3856)",
	async () => {
		const fixture = fixtureFor(agentDirectory("single"));
		await startBroker(fixture);
		const keeper = await connectSession(fixture.agentDir, "keeper");
		fixture.onCleanup(() => {
			keeper.destroy();
		});

		const query = await queryIntercomBroker(fixture.agentDir);
		assert.equal(query.state, "running");
		assert.ok(query.state === "running");
		assert.equal(query.report.sessions, 1);
		assert.equal(query.report.storage, undefined);
		assert.equal(query.report.multiNode.status, "off");
		assert.match(query.report.multiNode.reason ?? "", /no shared storage selection/);
		assert.match(brokerLog(fixture.agentDir), /Intercom multi-node routing is off: no shared storage selection/);
		assert.equal(expectedBrokerStorage(fixture.agentDir, {}), undefined);
	},
	BROKER_SCENARIO_TIMEOUT_MS,
);

describe("brokers sharing a SQLite selection", () => {
	const shared = join(root, "shared.sqlite");
	const settings = { storage: { path: shared, prefix: "t_" } };
	let first: IntercomBrokerFixture;
	let second: IntercomBrokerFixture;

	beforeAll(async () => {
		first = fixtureFor(agentDirectory("first", settings));
		second = fixtureFor(agentDirectory("second", settings));
		for (const fixture of [first, second]) {
			await startBroker(fixture);
			const keeper = await connectSession(fixture.agentDir, `keeper-${fixture === first ? "a" : "b"}`);
			fixture.onCleanup(() => {
				keeper.destroy();
			});
			await vi.waitFor(() => assert.match(brokerLog(fixture.agentDir), /Intercom multi-node routing is on/), {
				timeout: BROKER_WAIT_MS,
				interval: 50,
			});
		}
	}, BROKER_SCENARIO_TIMEOUT_MS);

	test("each broker logs multi-node routing on with its adapter and prefix (#3857)", () => {
		for (const fixture of [first, second]) {
			assert.match(brokerLog(fixture.agentDir), /Intercom multi-node routing is on \(adapter sqlite, prefix t_\)/);
		}
	});

	test(
		"status reports the selection's digest, the multi-node state and the live peer broker (#3857)",
		async () => {
			const query = await queryIntercomBroker(first.agentDir);
			assert.ok(query.state === "running");
			assert.equal(query.report.multiNode.status, "on");
			assert.equal(query.report.multiNode.adapter, "sqlite");
			assert.equal(query.report.multiNode.prefix, "t_");
			assert.equal(query.report.multiNode.peers?.length, 1);
			assert.equal(query.report.storage?.source, "settings");
			assert.equal(query.report.storage?.digest, expectedBrokerStorage(first.agentDir, {})?.digest);

			const database = await openNodeSqliteDatabase(shared);
			try {
				assert.equal((await readLiveBrokers(database, "t_"))?.length, 2);
				assert.equal(await readLiveBrokers(database, "absent_"), undefined);
			} finally {
				await database.close();
			}
		},
		BROKER_SCENARIO_TIMEOUT_MS,
	);

	test("a changed selection no longer matches the running broker's digest (#3857)", async () => {
		const query = await queryIntercomBroker(first.agentDir);
		assert.ok(query.state === "running");
		const changed = { storage: { ...settings.storage, prefix: "u_" } };
		const agentDir = agentDirectory("changed", changed);
		assert.notEqual(expectedBrokerStorage(agentDir, {})?.digest, query.report.storage?.digest);
		const fromEnv = expectedBrokerStorage(agentDir, { ATOMIC_STORAGE: JSON.stringify(settings.storage) });
		assert.equal(fromEnv?.source, "env");
		assert.equal(fromEnv?.digest, query.report.storage?.digest);
	});

	test(
		"a session's intercom status shows multi-node routing and its peers (#3857)",
		async () => {
			const original = process.env.ATOMIC_CODING_AGENT_DIR;
			process.env.ATOMIC_CODING_AGENT_DIR = first.agentDir;
			let clientModule: typeof import("../../packages/intercom/broker/client.js");
			try {
				vi.resetModules();
				clientModule = await import("../../packages/intercom/broker/client.js");
			} finally {
				if (original === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
				else process.env.ATOMIC_CODING_AGENT_DIR = original;
			}
			const client = new clientModule.IntercomClient();
			const now = Date.now();
			await client.connect({
				name: "status",
				cwd: root,
				model: "control-test",
				pid: process.pid,
				startedAt: now,
				lastActivity: now,
			});
			try {
				type Tool = {
					execute(
						id: string,
						params: { action: string },
						signal: undefined,
						update: undefined,
						ctx: object,
					): Promise<{ content: Array<{ text: string }>; isError: boolean; details?: Record<string, unknown> }>;
				};
				let tool: Tool | undefined;
				const replies = new ReplyWaiterRegistry();
				registerIntercomTool(
					{
						registerTool(value: Tool) {
							tool = value;
						},
						async appendEntry() {},
					} as never,
					{
						ensureConnected: async () => client,
						syncPresenceIdentity() {},
						homeGroup: () => "default",
						setJoinedGroups() {},
						clearJoinedGroups() {},
						confirmSend: false,
						beginReplyWait: (from: string, replyTo: string, signal?: AbortSignal) =>
							replies.begin(from, replyTo, signal),
						replyTracker: new ReplyTracker(),
					} as never,
				);
				assert.ok(tool);
				const status = await tool.execute("status", { action: "status" }, undefined, undefined, {
					sessionManager: { getSessionId: () => "atomic-session" },
					hasUI: false,
				});
				assert.equal(status.isError, false, status.content[0]?.text);
				assert.match(
					status.content[0]?.text ?? "",
					/Multi-node routing: on \(adapter sqlite, prefix t_\), 1 peer broker live/,
				);
				assert.equal((status.details?.multiNode as { status?: string } | undefined)?.status, "on");
			} finally {
				await client.disconnect();
			}
		},
		BROKER_SCENARIO_TIMEOUT_MS,
	);
});

test(
	"restart stops a broker without sessions and reports that none restarted it (#3857)",
	async () => {
		const fixture = fixtureFor(agentDirectory("idle"));
		const broker = await startBroker(fixture);
		const outcome = await restartIntercomBroker(fixture.agentDir);
		assert.deepEqual(outcome, { status: "stopped", previous: { pid: broker.pid, sessions: 0 } });
		await exited(broker);
		assert.match(brokerLog(fixture.agentDir), /shutting down on request/);
		assert.deepEqual(await queryIntercomBroker(fixture.agentDir), { state: "stopped" });
		assert.deepEqual(await restartIntercomBroker(fixture.agentDir), { status: "not-running" });
	},
	BROKER_SCENARIO_TIMEOUT_MS,
);

test(
	"restart waits for a reconnecting session to start a new broker and reports it (#3857)",
	async () => {
		const fixture = fixtureFor(agentDirectory("restart"));
		const before = await startBroker(fixture);
		const session = await connectSession(fixture.agentDir, "reconnecting");
		// A real session reconnects through `spawnBrokerIfNeeded` once its broker is gone; this one starts the broker itself.
		let after: Promise<ChildProcess> | undefined;
		session.once("close", () => {
			after = exited(before).then(() => startBroker(fixture));
		});
		const progress: string[] = [];
		const outcome = await restartIntercomBroker(fixture.agentDir, { onProgress: (line) => progress.push(line) });
		const replacement = await after;
		assert.ok(replacement?.pid !== undefined);
		assert.equal(outcome.status, "restarted");
		assert.ok(outcome.status === "restarted");
		assert.deepEqual(outcome.previous, { pid: before.pid, sessions: 1 });
		assert.ok(outcome.current.state === "running");
		assert.equal(outcome.current.report.pid, replacement.pid);
		assert.equal(outcome.current.report.multiNode.status, "off");
		assert.match(progress[0] ?? "", /Stopping the Intercom broker \(pid \d+, 1 session connected\)/);
	},
	BROKER_SCENARIO_TIMEOUT_MS,
);

test("a stale legacy endpoint with a dead PID is stopped, not a restarted broker (#3857)", async () => {
	const agentDir = agentDirectory("stale-legacy");
	const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
	await exited(child);
	writeFileSync(getBrokerPidPath(agentDir), String(child.pid));
	const server = net.createServer((socket) => socket.on("data", () => socket.destroy()));
	await new Promise<void>((resolveListening) =>
		server.listen(getBrokerSocketPath(process.platform, agentDir), resolveListening),
	);
	try {
		assert.deepEqual(await queryIntercomBroker(agentDir), { state: "stopped" });
	} finally {
		await new Promise<void>((resolveClosed) => server.close(() => resolveClosed()));
	}
});

test(
	"restart stops a broker that predates broker_status with SIGTERM (#3857)",
	async () => {
		const agentDir = agentDirectory("legacy");
		const socketPath = getBrokerSocketPath(process.platform, agentDir);
		// An older broker drops a connection whose first frame is not `register`, and shuts down on SIGTERM.
		const legacy = spawn(
			process.execPath,
			[
				"-e",
				`const net = require("node:net");
				const fs = require("node:fs");
				const server = net.createServer((socket) => socket.on("data", () => socket.destroy()));
				server.listen(process.argv[1], () => fs.writeFileSync(process.argv[2], String(process.pid)));
				process.on("SIGTERM", () => server.close(() => process.exit(0)));`,
				socketPath,
				getBrokerPidPath(agentDir),
			],
			{ stdio: "ignore" },
		);
		const fixture = fixtureFor(agentDir);
		fixture.trackBroker(legacy);
		await vi.waitFor(
			async () => {
				fixture.assertRunning();
				if (!(await socketAnswers(agentDir))) throw new Error("legacy broker is not answering yet");
				if (readFileSync(getBrokerPidPath(agentDir), "utf8") !== String(legacy.pid)) throw new Error("no pid yet");
			},
			{ timeout: BROKER_WAIT_MS, interval: 20 },
		);
		assert.deepEqual(await queryIntercomBroker(agentDir), { state: "legacy", pid: legacy.pid });
		const outcome = await restartIntercomBroker(agentDir, { reconnectTimeoutMs: 200 });
		assert.deepEqual(outcome, { status: "stopped", previous: { pid: legacy.pid } });
		await exited(legacy);
	},
	BROKER_SCENARIO_TIMEOUT_MS,
);
