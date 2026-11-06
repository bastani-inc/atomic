import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@bastani/atomic";
import { test } from "vitest";
import { type AgentWake, AgentWakeDispatcher } from "../../packages/coding-agent/src/core/agent-wake-dispatcher.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { TaskCompletionMessage } from "../../packages/coding-agent/src/core/tasks/child-command-owner.js";
import { isReleasedChildError } from "../../packages/subagents/src/runs/foreground/released-child-errors.js";
import {
	releasedChildShellRoute,
	routeReleasedChildShellCompletions,
	subagentWakeKey,
	subagentWakeNamespace,
} from "../../packages/subagents/src/runs/foreground/released-children.js";
import { subagentChildRecordOf } from "../../packages/subagents/src/runs/foreground/subagent-child-card-state.js";
import {
	createSubagentChildRecordSink,
	SUBAGENT_CHILD_RELEASED_STATUS,
	subagentChildRecordFailures,
	subagentChildRecordsAppended,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";

function owner() {
	const sessionManager = SessionManager.inMemory("/repo");
	const ctx = { sessionManager } as unknown as ExtensionContext;
	const pi = {
		appendEntry: async <T>(type: string, data?: T) => {
			await sessionManager.appendCustomEntry(type, data);
		},
	};
	const sink = createSubagentChildRecordSink(pi, ctx);
	const runId = `run-${randomUUID().slice(0, 8)}`;
	return { sink, ownerSessionId: sessionManager.getSessionId(), runId, childId: `${runId}:0` };
}

async function recorded(
	{ sink, runId }: ReturnType<typeof owner>,
	state: "running" | "terminal",
	terminalStatus?: string,
): Promise<void> {
	sink.record({
		runId,
		index: 0,
		agent: "worker",
		cwd: "/repo",
		taskId: "task-1",
		state,
		...(terminalStatus === undefined ? {} : { terminalStatus }),
	});
	await sink.flushed?.();
}

function completion(text: string, completionId: string): TaskCompletionMessage {
	return { customType: "task_completion", content: text, details: { completionId }, display: true };
}

function wakeLog(dispatcher: AgentWakeDispatcher, ownerSessionId: string): AgentWake[] {
	const wakes: AgentWake[] = [];
	dispatcher.handle(subagentWakeNamespace(ownerSessionId), async (_key, batch) => {
		wakes.push(...batch);
	});
	return wakes;
}

test("a released child holds each completion of a shell task it launched, in order, and is woken for it (#4326)", async () => {
	const current = owner();
	const { sink, ownerSessionId, childId } = current;
	await recorded(current, "terminal", SUBAGENT_CHILD_RELEASED_STATUS);
	const dispatcher = new AgentWakeDispatcher();
	const wakes = wakeLog(dispatcher, ownerSessionId);
	const holdMessages = sink.holdMessages;
	assert.ok(holdMessages);
	const route = releasedChildShellRoute(holdMessages, ownerSessionId, childId, dispatcher);

	await route.deliver(completion("build finished", "c-1"));
	await route.deliver(completion("tests finished", "c-2"));
	await dispatcher.whenIdle(subagentWakeKey(ownerSessionId, childId));

	assert.deepEqual(subagentChildRecordOf(ownerSessionId, childId)?.heldMessages, {
		taskId: "task-1",
		messages: ["build finished", "tests finished"],
		taskExpands: false,
	});
	assert.deepEqual(
		wakes.map((wake) => [wake.id, wake.kind]),
		[
			["task-completion:c-1", "task-completion"],
			["task-completion:c-2", "task-completion"],
		],
	);
	assert.equal(route.isOpen(), true);
});

test("a paused child holds the completion for its resume without being woken (#4326)", async () => {
	const current = owner();
	const { sink, ownerSessionId, childId } = current;
	await recorded(current, "terminal", "paused");
	const dispatcher = new AgentWakeDispatcher();
	const wakes = wakeLog(dispatcher, ownerSessionId);
	const holdMessages = sink.holdMessages;
	assert.ok(holdMessages);

	await releasedChildShellRoute(holdMessages, ownerSessionId, childId, dispatcher).deliver(completion("done", "c-1"));
	await dispatcher.whenIdle();

	assert.deepEqual(subagentChildRecordOf(ownerSessionId, childId)?.heldMessages?.messages, ["done"]);
	assert.deepEqual(wakes, []);
});

test("a child that runs again or has ended takes no completion: the route refuses it typed, so its launcher gets it (#4326)", async () => {
	for (const [state, status] of [
		["running", undefined],
		["terminal", "ok"],
	] as const) {
		const current = owner();
		const { sink, ownerSessionId, childId } = current;
		await recorded(current, state, status);
		const dispatcher = new AgentWakeDispatcher();
		const wakes = wakeLog(dispatcher, ownerSessionId);
		const holdMessages = sink.holdMessages;
		assert.ok(holdMessages);

		await assert.rejects(
			releasedChildShellRoute(holdMessages, ownerSessionId, childId, dispatcher).deliver(completion("done", "c-1")),
			(error: Error) => isReleasedChildError(error) && (error as { code?: string }).code === "completion-not-held",
		);
		await subagentChildRecordsAppended(ownerSessionId);
		assert.equal(subagentChildRecordOf(ownerSessionId, childId)?.heldMessages, undefined);
		assert.deepEqual(wakes, []);
	}
});

test("routing a released child's shell completions hands its runner the child's route, and a failure is counted typed (#4326)", async () => {
	const current = owner();
	const { sink, ownerSessionId, childId } = current;
	await recorded(current, "terminal", SUBAGENT_CHILD_RELEASED_STATUS);
	const dispatcher = new AgentWakeDispatcher();
	const wakes = wakeLog(dispatcher, ownerSessionId);
	const holdMessages = sink.holdMessages;
	assert.ok(holdMessages);
	const routes: Array<
		Parameters<NonNullable<Parameters<typeof routeReleasedChildShellCompletions>[0]["routeShellCompletions"]>>[0]
	> = [];

	routeReleasedChildShellCompletions(
		{ routeShellCompletions: (route) => routes.push(route) > 0 },
		holdMessages,
		ownerSessionId,
		childId,
		dispatcher,
	);
	await routes[0]?.deliver(completion("deployed", "c-9"));
	await dispatcher.whenIdle();
	const failuresBefore = subagentChildRecordFailures.count;
	routeReleasedChildShellCompletions(
		{
			routeShellCompletions: () => {
				throw new Error("the parent's task owner is closed");
			},
		},
		holdMessages,
		ownerSessionId,
		childId,
		dispatcher,
	);

	assert.equal(routes.length, 1);
	assert.deepEqual(
		wakes.map((wake) => wake.id),
		["task-completion:c-9"],
	);
	assert.equal(subagentChildRecordFailures.count, failuresBefore + 1);
	assert.equal((subagentChildRecordFailures.last as { code?: string } | undefined)?.code, "completion-not-held");
});
