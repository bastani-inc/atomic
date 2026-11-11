import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { type AgentWake, AgentWakeDispatcher, type DetachedToolCall, type DetachedToolResult } from "@bastani/atomic";
import { afterEach, test, vi } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type { TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import type { TaskTranscriptSource } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { taskTranscriptSource } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agents.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import {
	type EndedChildMark,
	SUBAGENT_MARK_ENDED_CHILDREN_EVENT,
} from "../../packages/subagents/src/runs/foreground/released-child-reservations.js";
import {
	subagentWakeKey,
	subagentWakeNamespace,
} from "../../packages/subagents/src/runs/foreground/released-children.js";
import {
	SUBAGENT_CHILD_RELEASED_STATUS,
	type SubagentChildRecordInput,
	type SubagentChildRecordSink,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import {
	forgetRunMembership,
	rememberSubagentChildSchedule,
	runAgentTask,
	subagentTaskRegistrySizes,
} from "../../packages/subagents/src/runs/foreground/task-execution.js";
import {
	type RunSyncOptions,
	type SingleResult,
	SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT,
	SUBAGENT_RESULT_INTERCOM_EVENT,
} from "../../packages/subagents/src/shared/types.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { drained } from "../helpers/wake-completion.js";

const agent: AgentConfig = {
	name: "worker",
	description: "worker",
	source: "project",
	filePath: "worker.md",
	systemPrompt: "Work",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
};

const OWNER = "owner-session-4326";
const WAIT = { toolCallId: "ci-1", toolName: "wait_for_ci" } as const;

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

function newHost(): AgentTaskHost {
	return new AgentTaskHost({
		scope: { kind: "session", sessionId: `task-release-${randomUUID()}` },
		authorizeLaunch() {},
	});
}

function toolResult(toolCallId: string): DetachedToolResult {
	return {
		toolCallId,
		toolName: "wait_for_ci",
		result: { content: [{ type: "text", text: `${toolCallId} green` }], details: undefined },
		isError: false,
	};
}

function detached(result: DetachedToolResult): DetachedToolCall {
	return {
		toolCallId: result.toolCallId,
		toolName: result.toolName,
		result: Promise.resolve(result),
		abort() {},
	};
}

interface Launch {
	readonly records: SubagentChildRecordInput[];
	readonly taskId: TaskId;
	readonly host: AgentTaskHost;
	readonly wakes: Array<{ key: string; wake: AgentWake }>;
	readonly dispatcher: AgentWakeDispatcher;
	transcript(): TaskTranscriptSource | undefined;
}

async function launch(options: {
	readonly released?: SingleResult["released"] | undefined;
	readonly session?: TaskTranscriptSource;
	readonly options?: Partial<RunSyncOptions>;
	readonly sink?: SubagentChildRecordSink | "none";
	readonly runId: string;
}): Promise<Launch> {
	const cwd = makeTempDirectory("task-release-");
	cleanups.push(() => removeTempDirectory(cwd));
	const host = newHost();
	const records: SubagentChildRecordInput[] = [];
	const wakes: Array<{ key: string; wake: AgentWake }> = [];
	const dispatcher = new AgentWakeDispatcher();
	dispatcher.handle(subagentWakeNamespace(OWNER), async (key, taken) => {
		for (const wake of taken) wakes.push({ key, wake });
	});
	const sink: SubagentChildRecordSink | undefined =
		options.sink === "none"
			? undefined
			: (options.sink ?? { ownerSessionId: OWNER, record: (input) => void records.push(input) });
	const runtime = async (...args: Parameters<typeof runSync>): Promise<SingleResult> => {
		const [parentCwd, agents, agentName, task, runOptions] = args;
		const done = await runSync(parentCwd, agents, agentName, task, {
			...runOptions,
			testSession: { output: "waiting" },
		});
		if (options.session) runOptions.taskExecution?.bindTranscript?.(options.session);
		if (options.released === undefined) return done;
		return { ...done, status: "interrupted", interrupted: true, released: options.released };
	};
	const response = await runAgentTask({
		host,
		cwd,
		agents: [agent],
		agent: "worker",
		task: "watch CI",
		options: { cwd, runId: options.runId, index: 0, sessionDir: join(cwd, "sessions"), ...options.options },
		wait: { kind: "background" },
		...(sink ? { recordChild: sink } : {}),
		wakeDispatcher: dispatcher,
		runtime: { runSync: runtime },
	});
	assert.ok(response.kind === "admitted");
	const taskId = response.observation.taskId as TaskId;
	for (;;) {
		const observed = await host.waitForTask(taskId);
		if (!observed.ok || observed.value.kind === "settled") break;
	}
	return {
		records,
		taskId,
		host,
		wakes,
		dispatcher,
		transcript() {
			const lease = host.resolveTask(taskId);
			if (!lease.ok) return undefined;
			const source = taskTranscriptSource(lease.value);
			return source.ok ? source.value.session : undefined;
		},
	};
}

function fakeSession(extra: Partial<TaskTranscriptSource> = {}): TaskTranscriptSource {
	return { getSessionId: () => "child-session-1", getEntries: () => [], ...extra };
}

test("a task's transcript is the session it bound, answering through it, with Intercom completion only when named (#4326)", async () => {
	const subscribed: string[] = [];
	const streaming = { role: "assistant" } as never;
	const session: TaskTranscriptSource = {
		getSessionId() {
			return this === session ? "child-session-1" : "wrong-this";
		},
		getEntries() {
			return [];
		},
		subscribe(listener) {
			subscribed.push(this === session ? "bound" : "unbound");
			void listener;
			return () => {};
		},
		getStreamingMessage() {
			return this === session ? streaming : undefined;
		},
	};
	const named = await launch({
		runId: "transcript-named",
		session,
		options: { intercomSessionName: "worker-named" },
	});
	const source = named.transcript();
	assert.ok(source);
	assert.equal(source.getSessionId(), "child-session-1");
	assert.ok(source.subscribe);
	source.subscribe(() => {});
	assert.deepEqual(subscribed, ["bound"]);
	assert.equal(source.getStreamingMessage?.(), streaming);
	assert.deepEqual(source.completionSource, { runId: "transcript-named", intercomTarget: "worker-named" });

	const plain = await launch({ runId: "transcript-plain", session: fakeSession() });
	const bare = plain.transcript();
	assert.ok(bare);
	assert.equal(bare.getSessionId(), "child-session-1");
	assert.equal(Object.hasOwn(bare, "completionSource"), false);
	assert.equal(Object.hasOwn(bare, "subscribe"), false);
	assert.equal(Object.hasOwn(bare, "getStreamingMessage"), false);
});

test("a named child's transcript reports compaction and takes messages through the parent's Intercom relay (#4521)", async () => {
	const events = createEventBus();
	const relayed: Array<{ to: string; message: string }> = [];
	events.on(SUBAGENT_RESULT_INTERCOM_EVENT, (payload) => {
		const request = payload as { to: string; message: string; requestId: string };
		relayed.push({ to: request.to, message: request.message });
		events.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, { requestId: request.requestId, delivered: true });
	});
	let compactions = 0;
	const session = fakeSession({
		getCompactionReason() {
			compactions++;
			return this === session ? "threshold" : undefined;
		},
	});
	const named = await launch({
		runId: "transcript-messages",
		session,
		options: { intercomSessionName: "worker-messages", intercomEvents: events },
	});
	const source = named.transcript();
	assert.ok(source?.sendMessage);
	assert.equal(source.getCompactionReason?.(), "threshold");
	assert.equal(compactions, 1);
	assert.deepEqual(await source.sendMessage("steer this way"), { delivered: true });
	assert.deepEqual(relayed, [{ to: "worker-messages", message: "steer this way" }]);

	const unrelayed = await launch({
		runId: "transcript-no-relay",
		session: fakeSession(),
		options: { intercomSessionName: "worker-quiet" },
	});
	assert.equal(Object.hasOwn(unrelayed.transcript() ?? {}, "sendMessage"), false);
	assert.equal(Object.hasOwn(unrelayed.transcript() ?? {}, "getCompactionReason"), false);
	const unnamed = await launch({
		runId: "transcript-unnamed",
		session: fakeSession(),
		options: { intercomEvents: events },
	});
	assert.equal(Object.hasOwn(unnamed.transcript() ?? {}, "sendMessage"), false);
});

test("a released child is recorded released with what it waits on and the Intercom id it had, and none when it had none (#4326)", async () => {
	const withId = await launch({
		runId: "rel-id",
		released: { waitingOn: [WAIT], calls: [], intercomId: "icom-9" },
	});
	const releasedWithId = withId.records.filter((record) => record.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS);
	assert.equal(releasedWithId.length, 1);
	assert.equal(releasedWithId[0]?.state, "terminal");
	assert.deepEqual(releasedWithId[0]?.waitingOn, [WAIT]);
	assert.equal(releasedWithId[0]?.releasedIntercomId, "icom-9");

	const without = await launch({ runId: "rel-none", released: { waitingOn: [WAIT], calls: [] } });
	const releasedWithout = without.records.filter((record) => record.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS);
	assert.equal(releasedWithout.length, 1);
	assert.equal(Object.hasOwn(releasedWithout[0] ?? {}, "releasedIntercomId"), false);
});

test("a released child's detached results wake it under its owner's key, and a child with no owner forwards nothing (#4326)", async () => {
	const owned = await launch({
		runId: "rel-wake",
		released: { waitingOn: [WAIT], calls: [detached(toolResult("ci-1"))] },
	});
	assert.equal(await drained(owned.dispatcher), 0);
	assert.deepEqual(
		owned.wakes.map((entry) => [entry.key, entry.wake.id, entry.wake.toolResult?.toolCallId]),
		[[subagentWakeKey(OWNER, "rel-wake:0"), "tool-result:ci-1", "ci-1"]],
	);

	const ownerless = await launch({
		runId: "rel-ownerless",
		sink: "none",
		released: { waitingOn: [WAIT], calls: [detached(toolResult("ci-2"))] },
	});
	assert.equal(await drained(ownerless.dispatcher), 0);
	assert.deepEqual(ownerless.wakes, []);
	assert.equal(ownerless.dispatcher.stats().unobservedFailures, 0);
});

test("a released child's wake is not sent when its sink does not know the child's record (#4326)", async () => {
	const records: SubagentChildRecordInput[] = [];
	const launched = await launch({
		runId: "rel-unindexed",
		sink: { ownerSessionId: OWNER, record: (input) => void records.push(input) },
		released: { waitingOn: [WAIT], calls: [] },
	});
	assert.equal(await drained(launched.dispatcher), 0);
	assert.equal(launched.records.length, 0);
	assert.equal(records.filter((record) => record.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS).length, 1);
	assert.equal(records.filter((record) => record.terminalStatus === "error").length, 0);
	const outcome = await launched.host.waitForTask(launched.taskId);
	assert.ok(outcome.ok && outcome.value.kind === "settled");
	assert.deepEqual(launched.wakes, []);
	assert.equal(launched.dispatcher.stats().unobservedFailures, 0);
});

test("a named child whose run ended is reported to its owner's Intercom with why and its resume id; others are not (#4639)", async () => {
	const events = createEventBus();
	const reported: EndedChildMark[][] = [];
	events.on(SUBAGENT_MARK_ENDED_CHILDREN_EVENT, (payload) => {
		reported.push((payload as { children: EndedChildMark[] }).children);
	});
	const completed = await launch({
		runId: "ended-ok",
		options: { intercomSessionName: "worker-ended", intercomEvents: events, intercomGroup: "lane" },
	});
	assert.ok(completed.records.some((record) => record.state === "terminal" && record.terminalStatus === "ok"));
	assert.deepEqual(
		reported.map((children) =>
			children.map(({ childName, group, outcome, childId }) => ({ childName, group, outcome, childId })),
		),
		[[{ childName: "worker-ended", group: "lane", outcome: "completed", childId: "ended-ok:0" }]],
		"one report, once the run ended; the running records report nothing",
	);

	reported.length = 0;
	await launch({
		runId: "ended-released",
		released: { waitingOn: [WAIT], calls: [] },
		options: { intercomSessionName: "worker-released", intercomEvents: events },
	});
	await launch({
		runId: "ended-ownerless",
		sink: "none",
		options: { intercomSessionName: "w", intercomEvents: events },
	});
	await launch({ runId: "ended-unnamed", options: { intercomEvents: events } });
	const logged = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		await launch({ runId: "ended-no-intercom", options: { intercomSessionName: "worker-quiet" } });
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(
			logged.mock.calls.filter(([text]) => String(text).includes("Subagent end report failed")),
			[],
			"without Intercom there is nothing to report to, so nothing fails",
		);
	} finally {
		logged.mockRestore();
	}
	assert.deepEqual(reported, [], "a released, ownerless, unnamed or Intercom-less child is not reported");
});

