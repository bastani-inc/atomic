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
import * as framing from "../../packages/intercom/broker/framing.js";
import { SUBAGENT_RELEASED_CHILD_WAKE_EVENT } from "../../packages/intercom/session-recovery.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agents.js";
import {
	requestSupervisorAuthorization,
	SUBAGENT_SUPERVISOR_AUTHORIZATION_EVENT,
} from "../../packages/subagents/src/intercom/supervisor-authorization.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import {
	acknowledgeReleasedChildWake,
	INTERCOM_CONNECTED_EVENT,
	type ReleasedChildReservation,
	releasedChildReservation,
	reserveReleasedChildren,
	reserveReleasedChildrenOf,
	SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT,
	SUBAGENT_HOLD_RECOVERED_EVENT,
	SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT,
} from "../../packages/subagents/src/runs/foreground/released-child-reservations.js";
import { bindReleasedChildWakes } from "../../packages/subagents/src/runs/foreground/released-child-wakes.js";
import {
	SUBAGENT_RELEASED_WAKE_PROMPT,
	subagentWakeKey,
} from "../../packages/subagents/src/runs/foreground/released-children.js";
import { subagentChildRecordForTarget } from "../../packages/subagents/src/runs/foreground/subagent-child-card-state.js";
import { SUBAGENT_RESERVE_RESTORING_CHILD_EVENT } from "../../packages/subagents/src/runs/foreground/subagent-child-hold.js";
import {
	createSubagentChildRecordSink,
	readSubagentChildRecords,
	SUBAGENT_CHILD_RELEASED_STATUS,
	subagentChildRecordFailures,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import type { SubagentChildRestoreDeps } from "../../packages/subagents/src/runs/foreground/subagent-child-restore.js";
import { runAgentTask } from "../../packages/subagents/src/runs/foreground/task-execution.js";
import {
	type RunSyncOptions,
	type SingleResult,
	SUBAGENT_COMPLETE_EVENT,
} from "../../packages/subagents/src/shared/types.js";
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

/** Requests to reserve released children seen on a bus, with the completion Intercom attached to each. */
interface ObservedReservation {
	readonly children: readonly ReleasedChildReservation[];
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
			if (eventName === SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT) reservations.push(payload as ObservedReservation);
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
							released: { waitingOn: [{ toolCallId: "ci-1", toolName: "wait_for_ci" }], calls: [] },
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
				recordChild: createSubagentChildRecordSink(
					{ appendEntry: parent.appendEntry },
					{ sessionManager: parent.sessionManager },
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
			// The released child is reserved at the broker by name, to wake its owner, before anything is sent.
			await vi.waitFor(() => assert.ok(parent.events.reservations.some((request) => request.children.length > 0)), {
				timeout: RECORD_WAIT_MS,
				interval: 10,
			});
			const reservation = parent.events.reservations.find((request) => request.children.length > 0);
			assert.deepEqual(
				reservation?.children.map((child) => [child.childName, child.wake]),
				[[childName, true]],
			);
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
		const reserve = async (request: { capability: string; aliases: string[] }) => {
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
			await reserveReleasedChildren(parent.events, [{ childName: released, aliases: [], wake: true }]);
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

test(
	"a subagent that finished on its own and is woken for a late result gets no reservation notice (#5551)",
	async () => {
		const cwd = makeTempDirectory("released-intercom-late-");
		const parent = parentSession("late-result-parent", cwd);
		const ownerSessionId = parent.sessionManager.getSessionId();
		const childName = "subagent-worker-late1-1";
		const launched: RunSyncOptions[] = [];
		const runtime = {
			runSync: async (...args: Parameters<typeof runSync>): Promise<SingleResult> => {
				launched.push(args[4]);
				return runSync(args[0], args[1], args[2], args[3], {
					...args[4],
					testSession: { output: launched.length === 1 ? "all done" : "read the late result" },
				});
			},
		};
		const deps: SubagentChildRestoreDeps = {
			pi: {
				events: parent.events,
				appendEntry: parent.appendEntry,
				getSessionName: () => "late-result-parent",
			} as never,
			config: {},
			discoverAgents: () => ({ agents: [worker] }),
			runtime,
		};
		const notices: Array<{ readonly noticeLabel?: string; readonly summary?: string }> = [];
		parent.events.on(SUBAGENT_COMPLETE_EVENT, (notice) => notices.push(notice as never));
		const confirmations: Array<{ readonly childName: string; completion?: Promise<void> }> = [];
		parent.events.on(SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT, (request) =>
			confirmations.push(request as never),
		);
		let connected = false;
		parent.events.on(INTERCOM_CONNECTED_EVENT, () => {
			connected = true;
		});
		const dispatcher = new AgentWakeDispatcher();
		const stopWakes = bindReleasedChildWakes(deps, parent.ctx, parent.events, dispatcher);
		const failuresBefore = subagentChildRecordFailures.count;
		try {
			await parent.fire("session_start", { type: "session_start", reason: "startup" });
			// As a launch does, the owner authorizes the child as its supervisor on its own broker connection.
			const supervisorAuthorization = await requestSupervisorAuthorization(parent.events, childName);
			assert.ok(supervisorAuthorization);
			assert.equal(connected, true, "the owner is connected to the broker");
			const response = await runAgentTask({
				host: parent.host,
				cwd,
				agents: [worker],
				agent: "worker",
				task: "finish quickly",
				options: {
					cwd,
					runId: "late1",
					index: 0,
					sessionDir: join(cwd, "children", "late1"),
					intercomSessionName: childName,
					intercomGroup: "default",
					intercomEvents: parent.events,
					supervisorAuthorization,
				},
				recordChild: createSubagentChildRecordSink(
					{ appendEntry: parent.appendEntry },
					{ sessionManager: parent.sessionManager },
				),
				runtime,
			});
			assert.equal(response.kind, "admitted");
			await vi.waitFor(
				() =>
					assert.equal(
						readSubagentChildRecords(parent.sessionManager.getEntries()).get("late1:0")?.terminalStatus,
						"ok",
					),
				{ timeout: RECORD_WAIT_MS, interval: 10 },
			);
			// The child was never released, so the broker holds no reservation for it.
			// The result of a call that kept running in the background arrives after the child finished.
			const woken = dispatcher.deliver(subagentWakeKey(ownerSessionId, "late1:0"), {
				id: "tool-result:ci-late-1",
				kind: "tool-result",
				toolResult: {
					toolCallId: "ci-late-1",
					toolName: "bash",
					result: { content: [{ type: "text", text: "CI finished" }], details: undefined },
					isError: false,
				},
			});
			await vi.waitFor(() => assert.equal(launched.length, 2), { timeout: RECORD_WAIT_MS, interval: 10 });
			const relaunch = launched[1];
			assert.equal(relaunch?.resumeSession, true, "the child is woken from its session to read the late result");
			const capability = relaunch?.supervisorAuthorization;
			assert.ok(capability, "the relaunch carries its owner's capability");
			// The woken session registers on Intercom under its owner, as a restored child does.
			await peer(childName, {
				capability: capability.capability,
				supervisorSessionId: capability.supervisorSessionId,
			});
			await woken;
			const settled = await Promise.allSettled(confirmations.map((request) => request.completion));
			await new Promise((resolveTurn) => setImmediate(resolveTurn));
			assert.deepEqual(
				settled.flatMap((outcome) => (outcome.status === "rejected" ? [String(outcome.reason)] : [])),
				[],
				"the broker refuses nothing the owner asks of it for this child",
			);

			assert.deepEqual(
				notices.filter((notice) => notice.noticeLabel === "Released subagent reservation").map((n) => n.summary),
				[],
			);
			assert.equal(subagentChildRecordFailures.count, failuresBefore, "status shows no reservation failure");
		} finally {
			stopWakes();
			await parent.host.close("session-close");
			await parent.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
			removeTempDirectory(cwd);
		}
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

async function ownerClient(
	name: string,
	address = randomUUID(),
	token = randomUUID(),
	preferredSessionId?: string,
): Promise<Client> {
	const client = new IntercomClient(address, { preferredSessionId });
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
		token,
	);
	brokerFixture.onCleanup(() => client.disconnect().catch(() => undefined));
	return client;
}

const HOLD_NOTICE_LABEL = "Released subagent reservation";

/** The subagents a reservation failure notice names. */
function namedIn(summary: string): string | undefined {
	return /^Sends to released subagents? (.+?) cannot be held/.exec(summary)?.[1];
}

/**
 * An owner session that keeps its released subagents addressable on its own broker connection, as Intercom does for it,
 * with the reservation failure notices it receives. `record` writes a child's latest record: by default released by
 * the run of task `task-1` while it waits on a call.
 */
async function reservingOwner(label: string) {
	const address = randomUUID();
	const token = randomUUID();
	let client = await ownerClient(label, address, token);
	const sessionManager = SessionManager.inMemory(repoRoot);
	const ctx = { sessionManager } as unknown as ExtensionContext;
	const events = eventBus();
	const notices: string[] = [];
	events.on(SUBAGENT_COMPLETE_EVENT, (payload) => {
		const notice = payload as { readonly noticeLabel?: string; readonly summary?: string };
		if (notice.noticeLabel === HOLD_NOTICE_LABEL) notices.push(notice.summary ?? "");
	});
	events.on(SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT, (payload) => {
		const request = payload as ObservedReservation;
		request.completion = client.reserveReleasedChildren(request.children);
	});
	const sink = createSubagentChildRecordSink(
		{ appendEntry: async (customType, data) => void (await sessionManager.appendCustomEntry(customType, data)) },
		ctx,
	);
	const bind = (context = ctx) =>
		bindReleasedChildWakes({} as SubagentChildRestoreDeps, context, events, new AgentWakeDispatcher());
	let stop = bind();
	brokerFixture.onCleanup(() => stop());
	const record = (
		childName: string,
		taskId = "task-1",
		state: "running" | "terminal" = "terminal",
		terminalStatus: string = SUBAGENT_CHILD_RELEASED_STATUS,
	) =>
		sink.record({
			agent: "worker",
			runId: childName,
			index: 0,
			cwd: repoRoot,
			state,
			terminalStatus,
			taskId,
			intercomTarget: childName,
			waitingOn: [{ toolCallId: "ci", toolName: "bash" }],
		});
	/** What the owner asks the broker for this child now, as a reconnect would: from its latest record. */
	const reservationOf = (childName: string): ReleasedChildReservation => {
		const latest = subagentChildRecordForTarget(sessionManager.getSessionId(), childName);
		const reservation = latest === undefined ? undefined : releasedChildReservation(latest);
		assert.ok(reservation, `${childName} is held`);
		return reservation;
	};
	const reconnect = async () => {
		const previous = client.sessionId;
		assert.ok(previous);
		await client.disconnect();
		client = await ownerClient(label, address, token, previous);
		assert.equal(client.sessionId, previous);
	};
	return {
		get client() {
			return client;
		},
		reconnect,
		rebind(differentSession = false) {
			stop();
			stop = bind(
				differentSession
					? {
							...ctx,
							sessionManager: SessionManager.inMemory(repoRoot) as unknown as ExtensionContext["sessionManager"],
						}
					: ctx,
			);
		},
		events,
		notices,
		record,
		reservationOf,
		ownerSessionId: sessionManager.getSessionId(),
	};
}

/** Hold back the outcome of the next reservation request on `events` until `release` is called. */
function holdNextReservationOutcome(
	events: ReturnType<typeof eventBus>,
	eventName = SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT,
) {
	const refused = Promise.withResolvers<string | undefined>();
	const allowed = Promise.withResolvers<void>();
	let armed = true;
	events.on(eventName, (payload) => {
		if (!armed) return;
		armed = false;
		const request = payload as ObservedReservation;
		request.completion = request.completion?.then(
			async () => {
				refused.resolve(undefined);
				await allowed.promise;
			},
			async (error: Error & { readonly code?: string }) => {
				refused.resolve(error.code);
				await allowed.promise;
				throw error;
			},
		);
	});
	return { refusedWith: refused.promise, release: () => allowed.resolve() };
}

test(
	"a refused reservation names the one subagent the broker refused, and the others it was asked with stay held (#5551)",
	async () => {
		const owner = await reservingOwner("frames-owner");
		const rival = await ownerClient("frames-rival");
		const names = Array.from({ length: 501 }, (_, index) => `subagent-frames-${index}-1`);
		const lastRefused = names[500] as string;
		const middle = ["subagent-frames-a-1", "subagent-frames-b-1", "subagent-frames-c-1"];
		const middleRefused = middle[1] as string;
		await rival.reserveReleasedChildren([
			{ childName: lastRefused, aliases: [], wake: true },
			{ childName: middleRefused, aliases: [], wake: true },
		]);
		for (const name of [...names, ...middle]) owner.record(name);

		// The 501st is another session's: the broker takes the first 500 and refuses the last.
		await reserveReleasedChildren(
			owner.events,
			names.map((name) => owner.reservationOf(name)),
		);
		// The second of these three is another session's: the broker refuses all three at once.
		await reserveReleasedChildren(
			owner.events,
			middle.map((name) => owner.reservationOf(name)),
		);

		assert.deepEqual(owner.notices.map(namedIn), [lastRefused, middleRefused]);
		// The broker confirms the owner holds every other one.
		for (const held of [names[0], names[499], middle[0], middle[2]])
			await owner.client.acknowledgeReleasedChildWake(held as string);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a reservation retry preserves the end report of a subagent that ran again and completed (#5551)",
	async () => {
		const owner = await reservingOwner("retry-owner");
		const rival = await ownerClient("retry-rival");
		const refused = "subagent-retry-refused";
		const finished = "subagent-retry-finished";
		owner.record(refused);
		owner.record(finished);
		await rival.reserveReleasedChildren([{ childName: refused, aliases: [], wake: true }]);
		await reserveReleasedChildren(owner.events, [owner.reservationOf(finished)]);
		const held = holdNextReservationOutcome(owner.events);
		const renewal = reserveReleasedChildrenOf(owner.events, owner.ownerSessionId);
		assert.equal(await held.refusedWith, "not_owner");
		const authorization = await owner.client.authorizeSupervisorChild(finished);
		const child = await peer(finished, authorization);
		owner.record(finished, "task-2", "running");
		await child.disconnect();
		owner.record(finished, "task-2", "terminal", "ok");
		await owner.client.markEndedChildren([
			{ childName: finished, aliases: [], childId: `${finished}:0`, outcome: "completed" },
		]);
		const sender = await peer("retry-sender");
		assert.equal((await sender.send(finished, { text: "before retry" })).reasonCode, "recipient_completed");
		held.release();
		await renewal;
		await assert.rejects(owner.client.acknowledgeReleasedChildWake(finished), { code: "unknown_released_child" });
		assert.equal((await sender.send(finished, { text: "after retry" })).reasonCode, "recipient_completed");
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a refusal that answers a subagent's earlier release is not reported once its next release is reserved (#5551)",
	async () => {
		const owner = await reservingOwner("release-owner");
		const rival = await ownerClient("release-rival");
		const name = "subagent-release-a-1";
		await rival.reserveReleasedChildren([{ childName: name, aliases: [], wake: true }]);
		owner.record(name, "task-1");
		const held = holdNextReservationOutcome(owner.events);
		const earlier = reserveReleasedChildren(owner.events, [owner.reservationOf(name)]);
		assert.equal(await held.refusedWith, "not_owner", "the broker really refused the earlier release");

		// The other session lets go; the child runs again, is released by its next run and reserved for that release.
		await rival.dropReleasedChildren([name]);
		owner.record(name, "task-2", "running");
		owner.record(name, "task-2");
		await reserveReleasedChildren(owner.events, [owner.reservationOf(name)]);
		await owner.client.acknowledgeReleasedChildWake(name);
		held.release();
		await earlier;

		assert.deepEqual(owner.notices, [], "the earlier release's refusal is not a failure of the reserved one");
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a refusal overtaken by a later reservation of the same release is not reported (#5551)",
	async () => {
		const owner = await reservingOwner("renewal-owner");
		const rival = await ownerClient("renewal-rival");
		const name = "subagent-renewal-a-1";
		await rival.reserveReleasedChildren([{ childName: name, aliases: [], wake: true }]);
		owner.record(name);
		const held = holdNextReservationOutcome(owner.events);
		const earlier = reserveReleasedChildren(owner.events, [owner.reservationOf(name)]);
		assert.equal(await held.refusedWith, "not_owner");

		// As at a reconnect, the same release is asked for again once the other session let go, and the broker takes it.
		await rival.dropReleasedChildren([name]);
		await reserveReleasedChildrenOf(owner.events, owner.ownerSessionId);
		await owner.client.acknowledgeReleasedChildWake(name);
		held.release();
		await earlier;

		assert.deepEqual(owner.notices, [], "the broker holds the child: the overtaken refusal is not reported");
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"the owner's Intercom extension forwards a delayed refusal for the release it restored (#5641)",
	async () => {
		const cwd = makeTempDirectory("released-confirmation-");
		const parent = parentSession("confirmation-extension", cwd);
		const childName = "subagent-confirmation-extension";
		const ownerId = parent.sessionManager.getSessionId();
		const notices: string[] = [];
		parent.events.on(SUBAGENT_COMPLETE_EVENT, (data) => {
			const notice = data as { noticeLabel: string; summary: string };
			if (notice.noticeLabel === HOLD_NOTICE_LABEL) notices.push(notice.summary);
		});
		const stop = bindReleasedChildWakes(
			{} as SubagentChildRestoreDeps,
			parent.ctx,
			parent.events,
			new AgentWakeDispatcher(),
		);
		try {
			await parent.fire("session_start", { type: "session_start", reason: "startup" });
			assert.ok(await requestSupervisorAuthorization(parent.events, childName));
			const sink = createSubagentChildRecordSink({ appendEntry: parent.appendEntry }, parent.ctx);
			await sink.record({
				agent: "worker",
				runId: childName,
				index: 0,
				cwd,
				state: "terminal",
				terminalStatus: SUBAGENT_CHILD_RELEASED_STATUS,
				taskId: "task-1",
				intercomTarget: childName,
				waitingOn: [{ toolCallId: "ci", toolName: "bash" }],
			});
			const hold = holdNextReservationOutcome(parent.events, SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT);
			const confirmation = acknowledgeReleasedChildWake(parent.events, childName, "task-1", `${childName}:0`);
			try {
				assert.equal(await hold.refusedWith, "unknown_released_child");
				await reserveReleasedChildrenOf(parent.events, ownerId);
			} finally {
				hold.release();
				await confirmation;
			}
			assert.deepEqual(notices, []);
		} finally {
			stop();
			await parent.host.close("session-close");
			await parent.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
			removeTempDirectory(cwd);
		}
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

/** Main's ACK frame, including the four-byte framing header. Only its per-call UUID varies. */
function assertLegacyAckBytes(chunks: readonly unknown[], name: string): void {
	let matched = 0;
	for (const chunk of chunks) {
		if (!Buffer.isBuffer(chunk) || chunk.length < 5 || chunk.readUInt32BE() !== chunk.length - 4) continue;
		const frame = JSON.parse(chunk.subarray(4).toString());
		if (frame.type !== "acknowledge_released_child_wake" || frame.childName !== name) continue;
		const body = Buffer.from(
			JSON.stringify({ type: "acknowledge_released_child_wake", childName: name, requestId: frame.requestId }),
		);
		const length = Buffer.alloc(4);
		length.writeUInt32BE(body.length);
		assert.deepEqual(
			chunk,
			Buffer.concat([length, body]),
			"an unnegotiated ACK is byte-identical to the legacy frame",
		);
		matched++;
	}
	assert.ok(matched > 0);
}

/** Once the native refusal is delivered, reporting may drain microtasks but must not wait for a timer or another I/O turn. */
async function assertImmediateRefusal(pending: Promise<void>, deliver: () => void): Promise<void> {
	const timers = vi.spyOn(globalThis, "setTimeout");
	try {
		deliver();
		assert.equal(
			await Promise.race([
				pending.then(() => "reported"),
				new Promise<string>((resolve) => setImmediate(() => resolve("next turn"))),
			]),
			"reported",
		);
		assert.equal(timers.mock.calls.length, 0, "no diagnostic timer for a current refusal");
	} finally {
		timers.mockRestore();
	}
}

test.each(["restored", "dropped", "fresh refusal", "legacy broker", "opaque forwarder"] as const)(
	"a delayed confirmation after a physical reconnect distinguishes the %s case (#5641)",
	async (scenario) => {
		const name = `subagent-confirmation-${scenario.replaceAll(" ", "-")}`;
		// Withhold only the registration advertisement, as on an older broker. Do not edit an outgoing ACK.
		const read = framing.createMessageReader;
		const legacy =
			scenario === "legacy broker"
				? vi.spyOn(framing, "createMessageReader").mockImplementation((receive, fail) =>
						read((frame) => {
							if (frame && typeof frame === "object" && !Array.isArray(frame) && frame.type === "registered") {
								const { stampsReleasedChildren: _omitted, ...registration } = frame;
								receive(registration);
							} else receive(frame);
						}, fail),
					)
				: undefined;
		const capture = legacy && vi.spyOn(net.Socket.prototype, "write");
		const owner = await reservingOwner(`confirmation-${scenario}`);
		let verifications = 0;
		const send = framing.writeMessage;
		const wire = vi.spyOn(framing, "writeMessage").mockImplementation((socket, frame, callback) => {
			if ((frame as { type: string }).type === "verify_released_child") verifications++;
			send(socket, frame, callback);
		});
		const firstSend = Promise.withResolvers<void>();
		if (scenario !== "fresh refusal") firstSend.resolve();
		owner.record(name);
		owner.events.on(SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT, (payload) => {
			const request = payload as { childName: string; completion?: Promise<void> };
			request.completion = firstSend.promise.then(() =>
				owner.client.acknowledgeReleasedChildWake(
					request.childName,
					scenario === "opaque forwarder" ? undefined : request,
				),
			);
		});
		const hold = holdNextReservationOutcome(owner.events, SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT);
		const confirm = () => acknowledgeReleasedChildWake(owner.events, name, "task-1", `${name}:0`);
		const pending = confirm();
		try {
			if (scenario !== "fresh refusal") assert.equal(await hold.refusedWith, "unknown_released_child");
			await owner.reconnect();
			const recovered = Promise.withResolvers<void>();
			owner.events.on(SUBAGENT_HOLD_RECOVERED_EVENT, () => recovered.resolve());
			owner.events.emit(INTERCOM_CONNECTED_EVENT, {});
			await recovered.promise;
			await owner.client.acknowledgeReleasedChildWake(name);
			// Saving another observation of the same released task must not invalidate its broker receipt.
			await owner.record(name);
			if (scenario === "dropped" || scenario === "fresh refusal") await owner.client.dropReleasedChildren([name]);
			firstSend.resolve();
			assert.equal(await hold.refusedWith, "unknown_released_child");
			if (capture)
				assertLegacyAckBytes(
					capture.mock.calls.map(([chunk]) => chunk),
					name,
				);
			if (scenario === "fresh refusal") await assertImmediateRefusal(pending, hold.release);
		} finally {
			firstSend.resolve();
			hold.release();
			await pending.finally(() => {
				wire.mockRestore();
				capture?.mockRestore();
				legacy?.mockRestore();
			});
		}
		assert.deepEqual(owner.notices.map(namedIn), scenario === "restored" ? [] : [name]);
		assert.equal(verifications, scenario === "restored" || scenario === "dropped" ? 1 : 0);
		if (scenario === "restored") {
			await owner.client.dropReleasedChildren([name]);
			const ordinary = holdNextReservationOutcome(owner.events, SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT);
			const confirmation = confirm();
			assert.equal(await ordinary.refusedWith, "unknown_released_child");
			await assertImmediateRefusal(confirmation, ordinary.release);
			assert.deepEqual(owner.notices.map(namedIn), [name], "a genuinely unheld release still reports its refusal");
		}
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a reconnect reservation queued before a wake can physically repair its refusal (#5641)",
	async () => {
		const owner = await reservingOwner("queued-reconnect");
		const name = "subagent-queued-repair";
		await owner.record(name);
		const write = framing.writeMessage;
		const installation = Promise.withResolvers<() => void>();
		const wire = vi.spyOn(framing, "writeMessage").mockImplementation((socket, frame, callback) => {
			if ((frame as { type: string }).type === "reserve_released_children")
				installation.resolve(() => write(socket, frame, callback));
			else write(socket, frame, callback);
		});
		try {
			const reserve = reserveReleasedChildrenOf(owner.events, owner.ownerSessionId);
			const install = await installation.promise;
			owner.events.on(SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT, (data) => {
				const request = data as { childName: string; completion?: Promise<void> };
				request.completion = owner.client.acknowledgeReleasedChildWake(request.childName, request);
			});
			const hold = holdNextReservationOutcome(owner.events, SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT);
			const confirmation = acknowledgeReleasedChildWake(owner.events, name, "task-1", `${name}:0`);
			assert.equal(await hold.refusedWith, "unknown_released_child");
			install();
			await reserve;
			hold.release();
			await confirmation;
			assert.deepEqual(owner.notices, []);
		} finally {
			wire.mockRestore();
		}
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test.each(["recovery", "owner reload", "owner switch"] as const)(
	"a delayed reservation check cannot silence a lost hold or the next failure after %s (#5641)",
	async (duringCheck) => {
		const owner = await reservingOwner(`recovery-while-checking-${duringCheck}`);
		const name = `subagent-checking-${duringCheck.replaceAll(" ", "-")}`;
		await owner.record(name);
		owner.events.on(SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT, (data) => {
			const request = data as { childName: string; completion?: Promise<void> };
			request.completion = owner.client.acknowledgeReleasedChildWake(request.childName, request);
		});
		const hold = holdNextReservationOutcome(owner.events, SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT);
		const confirm = () => acknowledgeReleasedChildWake(owner.events, name, "task-1", `${name}:0`);
		const started = confirm();
		assert.equal(await hold.refusedWith, "unknown_released_child");
		const reserve = () => reserveReleasedChildrenOf(owner.events, owner.ownerSessionId);
		await reserve();
		const verification = Promise.withResolvers<() => void>();
		const send = framing.writeMessage;
		const wire = vi.spyOn(framing, "writeMessage").mockImplementation((socket, frame, callback) => {
			if ((frame as { type: string }).type === "verify_released_child")
				verification.resolve(() => send(socket, frame, callback));
			else send(socket, frame, callback);
		});
		try {
			hold.release();
			const check = await verification.promise;
			if (duringCheck === "owner switch") {
				await owner.client.dropReleasedChildren([name]);
				owner.rebind(true);
				await started;
				assert.deepEqual(
					owner.notices.map(namedIn),
					[name],
					"a check that outlives its owner reports to the departing session",
				);
				check();
				await owner.client.listSessions();
				assert.deepEqual(owner.notices.map(namedIn), [name]);
				return;
			}
			if (duringCheck === "owner reload") {
				const recovered = Promise.withResolvers<void>();
				owner.events.on(SUBAGENT_HOLD_RECOVERED_EVENT, () => recovered.resolve());
				owner.rebind();
				await recovered.promise;
			} else await reserve();
			await owner.client.dropReleasedChildren([name]);
			check();
			await started;
			assert.deepEqual(owner.notices.map(namedIn), [name], "loss keeps the original refusal");
			await confirm();
			assert.deepEqual(owner.notices.map(namedIn), [name, name], "the later release recovery reset the episode");
		} finally {
			wire.mockRestore();
		}
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a refusal for a subagent's earlier release is not reported after it was released again, before that release is reserved (#5551)",
	async () => {
		const owner = await reservingOwner("rereleased-owner");
		const rival = await ownerClient("rereleased-rival");
		const name = "subagent-rereleased-a-1";
		await rival.reserveReleasedChildren([{ childName: name, aliases: [], wake: true }]);
		owner.record(name, "task-1");
		const held = holdNextReservationOutcome(owner.events);
		const earlier = reserveReleasedChildren(owner.events, [owner.reservationOf(name)]);
		assert.equal(await held.refusedWith, "not_owner");
		owner.record(name, "task-2", "running");
		owner.record(name, "task-2");
		held.release();
		await earlier;
		assert.deepEqual(owner.notices, [], "the refusal answered the run before");

		// The new release is refused in its turn: that failure is its own, and is reported.
		await reserveReleasedChildren(owner.events, [owner.reservationOf(name)]);
		assert.deepEqual(owner.notices.map(namedIn), [name]);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a refusal that stays unresolved is announced once, whatever other subagents' reservations do meanwhile (#5551)",
	async () => {
		const owner = await reservingOwner("episode-owner");
		const rival = await ownerClient("episode-rival");
		const [failing, healthy, alsoFailing] = [
			"subagent-episode-a-1",
			"subagent-episode-b-1",
			"subagent-episode-c-1",
		] as const;
		await rival.reserveReleasedChildren([
			{ childName: failing, aliases: [], wake: true },
			{ childName: alsoFailing, aliases: [], wake: true },
		]);
		for (const name of [failing, healthy, alsoFailing]) owner.record(name);

		await reserveReleasedChildren(owner.events, [owner.reservationOf(failing)]);
		await reserveReleasedChildren(owner.events, [owner.reservationOf(healthy)]);
		await owner.client.acknowledgeReleasedChildWake(healthy);
		await reserveReleasedChildren(owner.events, [owner.reservationOf(failing)]);
		assert.deepEqual(owner.notices.map(namedIn), [failing], "the same refusal of the same release, told once");

		// Another subagent's own refusal is a failure of its own, and is told although the first is unresolved.
		await reserveReleasedChildren(owner.events, [owner.reservationOf(alsoFailing)]);
		assert.deepEqual(owner.notices.map(namedIn), [failing, alsoFailing]);

		// The first runs again and its next run releases it: the refusal of that release is that release's own.
		owner.record(failing, "task-2", "running");
		owner.record(failing, "task-2");
		await reserveReleasedChildren(owner.events, [owner.reservationOf(failing)]);
		assert.deepEqual(owner.notices.map(namedIn), [failing, alsoFailing, failing]);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"another owner's reservation of a child does not take over a hold that is not dormant (#4326)",
	async () => {
		const childName = "subagent-worker-keep1-1";
		const first = await ownerClient("hold-keeper-owner");
		const { capability } = await first.authorizeSupervisorChild(childName);
		await first.reserveRestoringRecipient(capability);
		const sender = await peer("hold-keeper-sender");
		let settled = false;
		void sender
			.send(childName, { text: "for the first owner's child" })
			.finally(() => {
				settled = true;
			})
			.catch(() => undefined);
		await sleep(SETTLE_MS);
		const second = await ownerClient("hold-taker-owner");
		const taken = await second.authorizeSupervisorChild(childName);
		await second.reserveRestoringRecipient(taken.capability);
		const received: string[] = [];
		const child = new IntercomClient(randomUUID());
		child.on("message", (_from: object, message: { content: { text: string } }) => {
			received.push(message.content.text);
		});
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
			{ capability: taken.capability, supervisorSessionId: taken.supervisorSessionId },
		);
		await sleep(SETTLE_MS);
		assert.deepEqual(received, [], "the send held under the first owner's reservation stays with it");
		assert.equal(settled, false);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);
