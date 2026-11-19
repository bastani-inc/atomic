import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { getAgentTaskHost } from "../../packages/coding-agent/src/core/agent-session-tasks.js";
import {
	createExtensionRuntime,
	getExtensionRuntimeEventBus,
} from "../../packages/coding-agent/src/core/extensions/loader.js";
import type { SendMessageOptions } from "../../packages/coding-agent/src/core/extensions/types.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type { OperationId, TaskResult } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { taskTranscriptSource } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { InboundIdleQueue } from "../../packages/intercom/inbound-idle-queue.js";
import { createIncomingMessageSender } from "../../packages/intercom/incoming-message-delivery.js";
import type { InboundMessageEntry } from "../../packages/intercom/intercom-utils.js";
import { registerTerminalOrderingBarrier } from "../../packages/intercom/terminal-ordering-barrier.js";
import { runAgentTask } from "../../packages/subagents/src/runs/foreground/task-execution.js";

function message(id: string, target = "child-target", runId = "child-run"): InboundMessageEntry {
	const from = {
		id: `${target}-broker-id`,
		name: target,
		cwd: "/repo",
		model: "test",
		pid: 1,
		startedAt: 1,
		lastActivity: 1,
	};
	return {
		from,
		message: { id, timestamp: 1, source: { subagentRunId: runId }, content: { text: id } },
		bodyText: id,
	};
}

for (const failAt of [undefined, "second", "task-completion"] as const) {
	test(`owner-bound completion orders child messages in the delivery outbox, failAt=${failAt}`, async () => {
		const manager = SessionManager.inMemory();
		const child = SessionManager.inMemory();
		const runtime = createExtensionRuntime();
		const events = getExtensionRuntimeEventBus(runtime);
		const queue = new InboundIdleQueue();
		queue.enqueue(message("first"));
		queue.enqueue(message("unrelated", "other-target", "other-run"));
		queue.enqueue(message("second"));
		queue.enqueue(message("same-alias-other-run", "child-target", "other-run"));
		const delivered: string[] = [];
		let fail = failAt !== undefined;
		const session = {
			sessionManager: manager,
			_resourceLoader: { getExtensions: () => ({ runtime }) },
			async sendCustomMessage(
				value: { customType: string; content: string; details?: InboundMessageEntry },
				options?: SendMessageOptions,
			) {
				const id = value.customType === "intercom_message" ? value.details!.message.id : value.customType;
				if (fail && id === failAt) throw new Error("injected delivery failure");
				if (value.customType === "intercom_message") {
					assert.equal(options?.stageAdmissionKey, `intercom:${id}`);
					assert.equal(options?.triggerTurn, undefined, "prelude must not trigger another turn");
				} else assert.ok(!options?.stageAdmissionKey?.startsWith("intercom:"));
				delivered.push(id);
			},
		} as unknown as ThisParameterType<typeof getAgentTaskHost>;
		const send = createIncomingMessageSender({
			pi: { sendMessage: (value, options) => session.sendCustomMessage(value, options) },
			currentGeneration: () => 1,
			canDeliver: () => true,
			queueTurnContext() {},
		});
		const unregister = registerTerminalOrderingBarrier({ events } as never, {
			queue,
			deliver: (entry) => send(entry, "prelude", 1, false),
		});
		const host = getAgentTaskHost.call(session);
		const result = Promise.withResolvers<TaskResult>();
		let launches = 0;
		try {
			const started = await host.startAgentTask(
				{ kind: "agent", agent: "fake", task: "Inspect" },
				"ordered-completion" as OperationId,
				(context) => {
					launches++;
					context.bindTranscript({
						getSessionId: () => child.getSessionId(),
						getEntries: () => child.getEntries(),
						completionSource: { runId: "child-run", intercomTarget: "child-target" },
					});
					return { result: result.promise, cleanup: Promise.resolve({ kind: "reaped" }) };
				},
			);
			assert.ok(started.ok);
			await host.observeAgentLaunch(started.value.taskId, { kind: "background" });
			const before = host.watchOwnerTasks();
			assert.ok(before.ok);
			const outcome: TaskResult = { kind: "completed", output: before.value.snapshot.tasks[0]!.output };
			before.value.dispose();
			result.resolve(outcome);
			await host.waitForTask(started.value.taskId);
			await vi.waitFor(() =>
				assert.ok(
					manager
						.getEntries()
						.some((entry) => entry.type === "custom" && entry.customType === "task-completion-intent"),
				),
			);
			await session._taskCompletionOutbox!.flush();
			if (failAt) {
				assert.deepEqual(delivered, failAt === "second" ? ["first"] : ["first", "second"]);
				assert.equal(session._taskCompletionOutbox!.pending.length, 1);
				if (failAt === "task-completion") queue.enqueue(message("late-before-retry"));
				fail = false;
				await session._taskCompletionOutbox!.flush();
			}
			assert.deepEqual(delivered, [
				"first",
				"second",
				...(failAt === "task-completion" ? ["late-before-retry"] : []),
				"task-completion",
			]);
			assert.equal(session._taskCompletionOutbox!.pending.length, 0);
			assert.deepEqual(
				queue.drain().map((entry) => entry.message.id),
				["unrelated", "same-alias-other-run"],
			);
			assert.equal(launches, 1);
			const watched = host.watchOwnerTasks();
			assert.ok(watched.ok);
			assert.deepEqual(watched.value.snapshot.tasks[0]!.execution, { kind: "settled", result: outcome });
			watched.value.dispose();
		} finally {
			unregister();
			await host.close("session-close");
		}
	});
}

test("subagent task bridge binds its actual run and Intercom target, not its SDK session ID", async () => {
	const host = new AgentTaskHost({ scope: { kind: "session", sessionId: "source-owner" }, authorizeLaunch() {} });
	const child = SessionManager.inMemory();
	const finish = Promise.withResolvers<void>();
	try {
		const response = await runAgentTask({
			host,
			cwd: process.cwd(),
			agents: [],
			agent: "fake",
			task: "Inspect",
			options: { runId: "actual-run", intercomSessionName: "actual-intercom-target" },
			runtime: {
				async runSync(_cwd, _agents, _agent, _task, options) {
					options.taskExecution!.bindTranscript!(child);
					await finish.promise;
					return {
						agent: "fake",
						task: "Inspect",
						status: "ok",
						envelope: "Done",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
					};
				},
			},
		});
		assert.equal(response.kind, "admitted");
		if (response.kind !== "admitted") return;
		const task = host.resolveTask(response.observation.taskId);
		assert.ok(task.ok);
		const source = taskTranscriptSource(task.value);
		assert.ok(source.ok);
		assert.equal(source.value.session.getSessionId(), child.getSessionId());
		assert.deepEqual(source.value.session.completionSource, {
			runId: "actual-run",
			intercomTarget: "actual-intercom-target",
		});
	} finally {
		finish.resolve();
		await host.close("session-close");
	}
});
