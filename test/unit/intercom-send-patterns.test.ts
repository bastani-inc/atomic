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
		params: { action: string; to?: string; message?: string; broadcast?: boolean },
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
		/** The host session's return address: the stable identity a return path binds. */
		returnAddress?: string;
	} = {},
): Promise<Client> {
	const client = new IntercomClient(options.returnAddress);
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

test("a subagents: pattern send never travels on a return path its owner holds to a child in another group", async () => {
	const ownerGroup = `return-path-owner-${randomUUID()}`;
	const childGroup = `return-path-child-${randomUUID()}`;
	const hostSessionId = `return-path-host-${randomUUID()}`;
	const childName = `return-path-child-${randomUUID()}`;
	const childInbox: string[] = [];
	const owner = await connect("return-path-pattern-owner", {
		group: ownerGroup,
		ownerToken: randomUUID(),
		returnAddress: hostSessionId,
	});
	const authorization = await owner.authorizeSupervisorChild(childName);
	const child = await connect(childName, {
		group: childGroup,
		supervisor: authorization,
		received: childInbox,
		returnAddress: `child-host-${randomUUID()}`,
	});
	observeSubagentChildRecord(childRecord(hostSessionId, randomUUID(), 1, childName, childGroup, { state: "running" }));
	const events = eventBus();
	answerIntercomChildrenRequests(events, () => true);
	const tool = registerTool(owner, events);
	// The child reports to its supervisor across groups: the owner may now answer it directly.
	assert.equal((await child.sendToSupervisor(owner.sessionId!, { text: "report to owner" })).delivered, true);
	assert.equal(
		(await owner.listSessions()).some((peer) => peer.id === child.sessionId),
		false,
	);
	const glob = await tool.execute(
		"return-path-glob",
		{ action: "send", to: "return-path-child-*", message: "glob stays isolated", broadcast: true },
		undefined,
		undefined,
		contextFor(hostSessionId),
	);
	assert.equal(glob.isError, true);
	const pattern = await tool.execute(
		"return-path-subagents",
		{ action: "send", to: "subagents:*", message: "pattern stays isolated" },
		undefined,
		undefined,
		contextFor(hostSessionId),
	);
	assert.equal(pattern.isError, true, text(pattern));
	assert.equal(childInbox.length, 0);
	// The explicit answer, by the child's name, is what the return path is for.
	const answer = await tool.execute(
		"return-path-direct",
		{ action: "send", to: childName, message: "direct answer" },
		undefined,
		undefined,
		contextFor(hostSessionId),
	);
	assert.equal(answer.isError, false, text(answer));
	await waitFor(() => childInbox.includes("direct answer"), "the direct answer reaches the child");
	assert.deepEqual(childInbox, ["direct answer"]);
});

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
				{ action: "send", to: "subagent-worker-*", message: "scope changed", broadcast: true },
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
				{ action: "send", to: "*", message: "to all", broadcast: true },
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
				{ action: "send", to: "refusal-worker-*", message: "hello", broadcast: true },
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
		"a workflow-stage target, pattern or not, gets the answer an unknown name or pattern gets, and sends nothing (Atomic 0.10.0 removed workflows)",
		async () => {
			const runId = randomUUID();
			const member = await connect("workflow-member", { group: `workflow:${runId}` });
			const inbox: string[] = [];
			member.on("message", (_from: unknown, message: { content: { text: string } }) =>
				inbox.push(message.content.text),
			);
			const sender = await connect("workflow-sender");
			const tool = registerTool(sender);
			const send = (to: string) =>
				tool.execute(
					"workflow",
					{ action: "send", to, message: "broadcast" },
					undefined,
					undefined,
					contextFor("workflow-host"),
				);
			/** The result with its target written as `<target>` and message ids as `<id>`, which differ between calls. */
			const normalized = async (to: string) =>
				JSON.parse(
					JSON.stringify(await send(to))
						.split(to)
						.join("<target>")
						.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>"),
				);

			for (const [to, unknown] of [
				[`workflow:${runId}/**`, `no-such-run-${runId}/**`],
				[`workflow:${runId}/reviewer`, `no-such-run-${runId}-reviewer`],
			] as const) {
				const viaPath = await normalized(to);
				assert.equal(viaPath.isError, true, to);
				assert.deepEqual(viaPath, await normalized(unknown), to);
			}
			assert.deepEqual(inbox, []);
		},
		REAL_BROKER_TEST_TIMEOUT_MS,
	);
});

