/**
 * A send to a subagent that is launching, before it registers on Intercom, waits for it and reaches it once it
 * registers, instead of failing with `Session not found`. A child whose start fails tells the held senders why.
 * Real broker child process; the launch runs through the subagent tool with a child that registers when the test lets
 * it.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { afterAll, beforeAll, test, vi } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import { createMessageReader, writeMessage } from "../../packages/intercom/broker/framing.js";
import type { BrokerMessage } from "../../packages/intercom/types.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agents.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import { subagentStartHoldMs } from "../../packages/subagents/src/runs/shared/start-progress.js";
import type { RunSyncOptions, SingleResult } from "../../packages/subagents/src/shared/types.js";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const brokerFixture = new IntercomBrokerFixture(mkdtempSync(join(tmpdir(), "launch-hold-")));
brokerFixture.overrideAgentDir();
// Intercom's broker paths are snapshotted at import time, so import after the agent dir override.
const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");
const { getJitiCliPath } = await import("../../packages/intercom/broker/spawn.js");
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
const { default: intercomLightweight } = await import("../../packages/intercom/index.js");

type Client = InstanceType<typeof IntercomClient>;
type Handler = (event: object, ctx: object) => unknown;
type EventHandler = (payload: unknown) => void;

/** Spawning the broker child is the structural cost of this real-broker suite. */
const REAL_BROKER_TEST_TIMEOUT_MS = 60_000;
const SETTLE_MS = 400;

const worker: AgentConfig = {
	name: "worker",
	description: "worker",
	source: "project",
	filePath: "worker.md",
	systemPrompt: "Work",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
};

function eventBus() {
	const handlers = new Map<string, EventHandler[]>();
	return {
		on(eventName: string, handler: EventHandler) {
			handlers.set(eventName, [...(handlers.get(eventName) ?? []), handler]);
			return () => {
				handlers.set(
					eventName,
					(handlers.get(eventName) ?? []).filter((candidate) => candidate !== handler),
				);
			};
		},
		emit(eventName: string, payload: unknown) {
			for (const handler of handlers.get(eventName) ?? []) handler(payload);
		},
	};
}

async function peer(name: string): Promise<Client> {
	const client = new IntercomClient(randomUUID());
	await client.connect({
		name,
		model: "test-model",
		cwd: repoRoot,
		pid: process.pid,
		status: "idle",
		startedAt: Date.now(),
		lastActivity: Date.now(),
		group: "default",
		groups: ["default"],
	});
	brokerFixture.onCleanup(() => client.disconnect().catch(() => undefined));
	return client;
}

/**
 * A parent session with the real Intercom extension, launching through the subagent tool. Its child's start is held
 * until the test calls `register` (the child registers under its launch's capability) or `fail` (its start fails).
 */
