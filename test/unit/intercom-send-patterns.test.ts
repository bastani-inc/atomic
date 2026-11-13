import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, test, vi } from "vitest";
import { answerIntercomChildrenRequests } from "../../packages/subagents/src/runs/foreground/intercom-children.js";
import { observeSubagentChildRecord } from "../../packages/subagents/src/runs/foreground/subagent-child-card-state.js";
import type { SubagentChildRecord } from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";

const brokerFixture = new IntercomBrokerFixture(mkdtempSync(join(tmpdir(), "intercom-send-patterns-")));
brokerFixture.overrideAgentDir();
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
const { registerIntercomTool } = await import("../../packages/intercom/intercom-tool.js");
const { ReplyTracker } = await import("../../packages/intercom/reply-tracker.js");
const { ReplyWaiterRegistry } = await import("../../packages/intercom/reply-waiter.js");
const { IntercomClientDisconnectedError } = await import("../../packages/intercom/recoverable-disconnect.js");

type Client = InstanceType<typeof IntercomClient>;
interface RecipientDetail {
	readonly target: string;
	readonly label: string;
	readonly outcome: string;
	readonly reason?: string;
}
interface ToolResult {
	content: Array<{ text: string }>;
	isError: boolean;
	details?: { recipients?: RecipientDetail[]; queued?: boolean };
}
interface Tool {
	execute(
		id: string,
		params: { action: string; to?: string; message?: string },
		signal: AbortSignal | undefined,
		update: undefined,
		ctx: object,
	): Promise<ToolResult>;
}

/** Real broker child plus a dozen real clients: the cost is the broker process and its sockets. */
const REAL_BROKER_TEST_TIMEOUT_MS = 60_000;
const BROKER_START_TIMEOUT_MS = 10_000;

beforeAll(() => brokerFixture.startSourceBroker(BROKER_START_TIMEOUT_MS), BROKER_START_TIMEOUT_MS * 2);
afterAll(() => brokerFixture.cleanup());

async function connect(
	name: string,
	options: {
		group?: string;
		ownerToken?: string;
		supervisor?: { capability: string; supervisorSessionId: string };
		received?: string[];
	} = {},
): Promise<Client> {
	const client = new IntercomClient();
	client.on("error", () => {});
	if (options.received !== undefined) {
		const received = options.received;
		client.on("message", (_from: object, message: { content: { text: string } }) =>
			received.push(message.content.text),
		);
	}
	const group = options.group ?? "default";
	await client.connect(
		{
			name,
			model: "test-model",
			cwd: "/repo",
			pid: process.pid,
			status: "idle",
			startedAt: Date.now(),
			lastActivity: Date.now(),
			group,
			groups: [group],
		},
		options.supervisor,
		options.ownerToken,
		undefined,
		group,
	);
	brokerFixture.onCleanup(() => client.disconnect().catch(() => undefined));
	return client;
}

interface EventBus {
	on(eventName: string, handler: (payload: unknown) => void): () => void;
	emit(eventName: string, payload: unknown): void;
}

function eventBus(): EventBus {
	const handlers = new Map<string, Set<(payload: unknown) => void>>();
	return {
		on(eventName, handler) {
			const set = handlers.get(eventName) ?? new Set();
			set.add(handler);
			handlers.set(eventName, set);
			return () => set.delete(handler);
		},
		emit(eventName, payload) {
			for (const handler of handlers.get(eventName) ?? []) handler(payload);
		},
	};
}

function registerTool(
	sender: Client,
	events: EventBus = eventBus(),
	ensureConnected: () => Promise<Client> = async () => sender,
): Tool {
	let tool: Tool | undefined;
	const waiters = new ReplyWaiterRegistry();
	registerIntercomTool(
		{
			registerTool(value: Tool) {
				tool = value;
			},
			async appendEntry() {},
			events,
		} as never,
		{
			ensureConnected,
			syncPresenceIdentity() {},
			homeGroup: () => "default",
			setJoinedGroups() {},
			clearJoinedGroups() {},
			confirmSend: false,
			beginReplyWait: (from: string, replyTo: string, signal?: AbortSignal) => waiters.begin(from, replyTo, signal),
			replyTracker: new ReplyTracker(),
		} as never,
	);
	assert.ok(tool);
	return tool;
}

function contextFor(hostSessionId: string): object {
	return { sessionManager: { getSessionId: () => hostSessionId }, hasUI: false };
}

function text(result: ToolResult): string {
	return result.content.map((part) => part.text).join("\n");
}

async function waitFor(condition: () => boolean, description: string): Promise<void> {
	await vi.waitFor(() => assert.ok(condition(), description), { timeout: 10_000, interval: 20 });
}

