import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { getAgentTaskHost } from "../../packages/coding-agent/src/core/agent-session-tasks.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { OperationId, TaskResult } from "../../packages/coding-agent/src/core/tasks/contracts.js";

type Session = ThisParameterType<typeof getAgentTaskHost>;
type SendOptions = Parameters<Session["sendCustomMessage"]>[1];

async function noticeOptions(
	operation: string,
	settle: TaskResult,
): Promise<{ content: string; options: SendOptions }> {
	const sessionManager = SessionManager.inMemory();
	const sendCustomMessage = vi.fn(async () => {});
	const session = { sessionManager, sendCustomMessage } as unknown as Session;
	const host = getAgentTaskHost.call(session);
	try {
		const result = Promise.withResolvers<TaskResult>();
		const started = await host.startAgentTask(
			{ kind: "agent", agent: "worker", task: "Build and wait for the build" },
			operation as OperationId,
			() => ({ result: result.promise, cleanup: Promise.resolve({ kind: "reaped" }) }),
		);
		assert.ok(started.ok);
		await host.observeAgentLaunch(started.value.taskId, { kind: "background" });
		result.resolve(settle);
		await host.waitForTask(started.value.taskId);
		await vi.waitFor(() => assert.equal(sendCustomMessage.mock.calls.length, 1));
		const [message, options] = sendCustomMessage.mock.calls[0] as unknown as Parameters<Session["sendCustomMessage"]>;
		return { content: String(message.content), options };
	} finally {
		await host.close("session-close");
	}
}

test("a subagent released while it waits tells its parent without starting a parent turn", async () => {
	const released = await noticeOptions("released-quiet", {
		kind: "cancelled",
		cause: "pause",
		released: { waitingOn: [{ toolCallId: "toolu_1", toolName: "bash" }] },
	});
	assert.match(released.content, /Subagent worker released while waiting on bash \(toolu_1\)/);
	assert.equal(released.options?.triggerTurn, false);
});

test("a subagent that finishes still starts its parent's turn", async () => {
	const failed = await noticeOptions("failed-turn", { kind: "failed", code: "Probe", message: "It broke" });
	assert.match(failed.content, /Subagent worker failed/);
	assert.equal(failed.options?.triggerTurn, true);
});
