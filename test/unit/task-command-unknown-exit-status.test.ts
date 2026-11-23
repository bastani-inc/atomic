import assert from "node:assert/strict";
import crypto from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { onTestFinished, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import { taskOutcomeStatus } from "../../packages/coding-agent/src/core/tasks/command-output.js";
import {
	formatTaskCompletion,
	type TaskCompletionEnvelope,
	taskCompletionNotice,
	taskNoticeLine,
} from "../../packages/coding-agent/src/core/tasks/completion.js";
import { commandOutputExcerpt } from "../../packages/coding-agent/src/core/tasks/completion-message.js";
import type {
	OperationId,
	OutputRef,
	OwnerId,
	Sequence,
	TaskId,
	TaskRecord,
	TaskResult,
} from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import {
	taskBoardState,
	taskState,
	taskStatusAppearance,
} from "../../packages/coding-agent/src/modes/interactive/components/task-row.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { taskRecord } from "../helpers/task-record.js";
import { transcriptOnlySource } from "../helpers/task-transcript-environment.js";

const output: OutputRef = {
	ownerId: "owner-1" as OwnerId,
	taskId: "task-cmd-1" as TaskId,
	artifactId: "output-task-cmd-1",
	byteCount: "0",
	omittedRanges: [],
};

function makeEnvelope(result: TaskResult, overrides: Partial<TaskCompletionEnvelope> = {}): TaskCompletionEnvelope {
	return {
		completionId: "completion-1",
		ownerId: "owner-1" as OwnerId,
		taskId: "task-cmd-1" as TaskId,
		terminalSequence: "1" as Sequence,
		result,
		display: false,
		...overrides,
	};
}

test("taskOutcomeStatus treats a command with missing or non-zero exitCode as failed, and only exitCode 0 as completed", () => {
	assert.equal(taskOutcomeStatus({ kind: "completed", output, exitCode: 0 }, "command"), "completed");
	assert.equal(taskOutcomeStatus({ kind: "completed", output, exitCode: 1 }, "command"), "failed");
	assert.equal(taskOutcomeStatus({ kind: "completed", output, exitCode: Number.NaN }, "command"), "failed");
	assert.equal(taskOutcomeStatus({ kind: "completed", output }, "command"), "failed");
	assert.equal(taskOutcomeStatus({ kind: "failed", code: "SpawnFailed", message: "boom" }, "command"), "failed");
	assert.equal(taskOutcomeStatus({ kind: "cancelled", cause: "user" }, "command"), "cancelled");

	// Agents and kind-less restored tasks keep their existing completion semantics.
	assert.equal(taskOutcomeStatus({ kind: "completed", output }, "agent"), "completed");
	assert.equal(taskOutcomeStatus({ kind: "completed", output }, undefined), "completed");

	// User- or agent-initiated stop always stays cancelled regardless of kind or exit code absence.
	for (const cause of [
		"user",
		"owner-close",
		"execution-timeout",
		"output-limit",
		"parent-handoff",
		"pause",
		"quit",
		"shutdown",
	] as const) {
		const cancelled: TaskResult = { kind: "cancelled", cause, output };
		const shell: TaskRecord = {
			...taskRecord(`task-cancel-${cause}`, "command"),
			title: "sleep 30",
			execution: { kind: "settled", result: cancelled },
		};
		const env = makeEnvelope(cancelled, { taskId: shell.ref.taskId, taskKind: "command" });
		assert.equal(taskOutcomeStatus(cancelled, "command"), "cancelled");
		assert.equal(taskBoardState(shell), "stopped");
		assert.equal(taskCompletionNotice(env, shell).status, "cancelled");
		assert.equal(taskCompletionNotice(env, undefined).status, "cancelled");
		assert.equal(taskNoticeLine(env, shell).status, cause === "execution-timeout" ? "warning" : "stopped");
	}
});

test("successful commands (live, restored with taskKind, and legacy kind-less intents) never render failed", async () => {
	// Restored command with exitCode: 0 (with and without live TaskRecord).
	const okResult: TaskResult = { kind: "completed", output, exitCode: 0 };
	const okShell: TaskRecord = {
		...taskRecord("task-cmd-ok", "command"),
		title: "echo ok",
		execution: { kind: "settled", result: okResult },
	};
	const okEnv = makeEnvelope(okResult, { taskId: okShell.ref.taskId, taskKind: "command" });
	assert.equal(taskOutcomeStatus(okResult, "command"), "completed");
	assert.equal(taskState(okShell), "completed");
	assert.equal(taskBoardState(okShell), "done");
	assert.equal(taskCompletionNotice(okEnv, okShell).status, "completed");
	assert.equal(taskCompletionNotice(okEnv, undefined).status, "completed");
	assert.equal(taskNoticeLine(okEnv, okShell).status, "success");

	// Older restored intent without taskKind still renders completed.
	const legacyEnv = makeEnvelope({ kind: "completed", output }, { taskKind: undefined });
	assert.equal(taskCompletionNotice(legacyEnv, undefined).status, "completed");
	assert.equal(taskNoticeLine(legacyEnv, undefined).status, "success");

	// Real supervised background command exiting 0 attaches exitCode: 0 atomically on settle (Linux and Windows).
	const host = new AgentTaskHost({
		scope: { kind: "session", sessionId: crypto.randomUUID() },
		authorizeLaunch() {},
	});
	onTestFinished(async () => {
		await host.close("session-close");
	});
	const { supervisor, owner } = host.ownerBinding;
	const started = await supervisor.startCommandTask(
		owner,
		{ kind: "command", command: "exit 0", terminal: { kind: "pipe" } },
		crypto.randomUUID() as OperationId,
	);
	assert.ok(started.ok);
	const settled = await supervisor.waitForTask(started.value, 10_000);
	assert.ok(settled.ok && settled.value.kind === "settled");
	assert.equal(settled.value.result.kind, "completed");
	assert.equal(settled.value.result.exitCode, 0);
	const [shell] = host.taskRecords(new Set([settled.value.taskId]));
	assert.ok(shell);
	assert.equal(taskOutcomeStatus(settled.value.result, "command"), "completed");
	assert.equal(taskBoardState(shell), "done");
	const env = makeEnvelope(settled.value.result, {
		ownerId: shell.ref.ownerId,
		taskId: shell.ref.taskId,
		taskKind: "command",
	});
	assert.equal(taskCompletionNotice(env, shell).status, "completed");
	assert.equal(taskNoticeLine(env, shell).status, "success");
});

test("command completion notices, text, rows, and inspector never report missing exitCode as success", () => {
	initTheme("dark");
	const previousKeybindings = getKeybindings();
	setKeybindings(new KeybindingsManager());
	try {
		const unknownResult: TaskResult = { kind: "completed", output };
		const shell: TaskRecord = {
			...taskRecord("task-cmd-1", "command"),
			title: "kill -TERM $$",
			execution: { kind: "settled", result: unknownResult },
		};
		const envelope = makeEnvelope(unknownResult, { taskKind: "command" });

		// Task row & board state.
		assert.equal(taskState(shell), "failed");
		assert.equal(taskBoardState(shell), "failed");
		const appearance = taskStatusAppearance(shell);
		assert.equal(appearance.label, "Failed");
		assert.equal(appearance.color, "error");

		// Notice line & completion card with TaskRecord present.
		const line = taskNoticeLine(envelope, shell);
		assert.equal(line.status, "failure");
		assert.equal(line.outcome, "failed (exit status unknown)");

		const notice = taskCompletionNotice(envelope, shell, "partial output");
		assert.equal(notice.status, "failed");
		assert.equal(notice.line?.status, "failure");
		assert.equal(notice.line?.outcome, "failed (exit status unknown)");

		// Notice with TaskRecord absent (restored/evicted task using envelope.taskKind).
		const restoredNotice = taskCompletionNotice(envelope, undefined, "partial output");
		assert.equal(restoredNotice.status, "failed");
		assert.equal(restoredNotice.line?.status, "failure");
		assert.equal(restoredNotice.line?.outcome, "failed (exit status unknown)");

		// Restored command with non-zero exitCode and no TaskRecord must also stay failed.
		const restoredNonZero = taskCompletionNotice(
			makeEnvelope({ kind: "completed", output, exitCode: 2 }, { taskKind: "command" }),
			undefined,
		);
		assert.equal(restoredNonZero.status, "failed");

		// Model-facing completion text.
		const formatted = formatTaskCompletion(envelope, shell, "partial output");
		assert.match(formatted, /^Background shell failed: kill -TERM \$\$/);
		assert.match(formatted, /Exit status: unknown \(ended without an exit code\)/);

		// Shell viewer inspector header shows Failed + unknown exit status.
		const source = transcriptOnlySource({
			tasks: [shell],
			backgroundTasks: [shell],
			recentActivity: () => [],
			activityOmitted: () => false,
			stdinAvailable: () => false,
			taskDetailText: () => ({}),
			readTaskOutput: async () => ({ ok: true, value: { text: "", omitted: false } }),
		});
		const inspector = new TaskInspector(
			source,
			() => {},
			() => {},
		);
		try {
			inspector.open(shell.ref.taskId);
			inspector.handleInput("\r");
			const rendered = stripVTControlCharacters(inspector.renderViewport(100, 16).join("\n"));
			assert.match(rendered, /Failed/);
			assert.match(rendered, /exit status unknown/i);
			assert.doesNotMatch(rendered, /Completed/);
		} finally {
			inspector.dispose();
		}
	} finally {
		setKeybindings(previousKeybindings);
	}
});

test.skipIf(process.platform === "win32")(
	"real Unix signal-killed background command reports failure across supervisor notice and board views",
	async () => {
		const host = new AgentTaskHost({
			scope: { kind: "session", sessionId: crypto.randomUUID() },
			authorizeLaunch() {},
		});
		onTestFinished(async () => {
			await host.close("session-close");
		});
		const { supervisor, owner } = host.ownerBinding;
		const started = await supervisor.startCommandTask(
			owner,
			{ kind: "command", command: "kill -TERM $$", terminal: { kind: "pipe" } },
			crypto.randomUUID() as OperationId,
		);
		assert.ok(started.ok);
		const settled = await supervisor.waitForTask(started.value, 10_000);
		assert.ok(settled.ok && settled.value.kind === "settled");
		assert.equal(settled.value.result.kind, "completed");
		assert.equal(settled.value.result.exitCode, undefined);

		const [shell] = host.taskRecords(new Set([settled.value.taskId]));
		assert.ok(shell);
		assert.equal(taskOutcomeStatus(settled.value.result, "command"), "failed");
		assert.equal(taskState(shell), "failed");
		assert.equal(taskBoardState(shell), "failed");

		const excerpt = await commandOutputExcerpt(host, started.value, shell);
		const env = makeEnvelope(settled.value.result, {
			ownerId: shell.ref.ownerId,
			taskId: shell.ref.taskId,
			taskKind: "command",
		});
		const notice = taskCompletionNotice(env, shell, excerpt.text, excerpt.omissions);
		assert.equal(notice.status, "failed");
		assert.equal(notice.line?.status, "failure");
		assert.equal(notice.line?.outcome, "failed (exit status unknown)");
		const text = formatTaskCompletion(env, shell, excerpt.text, excerpt.omissions);
		assert.match(text, /^Background shell failed:/);
		assert.match(text, /Exit status: unknown \(ended without an exit code\)/);
	},
);
