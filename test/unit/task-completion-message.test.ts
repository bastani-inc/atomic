import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { cancelReasonText } from "../../packages/coding-agent/src/core/tasks/cancel-reason.js";
import {
	formatTaskCompletion,
	type TaskCompletionEnvelope,
	taskCompletionEnvelope,
} from "../../packages/coding-agent/src/core/tasks/completion.js";
import type {
	CancelCause,
	Generation,
	Sequence,
	SettlementReceipt,
} from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { TaskCompletionMessage } from "../../packages/coding-agent/src/modes/interactive/components/task-completion-message.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { assertBackgroundFill } from "../helpers/background-fill.js";
import { taskRecord } from "../helpers/task-record.js";

const task = taskRecord("completion");
const envelope: TaskCompletionEnvelope = {
	completionId: "completion-fixture",
	ownerId: task.ref.ownerId,
	taskId: task.ref.taskId,
	terminalSequence: "7" as Sequence,
	result: { kind: "completed", output: task.output },
	display: false,
};

test("completion content is readable, bounded and leaves structured identity unchanged", () => {
	const before = JSON.stringify(envelope);
	const text = formatTaskCompletion(envelope, task, `Hello world\n${"x".repeat(9000)}`);
	assert.match(text, /Subagent .* completed/);
	assert.match(text, /Hello world/);
	assert.match(text, /Result excerpt truncated/);
	assert.doesNotMatch(text, /"completionId"|"terminalSequence"/);
	assert.ok(text.length < 9000);
	assert.equal(JSON.stringify(envelope), before);
});

test("restored and killed completions report only known context", () => {
	assert.match(formatTaskCompletion(envelope), /^Background task completed/);
	const stopped = formatTaskCompletion({ ...envelope, result: { kind: "cancelled", cause: "user" } }, task);
	assert.match(stopped, /killed \(non-resumable\)/);
	assert.match(stopped, /Stop reason: user/);
	assert.doesNotMatch(stopped, /completed|Result excerpt/);
});

const RESUMABLE_CHILD_ID = "quitrun:0";
const RESUMABLE_STOP_TITLES = {
	quit: /^Subagent worker quit · paused, awaiting resume: /,
	pause: /^Subagent worker paused · awaiting resume: /,
} as const;

test("a quit or paused subagent's notice says it is paused and resumable and names its resume call, never that it ended", () => {
	// A resumed child's launch operation carries a resume suffix; its resume call still names the child id.
	const resumedLaunch = { ...task, agentName: "worker", launchOperationId: `${RESUMABLE_CHILD_ID}:resume:uuid` };
	for (const cause of ["quit", "pause"] as const) {
		for (const launched of [{ ...task, agentName: "worker", launchOperationId: RESUMABLE_CHILD_ID }, resumedLaunch]) {
			const notice = formatTaskCompletion(
				{ ...envelope, result: { kind: "cancelled", cause } },
				launched as typeof task,
				"partial work",
			);
			assert.match(notice, RESUMABLE_STOP_TITLES[cause]);
			assert.match(notice, new RegExp(`Stop reason: ${cause}\\n`));
			assert.ok(notice.includes(`subagent({ action: "resume", id: "${RESUMABLE_CHILD_ID}" })`), notice);
			assert.match(notice, /partial work/);
			assert.doesNotMatch(notice, /This execution has ended|Do not restart it|parent-handoff|stopped/);
		}
	}
	const killed = formatTaskCompletion({ ...envelope, result: { kind: "cancelled", cause: "user" } }, task);
	assert.match(killed, /This execution has ended\. Do not restart it/);
});

