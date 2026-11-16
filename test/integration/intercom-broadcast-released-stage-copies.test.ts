import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntry } from "@bastani/atomic";
import { afterAll, beforeAll, test, vi } from "vitest";
import type { ReleasedStageAnnouncement } from "../../packages/intercom/released-stage-peers.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";

const brokerFixture = new IntercomBrokerFixture(mkdtempSync(join(tmpdir(), "intercom-broadcast-copies-")));
brokerFixture.overrideAgentDir();
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
const { default: intercomHeavy } = await import("../../packages/intercom/index-heavy.js");
const { registerIntercomTool } = await import("../../packages/intercom/intercom-tool.js");
const { ReplyTracker } = await import("../../packages/intercom/reply-tracker.js");
const { ReplyWaiterRegistry } = await import("../../packages/intercom/reply-waiter.js");
const { INTERCOM_RECOVERY_PEERS_EVENT } = await import("../../packages/intercom/session-recovery.js");
const { RELEASED_STAGE_EVENT } = await import("../../packages/intercom/released-stage-peers.js");
const { consumedIntercomMessageIds, unconsumedIntercomInbox } = await import(
	"../../packages/intercom/durable-inbox.js"
);
const { buildIncomingCustomMessage } = await import("../../packages/intercom/incoming-message-delivery.js");

/** A real broker child, one host runtime hosting 99 released stages, and a 100-recipient broadcast over sockets. */
const REAL_BROKER_BROADCAST_TEST_TIMEOUT_MS = 60_000;
const BROKER_START_TIMEOUT_MS = 10_000;
const WAIT_TIMEOUT_MS = 20_000;
/** The incident's shape: one host session and the 99 finished stages it hosts all match the sender's glob. */
const RELEASED_STAGES = 99;
const RELEASED_STAGE_STATUS = "closed · reply: post-mortem only";
/** Closed stages not yet released: each is still its own Intercom session and hands what it receives to its host. */
const CLOSED_STAGES = 3;
const LATE_STAGE_MESSAGE_EVENT = "atomic:workflow-stage-late-message";
const GROUP = "default";

beforeAll(() => brokerFixture.startSourceBroker(BROKER_START_TIMEOUT_MS), BROKER_START_TIMEOUT_MS * 2);
afterAll(() => brokerFixture.cleanup());

type Handler = (event: object, ctx: object) => unknown;
type EventHandler = (payload: object) => void;
interface ShownMessage {
	content?: string;
	details?: { message?: { id?: string; content?: { text?: string } } };
}
interface ToolResult {
	content: Array<{ text: string }>;
	isError: boolean;
	details?: { recipients?: Array<{ outcome: string }> };
}
interface Tool {
	execute(
		id: string,
		params: { action: string; to?: string; message?: string; broadcast?: boolean },
		signal: AbortSignal | undefined,
		update: undefined,
		ctx: object,
	): Promise<ToolResult>;
}

/** A live, idle host session: the real Intercom runtime, whose shown messages become `intercom_message` cards. */
async function startHost(sessionId: string) {
	const branch: SessionEntry[] = [];
	const shownTexts: string[] = [];
	const handlers = new Map<string, Handler[]>();
	const eventHandlers = new Map<string, EventHandler[]>();
	const events = {
		on(eventName: string, handler: EventHandler) {
			eventHandlers.set(eventName, [...(eventHandlers.get(eventName) ?? []), handler]);
			return () => {};
		},
		emit(eventName: string, payload: object) {
			for (const handler of eventHandlers.get(eventName) ?? []) handler(payload);
		},
	};
	const show = (message: ShownMessage) => {
		shownTexts.push(message.details?.message?.content?.text ?? "?");
		branch.push({
			type: "custom_message",
			id: `card-${branch.length}`,
			parentId: null,
			timestamp: new Date().toISOString(),
			customType: "intercom_message",
			content: message.content ?? "",
			display: true,
			details: message.details,
		});
	};
	const pi = {
		on(eventName: string, handler: Handler) {
			handlers.set(eventName, [...(handlers.get(eventName) ?? []), handler]);
		},
		registerTool() {},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		async appendEntry(customType: string, data?: object) {
			branch.push({
				type: "custom",
				id: `entry-${branch.length}`,
				parentId: null,
				timestamp: new Date().toISOString(),
				customType,
				data,
			});
		},
		async sendMessage(message: ShownMessage) {
			show(message);
		},
		async sendMessages(messages: ShownMessage[]) {
			for (const message of messages) show(message);
		},
		getSessionName: () => undefined,
		setSessionName() {},
		getActiveTools: () => [],
		setActiveTools() {},
		events,
	};
	const context = {
		hasUI: true,
		cwd: brokerFixture.agentDir,
		isIdle: () => true,
		model: { id: "host-model" },
		sessionManager: { getSessionId: () => sessionId, getEntries: () => branch, getBranch: () => branch },
		ui: { confirm: async () => true, notify() {} },
	};
	intercomHeavy(pi as never);
	const fire = async (eventName: string, event: object) => {
		for (const handler of handlers.get(eventName) ?? []) await handler(event, context);
	};
	await fire("session_start", { type: "session_start", reason: "startup" });
	const connected: { completion?: Promise<object[]> } = {};
	events.emit(INTERCOM_RECOVERY_PEERS_EVENT, connected);
	await connected.completion;
	brokerFixture.onCleanup(() => fire("session_shutdown", { type: "session_shutdown" }));
	return {
		branch,
		shownTexts,
		release(route: ReleasedStageAnnouncement) {
			events.emit(RELEASED_STAGE_EVENT, route as unknown as object);
		},
		emit: events.emit,
	};
}

