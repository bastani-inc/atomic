import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join, resolve } from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import { ENV_WORKFLOW_ARTIFACT_DIR } from "../../packages/workflows/src/shared/workflow-artifact-env.js";
import { stopDetachedBroker } from "../helpers/detached-broker.js";
import { type SpawnedProcess, spawnProcess } from "../helpers/runtime.js";
import { temporaryAgentDir, useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

/**
 * #4538: an Atomic 0.9.71 broker and session are running when a session of this version starts. The new session
 * replaces the broker with its own through the hand-over sessions already perform when a broker retires, the 0.9.71
 * session re-registers with the successor, and messages keep flowing between the two versions.
 *
 * The 0.9.71 broker is a real process, started by the 0.9.71 session's own spawner (test/fixtures/intercom-0.9.71). The
 * 0.9.71 session is its client plus the reconnect its runtime performs; the new session is this version's extension.
 */

useTemporaryAgentDir();

const UPGRADE_TEST_TIMEOUT_MS = 120_000;
const WAIT = { timeout: 30_000, interval: 25 };
const repoRoot = resolve(import.meta.dirname, "../..");
const previousRelease = join(repoRoot, "test/fixtures/intercom-0.9.71");

type SessionInfo = import("../../packages/intercom/types.js").SessionInfo;
type Message = import("../../packages/intercom/types.js").Message;
type BrokerQuery = Awaited<ReturnType<typeof import("../../packages/intercom/broker/control.js").queryIntercomBroker>>;

interface PreviousClient extends EventEmitter {
	readonly sessionId: string | null;
	isConnected(): boolean;
	connect(session: Omit<SessionInfo, "id">): Promise<void>;
	send(
		to: string,
		options: { text: string; replyTo?: string; requirePendingReply?: true; expectedRecipientId?: string },
	): Promise<{ id: string; delivered: boolean; reason?: string }>;
	listSessions(): Promise<SessionInfo[]>;
	acknowledgeReceived(messageId: string): void;
	disconnect(): Promise<void>;
}
interface PreviousModules {
	readonly IntercomClient: new (
		returnAddress: string,
		options?: { preferredSessionId?: string; acknowledgesReceipt?: true },
	) => PreviousClient;
	readonly spawnBrokerIfNeeded: (command: string, args: string[], readyTimeoutMs?: number) => Promise<void>;
}

let agentDir: string;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
	agentDir = temporaryAgentDir(process.env[ENV_WORKFLOW_ARTIFACT_DIR]);
	mkdirSync(join(agentDir, "intercom"), { recursive: true });
	writeFileSync(join(agentDir, "intercom", "config.json"), JSON.stringify({ brokerCommand: "bun", brokerArgs: [] }));
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("ATOMIC_INTERCOM_GROUP", "");
	vi.stubEnv("PI_INTERCOM_GROUP", "");
	vi.stubEnv("ATOMIC_STORAGE", "");
	vi.stubEnv("ATOMIC_PROFILE", "");
	vi.resetModules();
});

afterEach(async () => {
	try {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	} finally {
		await stopDetachedBroker(agentDir);
		vi.unstubAllEnvs();
	}
}, UPGRADE_TEST_TIMEOUT_MS);

async function control() {
	return import("../../packages/intercom/broker/control.js");
}

async function previousModules(): Promise<PreviousModules> {
	const client = (await import(join(previousRelease, "broker/client.ts"))) as Pick<PreviousModules, "IntercomClient">;
	const spawn = (await import(join(previousRelease, "broker/spawn.ts"))) as Pick<
		PreviousModules,
		"spawnBrokerIfNeeded"
	>;
	return { IntercomClient: client.IntercomClient, spawnBrokerIfNeeded: spawn.spawnBrokerIfNeeded };
}

