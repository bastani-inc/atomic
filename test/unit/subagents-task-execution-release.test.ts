import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { type AgentWake, AgentWakeDispatcher, type DetachedToolCall, type DetachedToolResult } from "@bastani/atomic";
import { afterEach, test } from "vitest";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type { TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import type { TaskTranscriptSource } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { taskTranscriptSource } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agents.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
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
import type { RunSyncOptions, SingleResult } from "../../packages/subagents/src/shared/types.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

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

async function settleWakes(): Promise<void> {
	for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setImmediate(resolve));
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

test("a child's transcript reports the compaction its session is running (#4521)", async () => {
	let compactions = 0;
	const session = fakeSession({
		getCompactionReason() {
			compactions++;
			return this === session ? "threshold" : undefined;
		},
	});
	const named = await launch({ runId: "transcript-compaction", session });
	assert.equal(named.transcript()?.getCompactionReason?.(), "threshold");
	assert.equal(compactions, 1);
	const plain = await launch({ runId: "transcript-no-compaction", session: fakeSession() });
	assert.equal(Object.hasOwn(plain.transcript() ?? {}, "getCompactionReason"), false);
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
	await settleWakes();
	assert.deepEqual(
		owned.wakes.map((entry) => [entry.key, entry.wake.id, entry.wake.toolResult?.toolCallId]),
		[[subagentWakeKey(OWNER, "rel-wake:0"), "tool-result:ci-1", "ci-1"]],
	);

	const ownerless = await launch({
		runId: "rel-ownerless",
		sink: "none",
		released: { waitingOn: [WAIT], calls: [detached(toolResult("ci-2"))] },
	});
	await settleWakes();
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
	await settleWakes();
	assert.equal(launched.records.length, 0);
	assert.equal(records.filter((record) => record.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS).length, 1);
	assert.equal(records.filter((record) => record.terminalStatus === "error").length, 0);
	const outcome = await launched.host.waitForTask(launched.taskId);
	assert.ok(outcome.ok && outcome.value.kind === "settled");
	assert.deepEqual(launched.wakes, []);
	assert.equal(launched.dispatcher.stats().unobservedFailures, 0);
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