describe("a broadcast to hundreds of sessions reaches every one", () => {
	/** The incident's scale: one glob broadcast matched 232 sessions. */
	const RECIPIENTS = 200;
	/** A loaded broker answers one session list at a time, each after this long. */
	const LOADED_LIST_SERVICE_MS = 20;
	/** A list the loaded broker has not answered by then fails, as the client's own list timeout fails it. */
	const LOADED_LIST_TIMEOUT_MS = 1_000;

	test(
		"a broadcast matching 200 sessions on a loaded broker reaches all 200, looking up the session list once",
		async () => {
			const group = `many-${randomUUID()}`;
			const sender = await connect("many-lead", { group });
			const inboxes = Array.from({ length: RECIPIENTS }, (): string[] => []);
			const recipients = await Promise.all(
				inboxes.map((received, index) => connect(`subagent-lane-${index}`, { group, received })),
			);
			const listSessions = sender.listSessions.bind(sender);
			let lists = 0;
			let answered: Promise<unknown> = Promise.resolve();
			sender.listSessions = (...args) => {
				lists += 1;
				const asked = Date.now();
				const answer = answered.then(async () => {
					if (Date.now() - asked > LOADED_LIST_TIMEOUT_MS) throw new Error("List sessions timeout");
					await new Promise((resolve) => setTimeout(resolve, LOADED_LIST_SERVICE_MS));
					return listSessions(...args);
				});
				answered = answer.catch(() => undefined);
				return answer;
			};
			const send = sender.send.bind(sender);
			let inFlight = 0;
			let peakInFlight = 0;
			sender.send = async (...args) => {
				inFlight += 1;
				peakInFlight = Math.max(peakInFlight, inFlight);
				try {
					return await send(...args);
				} finally {
					inFlight -= 1;
				}
			};
			const tool = registerTool(sender);

			const result = await tool.execute(
				"many",
				{ action: "send", to: "subagent-lane-*", message: "scope changed", broadcast: true },
				undefined,
				undefined,
				contextFor("many-host"),
			);

			assert.equal(result.isError, false, text(result));
			const outcomes = result.details?.recipients ?? [];
			assert.deepEqual(
				outcomes.filter((recipient) => recipient.outcome !== "delivered").map((recipient) => recipient.reason),
				[],
				"no recipient is missed",
			);
			assert.deepEqual(
				outcomes.map((recipient) => recipient.target).sort(),
				recipients.map((recipient) => recipient.sessionId).sort(),
			);
			assert.match(text(result), new RegExp(`reached ${RECIPIENTS} of ${RECIPIENTS} recipients`));
			assert.equal(lists, 1, "one pattern send looks up the session list once");
			assert.ok(
				peakInFlight > 1 && peakInFlight < RECIPIENTS / 4,
				`sends run a bounded few at a time (${peakInFlight})`,
			);
			await waitFor(
				() => inboxes.every((inbox) => inbox.length === 1),
				"every matched session receives the broadcast",
			);
		},
		REAL_BROKER_TEST_TIMEOUT_MS,
	);
});

describe("intercom name-glob sends need broadcast to reach several sessions (#5202)", () => {
	test(
		"a glob that matches several sessions is refused without broadcast, listing the matches, and delivered with it (#5202)",
		async () => {
			const group = `broadcast-${randomUUID()}`;
			const sender = await connect("broadcast-lead", { group });
			const firstInbox: string[] = [];
			const secondInbox: string[] = [];
			const first = await connect("subagent-debugger-aa-1", { group, received: firstInbox });
			const second = await connect("subagent-debugger-bb-1", { group, received: secondInbox });
			const tool = registerTool(sender);

			for (const to of ["subagent-debugger-*", "*"]) {
				const refused = await tool.execute(
					"no-broadcast",
					{ action: "send", to, message: "to you only" },
					undefined,
					undefined,
					contextFor("broadcast-host"),
				);
				assert.equal(refused.isError, true, to);
				assert.match(text(refused), /matches 2 sessions/);
				assert.match(text(refused), /\n- subagent-debugger-aa-1 \(/);
				assert.match(text(refused), /\n- subagent-debugger-bb-1 \(/);
				assert.match(text(refused), /broadcast: true/);
				assert.match(text(refused), /Nothing was sent/);
			}

			const delivered = await tool.execute(
				"broadcast",
				{ action: "send", to: "subagent-debugger-*", message: "to everyone", broadcast: true },
				undefined,
				undefined,
				contextFor("broadcast-host"),
			);
			assert.equal(delivered.isError, false, text(delivered));
			assert.deepEqual(
				delivered.details?.recipients?.map((recipient) => recipient.target).sort(),
				[first.sessionId, second.sessionId].sort(),
			);
			await waitFor(
				() => firstInbox.length === 1 && secondInbox.length === 1,
				"both sessions receive the broadcast",
			);
			assert.deepEqual(
				[firstInbox, secondInbox],
				[["to everyone"], ["to everyone"]],
				"the refused sends reached no one",
			);
		},
		REAL_BROKER_TEST_TIMEOUT_MS,
	);

	test(
		"a glob that matches exactly one session is delivered without broadcast (#5202)",
		async () => {
			const group = `single-${randomUUID()}`;
			const sender = await connect("single-lead", { group });
			const inbox: string[] = [];
			const only = await connect("subagent-debugger-cc-1", { group, received: inbox });
			await connect("subagent-reviewer-cc-1", { group });
			const tool = registerTool(sender);

			const result = await tool.execute(
				"single",
				{ action: "send", to: "subagent-debugger-*", message: "just you" },
				undefined,
				undefined,
				contextFor("single-host"),
			);

			assert.equal(result.isError, false, text(result));
			assert.deepEqual(
				result.details?.recipients?.map((recipient) => recipient.target),
				[only.sessionId],
			);
			await waitFor(() => inbox.length === 1, "the one match receives the message");
			assert.deepEqual(inbox, ["just you"]);
		},
		REAL_BROKER_TEST_TIMEOUT_MS,
	);
});
