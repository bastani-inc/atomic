import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@bastani/pi-ai/compat";
import { test, vi } from "vitest";
import { PROTECTED_RECONCILIATION_CUSTOM_TYPE } from "../../packages/coding-agent/src/core/agent-session-persistent-custom-messages.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { OperationId, TaskResult } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { createHarness } from "../../packages/coding-agent/test/suite/harness.js";
import { makeTempDirectory } from "../helpers/runtime.js";

test("a file-backed session disposes cleanly after background completions settle while idle (#3925)", async () => {
	const root = makeTempDirectory("atomic-idle-completion-dispose-");
	try {
		const manager = await SessionManager.create(root, join(root, "sessions"));
		const harness = await createHarness({ sessionManager: manager });
		harness.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage("parent saw notice")));
		let disposed = false;
		try {
			const host = harness.session.getAgentTaskHost();
			const gates: PromiseWithResolvers<TaskResult>[] = [];
			const taskIds: string[] = [];
			for (let index = 0; index < 3; index++) {
				const gate = Promise.withResolvers<TaskResult>();
				gates.push(gate);
				const started = await host.startAgentTask(
					{ kind: "agent", agent: "worker", task: `idle ${index}` },
					`idle-${index}` as OperationId,
					() => ({ result: gate.promise, cleanup: Promise.resolve({ kind: "reaped" as const }) }),
				);
				assert.ok(started.ok);
				taskIds.push(started.value.taskId);
				await host.observeAgentLaunch(started.value.taskId, { kind: "background" });
			}
			// The first completion starts a parent turn; the rest arrive while it streams and
			// their durable card writes yield to file I/O across the end of that turn.
			for (const gate of gates) gate.resolve({ kind: "failed", code: "fixture", message: "idle done" });
			await Promise.all(taskIds.map((taskId) => host.waitForTask(taskId as never)));

			const notices = (taskId: string) =>
				harness
					.eventsOfType("message_end")
					.filter(
						(event) =>
							event.message.role === "custom" &&
							event.message.customType === "task-completion" &&
							(event.message.details as { taskId: string }).taskId === taskId,
					).length;
			const reconciliations = () =>
				manager
					.getBranch()
					.filter(
						(entry) =>
							entry.type === "custom_message" && entry.customType === PROTECTED_RECONCILIATION_CUSTOM_TYPE,
					).length;
			// Every completion's hidden reconciliation turn runs while the parent is otherwise idle.
			await vi.waitFor(() => {
				for (const taskId of taskIds) assert.equal(notices(taskId), 1, `notice for ${taskId}`);
				assert.equal(reconciliations(), taskIds.length);
				assert.equal(harness.session.isStreaming, false);
			});

			disposed = true;
			await harness.cleanup();
			for (const taskId of taskIds) assert.equal(notices(taskId), 1, `single notice for ${taskId}`);
			assert.equal(reconciliations(), taskIds.length);
		} finally {
			if (!disposed) await harness.cleanup().catch(() => {});
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