test("a shell interrupted by a stage, run or session pause asks to redo the step (#3996)", () => {
	const shell = taskRecord("paused-shell", "command");
	const notice = formatTaskCompletion(
		{ ...envelope, result: { kind: "cancelled", cause: "pause" } },
		shell,
		"round 1",
	);
	assert.match(notice, /^Background shell interrupted by a pause: /);
	assert.match(notice, /Stop reason: pause\n/);
	assert.match(notice, /redo or continue the interrupted step/);
	assert.match(notice, /round 1/);
	assert.doesNotMatch(notice, /This execution has ended|Do not restart it|subagent\(|stopped/);
	// A user stop of the same shell keeps the ended-for-good wording.
	const stopped = formatTaskCompletion({ ...envelope, result: { kind: "cancelled", cause: "user" } }, shell);
	assert.match(stopped, /^Background shell stopped: /);
	assert.match(stopped, /This execution has ended\. Do not restart it/);
});

test("a shell its execution timeout stopped names the timeout's length and how to give it longer (#4639)", () => {
	const shell = taskRecord("timed-out-shell", "command");
	const notice = formatTaskCompletion(
		{ ...envelope, result: { kind: "cancelled", cause: "execution-timeout", executionTimeoutMs: 300_000 } },
		shell,
		"suite still running",
	);
	assert.match(notice, /^Background shell timed out after 300 seconds: /);
	assert.match(notice, /Stop reason: execution-timeout \(timed out after 300 seconds\)\n/);
	assert.match(
		notice,
		/Its execution timeout stopped it after 300 seconds, before it finished\. If its result is still needed, run it again with a larger timeout\.$/,
	);
	assert.doesNotMatch(notice, /Do not restart it/);
});

test.each([
	["session-close", "session closed"],
	["stage-close", "workflow stage closed"],
	["app-shutdown", "Atomic shut down"],
] as const)("a shell its owner's %s cancelled names that close (#4639)", (ownerClose, reason) => {
	const shell = taskRecord("owner-closed-shell", "command");
	const notice = formatTaskCompletion(
		{ ...envelope, result: { kind: "cancelled", cause: "owner-close", ownerClose } },
		shell,
	);
	assert.ok(notice.startsWith(`Background shell stopped (${reason}): `), notice);
	assert.ok(notice.includes(`Stop reason: owner-close (${reason})\n`), notice);
	assert.match(notice, /This execution has ended\./);
});

test("a shell its execution timeout stopped, with no recorded limit, still says the timeout stopped it (#4639)", () => {
	const shell = taskRecord("timed-out-shell", "command");
	const notice = formatTaskCompletion(
		{ ...envelope, result: { kind: "cancelled", cause: "execution-timeout" } },
		shell,
	);
	assert.match(notice, /^Background shell timed out: /);
	assert.match(
		notice,
		/Its execution timeout stopped it, before it finished\. If its result is still needed, run it again with a larger timeout\.$/,
	);
});

test("a shell stopped at the longest execution timeout is told to split its run (#4639)", () => {
	const shell = taskRecord("max-timeout-shell", "command");
	const notice = formatTaskCompletion(
		{ ...envelope, result: { kind: "cancelled", cause: "execution-timeout", executionTimeoutMs: 3_600_000 } },
		shell,
	);
	assert.match(notice, /^Background shell timed out after 3600 seconds: /);
	assert.match(
		notice,
		/Its execution timeout stopped it after 3600 seconds, before it finished\. If its result is still needed, 3600 seconds is the longest timeout; split a longer run into shorter commands\.$/,
	);
	const justBelow = formatTaskCompletion(
		{ ...envelope, result: { kind: "cancelled", cause: "execution-timeout", executionTimeoutMs: 3_599_000 } },
		shell,
	);
	assert.match(justBelow, /run it again with a larger timeout\.$/);
});

test("a finished task's notice names no stop reason (#4639)", () => {
	const shell = taskRecord("finished-shell", "command");
	const notice = formatTaskCompletion(
		{ ...envelope, result: { kind: "completed", output: shell.output, exitCode: 0 } },
		shell,
	);
	assert.match(notice, /^Background shell completed: /);
	assert.doesNotMatch(notice, /Stop reason|timed out|stopped/);
});

test.each<[CancelCause, string]>([
	["user", "stop requested"],
	["owner-close", "task owner closed"],
	["execution-timeout", "timed out"],
	["output-limit", "output limit reached"],
	["parent-handoff", "handed off"],
	["pause", "stopped by a pause"],
	["quit", "quit · paused · awaiting resume"],
	["shutdown", "Atomic shut down"],
])("a task cancelled for %s without recorded facts reads as %s (#4639)", (cause, text) => {
	assert.equal(cancelReasonText({ kind: "cancelled", cause }), text);
});

test("a cancellation names a close or a timeout only for its own cause (#4639)", () => {
	assert.equal(cancelReasonText({ kind: "cancelled", cause: "user", ownerClose: "stage-close" }), "stop requested");
	assert.equal(cancelReasonText({ kind: "cancelled", cause: "user", executionTimeoutMs: 5_000 }), "stop requested");
	assert.equal(
		cancelReasonText({ kind: "cancelled", cause: "owner-close", executionTimeoutMs: 5_000 }),
		"task owner closed",
	);
	assert.equal(
		cancelReasonText({ kind: "cancelled", cause: "execution-timeout", executionTimeoutMs: 2_500 }),
		"timed out after 2.5 seconds",
	);
});

test("a completion envelope names its task's kind only when it is known", () => {
	const receipt: SettlementReceipt = {
		taskId: envelope.taskId,
		cursor: { generation: "1" as Generation, sequence: "7" as Sequence },
		result: { kind: "cancelled", cause: "user" },
		completionId: "completion-fixture",
	};
	const unknown = taskCompletionEnvelope(envelope.ownerId, receipt);
	assert.equal("taskKind" in unknown, false);
	assert.deepEqual(unknown, { ...envelope, result: receipt.result });
	assert.deepEqual(taskCompletionEnvelope(envelope.ownerId, receipt, "command"), {
		...envelope,
		result: receipt.result,
		taskKind: "command",
	});
});

test("completion cards shade their full width with chat-card padding in both themes", () => {
	for (const mode of ["dark", "light"] as const) {
		initTheme(mode);
		for (const status of ["completed", "failed", "cancelled"] as const) {
			const notice = { title: `Reviewer ${status}`, preview: "A useful result", status, taskId: "task-card" };
			for (const expanded of [false, true]) {
				const card = new TaskCompletionMessage(notice, expanded);
				for (const width of [1, 2, 24, 48, 100]) {
					const rows = card.render(width);
					assert.ok(rows.every((line) => visibleWidth(line) === width));
					assert.equal(rows[0], theme.bg("customMessageBg", " ".repeat(width)));
					assert.equal(rows.at(-1), rows[0]);
					const background = rows[0].match(/\x1b\[[0-9;]+m/)?.[0];
					assert.ok(background);
					assert.ok(
						rows.every((line) => line.includes(background)),
						"all card rows carry the background",
					);
					if (width >= 48) {
						assert.match(stripVTControlCharacters(rows[1]), /^ [✓✗] Reviewer/);
						assert.match(rows.map(stripVTControlCharacters).join("\n"), /A useful result/);
					}
				}
			}
		}
	}
});

test.each([
	{
		label: "subagent",
		title: `Subagent codebase-analyzer completed: <keepContext>Read-only, no edits/workflows. ${"界".repeat(80)}`,
	},
	{
		label: "shell",
		title: "Background shell completed: git status --short; git diff --check && git add packages/coding-agent/CHANGELOG.md packages/workflows/CHANGELOG.md packages/coding-agent/docs/background-tasks.md",
	},
])("$label completion titles, wrapped Markdown and expand hints keep every card cell shaded", async ({ title }) => {
	for (const mode of ["dark", "light"] as const) {
		initTheme(mode);
		const notice = {
			title,
			preview:
				"## Analysis: Task UI retention\n\n**Current behavior is persistent retention, not stale-task expiry.** " +
				"Long result text. ".repeat(50),
			status: "completed" as const,
			taskId: "long-task-identity".repeat(12),
		};
		for (const expanded of [false, true]) {
			for (const width of [12, 48, 80, 120]) {
				await assertBackgroundFill(
					new TaskCompletionMessage(notice, expanded).render(width),
					width,
					theme.getBgAnsi("customMessageBg"),
				);
			}
		}
	}
});
