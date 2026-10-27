import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fauxAssistantMessage } from "@bastani/pi-ai/compat";
import { test, vi } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { TaskCompletionEnvelope } from "../../packages/coding-agent/src/core/tasks/completion.js";
import type { OperationId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { createHarness, type Harness } from "../../packages/coding-agent/test/suite/harness.js";

const STAGE_CONTEXT = {
	kind: "workflow-stage",
	workflowRunId: "restore-run",
	workflowStageId: "restore-stage",
	workflowStageName: "Restore stage",
	constraints: { disableWorkflowTool: true },
} as const;

function intentOf(manager: SessionManager, taskId: string): TaskCompletionEnvelope | undefined {
	const entry = manager
		.getEntries()
		.find(
			(candidate) =>
				candidate.type === "custom" &&
				candidate.customType === "task-completion-intent" &&
				(candidate.data as TaskCompletionEnvelope).taskId === taskId,
		);
	return entry?.type === "custom" ? (entry.data as TaskCompletionEnvelope) : undefined;
}

/** Replay one unacknowledged intent in a new process's session, as recovery after a restart does. */
async function replayedNotice(intent: object): Promise<string> {
	const manager = SessionManager.inMemory();
	// The earlier process's owner and task are gone; only the saved intent remains.
	await manager.appendCustomEntry("task-completion-intent", {
		...intent,
		ownerId: "previous-owner",
		taskId: "previous-task",
	});
	const harness: Harness = await createHarness({ sessionManager: manager, orchestrationContext: STAGE_CONTEXT });
	harness.setResponses(Array.from({ length: 3 }, () => fauxAssistantMessage("stage saw notice")));
	try {
		const report = await harness.session.startPendingRecovery("workflow_stage_resume");
		assert.equal(report.completions, 1);
		const notice = harness
			.eventsOfType("message_end")
			.map((event) => event.message)
			.find((message) => message.role === "custom" && message.customType === "task-completion");
		assert.ok(notice && notice.role === "custom");
		return String(notice.content);
	} finally {
		await harness.cleanup();
	}
}

test.runIf(process.platform !== "win32")(
	"a shell completion replayed after a restart keeps its pause wording and never offers a subagent resume (#3996)",
	async () => {
		// The live process records the stopped task's kind with the completion intent.
		const manager = SessionManager.inMemory();
		const live = await createHarness({ sessionManager: manager, orchestrationContext: STAGE_CONTEXT });
		live.setResponses(Array.from({ length: 3 }, () => fauxAssistantMessage("stage saw notice")));
		let intent: TaskCompletionEnvelope | undefined;
		try {
			const host = live.session.getAgentTaskHost();
			const { supervisor, owner } = host.ownerBinding;
			const started = await supervisor.startCommandTask(
				owner,
				{ kind: "command", command: "read value", description: "Paused shell", terminal: { kind: "pipe" } },
				randomUUID() as OperationId,
			);
			assert.ok(started.ok);
			const observed = await supervisor.initialObservation(started.value, { kind: "background" });
			assert.ok(observed.ok && observed.value.kind === "yielded");
			const taskId = observed.value.taskId;
			assert.ok((await host.cancelTask(taskId, "pause")).ok);
			await vi.waitFor(() => {
				intent = intentOf(manager, taskId);
				assert.ok(intent);
			});
		} finally {
			await live.cleanup();
		}
		assert.ok(intent);
		assert.equal(intent.taskKind, "command");
		assert.deepEqual(intent.result.kind === "cancelled" && intent.result.cause, "pause");

		// A new process replays the intent without the task record.
		const shell = await replayedNotice({ ...intent, completionId: "replayed-shell" });
		assert.match(shell, /^Background shell interrupted by a pause\./);
		assert.match(shell, /redo or continue the interrupted step/);
		assert.doesNotMatch(shell, /subagent\(|This execution has ended|Do not restart it/);

		// An intent recorded before the kind was saved gets neutral wording.
		const { taskKind: _kind, ...legacy } = intent;
		const unknown = await replayedNotice({ ...legacy, completionId: "replayed-legacy" });
		assert.match(unknown, /^Background task stopped by a pause\./);
		assert.match(unknown, /redo or continue the interrupted step/);
		assert.doesNotMatch(unknown, /subagent\(|This execution has ended|Do not restart it/);
	},
);