async function runningBroker(): Promise<Extract<BrokerQuery, { state: "running" }>["report"]> {
	const { queryIntercomBroker } = await control();
	let report: Extract<BrokerQuery, { state: "running" }>["report"] | undefined;
	await vi.waitFor(async () => {
		const query = await queryIntercomBroker(agentDir);
		assert.equal(query.state, "running");
		if (query.state === "running") report = query.report;
	}, WAIT);
	assert.ok(report);
	return report;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function session(name: string, cwd: string): Omit<SessionInfo, "id"> {
	return {
		name,
		model: "previous-model",
		cwd,
		pid: process.pid,
		status: "idle",
		startedAt: Date.now(),
		lastActivity: Date.now(),
		group: "default",
		groups: ["default"],
	};
}

/**
 * A 0.9.71 session as its runtime keeps it connected: it starts the broker its own package ships when none answers,
 * registers with receipts on, and when the broker goes away starts or waits for one again and re-registers under the
 * session id it held.
 */
class PreviousSession {
	readonly received: Message[] = [];
	readonly registrations: string[] = [];
	client: PreviousClient | undefined;
	private readonly returnAddress = randomUUID();
	private sessionId: string | undefined;
	private stopped = false;
	private reconnecting: Promise<void> | undefined;

	constructor(
		private readonly modules: PreviousModules,
		readonly name: string,
	) {}

	async start(): Promise<void> {
		await this.modules.spawnBrokerIfNeeded("bun", [], 30_000);
		await this.register();
	}

	private async register(): Promise<void> {
		const client = new this.modules.IntercomClient(this.returnAddress, {
			acknowledgesReceipt: true,
			...(this.sessionId === undefined ? {} : { preferredSessionId: this.sessionId }),
		});
		client.on("message", (_from: SessionInfo, message: Message) => {
			this.received.push(message);
			client.acknowledgeReceived(message.id);
		});
		client.on("error", () => {});
		client.once("disconnected", () => {
			if (!this.stopped) this.reconnecting = this.reconnect();
		});
		await client.connect(session(this.name, repoRoot));
		this.client = client;
		this.sessionId = client.sessionId ?? undefined;
		this.registrations.push(client.sessionId ?? "");
	}

	private async reconnect(): Promise<void> {
		for (let attempt = 0; !this.stopped; attempt += 1) {
			await new Promise((settle) => setTimeout(settle, 250));
			try {
				await this.modules.spawnBrokerIfNeeded("bun", [], 30_000);
				await this.register();
				return;
			} catch {
				if (attempt > 40) throw new Error(`${this.name} did not re-register`);
			}
		}
	}

	async reconnected(count: number): Promise<void> {
		await vi.waitFor(() => assert.equal(this.registrations.length, count), WAIT);
		await this.reconnecting;
	}

	async stop(): Promise<void> {
		this.stopped = true;
		await this.client?.disconnect().catch(() => undefined);
	}
}

async function startPreviousSession(name: string): Promise<PreviousSession> {
	const previous = new PreviousSession(await previousModules(), name);
	cleanups.push(() => previous.stop());
	await previous.start();
	return previous;
}

type LifecycleHandler = (event: { type: string; reason: string }, ctx: ExtensionContext) => unknown;
interface ToolResult {
	isError: boolean;
	content: Array<{ text: string }>;
	details?: { code?: string };
}
interface IntercomTool {
	name: string;
	execute(
		id: string,
		params: { action: string; to?: string; message?: string },
		signal: AbortSignal | undefined,
		update: undefined,
		ctx: ExtensionContext,
	): Promise<ToolResult>;
}

/** A session of this version: its Intercom extension, with the messages it was handed. */
async function startCurrentSession(name: string): Promise<{
	readonly run: (params: { action: string; to?: string; message?: string }) => Promise<ToolResult>;
	readonly delivered: string[];
	readonly notices: string[];
}> {
	const { default: intercomHeavy } = await import("../../packages/intercom/index-heavy.js");
	const handlers = new Map<string, LifecycleHandler[]>();
	const delivered: string[] = [];
	const notices: string[] = [];
	let tool: IntercomTool | undefined;
	const record = (message: { content?: unknown }) => {
		delivered.push(typeof message.content === "string" ? message.content : JSON.stringify(message.content));
	};
	const pi = {
		on(event: string, handler: LifecycleHandler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool(registered: IntercomTool) {
			if (registered.name === "intercom") tool = registered;
		},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		async appendEntry() {},
		async sendMessage(message: { content?: unknown }) {
			record(message);
		},
		async sendMessages(messages: Array<{ content?: unknown }>) {
			for (const message of messages) record(message);
		},
		getSessionName: () => name,
		events: createEventBus(),
	};
	intercomHeavy(pi as never);
	const sessionId = `upgrade-${randomUUID()}`;
	const ctx = {
		hasUI: true,
		cwd: repoRoot,
		isIdle: () => true,
		ui: { notify: (message: string, level: string) => notices.push(`${level}: ${message}`), setStatus() {} },
		sessionManager: { getSessionId: () => sessionId, getBranch: () => [], getEntries: () => [] },
	} as unknown as ExtensionContext;
	for (const handler of handlers.get("session_start") ?? [])
		await handler({ type: "session_start", reason: "startup" }, ctx);
	cleanups.push(async () => {
		for (const handler of handlers.get("session_shutdown") ?? [])
			await handler({ type: "session_shutdown", reason: "quit" }, ctx);
	});
	const run = (params: { action: string; to?: string; message?: string }) => {
		assert.ok(tool, "the intercom tool is registered");
		return tool.execute(params.action, params, undefined, undefined, ctx);
	};
	return { run, delivered, notices };
}

async function sessionNamed(client: PreviousClient, name: string): Promise<SessionInfo> {
	let found: SessionInfo | undefined;
	await vi.waitFor(async () => {
		found = (await client.listSessions()).find((info) => info.name === name);
		assert.ok(found, `${name} is listed`);
	}, WAIT);
	assert.ok(found);
	return found;
}

describe("a session of this version finding a 0.9.71 broker (#4538)", () => {
	test(
		"replaces the broker, the 0.9.71 session re-registers with the successor, and messages flow both ways",
		async () => {
			const previous = await startPreviousSession("previous-session");
			const before = await runningBroker();
			assert.equal(before.protocol, undefined, "the 0.9.71 broker advertises no protocol range");
			assert.equal(before.sessions, 1);
			const previousId = previous.client?.sessionId;
			assert.ok(previousId);

			const current = await startCurrentSession("current-session");
			const status = await current.run({ action: "status" });
			assert.equal(status.isError, false, status.content[0]?.text);

			const after = await runningBroker();
			assert.deepEqual(after.protocol, { min: 1, max: 2 });
			assert.notEqual(after.pid, before.pid);
			assert.equal(isAlive(before.pid), false, "the 0.9.71 broker exited");
			await previous.reconnected(2);
			assert.deepEqual(previous.registrations, [previousId, previousId]);
			assert.deepEqual(current.notices, [], "a replaced broker needs no single-machine warning");
			assert.equal(existsSync(join(agentDir, "intercom", "broker.spawn.lock")), false);
			const settled = await runningBroker();
			assert.equal(settled.pid, after.pid, "the 0.9.71 session did not start its own broker again");
			assert.equal(settled.sessions, 2);

			const sent = await current.run({ action: "send", to: "previous-session", message: "from the new version" });
			assert.equal(sent.isError, false, sent.content[0]?.text);
			await vi.waitFor(
				() => assert.ok(previous.received.some((message) => message.content.text === "from the new version")),
				WAIT,
			);
			const client = previous.client;
			assert.ok(client);
			const currentInfo = await sessionNamed(client, "current-session");
			const back = await client.send(currentInfo.id, { text: "from 0.9.71" });
			assert.equal(back.delivered, true, back.reason);
			await vi.waitFor(() => assert.ok(current.delivered.some((text) => text.includes("from 0.9.71"))), WAIT);

			const asked = current.run({ action: "ask", to: "previous-session", message: "which version are you?" });
			let question: Message | undefined;
			await vi.waitFor(() => {
				question = previous.received.find((message) => message.content.text === "which version are you?");
				assert.ok(question);
			}, WAIT);
			assert.ok(question);
			const answer = await client.send(currentInfo.id, {
				text: "0.9.71",
				replyTo: question.id,
				requirePendingReply: true,
				expectedRecipientId: currentInfo.id,
			});
			assert.equal(answer.delivered, true, answer.reason);
			const reply = await asked;
			assert.equal(reply.isError, false, reply.content[0]?.text);
			assert.match(reply.content[0]?.text ?? "", /0\.9\.71/);
			assert.equal(client.isConnected(), true);
		},
		UPGRADE_TEST_TIMEOUT_MS,
	);

	test(
		"several sessions of this version starting together replace the broker once",
		async () => {
			const previous = await startPreviousSession("previous-crowded");
			const before = await runningBroker();
			const sessions = await Promise.all(
				["current-one", "current-two", "current-three"].map((name) => startCurrentSession(name)),
			);
			const statuses = await Promise.all(sessions.map((current) => current.run({ action: "status" })));
			for (const status of statuses) assert.equal(status.isError, false, status.content[0]?.text);
			await previous.reconnected(2);
			const after = await runningBroker();
			assert.deepEqual(after.protocol, { min: 1, max: 2 });
			assert.equal(isAlive(before.pid), false);
			assert.equal(after.sessions, 4);
			assert.deepEqual(
				sessions.map((current) => current.notices),
				[[], [], []],
			);
			const sent = await sessions[2]?.run({ action: "send", to: "previous-crowded", message: "crowded hello" });
			assert.equal(sent?.isError, false, sent?.content[0]?.text);
			await vi.waitFor(
				() => assert.ok(previous.received.some((message) => message.content.text === "crowded hello")),
				WAIT,
			);
		},
		UPGRADE_TEST_TIMEOUT_MS,
	);
});

interface FakeLegacyBrokerOptions {
	/** How long it keeps accepting connections after acknowledging a shutdown, as a Windows named pipe does until its process has exited. */
	readonly exitDelayMs?: number;
	readonly storage?: { digest: string; source: "env" | "settings" };
	readonly sessions?: number;
	/** `malformed`: an unreadable status report. `dropped`: closes the status request, as a broker older than it does. */
	readonly status?: "report" | "malformed" | "dropped";
	/** `dropped`: closes the shutdown request unanswered. `ignored`: acknowledges it and never exits. */
	readonly shutdown?: "exits" | "dropped" | "ignored";
}

/** A broker of protocol 1 at the agent directory's socket: its pid is a real process that ends when it shuts down. */
async function startFakeLegacyBroker(options: FakeLegacyBrokerOptions = {}): Promise<{
	shutdownRequests: () => number;
	statusRequests: () => number;
	exitedAt: () => number | undefined;
	pid: number;
}> {
	const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");
	const { createMessageReader, writeMessage } = await import("../../packages/intercom/broker/framing.js");
	const holder: SpawnedProcess = spawnProcess([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	let shutdowns = 0;
	let statuses = 0;
	let exitedAt: number | undefined;
	const sockets = new Set<net.Socket>();
	const server = net.createServer((socket) => {
		sockets.add(socket);
		socket.on("error", () => {});
		socket.on("close", () => sockets.delete(socket));
		socket.on(
			"data",
			createMessageReader(
				(frame) => {
					if (typeof frame !== "object" || frame === null || Array.isArray(frame)) return;
					if (frame.type === "broker_status") {
						statuses += 1;
						if (options.status === "dropped") {
							socket.destroy();
							return;
						}
						writeMessage(socket, {
							type: "broker_status",
							requestId: frame.requestId,
							report:
								options.status === "malformed"
									? { pid: "unknown" }
									: {
											pid: holder.pid ?? 0,
											sessions: options.sessions ?? 1,
											...(options.storage === undefined ? {} : { storage: options.storage }),
											multiNode: { status: "off" },
										},
						});
					}
					if (frame.type === "shutdown") {
						shutdowns += 1;
						if (options.shutdown === "dropped") {
							socket.destroy();
							return;
						}
						writeMessage(socket, { type: "shutdown_ack", requestId: frame.requestId });
						if (options.shutdown === "ignored") return;
						setTimeout(() => {
							for (const open of sockets) open.destroy();
							server.close();
							holder.kill("SIGKILL");
							void holder.exited.then(() => {
								exitedAt = performance.now();
							});
						}, options.exitDelayMs ?? 0);
					}
				},
				() => {},
			),
		);
	});
	await new Promise<void>((listening) => server.listen(getBrokerSocketPath(process.platform, agentDir), listening));
	cleanups.push(async () => {
		for (const open of sockets) open.destroy();
		if (server.listening) await new Promise<void>((closed) => server.close(() => closed()));
		if (holder.exitCode === null) holder.kill("SIGKILL");
		await holder.exited;
	});
	return {
		shutdownRequests: () => shutdowns,
		statusRequests: () => statuses,
		exitedAt: () => exitedAt,
		pid: holder.pid ?? 0,
	};
}

describe("replacing an older broker (#4538)", () => {
	test(
		"concurrent replacements stop the older broker once and start one successor, holding the spawn lock throughout",
		async () => {
			const legacy = await startFakeLegacyBroker();
			const { upgradeBroker } = await import("../../packages/intercom/broker/spawn.js");
			const outcomes = await Promise.all(Array.from({ length: 4 }, () => upgradeBroker("bun", [], 30_000)));
			assert.deepEqual([...outcomes].sort(), ["current", "current", "current", "upgraded"]);
			assert.equal(legacy.shutdownRequests(), 1);
			assert.equal(
				legacy.statusRequests(),
				1,
				"sessions that waited for the lock found the successor, not the older broker",
			);
			const after = await runningBroker();
			assert.deepEqual(after.protocol, { min: 1, max: 2 });
			assert.equal(existsSync(join(agentDir, "intercom", "broker.spawn.lock")), false);
		},
		UPGRADE_TEST_TIMEOUT_MS,
	);

	test(
		"the successor starts only once the older broker's process has exited, as a Windows named pipe requires",
		async () => {
			const legacy = await startFakeLegacyBroker({ exitDelayMs: 1_000 });
			const { upgradeBroker } = await import("../../packages/intercom/broker/spawn.js");
			assert.equal(await upgradeBroker("bun", [], 30_000), "upgraded");
			const exitedAt = legacy.exitedAt();
			assert.ok(exitedAt !== undefined, "the older broker's process had exited when the upgrade finished");
			const after = await runningBroker();
			assert.deepEqual(
				after.protocol,
				{ min: 1, max: 2 },
				"a successor started while the older broker still answered would have yielded to it",
			);
			assert.equal(legacy.shutdownRequests(), 1);
		},
		UPGRADE_TEST_TIMEOUT_MS,
	);

	test(
		"an older broker that reads another storage selection than its successor would is left running, so its sessions keep their routing",
		async () => {
			const legacy = await startFakeLegacyBroker({
				storage: { digest: "selection-of-another-process", source: "env" },
			});
			const { upgradeBroker } = await import("../../packages/intercom/broker/spawn.js");
			assert.equal(await upgradeBroker("bun", [], 30_000), "storage-differs");
			assert.deepEqual([legacy.statusRequests(), legacy.shutdownRequests()], [1, 0]);
			assert.equal(existsSync(join(agentDir, "intercom", "broker.spawn.lock")), false);
		},
		UPGRADE_TEST_TIMEOUT_MS,
	);

	for (const status of ["malformed", "dropped"] as const) {
		test(
			`a broker whose status cannot be read (${status}) is left alone`,
			async () => {
				const legacy = await startFakeLegacyBroker({ status });
				const { upgradeBroker } = await import("../../packages/intercom/broker/spawn.js");
				assert.equal(await upgradeBroker("bun", [], 30_000), "current");
				assert.deepEqual([legacy.statusRequests(), legacy.shutdownRequests()], [1, 0]);
			},
			UPGRADE_TEST_TIMEOUT_MS,
		);
	}

	test(
		"an older broker that closes its shutdown request unanswered fails the replacement at once, without waiting for it",
		async () => {
			const legacy = await startFakeLegacyBroker({ shutdown: "dropped" });
			const { upgradeBroker } = await import("../../packages/intercom/broker/spawn.js");
			const error = await upgradeBroker("bun", [], 30_000).catch((caught: unknown) => caught);
			const { isIntercomBrokerUpgradeError } = await import("@bastani/atomic");
			assert.ok(isIntercomBrokerUpgradeError(error), String(error));
			assert.deepEqual([error.phase, error.previousPid, error.cause], ["stop", legacy.pid, undefined]);
			assert.equal(legacy.shutdownRequests(), 1);
		},
		UPGRADE_TEST_TIMEOUT_MS,
	);

	for (const [label, select] of [
		[
			"settings",
			(selection: string) =>
				writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ storage: JSON.parse(selection) })),
		],
		["ATOMIC_STORAGE", (selection: string) => vi.stubEnv("ATOMIC_STORAGE", selection)],
	] as const) {
		test(
			`an older broker that reads the storage selection its successor would read from ${label} is replaced`,
			async () => {
				const selection = JSON.stringify({ adapter: "@example/adapter-that-is-not-installed", prefix: "team_" });
				select(selection);
				vi.resetModules();
				const { sharedStorageDigest } = await import("../../packages/intercom/broker/shared-storage-setting.js");
				const legacy = await startFakeLegacyBroker({
					storage: {
						digest: sharedStorageDigest(JSON.parse(selection)),
						source: label === "settings" ? "settings" : "env",
					},
				});
				const { upgradeBroker } = await import("../../packages/intercom/broker/spawn.js");
				assert.equal(await upgradeBroker("bun", [], 30_000), "upgraded");
				assert.equal(legacy.shutdownRequests(), 1);
				assert.deepEqual((await runningBroker()).protocol, { min: 1, max: 2 });
			},
			UPGRADE_TEST_TIMEOUT_MS,
		);
	}

	test(
		"starts this version's broker for an agent directory that has no Intercom directory yet",
		async () => {
			const fresh = temporaryAgentDir(process.env[ENV_WORKFLOW_ARTIFACT_DIR]);
			vi.stubEnv("ATOMIC_CODING_AGENT_DIR", fresh);
			vi.resetModules();
			cleanups.push(() => stopDetachedBroker(fresh));
			const { upgradeBroker } = await import("../../packages/intercom/broker/spawn.js");
			assert.equal(await upgradeBroker("bun", [], 30_000), "started");
			const { queryIntercomBroker } = await control();
			await vi.waitFor(async () => assert.equal((await queryIntercomBroker(fresh)).state, "running"), WAIT);
		},
		UPGRADE_TEST_TIMEOUT_MS,
	);

	test(
		"an older broker that does not exit in time fails the replacement at the stop, typed, and nothing is started",
		async () => {
			const legacy = await startFakeLegacyBroker({ shutdown: "ignored" });
			const { upgradeBroker } = await import("../../packages/intercom/broker/spawn.js");
			const error = await upgradeBroker("bun", [], 30_000).catch((caught: unknown) => caught);
			const { isIntercomBrokerStopTimeoutError, isIntercomBrokerUpgradeError } = await import("@bastani/atomic");
			assert.ok(isIntercomBrokerUpgradeError(error), String(error));
			assert.deepEqual([error.phase, error.previousPid, error.previousProtocolMax], ["stop", legacy.pid, 1]);
			assert.ok(isIntercomBrokerStopTimeoutError(error.cause), String(error.cause));
			assert.equal(error.cause.pid, legacy.pid);
			assert.equal(legacy.shutdownRequests(), 1);
			assert.equal(existsSync(join(agentDir, "intercom", "broker.spawn.lock")), false);
		},
		UPGRADE_TEST_TIMEOUT_MS,
	);

	test(
		"a successor that cannot start fails the replacement at the start, typed, with the spawn failure as its cause",
		async () => {
			const legacy = await startFakeLegacyBroker();
			const { upgradeBroker } = await import("../../packages/intercom/broker/spawn.js");
			const error = await upgradeBroker("atomic-test-missing-broker-runtime-4538", [], 5_000).catch(
				(caught: unknown) => caught,
			);
			const { isIntercomBrokerUpgradeError } = await import("@bastani/atomic");
			assert.ok(isIntercomBrokerUpgradeError(error), String(error));
			assert.deepEqual([error.phase, error.previousPid], ["start", legacy.pid]);
			assert.ok(error.cause instanceof Error);
			assert.equal(legacy.shutdownRequests(), 1);
			assert.equal(existsSync(join(agentDir, "intercom", "broker.spawn.lock")), false);
		},
		UPGRADE_TEST_TIMEOUT_MS,
	);

	test(
		"a session that cannot take the spawn lock within the bound does nothing",
		async () => {
			const legacy = await startFakeLegacyBroker();
			const lockPath = join(agentDir, "intercom", "broker.spawn.lock");
			writeFileSync(lockPath, `${process.pid}\n${Date.now()}\n`, { flag: "wx" });
			try {
				const { upgradeBroker } = await import("../../packages/intercom/broker/spawn.js");
				const { BROKER_STOP_TIMEOUT_MS } = await import("../../packages/intercom/broker/broker-stop.js");
				const startedAt = Date.now();
				assert.equal(await upgradeBroker("bun", [], 1), "busy");
				assert.ok(Date.now() - startedAt >= BROKER_STOP_TIMEOUT_MS, "it waited the stop bound for the lock");
				assert.deepEqual([legacy.statusRequests(), legacy.shutdownRequests()], [0, 0]);
				assert.equal(existsSync(lockPath), true, "another process's lock is left as it is");
			} finally {
				rmSync(lockPath, { force: true });
			}
		},
		UPGRADE_TEST_TIMEOUT_MS,
	);

	test(
		"a successor of this version is not replaced again, and no broker is started where none runs without one being needed",
		async () => {
			const { upgradeBroker } = await import("../../packages/intercom/broker/spawn.js");
			assert.equal(await upgradeBroker("bun", [], 30_000), "started");
			const started = await runningBroker();
			assert.equal(await upgradeBroker("bun", [], 30_000), "current");
			assert.equal((await runningBroker()).pid, started.pid);
		},
		UPGRADE_TEST_TIMEOUT_MS,
	);
});

describe("atomic intercom upgrade against a 0.9.71 broker (#4538)", () => {
	test(
		"leaves a broker with a 0.9.71 session connected to the next session, and stops it once none is",
		async () => {
			const { upgradeIntercomBroker } = await control();
			const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");
			const previous = await startPreviousSession("previous-installing");
			const report = await runningBroker();
			const deferred = await upgradeIntercomBroker(agentDir);
			assert.deepEqual(deferred, { status: "deferred", pid: report.pid, sessions: 1, protocol: { min: 1, max: 1 } });
			assert.equal(isAlive(report.pid), true);

			// The idle broker retires on its own five seconds after its last session; fresh unregistered connections
			// keep it up, without being sessions, until the upgrade has run.
			const keepAlive = setInterval(() => {
				const socket = net.connect(getBrokerSocketPath(process.platform, agentDir));
				socket.on("error", () => {});
				setTimeout(() => socket.destroy(), 900);
			}, 500);
			try {
				await previous.stop();
				await vi.waitFor(async () => assert.equal((await runningBroker()).sessions, 0), WAIT);
				const progress: string[] = [];
				const stopped = await upgradeIntercomBroker(agentDir, { onProgress: (line) => progress.push(line) });
				assert.deepEqual(stopped, {
					status: "stopped",
					previous: { pid: report.pid, protocol: { min: 1, max: 1 } },
				});
				assert.deepEqual(progress, [
					`Stopping the older Intercom broker (pid ${report.pid}); no session is connected.`,
				]);
				assert.equal(isAlive(report.pid), false);
			} finally {
				clearInterval(keepAlive);
			}
			assert.deepEqual(await upgradeIntercomBroker(agentDir), { status: "not-running" });
		},
		UPGRADE_TEST_TIMEOUT_MS,
	);

	test(
		"leaves a broker too old to report its sessions running, and fails typed when an older broker cannot be stopped",
		async () => {
			const { upgradeIntercomBroker } = await control();
			const { isIntercomBrokerStopTimeoutError, isIntercomBrokerUpgradeError } = await import("@bastani/atomic");
			const unreported = await startFakeLegacyBroker({ status: "dropped" });
			assert.deepEqual(await upgradeIntercomBroker(agentDir), { status: "unreported" });
			writeFileSync(join(agentDir, "intercom", "broker.pid"), `${unreported.pid}\n`);
			assert.deepEqual(await upgradeIntercomBroker(agentDir), { status: "unreported", pid: unreported.pid });
			assert.equal(unreported.shutdownRequests(), 0);
			for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
			rmSync(join(agentDir, "intercom", "broker.pid"), { force: true });

			const unanswered = await startFakeLegacyBroker({ sessions: 0, shutdown: "dropped" });
			const refused = await upgradeIntercomBroker(agentDir).catch((caught: unknown) => caught);
			assert.ok(isIntercomBrokerUpgradeError(refused), String(refused));
			assert.deepEqual([refused.phase, refused.previousPid, refused.cause], ["stop", unanswered.pid, undefined]);
			for (const cleanup of cleanups.splice(0).reverse()) await cleanup();

			const stuck = await startFakeLegacyBroker({ sessions: 0, shutdown: "ignored" });
			const timedOut = await upgradeIntercomBroker(agentDir, { stopTimeoutMs: 200 }).catch(
				(caught: unknown) => caught,
			);
			assert.ok(isIntercomBrokerUpgradeError(timedOut), String(timedOut));
			assert.equal(timedOut.phase, "stop");
			assert.ok(isIntercomBrokerStopTimeoutError(timedOut.cause), String(timedOut.cause));
			assert.deepEqual([timedOut.cause.pid, timedOut.cause.timeoutMs], [stuck.pid, 200]);
		},
		UPGRADE_TEST_TIMEOUT_MS,
	);

	test(
		"reports a broker of this version as current",
		async () => {
			const { upgradeIntercomBroker } = await control();
			const { spawnBrokerIfNeeded } = await import("../../packages/intercom/broker/spawn.js");
			await spawnBrokerIfNeeded("bun", [], 30_000);
			const report = await runningBroker();
			assert.deepEqual(await upgradeIntercomBroker(agentDir), {
				status: "current",
				pid: report.pid,
				protocol: { min: 1, max: 2 },
				decision: "compatible",
			});
		},
		UPGRADE_TEST_TIMEOUT_MS,
	);
});