async function connectSender(name: string) {
	const client = new IntercomClient();
	client.on("error", () => {});
	const now = Date.now();
	await client.connect(
		{
			name,
			model: "test-model",
			cwd: "/repo",
			pid: process.pid,
			startedAt: now,
			lastActivity: now,
			group: GROUP,
			groups: [GROUP],
		},
		undefined,
		undefined,
		undefined,
		GROUP,
	);
	brokerFixture.onCleanup(() => client.disconnect().catch(() => undefined));
	let tool: Tool | undefined;
	const waiters = new ReplyWaiterRegistry();
	registerIntercomTool(
		{
			registerTool(value: Tool) {
				tool = value;
			},
			async appendEntry() {},
			events: { on: () => () => {}, emit() {} },
		} as never,
		{
			ensureConnected: async () => client,
			syncPresenceIdentity() {},
			homeGroup: () => GROUP,
			setJoinedGroups() {},
			clearJoinedGroups() {},
			confirmSend: false,
			beginReplyWait: (from: string, replyTo: string, signal?: AbortSignal) => waiters.begin(from, replyTo, signal),
			replyTracker: new ReplyTracker(),
		} as never,
	);
	assert.ok(tool);
	return { client, tool, context: { sessionManager: { getSessionId: () => `${name}-session` }, hasUI: false } };
}

test(
	"a broadcast reaching a host session and the 99 released stages it hosts is shown to the host once",
	async () => {
		const host = await startHost(`host-${randomUUID()}`);
		const runId = randomUUID();
		const routes: ReleasedStageAnnouncement[] = Array.from({ length: RELEASED_STAGES }, (_, index) => ({
			runId,
			stageId: `stage-${index}`,
			stageName: `fix-lane-${index}`,
			sessionId: randomUUID(),
			group: GROUP,
			model: "faux/model",
			answer: async () => "unused",
		}));
		for (const route of routes) host.release(route);
		const sender = await connectSender("subagent-debugger-broadcast-1");
		const released = (sessions: SessionInfo[]) =>
			sessions.filter((session) => session.status === RELEASED_STAGE_STATUS).length;
		await vi.waitFor(async () => assert.equal(released(await sender.client.listSessions(GROUP)), RELEASED_STAGES), {
			timeout: WAIT_TIMEOUT_MS,
			interval: 50,
		});

		const broadcast = "Hi siblings! I own only my own files.";
		const result = await sender.tool.execute(
			"broadcast",
			{ action: "send", to: "subagent-chat-*", message: broadcast, broadcast: true },
			undefined,
			undefined,
			sender.context,
		);
		assert.equal(result.isError, false, result.content.map((part) => part.text).join("\n"));
		assert.equal(
			result.details?.recipients?.filter((recipient) => recipient.outcome === "delivered").length,
			RELEASED_STAGES + 1,
			"the host and every released stage it hosts are recipients",
		);

		// A plain send to one released stage still reaches its host; hosted messages arrive in order, so once it is
		// shown, every broadcast copy relayed before it has been handled.
		const marker = "fyi: a plain send to one released stage";
		const sent = await sender.client.send(`subagent-chat-${routes[RELEASED_STAGES - 1]!.sessionId}`, {
			text: marker,
		});
		assert.equal(sent.delivered, true);
		await vi.waitFor(() => assert.ok(host.shownTexts.includes(marker)), { timeout: WAIT_TIMEOUT_MS, interval: 20 });

		assert.equal(
			host.shownTexts.filter((text) => text === broadcast).length,
			1,
			"one broadcast is shown to its host session once, however many of its copies reach it",
		);
		assert.deepEqual(
			unconsumedIntercomInbox(host.branch).map((record) => record.message.content.text),
			[],
			"a resume shows no copy of the broadcast again",
		);
	},
	REAL_BROKER_BROADCAST_TEST_TIMEOUT_MS,
);