test("the registry sizes count remembered run schedules and drop them when a child ends for good (#4326)", () => {
	const before = subagentTaskRegistrySizes();
	assert.deepEqual(Object.keys(before).sort(), ["closing", "queued", "schedules"]);
	assert.equal(typeof before.queued, "number");
	rememberSubagentChildSchedule("sizes-run", 0, () => {});
	rememberSubagentChildSchedule("sizes-run", 1, () => {});
	assert.equal(subagentTaskRegistrySizes().schedules, before.schedules + 2);
	forgetRunMembership("sizes-run", 0);
	forgetRunMembership("sizes-run", 1);
	assert.equal(subagentTaskRegistrySizes().schedules, before.schedules);
});

test("a task's transcript passes on its session's chat session, running state and queue, and only when it has them (#4640)", async () => {
	const chatSession = { isStreaming: true } as unknown as NonNullable<TaskTranscriptSource["chatSession"]>;
	const queued = { steering: ["a"], followUp: ["b"] };
	let running = true;
	const session: TaskTranscriptSource = {
		getSessionId: () => "child-session-1",
		getEntries: () => [],
		chatSession,
		isRunning() {
			return this === session && running;
		},
		getQueuedMessages() {
			return this === session ? queued : { steering: [], followUp: [] };
		},
	};
	const live = await launch({ runId: "transcript-chat-session", session });
	const source = live.transcript();
	assert.equal(source?.chatSession, chatSession);
	assert.equal(source?.isRunning?.(), true);
	running = false;
	assert.equal(source?.isRunning?.(), false);
	assert.deepEqual(source?.getQueuedMessages?.(), queued);

	const bare = (await launch({ runId: "transcript-no-chat-session", session: fakeSession() })).transcript();
	for (const member of ["chatSession", "isRunning", "getQueuedMessages"])
		assert.equal(Object.hasOwn(bare ?? {}, member), false, `a transcript without ${member} offers none`);
});
