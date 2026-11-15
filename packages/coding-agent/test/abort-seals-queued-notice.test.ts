import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { test } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { PROTECTED_RECONCILIATION_CUSTOM_TYPE } from "../src/core/agent-session-persistent-custom-messages.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { TASK_COMPLETION_MESSAGE_TYPE } from "../src/core/tasks/completion.ts";
import type { OperationId, TaskId } from "../src/core/tasks/contracts.ts";
import type { BashToolDetails } from "../src/core/tools/bash.ts";
import { createHarness } from "./suite/harness.ts";

const launchShell = process.platform === "win32" ? "powershell" : "bash";
/** Waits for one line on stdin, so the test decides when the background command completes. */
const WAIT_FOR_RELEASE =
	launchShell === "powershell"
		? "$value = [Console]::ReadLine(); Write-Output 'released'"
		: "read value; printf released";

async function releaseTask(session: AgentSession, id: TaskId): Promise<void> {
	const host = session.getAgentTaskHost();
	const task = host.resolveTask(id);
	assert.ok(task.ok);
	const input = host.ownerBinding.supervisor.taskStdin(task.value);
	assert.ok(input.ok);
	const written = await host.ownerBinding.supervisor.writeTaskInput(input.value, crypto.randomUUID() as OperationId, {
		kind: "bytes",
		bytes: Buffer.from("go\n"),
	});
	assert.ok(written.ok);
}

function customEntries(manager: SessionManager, customType: string): number {
	return manager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === customType)
		.length;
}

test("an SDK abort that pauses queued messages lets dispose save a queued task completion notice (#5166)", async () => {
	const root = mkdtempSync(join(tmpdir(), "abort-seals-notice-"));
	const dir = join(root, "sessions");
	const manager = await SessionManager.create(root, dir);
	const harness = await createHarness({ sessionManager: manager, initialActiveToolNames: [launchShell] });
	const { session } = harness;
	const secondTurnStarted = Promise.withResolvers<void>();
	harness.setResponses([
		fauxAssistantMessage(
			fauxToolCall(launchShell, { command: WAIT_FOR_RELEASE, wait: { kind: "background" }, timeout: 60 }),
			{ stopReason: "toolUse" },
		),
		// The next model request runs until the abort, so the completion notice arrives while a turn streams.
		(_context, options) => {
			secondTurnStarted.resolve();
			return new Promise((resolve) =>
				options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("stopped")), { once: true }),
			);
		},
	]);
	let taskId: TaskId | undefined;
	const noticeShown = Promise.withResolvers<void>();
	session.subscribe((event) => {
		if (event.type === "tool_execution_end")
			taskId = (event.result.details as BashToolDetails | undefined)?.observation?.taskId;
		if (
			event.type === "message_end" &&
			event.message.role === "custom" &&
			event.message.customType === TASK_COMPLETION_MESSAGE_TYPE
		)
			noticeShown.resolve();
	});
	try {
		const turn = session.prompt("start the command in the background");
		await secondTurnStarted.promise;
		assert.ok(taskId, "the command continued in the background");
		await releaseTask(session, taskId);
		await noticeShown.promise;

		await session.abort({ pauseQueuedMessages: true });
		await session.dispose();
		await turn;

		const reopened = await SessionManager.open(manager.getSessionFile()!, dir, root);
		assert.deepEqual(
			{
				modelRequests: harness.faux.state.callCount,
				cards: customEntries(reopened, TASK_COMPLETION_MESSAGE_TYPE),
				reconciliations: customEntries(reopened, PROTECTED_RECONCILIATION_CUSTOM_TYPE),
			},
			{ modelRequests: 2, cards: 1, reconciliations: 1 },
		);
	} finally {
		await harness.cleanup();
		rmSync(root, { recursive: true, force: true });
	}
});

test("a plain SDK abort leaves queued messages unpaused (#5166)", async () => {
	const harness = await createHarness();
	try {
		await harness.session.abort();
		assert.equal(harness.session.queuedMessagesPaused, false);
	} finally {
		await harness.cleanup();
	}
});