function childRecord(
	ownerSessionId: string,
	runId: string,
	index: number,
	intercomTarget: string,
	group: string,
	state: Pick<SubagentChildRecord, "state" | "terminalStatus">,
): SubagentChildRecord {
	return {
		version: 1,
		childId: `${runId}:${index}`,
		runId,
		index,
		agent: "worker",
		cwd: "/repo",
		owner: { kind: "session", sessionId: ownerSessionId },
		intercomTarget,
		intercomGroup: group,
		...state,
	};
}

describe("intercom send to name patterns and subagents (#4752)", () => {
	test(
		"a glob send reaches every matching session in the sender's groups and lists each recipient's outcome (#4752)",
		async () => {
			const group = `glob-${randomUUID()}`;
			const sender = await connect("glob-lead", { group });
			const firstInbox: string[] = [];
			const secondInbox: string[] = [];
			const otherInbox: string[] = [];
			const first = await connect("subagent-worker-aa-1", { group, received: firstInbox });
			const second = await connect("subagent-worker-bb-1", { group, received: secondInbox });
			await connect("subagent-reviewer-cc-1", { group, received: otherInbox });
			const tool = registerTool(sender);

			const result = await tool.execute(
				"glob",
				{ action: "send", to: "subagent-worker-*", message: "scope changed" },
				undefined,
				undefined,
				contextFor("glob-host"),
			);

			assert.equal(result.isError, false, text(result));
			const recipients = result.details?.recipients ?? [];
			assert.deepEqual(
				recipients.map((recipient) => [recipient.target, recipient.outcome]).sort(),
				[
					[first.sessionId, "delivered"],
					[second.sessionId, "delivered"],
				].sort(),
			);
			assert.match(text(result), /reached 2 of 2 recipients/);
			assert.match(text(result), /subagent-worker-aa-1 \(.+\): delivered/);
			await waitFor(() => firstInbox.length === 1 && secondInbox.length === 1, "both workers receive the message");
			assert.deepEqual([firstInbox, secondInbox], [["scope changed"], ["scope changed"]]);
			assert.deepEqual(otherInbox, [], "a session the pattern does not match receives nothing");

			const everyone = await tool.execute(
				"all",
				{ action: "send", to: "*", message: "to all" },
				undefined,
				undefined,
				contextFor("glob-host"),
			);
			assert.equal(everyone.isError, false, text(everyone));
			assert.equal(everyone.details?.recipients?.length, 3, "`*` reaches every visible session but the sender");
			assert.ok(everyone.details?.recipients?.every((recipient) => recipient.target !== sender.sessionId));
		},
		REAL_BROKER_TEST_TIMEOUT_MS,
	);

	test(
		"a glob send reports a per-recipient refusal beside the deliveries (#4752)",
		async () => {
			const group = `refusal-${randomUUID()}`;
			const sender = await connect("refusal-lead", { group });
			const live = await connect("refusal-worker-1", { group });
			const leaving = await connect("refusal-worker-2", { group });
			const leavingId = leaving.sessionId;
			assert.ok(leavingId);
			const tool = registerTool(sender);
			const listSessions = sender.listSessions.bind(sender);
			// The second worker leaves between the lookup and its send, as a session can at any time.
			sender.listSessions = async (...args) => {
				const sessions = await listSessions(...args);
				await leaving.disconnect();
				return sessions;
			};

			const result = await tool.execute(
				"partial",
				{ action: "send", to: "refusal-worker-*", message: "hello" },
				undefined,
				undefined,
				contextFor("refusal-host"),
			);

			assert.equal(result.isError, false, text(result));
			const outcomes = new Map((result.details?.recipients ?? []).map((recipient) => [recipient.target, recipient]));
			assert.equal(outcomes.get(live.sessionId!)?.outcome, "delivered");
			assert.equal(outcomes.get(leavingId)?.outcome, "refused");
			assert.ok(outcomes.get(leavingId)?.reason, "a refusal carries its reason");
			assert.match(text(result), /reached 1 of 2 recipients/);
		},
		REAL_BROKER_TEST_TIMEOUT_MS,
	);

	test(
		"a glob send retries a recoverable disconnect while it looks up its recipients (#4752)",
		async () => {
			const group = `reconnect-${randomUUID()}`;
			const sender = await connect("reconnect-lead", { group });
			const inbox: string[] = [];
			await connect("reconnect-worker-1", { group, received: inbox });
			let connects = 0;
			const tool = registerTool(sender, eventBus(), async () => {
				connects += 1;
				if (connects === 1) throw new IntercomClientDisconnectedError();
				return sender;
			});

			const result = await tool.execute(
				"reconnect",
				{ action: "send", to: "reconnect-worker-*", message: "after the restart" },
				undefined,
				undefined,
				contextFor("reconnect-host"),
			);

			assert.equal(result.isError, false, text(result));
			assert.equal(result.details?.recipients?.[0]?.outcome, "delivered");
			await waitFor(() => inbox.length === 1, "the worker receives the message once");
			assert.deepEqual(inbox, ["after the restart"]);
		},
		REAL_BROKER_TEST_TIMEOUT_MS,
	);

	test(
		"a glob that matches no session is an error that lists close names (#4752)",
		async () => {
			const group = `nomatch-${randomUUID()}`;
			const sender = await connect("nomatch-lead", { group });
			await connect("subagent-worker-dd-1", { group });
			const tool = registerTool(sender);

			const result = await tool.execute(
				"nomatch",
				{ action: "send", to: "subagent-wroker-*", message: "hello" },
				undefined,
				undefined,
				contextFor("nomatch-host"),
			);

			assert.equal(result.isError, true);
			assert.match(text(result), /No session visible in your groups matches "subagent-wroker-\*"/);
			assert.match(text(result), /Close names: subagent-worker-dd-1/);
		},
		REAL_BROKER_TEST_TIMEOUT_MS,
	);

	test(
		"a glob never reaches a session outside the sender's groups (#4752)",
		async () => {
			const group = `inside-${randomUUID()}`;
			const otherGroup = `outside-${randomUUID()}`;
			const sender = await connect("isolation-lead", { group });
			const insideInbox: string[] = [];
			const outsideInbox: string[] = [];
			const inside = await connect("isolation-worker-in", { group, received: insideInbox });
			await connect("isolation-worker-out", { group: otherGroup, received: outsideInbox });
			const tool = registerTool(sender);

			const result = await tool.execute(
				"isolation",
				{ action: "send", to: "isolation-worker-*", message: "group only" },
				undefined,
				undefined,
				contextFor("isolation-host"),
			);

			assert.equal(result.isError, false, text(result));
			assert.deepEqual(
				result.details?.recipients?.map((recipient) => recipient.target),
				[inside.sessionId],
			);
			await waitFor(() => insideInbox.length === 1, "the in-group worker receives the message");
			const outsideOnly = await tool.execute(
				"outside",
				{ action: "send", to: "isolation-worker-o*", message: "cross group" },
				undefined,
				undefined,
				contextFor("isolation-host"),
			);
			assert.equal(outsideOnly.isError, true, "a session in another group is not a match");
			assert.doesNotMatch(text(outsideOnly), /isolation-worker-out/, "nor is it offered as a close name");
			assert.deepEqual(outsideInbox, []);
		},
		REAL_BROKER_TEST_TIMEOUT_MS,
	);

	test(
		"subagents targets reach this session's running foreground and background children and its paused ones (#4752)",
		async () => {
			const group = `children-${randomUUID()}`;
			const hostSessionId = `children-host-${randomUUID()}`;
			const owner = await connect("children-lead", { group, ownerToken: randomUUID() });
			const foregroundInbox: string[] = [];
			const backgroundInbox: string[] = [];
			const pausedInbox: string[] = [];
			const finishedInbox: string[] = [];
			const foregroundRun = randomUUID().slice(0, 8);
			const backgroundRun = randomUUID().slice(0, 8);
			const names = {
				foreground: `subagent-worker-${foregroundRun}-1`,
				background: `subagent-worker-${backgroundRun}-1`,
				paused: `subagent-worker-${backgroundRun}-2`,
				finished: `subagent-worker-${backgroundRun}-3`,
				otherOwner: `subagent-worker-${backgroundRun}-4`,
			};
			for (const [name, inbox] of [
				[names.foreground, foregroundInbox],
				[names.background, backgroundInbox],
				[names.finished, finishedInbox],
			] as const) {
				const authorization = await owner.authorizeSupervisorChild(name);
				await connect(name, { group, supervisor: authorization, received: inbox });
			}
			const pausedAuthorization = await owner.authorizeSupervisorChild(names.paused);
			await owner.reserveRestoringRecipient(pausedAuthorization.capability, { group });
			observeSubagentChildRecord(
				childRecord(hostSessionId, foregroundRun, 1, names.foreground, group, { state: "running" }),
			);
			observeSubagentChildRecord(
				childRecord(hostSessionId, backgroundRun, 1, names.background, group, { state: "running" }),
			);
			observeSubagentChildRecord(
				childRecord(hostSessionId, backgroundRun, 2, names.paused, group, {
					state: "terminal",
					terminalStatus: "paused",
				}),
			);
			observeSubagentChildRecord(
				childRecord(hostSessionId, backgroundRun, 3, names.finished, group, {
					state: "terminal",
					terminalStatus: "ok",
				}),
			);
			observeSubagentChildRecord(
				childRecord(`another-${hostSessionId}`, backgroundRun, 4, names.otherOwner, group, { state: "running" }),
			);
			const events = eventBus();
			answerIntercomChildrenRequests(events, () => true);
			const tool = registerTool(owner, events);

			const sending = tool.execute(
				"children",
				{ action: "send", to: "subagents:*", message: "new scope" },
				undefined,
				undefined,
				contextFor(hostSessionId),
			);
			await waitFor(() => foregroundInbox.length === 1 && backgroundInbox.length === 1, "live children receive it");
			await vi.waitFor(async () => assert.equal((await owner.brokerStatus())?.heldSends, 1), {
				timeout: 10_000,
				interval: 20,
			});
			// The paused child gets the held send when it resumes, as a direct send to it would.
			await connect(names.paused, { group, supervisor: pausedAuthorization, received: pausedInbox });
			const result = await sending;

			assert.equal(result.isError, false, text(result));
			assert.deepEqual(
				result.details?.recipients?.map((recipient) => [recipient.target, recipient.outcome]),
				[
					[names.foreground, "delivered"],
					[names.background, "delivered"],
					[names.paused, "delivered"],
				],
			);
			await waitFor(() => pausedInbox.length === 1, "the resumed child receives the held message");
			assert.deepEqual(finishedInbox, [], "a finished child is not a recipient");

			const oneRun = await tool.execute(
				"one-run",
				{ action: "send", to: `subagents:${foregroundRun}/*`, message: "run only" },
				undefined,
				undefined,
				contextFor(hostSessionId),
			);
			assert.equal(oneRun.isError, false, text(oneRun));
			assert.deepEqual(
				oneRun.details?.recipients?.map((recipient) => recipient.target),
				[names.foreground],
			);

			const noChildren = await tool.execute(
				"none",
				{ action: "send", to: "subagents:*", message: "anyone?" },
				undefined,
				undefined,
				contextFor(`childless-${hostSessionId}`),
			);
			assert.equal(noChildren.isError, true);
			assert.match(text(noChildren), /no running, released or paused subagents/);
		},
		REAL_BROKER_TEST_TIMEOUT_MS,
	);

	test(
		"ask refuses a pattern target and sends nothing (#4752)",
		async () => {
			const group = `ask-${randomUUID()}`;
			const sender = await connect("ask-lead", { group });
			const inbox: string[] = [];
			await connect("ask-worker-1", { group, received: inbox });
			const tool = registerTool(sender);

			for (const to of ["ask-worker-*", "subagents:*"]) {
				const result = await tool.execute(
					"ask",
					{ action: "ask", to, message: "which?" },
					undefined,
					undefined,
					contextFor("ask-host"),
				);
				assert.equal(result.isError, true, to);
				assert.match(text(result), /ask needs one exact target/);
			}
			assert.deepEqual(inbox, []);
		},
		REAL_BROKER_TEST_TIMEOUT_MS,
	);

	test(
		"a workflow-stage pattern still queues one sticky send through its run's owner (#4752)",
		async () => {
			const runId = randomUUID();
			const invocationGroup = `workflow:${runId}`;
			const capability = `capability-${runId}`;
			const owner = await connect("workflow-owner", { group: invocationGroup });
			owner.registerPendingStageRoute(runId, invocationGroup, capability, [
				{
					stageId: "reviewer",
					stageName: "reviewer",
					target: `workflow:${runId}/reviewer`,
					lifecycle: "pending",
					routeEligible: true,
					group: invocationGroup,
				},
			]);
			await owner.listSessions();
			const routed: string[] = [];
			owner.on("pending_stage_message", (request: { requestId: string; target: string }) => {
				routed.push(request.target);
				owner.respondPendingStageMessage(request.requestId, { outcome: "queued", position: 1 });
			});
			const sender = await connect("workflow-sender");
			await sender.joinGroup(invocationGroup);
			const tool = registerTool(sender);

			const result = await tool.execute(
				"workflow",
				{ action: "send", to: `workflow:${runId}/**`, message: "broadcast" },
				undefined,
				undefined,
				contextFor("workflow-host"),
			);

			assert.equal(result.isError, false, text(result));
			assert.equal(result.details?.queued, true);
			assert.match(text(result), new RegExp(`Message queued for workflow:${runId}/\\*\\*`));
			assert.deepEqual(routed, [`workflow:${runId}/**`], "the owner routes the pattern once, not per session");
		},
		REAL_BROKER_TEST_TIMEOUT_MS,
	);
});
