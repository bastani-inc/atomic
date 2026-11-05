import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { afterAll, beforeAll, test, vi } from "vitest";
import { AgentWakeDispatcher } from "../../packages/coding-agent/src/core/agent-wake-dispatcher.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import { SUBAGENT_RELEASED_CHILD_WAKE_EVENT } from "../../packages/intercom/session-recovery.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agents.js";
import { SUBAGENT_SUPERVISOR_AUTHORIZATION_EVENT } from "../../packages/subagents/src/intercom/supervisor-authorization.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { bindReleasedChildWakes } from "../../packages/subagents/src/runs/foreground/released-child-wakes.js";
import { SUBAGENT_RELEASED_WAKE_PROMPT } from "../../packages/subagents/src/runs/foreground/released-children.js";
import { SUBAGENT_RESERVE_RESTORING_CHILD_EVENT } from "../../packages/subagents/src/runs/foreground/subagent-child-hold.js";
import {
	createSubagentChildRecordSink,
	readSubagentChildRecords,
	SUBAGENT_CHILD_RELEASED_STATUS,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import type { SubagentChildRestoreDeps } from "../../packages/subagents/src/runs/foreground/subagent-child-restore.js";
import { runAgentTask } from "../../packages/subagents/src/runs/foreground/task-execution.js";
import type { RunSyncOptions, SingleResult } from "../../packages/subagents/src/shared/types.js";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const brokerFixture = new IntercomBrokerFixture(mkdtempSync(join(tmpdir(), "released-intercom-")));
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
const RECORD_WAIT_MS = 10_000;
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

/** Reservation requests seen on a bus, with the completion Intercom attached to each. */
interface ObservedReservation {
	readonly wake?: boolean;
	readonly dormant?: boolean;
	completion?: Promise<void>;
}

function eventBus() {
	const handlers = new Map<string, EventHandler[]>();
	const reservations: ObservedReservation[] = [];
	return {
		reservations,
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
			if (eventName === SUBAGENT_RESERVE_RESTORING_CHILD_EVENT) reservations.push(payload as ObservedReservation);
		},
	};
}

/** A parent session with the real Intercom extension on the event bus its subagents use. */
function parentSession(name: string, cwd: string) {
	const sessionManager = SessionManager.inMemory(cwd);
	const host = new AgentTaskHost({
		scope: { kind: "session", sessionId: `${name}-${randomUUID()}` },
		authorizeLaunch() {},
	});
	const events = eventBus();
	const handlers = new Map<string, Handler[]>();
	let activeTools: string[] = [];
	const appendEntry = async (customType: string, data?: unknown) => {
		await sessionManager.appendCustomEntry(customType, data);
	};
	intercomLightweight({
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
	} as never);
	const ctx = {
		hasUI: false,
		cwd,
		isIdle: () => true,
		model: undefined,
		thinkingLevel: undefined,
		sessionManager,
		getAgentTaskHost: () => host,
		modelRegistry: { getAvailable: () => [], getAll: () => [], find: () => undefined },
		ui: { confirm: async () => true, notify() {} },
	} as unknown as ExtensionContext;
	const fire = async (eventName: string, event: object): Promise<void> => {
		for (const handler of handlers.get(eventName) ?? []) await handler(event, ctx);
	};
	return { sessionManager, host, events, appendEntry, ctx, fire };
}