test(
	"a broadcast reaching a host session and its closed, not yet released, stages is shown to the host once",
	async () => {
		const runId = randomUUID();
		const host = await startHost(`closed-${runId}-host`);
		const lateDeliveries: Array<Promise<void>> = [];
		const closedStageIds: string[] = [];
		for (let index = 0; index < CLOSED_STAGES; index += 1) {
			// A closed stage's runtime hands a message that arrives after it closed to its host's late-message route.
			const stage = new IntercomClient();
			stage.on("error", () => {});
			stage.on("message", (from: SessionInfo, message: Message) => {
				const event: { handled: boolean; completion?: Promise<void>; [field: string]: unknown } = {
					handled: false,
					batch: false,
					messages: [buildIncomingCustomMessage({ from, message, bodyText: message.content.text })],
					workflowRunId: runId,
					workflowStageId: `closed-stage-${index}`,
					workflowStageName: `closed-lane-${index}`,
					options: { triggerTurn: true },
				};
				host.emit(LATE_STAGE_MESSAGE_EVENT, event);
				assert.equal(event.handled, true, "the host owns a closed stage's late message");
				lateDeliveries.push(event.completion ?? Promise.resolve());
			});
			const now = Date.now();
			await stage.connect(
				{
					name: `subagent-chat-closed-${runId}-stage-${index}`,
					model: "faux/model",
					cwd: "/repo",
					pid: process.pid,
					startedAt: now,
					lastActivity: now,
					group: GROUP,
					groups: [GROUP],
				},
				undefined,
				undefined,
				undefined,
				GROUP,
			);
			brokerFixture.onCleanup(() => stage.disconnect().catch(() => undefined));
			closedStageIds.push(stage.sessionId!);
		}
		const sender = await connectSender("subagent-debugger-broadcast-2");

		const broadcast = "Closed stages: the scope changed.";
		const result = await sender.tool.execute(
			"broadcast-closed",
			{ action: "send", to: `subagent-chat-closed-${runId}-*`, message: broadcast, broadcast: true },
			undefined,
			undefined,
			sender.context,
		);
		assert.equal(result.isError, false, result.content.map((part) => part.text).join("\n"));
		assert.equal(
			result.details?.recipients?.length,
			CLOSED_STAGES + 1,
			"the host and its closed stages are recipients",
		);
		const recipients = (result.details?.recipients ?? []) as Array<{
			target: string;
			outcome: string;
			messageId?: string;
		}>;
		const hostCopy = recipients.find((recipient) => !closedStageIds.includes(recipient.target));
		assert.ok(hostCopy?.messageId, "the host session is a recipient");
		for (const id of closedStageIds) {
			assert.equal(recipients.find((recipient) => recipient.target === id)?.outcome, "delivered");
		}

		await vi.waitFor(
			() => {
				assert.equal(lateDeliveries.length, CLOSED_STAGES, "every closed stage hands its copy to the host");
				assert.ok(
					consumedIntercomMessageIds(host.branch).has(hostCopy.messageId!),
					"the host handled its own copy",
				);
			},
			{ timeout: WAIT_TIMEOUT_MS, interval: 20 },
		);
		await Promise.all(lateDeliveries);

		assert.equal(
			host.shownTexts.filter((text) => text === broadcast).length,
			1,
			"one broadcast is shown to its host session once, however many closed stages hand it a copy",
		);
		assert.deepEqual(
			unconsumedIntercomInbox(host.branch).map((record) => record.message.content.text),
			[],
			"a resume shows no copy of the broadcast again",
		);
	},
	REAL_BROKER_BROADCAST_TEST_TIMEOUT_MS,
);