async function launchingParent(name: string) {
	const cwd = makeTempDirectory("launch-hold-");
	brokerFixture.onCleanup(() => removeTempDirectory(cwd));
	const sessionManager = SessionManager.inMemory(cwd);
	const host = new AgentTaskHost({
		scope: { kind: "session", sessionId: sessionManager.getSessionId() },
		authorizeLaunch() {},
	});
	brokerFixture.onCleanup(async () => {
		await host.close("session-close");
	});
	const events = eventBus();
	const handlers = new Map<string, Handler[]>();
	let activeTools: string[] = [];
	const appendEntry = async (customType: string, data?: unknown) => {
		await sessionManager.appendCustomEntry(customType, data);
	};
	const pi = {
		on(eventName: string, handler: Handler) {
			handlers.set(eventName, [...(handlers.get(eventName) ?? []), handler]);
		},
		registerTool() {},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		appendEntry,
		async sendMessage() {},
		async sendMessages() {},
		getSessionName: () => name,
		setSessionName() {},
		getActiveTools: () => activeTools,
		setActiveTools(next: string[]) {
			activeTools = next;
		},
		events,
	};
	intercomLightweight(pi as never);
	const ctx = {
		hasUI: false,
		mode: "print",
		cwd,
		isIdle: () => true,
		isProjectTrusted: () => true,
		model: undefined,
		thinkingLevel: undefined,
		sessionManager,
		getAgentTaskHost: () => host,
		modelRegistry: { getAvailable: () => [], getAll: () => [], find: () => undefined },
		ui: { confirm: async () => true, notify() {} },
	} as unknown as ExtensionContext;
	for (const handler of handlers.get("session_start") ?? [])
		await handler({ type: "session_start", reason: "startup" }, ctx);
	brokerFixture.onCleanup(async () => {
		for (const handler of handlers.get("session_shutdown") ?? [])
			await handler({ type: "session_shutdown", reason: "quit" }, ctx);
	});
	const launched = Promise.withResolvers<RunSyncOptions>();
	const start = Promise.withResolvers<"register" | "fail">();
	const received: string[] = [];
	const executor = createSubagentExecutor({
		pi: pi as never,
		state: {
			baseCwd: cwd,
			currentSessionId: sessionManager.getSessionId(),
			foregroundControls: new Map(),
			lastForegroundControlId: null,
			pendingForegroundControlNotices: new Map(),
			lastUiContext: null,
		},
		config: {},
		tempArtifactsDir: cwd,
		getSubagentSessionRoot: () => cwd,
		expandTilde: (value) => value,
		discoverAgents: () => ({ agents: [worker] }),
		runtime: {
			async runSync(_cwd, _agents, agent, task, options): Promise<SingleResult> {
				launched.resolve(options);
				const done = (status: "ok" | "error", error?: string): SingleResult => ({
					agent,
					task,
					status,
					...(error === undefined ? {} : { error, cause: error }),
					messages: [],
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
					finalOutput: "done",
				});
				if ((await start.promise) === "fail") return done("error", "Session start timed out: its start stalled.");
				const child = new IntercomClient(randomUUID());
				child.on("message", (_from: object, message: { content: { text: string } }) => {
					received.push(message.content.text);
				});
				brokerFixture.onCleanup(() => child.disconnect().catch(() => undefined));
				const supervisor = options.supervisorAuthorization;
				assert.ok(supervisor, "the launch carries the capability its hold was made under");
				await child.connect(
					{
						name: options.intercomSessionName!,
						model: "test-model",
						cwd: repoRoot,
						pid: process.pid,
						status: "idle",
						startedAt: Date.now(),
						lastActivity: Date.now(),
						group: "default",
						groups: ["default"],
					},
					{ capability: supervisor.capability, supervisorSessionId: supervisor.supervisorSessionId },
				);
				await sleep(SETTLE_MS);
				return done("ok");
			},
		},
	});
	const result = await executor.execute(
		"launch",
		{ agent: "worker", task: "work", wait: { kind: "background" }, artifacts: false } as never,
		new AbortController().signal,
		undefined,
		ctx as never,
	);
	const text = result.content.map((part) => ("text" in part ? part.text : "")).join("\n");
	const response = JSON.parse(text) as { intercomTarget?: string };
	const options = await launched.promise;
	assert.equal(response.intercomTarget, options.intercomSessionName);
	return { childName: options.intercomSessionName!, start, received };
}

async function wirePeer(name: string) {
	const socket = net.createConnection(getBrokerSocketPath(process.platform, brokerFixture.agentDir));
	brokerFixture.onCleanup(() => {
		socket.destroy();
	});
	const frames: BrokerMessage[] = [];
	const errors: Error[] = [];
	socket.on("error", (error) => errors.push(error));
	socket.on(
		"data",
		createMessageReader(
			(frame) => frames.push(frame as BrokerMessage),
			(error) => errors.push(error),
		),
	);
	const next = <T extends BrokerMessage["type"]>(type: T): Promise<Extract<BrokerMessage, { type: T }>> =>
		vi.waitFor(
			() => {
				assert.deepEqual(errors, []);
				const index = frames.findIndex((frame) => frame.type === type);
				assert.notEqual(index, -1, `waiting for ${type}: ${JSON.stringify(frames)}`);
				return frames.splice(index, 1)[0] as Extract<BrokerMessage, { type: T }>;
			},
			{ timeout: 5_000, interval: 10 },
		);
	const send = (frame: unknown) => writeMessage(socket, frame);
	send({
		type: "register",
		supervisorOwnerToken: randomUUID(),
		session: {
			name,
			model: "test-model",
			cwd: repoRoot,
			pid: process.pid,
			status: "idle",
			startedAt: Date.now(),
			lastActivity: Date.now(),
			group: "default",
		},
	});
	await next("registered");
	return { send, next, closed: () => socket.destroyed, frames };
}