/** A plain Intercom peer in the default group. */
async function peer(
	name: string,
	supervisor?: { capability: string; supervisorSessionId: string },
	returnAddress = randomUUID(),
): Promise<Client> {
	const client = new IntercomClient(returnAddress);
	await client.connect(
		{
			name,
			model: "test-model",
			cwd: repoRoot,
			pid: process.pid,
			status: "idle",
			startedAt: Date.now(),
			lastActivity: Date.now(),
			group: "default",
			groups: ["default"],
		},
		supervisor,
	);
	brokerFixture.onCleanup(() => client.disconnect().catch(() => undefined));
	return client;
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
	"sends and asks to a released subagent wake it and are delivered exactly once, in the order they were sent (#4326)",
	async () => {
		const cwd = makeTempDirectory("released-intercom-");
		const parent = parentSession("released-parent", cwd);
		const childName = "subagent-worker-rel1-1";
		const launched: RunSyncOptions[] = [];
		const tasks: string[] = [];
		const runtime = {
			runSync: async (...args: Parameters<typeof runSync>): Promise<SingleResult> => {
				launched.push(args[4]);
				tasks.push(args[3]);
				const first = launched.length === 1;
				const result = await runSync(args[0], args[1], args[2], args[3], {
					...args[4],
					testSession: first
						? { output: "waiting on CI" }
						: { output: "never", promptGate: new Promise(() => {}), abortResolvesPrompt: true },
				});
				// The first run ends waiting on a detached call: the child is released.
				return first
					? {
							...result,
							status: "interrupted",
							interrupted: true,
							released: { waitingOn: [{ toolCallId: "ci-1", toolName: "wait_for_ci" }] },
						}
					: result;
			},
		};
		const deps: SubagentChildRestoreDeps = {
			pi: {
				events: parent.events,
				appendEntry: parent.appendEntry,
				getSessionName: () => "released-parent",
			} as never,
			config: {},
			discoverAgents: () => ({ agents: [worker] }),
			runtime,
		};
		const dispatcher = new AgentWakeDispatcher();
		const stopWakes = bindReleasedChildWakes(deps, parent.ctx, parent.events, dispatcher);
		try {
			await parent.fire("session_start", { type: "session_start", reason: "startup" });
			const response = await runAgentTask({
				host: parent.host,
				cwd,
				agents: [worker],
				agent: "worker",
				task: "watch CI",
				options: {
					cwd,
					runId: "rel1",
					index: 0,
					sessionDir: join(cwd, "children", "rel1"),
					intercomSessionName: childName,
					intercomGroup: "default",
					intercomEvents: parent.events,
				},
				wait: { kind: "background" },
				recordChild: createSubagentChildRecordSink(
					{ appendEntry: parent.appendEntry },
					{ sessionManager: parent.sessionManager, orchestrationContext: undefined },
				),
				runtime,
			});
			assert.equal(response.kind, "admitted");
			await vi.waitFor(
				() =>
					assert.equal(
						readSubagentChildRecords(parent.sessionManager.getEntries()).get("rel1:0")?.terminalStatus,
						SUBAGENT_CHILD_RELEASED_STATUS,
					),
				{ timeout: RECORD_WAIT_MS, interval: 10 },
			);
			// The released child's targets are reserved at the broker, dormant and with wake, before anything is sent.
			await vi.waitFor(() => assert.ok(parent.events.reservations.some((request) => request.wake === true)), {
				timeout: RECORD_WAIT_MS,
				interval: 10,
			});
			const reservation = parent.events.reservations.find((request) => request.wake === true);
			assert.equal(reservation?.dormant, true);
			await reservation?.completion;
			const sender = await peer("released-sender");
			const replies: string[] = [];
			sender.on("message", (_from: object, message: { replyTo?: string; content: { text: string } }) => {
				if (message.replyTo) replies.push(message.content.text);
			});

			const sends = [
				sender.send(childName, { text: "REL-1" }),
				sender.send(childName, { text: "REL-2-ASK", expectsReply: true }),
				sender.send(childName, { text: "REL-3" }),
			];
			void Promise.allSettled(sends);
			// The broker told the parent; the parent's dispatcher restored the child, prompted to read what woke it.
			await vi.waitFor(() => assert.equal(launched.length, 2), { timeout: RECORD_WAIT_MS, interval: 10 });
			assert.equal(launched[1]?.resumeSession, true);
			assert.equal(tasks[1], SUBAGENT_RELEASED_WAKE_PROMPT, "the woken child is told to read what arrived");
			const relaunch = launched[1];
			assert.ok(relaunch);
			const capability = relaunch.supervisorAuthorization;
			assert.ok(capability, "the relaunch carries the capability that took the hold over");

			const received: string[] = [];
			const child = new IntercomClient(randomUUID());
			child.on(
				"message",
				(from: { id: string }, message: { id: string; expectsReply?: boolean; content: { text: string } }) => {
					received.push(message.content.text);
					if (message.expectsReply) void child.send(from.id, { text: "CI IS GREEN", replyTo: message.id });
				},
			);
			brokerFixture.onCleanup(() => child.disconnect().catch(() => undefined));
			await child.connect(
				{
					name: childName,
					model: "test-model",
					cwd: repoRoot,
					pid: process.pid,
					status: "idle",
					startedAt: Date.now(),
					lastActivity: Date.now(),
					group: "default",
					groups: ["default"],
				},
				{ capability: capability.capability, supervisorSessionId: capability.supervisorSessionId },
			);

			for (const result of await Promise.all(sends)) assert.equal(result.delivered, true, result.reason);
			await sleep(SETTLE_MS);
			assert.deepEqual(received, ["REL-1", "REL-2-ASK", "REL-3"], "each held send arrives once, in order");
			assert.deepEqual(replies, ["CI IS GREEN"], "the held ask is answered once through its reply route");
			assert.equal(launched.length, 2, "one wake for the whole burst");
		} finally {
			stopWakes();
			await parent.host.close("session-close");
			await parent.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
			removeTempDirectory(cwd);
		}
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"only a released subagent's held send asks its parent to wake it; a send held for a restoring one does not (#4326)",
	async () => {
		const cwd = makeTempDirectory("released-intercom-hold-only-");
		const parent = parentSession("hold-only-parent", cwd);
		const wakes: unknown[] = [];
		parent.events.on(SUBAGENT_RELEASED_CHILD_WAKE_EVENT, (notice) => wakes.push(notice));
		const authorize = (childName: string): Promise<{ capability: string }> => {
			const request: { childName: string; completion?: Promise<{ capability: string }> } = { childName };
			parent.events.emit(SUBAGENT_SUPERVISOR_AUTHORIZATION_EVENT, request);
			assert.ok(request.completion, "Intercom answers the supervisor authorization request");
			return request.completion;
		};
		const reserve = async (request: { capability: string; aliases: string[]; dormant?: boolean; wake?: boolean }) => {
			const forwarded: typeof request & { completion?: Promise<void> } = request;
			parent.events.emit(SUBAGENT_RESERVE_RESTORING_CHILD_EVENT, forwarded);
			assert.ok(forwarded.completion, "Intercom takes the reservation request");
			await forwarded.completion;
		};
		try {
			await parent.fire("session_start", { type: "session_start", reason: "startup" });
			const restoring = "subagent-worker-hold9-1";
			const released = "subagent-worker-rel9-1";
			await reserve({ capability: (await authorize(restoring)).capability, aliases: [] });
			await reserve({
				capability: (await authorize(released)).capability,
				aliases: [],
				dormant: true,
				wake: true,
			});
			const sender = await peer("hold-only-sender");
			let restoringSendSettled = false;
			void sender
				.send(restoring, { text: "to the restoring child" })
				.finally(() => {
					restoringSendSettled = true;
				})
				.catch(() => undefined);
			void sender.send(released, { text: "to the released child" }).catch(() => undefined);
			await vi.waitFor(() => assert.equal(wakes.length > 0, true), { timeout: RECORD_WAIT_MS, interval: 10 });
			await sleep(SETTLE_MS);
			assert.deepEqual(wakes, [{ childName: released }]);
			assert.equal(restoringSendSettled, false, "the send to the restoring child is still held");
		} finally {
			await parent.host.close("session-close");
			await parent.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
			removeTempDirectory(cwd);
		}
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

async function ownerClient(name: string): Promise<Client> {
	const client = new IntercomClient(randomUUID());
	await client.connect(
		{
			name,
			model: "test-model",
			cwd: repoRoot,
			pid: process.pid,
			status: "idle",
			startedAt: Date.now(),
			lastActivity: Date.now(),
			group: "default",
			groups: ["default"],
		},
		undefined,
		randomUUID(),
	);
	brokerFixture.onCleanup(() => client.disconnect().catch(() => undefined));
	return client;
}

test(
	"the broker drops a client whose reservation carries a wake that is not a boolean, and takes a boolean one (#4326)",
	async () => {
		const malformed = await ownerClient("malformed-wake-owner");
		const { capability } = await malformed.authorizeSupervisorChild("subagent-worker-bad1-1");
		const raw = malformed as unknown as { restoringRecipientRequest(request: object): Promise<void> };
		await assert.rejects(
			raw.restoringRecipientRequest({ type: "reserve_restoring_recipient", capability, wake: "yes" }),
			(error: Error) => error.name === "IntercomClientDisconnectedError",
		);
		const owner = await ownerClient("boolean-wake-owner");
		const granted = await owner.authorizeSupervisorChild("subagent-worker-bad2-1");
		await owner.reserveRestoringRecipient(granted.capability, { dormant: true, wake: true });
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);
