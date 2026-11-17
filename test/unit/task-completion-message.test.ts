import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { setKeybindings, visibleWidth } from "@bastani/atomic-tui";
import { test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { cancelReasonText } from "../../packages/coding-agent/src/core/tasks/cancel-reason.js";
import {
	formatTaskCompletion,
	isResumableStop,
	type TaskCompletionEnvelope,
	taskCompletionEnvelope,
	taskCompletionNotice,
} from "../../packages/coding-agent/src/core/tasks/completion.js";
import type {
	CancelCause,
	Generation,
	Sequence,
	SettlementReceipt,
} from "../../packages/coding-agent/src/core/tasks/contracts.js";
import {
	completionNoticeFromDetails,
	TaskCompletionMessage,
} from "../../packages/coding-agent/src/modes/interactive/components/task-completion-message.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { taskRecord } from "../helpers/task-record.js";

setKeybindings(new KeybindingsManager());

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

test("a subagent released while it waits is reported as released and waking by itself, while a pause keeps its pause notice (#5031)", () => {
	const launched = { ...task, agentName: "worker", launchOperationId: RESUMABLE_CHILD_ID } as typeof task;
	const released = formatTaskCompletion(
		{
			...envelope,
			result: {
				kind: "cancelled",
				cause: "pause",
				released: { waitingOn: [{ toolCallId: "toolu-7", toolName: "bash" }] },
			},
		},
		launched,
		"waiting on the build",
	);
	assert.match(released, /^Subagent worker released while waiting on bash \(toolu-7\): /);
	assert.match(released, /Stop reason: released\n/);
	assert.match(released, /it wakes by itself when that finishes/);
	assert.match(released, /waiting on the build/);
	assert.doesNotMatch(released, /paused|awaiting resume|resume|Stop reason: pause|This execution has ended/);

	// Each call it waits on is named; a release that names none still reads as one, also without a task record.
	const releasedOn = (waitingOn: Array<{ toolCallId: string; toolName: string }>) =>
		formatTaskCompletion({ ...envelope, result: { kind: "cancelled", cause: "pause", released: { waitingOn } } });
	assert.match(
		releasedOn([
			{ toolCallId: "toolu-7", toolName: "bash" },
			{ toolCallId: "ask-2", toolName: "intercom" },
		]),
		/^Background task released while waiting on bash \(toolu-7\), intercom \(ask-2\)\./,
	);
	assert.match(releasedOn([]), /^Background task released while waiting on a tool call\./);
	assert.doesNotMatch(releasedOn([]), /pause/);
	assert.equal(
		isResumableStop({ kind: "cancelled", cause: "pause", released: { waitingOn: [] } }),
		false,
		"a release is not a resumable stop",
	);
	assert.equal(isResumableStop({ kind: "completed", output: task.output }), false);

	const paused = formatTaskCompletion({ ...envelope, result: { kind: "cancelled", cause: "pause" } }, launched);
	assert.match(paused, RESUMABLE_STOP_TITLES.pause);
	assert.match(paused, /Stop reason: pause\n/);
	assert.ok(paused.includes(`subagent({ action: "resume", id: "${RESUMABLE_CHILD_ID}" })`), paused);
	assert.doesNotMatch(paused, /released/);
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

test("a finished task's notice is one unshaded notice line at 80 and 160 columns, in both themes", () => {
	for (const mode of ["dark", "light"] as const) {
		initTheme(mode);
		const shell = taskCompletionNotice(
			{ ...envelope, result: { kind: "completed", output: task.output, exitCode: 0 } },
			{
				kind: "command",
				title: "Print six ticks spaced 30 seconds apart",
				agentName: undefined,
				model: undefined,
				thinking: undefined,
				metrics: { elapsedMs: 182_000 },
			},
			"tick 1\ntick 2\ntick 3\ntick 4",
		);
		for (const [width, text] of [
			[160, '● Background command "Print six ticks spaced 30 seconds apart" completed (exit code 0) · 3m 2s'],
			[80, '● Background command "Print six ticks spaced 3…" completed (exit code 0) · 3m 2s'],
		] as const) {
			const rows = new TaskCompletionMessage(shell, false).render(width);
			assert.deepEqual(
				rows.map((row) => stripVTControlCharacters(row)),
				[text],
			);
			assert.ok(rows.every((row) => visibleWidth(row) <= width));
			assert.ok(!rows[0]!.includes(theme.getBgAnsi("customMessageBg")), "no card shading");
			assert.ok(rows[0]!.startsWith(theme.fg("success", "●")));
		}
		const expanded = new TaskCompletionMessage(shell, true).render(80).map((row) => stripVTControlCharacters(row));
		assert.deepEqual(expanded.slice(1), ["  ⎿  tick 1", "     tick 2", "     tick 3", "     tick 4"]);
	}
});

test.each([
	{
		result: { kind: "failed", code: "exit", message: "exit 1", exitCode: 1 },
		line: /^✗ Background command "npm test" failed \(exit code 1\)/,
	},
	{ result: { kind: "cancelled", cause: "user" }, line: /^◼ Task "npm test" was stopped by the user$/ },
	{
		result: { kind: "cancelled", cause: "execution-timeout", executionTimeoutMs: 300_000 },
		line: /^! Background command "npm test" timed out after 300 seconds$/,
	},
	{
		result: { kind: "cancelled", cause: "owner-close", ownerClose: "stage-close" },
		line: /^◼ Background command "npm test" was stopped \(workflow stage closed\)$/,
	},
] as const)("a shell notice reads how it ended: $line", ({ result, line }) => {
	initTheme("dark");
	const notice = taskCompletionNotice(
		{ ...envelope, result: result as TaskCompletionEnvelope["result"] },
		{
			kind: "command",
			title: "npm test",
			agentName: undefined,
			model: undefined,
			thinking: undefined,
		},
	);
	const [row] = new TaskCompletionMessage(notice, false).render(120);
	assert.match(stripVTControlCharacters(row!), line);
});

test("notices joined in one message show one line each", () => {
	initTheme("dark");
	const first = taskCompletionNotice(
		{ ...envelope, result: { kind: "completed", output: task.output, exitCode: 0 } },
		{ kind: "command", title: "build", agentName: undefined, model: undefined, thinking: undefined },
	);
	const second = taskCompletionNotice(
		{ ...envelope, result: { kind: "cancelled", cause: "user" } },
		{ kind: "command", title: "sleep 300", agentName: undefined, model: undefined, thinking: undefined },
	);
	const rows = new TaskCompletionMessage([first, second], false)
		.render(100)
		.map((row) => stripVTControlCharacters(row));
	assert.deepEqual(rows, [
		'● Background command "build" completed (exit code 0)',
		"",
		'◼ Task "sleep 300" was stopped by the user',
	]);
});

test("a subagent's completion notice shows its result's headline and keeps the rest behind expand (#5224)", () => {
	initTheme("dark");
	const notice = {
		title: "Subagent worker completed: inspect the sandbox",
		preview: "PR #5221 open: atomic lock creation\nsecond line\nthird line\nfourth line",
		taskId: "task-1",
		status: "completed" as const,
		model: "anthropic/claude-haiku-4-5",
	};
	const collapsed = stripVTControlCharacters(new TaskCompletionMessage(notice, false).render(100).join("\n"));
	assert.match(collapsed, /⎿ {2}PR #5221 open: atomic lock creation/);
	assert.doesNotMatch(collapsed, /second line/);
	assert.match(collapsed, /\(ctrl\+o for the full result\)/);
	assert.doesNotMatch(collapsed, /\/tasks to inspect|claude-haiku/, "no model line or /tasks hint (#5224 mockup)");
	const expanded = stripVTControlCharacters(new TaskCompletionMessage(notice, true).render(100).join("\n"));
	assert.match(expanded, /fourth line/);
	const { model: _model, ...withoutModel } = notice;
	const shell = { ...withoutModel, title: "Background shell completed", taskKind: "command" as const };
	const shellText = stripVTControlCharacters(new TaskCompletionMessage(shell, false).render(100).join("\n"));
	assert.doesNotMatch(shellText, /fourth line|PR #5221/, "a shell's notice is one line until expanded");
	const shellExpanded = stripVTControlCharacters(new TaskCompletionMessage(shell, true).render(100).join("\n"));
	assert.match(shellExpanded, /fourth line/);
});

test.each([20, 80, 160])("expanded agent notices show every retained result line at width %i (#5342)", (width) => {
	initTheme("dark");
	const output = Array.from({ length: 100 }, (_, index) => `finding ${index + 1}`).join("\n");
	const notice = taskCompletionNotice(envelope, { kind: "agent", title: "review" }, output);
	assert.equal(notice.preview, output);
	const rows = new TaskCompletionMessage(notice, true).render(width);
	const expanded = rows.map((row) => stripVTControlCharacters(row)).join("\n");
	for (let index = 1; index <= 100; index++) assert.match(expanded, new RegExp(`finding ${index}(?:\\n|$)`));
	assert.ok(rows.every((row) => visibleWidth(row) <= width));
});

test("expanded agent results also retain text beyond 40 soft wraps (#5342)", () => {
	initTheme("dark");
	const output = `${"z".repeat(7900)} final-result`;
	const notice = taskCompletionNotice(envelope, { kind: "agent", title: "review" }, output);
	const rows = new TaskCompletionMessage(notice, true).render(20).map(stripVTControlCharacters);
	const result = rows
		.slice(1)
		.map((row) => row.slice(5))
		.join("");
	assert.equal(result.replace(/\s/g, ""), output.replace(/\s/g, ""));
});

test("completion notices distinguish agents without model metadata from shell output tails (#5243)", () => {
	initTheme("dark");
	const preview = Array.from({ length: 10 }, (_, index) => `line${index + 1}`).join("\n");
	const agent = taskCompletionNotice(envelope, { kind: "agent", title: "worker" }, preview);
	const agentText = stripVTControlCharacters(new TaskCompletionMessage(agent, false).render(100).join("\n"));
	assert.match(agentText, /⎿ {2}line1\s/);
	assert.doesNotMatch(agentText, /line2/);
	const restored = completionNoticeFromDetails({ notification: agent });
	assert.ok(restored);
	assert.equal(restored.taskKind, "agent");
	assert.equal(
		new TaskCompletionMessage(restored, false).render(100).join("\n"),
		new TaskCompletionMessage(agent, false).render(100).join("\n"),
	);
	const shell = taskCompletionNotice({ ...envelope, taskKind: "command" }, undefined, preview);
	const shellText = stripVTControlCharacters(new TaskCompletionMessage(shell, false).render(100).join("\n"));
	assert.doesNotMatch(shellText, /line/, "a shell's notice is one line until expanded");
	const shellExpanded = stripVTControlCharacters(new TaskCompletionMessage(shell, true).render(100).join("\n"));
	assert.match(shellExpanded, /line10/);
	const longShell = taskCompletionNotice(
		{ ...envelope, taskKind: "command" },
		undefined,
		`${"earlier output\n".repeat(1_000)}${preview}`,
	);
	assert.ok(longShell.preview.length <= 8_000);
	assert.match(stripVTControlCharacters(new TaskCompletionMessage(longShell, true).render(100).join("\n")), /line10/);
});