let broker: ChildProcess | undefined;

beforeAll(async () => {
	const extensionDir = join(repoRoot, "packages/intercom");
	broker = spawn(process.execPath, [getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")], {
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: brokerFixture.agentDir },
		stdio: "ignore",
	});
	brokerFixture.trackBroker(broker);
	await vi.waitFor(
		async () => {
			brokerFixture.assertRunning();
			const connected = await new Promise<boolean>((resolveConnected) => {
				const socket = net.createConnection(getBrokerSocketPath(process.platform, brokerFixture.agentDir));
				socket.once("connect", () => {
					socket.destroy();
					resolveConnected(true);
				});
				socket.once("error", () => resolveConnected(false));
			});
			assert.ok(connected);
		},
		{ timeout: 10_000, interval: 20 },
	);
});
afterAll(() => brokerFixture.cleanup());

test(
	"a launch's requested hold duration reaches senders through the real broker (#5341)",
	async () => {
		const parent = await launchingParent("launch-duration-parent");
		try {
			const sender = await wirePeer("launch-duration-sender");
			const messageId = randomUUID();
			sender.send({
				type: "send",
				to: parent.childName,
				awaitRestoringRecipient: true,
				message: { id: messageId, timestamp: Date.now(), content: { text: "duration held message" } },
			});
			const held = await sender.next("send_held");
			assert.equal(held.messageId, messageId);
			assert.equal(held.timeoutMs, subagentStartHoldMs(undefined));
			parent.start.resolve("register");
			assert.equal((await sender.next("delivered")).messageId, messageId);
			await vi.waitFor(() => assert.deepEqual(parent.received, ["duration held message"]), {
				timeout: 5_000,
				interval: 10,
			});
		} finally {
			parent.start.resolve("fail");
		}
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"the broker disconnects malformed starting hold requests without accepting them (#5341)",
	async () => {
		for (const holdMs of [0, -1, 1.5, "60000", null]) {
			const owner = await wirePeer(`launch-invalid-duration-${holdMs}`);
			owner.send({ type: "authorize_supervisor", requestId: randomUUID(), childName: "invalid-hold-child" });
			const { capability } = await owner.next("supervisor_authorized");
			owner.send({ type: "reserve_restoring_recipient", requestId: randomUUID(), capability, holdMs });
			await vi.waitFor(() => assert.equal(owner.closed(), true), { timeout: 5_000, interval: 10 });
			assert.equal(
				owner.frames.some((frame) => frame.type === "restoring_recipient_ack"),
				false,
			);
		}
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"sends to a launching subagent before it registers wait for it and reach it once, in order, when it registers",
	async () => {
		const parent = await launchingParent("launch-hold-parent");
		const thirdParty = await peer("launch-hold-third-party");
		const settled: string[] = [];
		const sends = ["FIRST", "SECOND"].map((text) =>
			thirdParty.send(parent.childName, { text }).finally(() => settled.push(text)),
		);
		void Promise.allSettled(sends);
		await sleep(SETTLE_MS);
		assert.deepEqual(settled, [], "the sends wait for the child instead of failing with Session not found");

		parent.start.resolve("register");
		for (const result of await Promise.all(sends)) assert.equal(result.delivered, true, result.reason);
		await vi.waitFor(() => assert.deepEqual(parent.received, ["FIRST", "SECOND"]), { timeout: 5_000, interval: 10 });
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a send held for a launching subagent whose start fails is told why, not Session not found",
	async () => {
		const parent = await launchingParent("launch-fail-parent");
		const thirdParty = await peer("launch-fail-third-party");
		const held = thirdParty.send(parent.childName, { text: "are you up?" });
		await sleep(SETTLE_MS);
		parent.start.resolve("fail");
		const result = await held;
		assert.equal(result.delivered, false);
		assert.match(result.reason ?? "", /did not start: Session start timed out/);
		assert.doesNotMatch(result.reason ?? "", /Session not found/);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);
