import assert from "node:assert/strict";
import { setKeybindings, Text, visibleWidth } from "@bastani/atomic-tui";
import { onTestFinished, test, vi } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import { cancelReasonText } from "../../packages/coding-agent/src/core/tasks/cancel-reason.js";
import {
	formatTaskCompletion,
	isResumableStop,
	type TaskCompletionEnvelope,
	taskCompletionEnvelope,
	taskCompletionNotice,
} from "../../packages/coding-agent/src/core/tasks/completion.js";
import {
	commandOutputExcerpt,
	taskCompletionMessage,
} from "../../packages/coding-agent/src/core/tasks/completion-message.js";
import type {
	CancelCause,
	Generation,
	OperationId,
	Sequence,
	SettlementReceipt,
	TaskId,
} from "../../packages/coding-agent/src/core/tasks/contracts.js";
import {
	loadTaskOwnTranscriptEntries,
	loadTaskOwnTranscriptHistory,
} from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import {
	completionNoticeFromDetails,
	TaskCompletionMessage,
} from "../../packages/coding-agent/src/modes/interactive/components/task-completion-message.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import {
	renderContactSupervisorCall,
	renderContactSupervisorResult,
	renderIntercomCall,
	renderIntercomResult,
} from "../../packages/intercom/result-renderers.js";
import { taskRecord } from "../helpers/task-record.js";
import { stripVTControlCharacters } from "../helpers/visible-text.ts";

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

test("writing a completed command does not copy an ordinary subject through a buffer (#5690)", () => {
	const title = "npm run test:isolated -- ".repeat(8);
	const command = { ...taskRecord("completion", "command"), title };
	const from = vi.spyOn(Buffer, "from");
	try {
		const message = taskCompletionMessage(
			{ ...envelope, taskKind: "command", result: { kind: "completed", output: command.output, exitCode: 0 } },
			command,
			undefined,
		);
		assert.equal(completionNoticeFromDetails(message.details)?.line?.subject, title);
		assert.equal(from.mock.calls.filter(([input]) => input === title).length, 0);
	} finally {
		from.mockRestore();
	}
});

async function shellCompletion(expression: string) {
	const host = new AgentTaskHost({ scope: { kind: "session", sessionId: crypto.randomUUID() }, authorizeLaunch() {} });
	onTestFinished(async () => {
		await host.close("session-close");
	});
	const { supervisor, owner } = host.ownerBinding;
	const started = await supervisor.startCommandTask(
		owner,
		{ kind: "command", command: `node -e "process.stdout.write(${expression})"`, terminal: { kind: "pipe" } },
		crypto.randomUUID() as OperationId,
	);
	assert.ok(started.ok);
	const settled = await supervisor.waitForTask(started.value, 10_000);
	assert.ok(settled.ok && settled.value.kind === "settled");
	const [shell] = host.taskRecords(new Set([settled.value.taskId]));
	assert.ok(shell);
	return taskCompletionMessage(
		{ ...envelope, taskId: shell.ref.taskId, ownerId: shell.ref.ownerId, result: settled.value.result },
		shell,
		await commandOutputExcerpt(host, started.value, shell),
	);
}

test.each([
	["emoji", "\\u{1f600}", 212],
	["accented letter", "e\\u0301", 213],
] as const)("the saved shell excerpt ends before a cut %s (#5654)", async (_name, cluster, padding) => {
	const message = await shellCompletion(`'\\u65e5'+'x'.repeat(7974)+'${cluster}'+'y'.repeat(${padding})`);
	assert.match(message.content, /\[Earlier output omitted\]\nx{7974}\n\[Result excerpt truncated\]/);
});

test("the expanded shell preview omits the whole earlier-output label when only its end fits (#5654)", async () => {
	initTheme("dark");
	const message = await shellCompletion("'\\u65e5'.repeat(97)+'x'.repeat(7902)");
	const notice = completionNoticeFromDetails(message.details);
	assert.ok(notice);
	const rows = new TaskCompletionMessage(notice, true).render(80).map(stripVTControlCharacters);
	assert.match(rows[1]!, /⎿ {2}日/);
	assert.equal(notice.preview, "日".repeat(96) + "x".repeat(7902));
});

test("the shell preview preserves literal output that looks like an omission label (#5654)", async () => {
	const message = await shellCompletion("'[Earlier output omitted]\\n'+'x'.repeat(7998)");
	const notice = completionNoticeFromDetails(message.details);
	assert.ok(notice);
	assert.equal(notice.preview, "]\n" + "x".repeat(7998));
});

test("the shell preview starts after a whole accented letter at its tail limit (#5654)", async () => {
	const message = await shellCompletion("'\\u65e5'+'x'.repeat(188)+'e\\u0301'+'y'.repeat(7999)");
	const notice = completionNoticeFromDetails(message.details);
	assert.ok(notice);
	assert.equal(notice.preview, "y".repeat(7999));
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

const FINISHED_CHILD_ID = "a760c0ec:0";
const finishedResumeCall = (id: string) =>
	`Resume it with subagent({ action: "resume", id: "${id}", message: "…" }) to continue it with a follow-up.`;

test("a finished subagent's notice names its resume call and still says not to restart it for its result", () => {
	const launched = { ...task, agentName: "worker", launchOperationId: FINISHED_CHILD_ID } as typeof task;
	// A resumed child's launch operation carries a resume suffix; its resume call still names the child id.
	const resumed = { ...launched, launchOperationId: `${FINISHED_CHILD_ID}:resume:uuid` } as typeof task;
	const results: TaskCompletionEnvelope["result"][] = [
		{ kind: "completed", output: task.output },
		{ kind: "failed", code: "AgentFailed", message: "model refused", output: task.output },
	];
	for (const result of results) {
		for (const record of [launched, resumed]) {
			const notice = formatTaskCompletion({ ...envelope, result }, record, "the answer");
			assert.ok(notice.includes(finishedResumeCall(FINISHED_CHILD_ID)), notice);
			assert.match(notice, /This execution has ended\. Do not restart it merely to retrieve its result\./);
			assert.match(notice, /The user can inspect retained output with \/tasks\.$/);
		}
		// A notice restored without its task record names the task id, which resume also accepts.
		const restored = formatTaskCompletion({ ...envelope, result, taskKind: "agent" });
		assert.ok(restored.includes(finishedResumeCall(envelope.taskId)), restored);
	}
	// The child's Intercom name, when the notice has it, is the name it takes messages under once resumed.
	const named = taskCompletionMessage(
		{ ...envelope, result: { kind: "completed", output: task.output } },
		launched,
		"the answer",
		"subagent-worker-a760c0ec-0",
	);
	assert.ok(named.content.includes(finishedResumeCall(FINISHED_CHILD_ID)), named.content);
	assert.match(named.content, /Once resumed, it takes Intercom messages again as subagent-worker-a760c0ec-0\./);

	// A child killed for good, a shell, and a task of unknown kind name no resume call.
	const killed = formatTaskCompletion({ ...envelope, result: { kind: "cancelled", cause: "user" } }, launched);
	const shell = formatTaskCompletion(
		{ ...envelope, result: { kind: "completed", output: task.output, exitCode: 0 } },
		taskRecord("finished-shell", "command"),
	);
	const unknown = formatTaskCompletion({ ...envelope, result: { kind: "completed", output: task.output } });
	for (const notice of [killed, shell, unknown]) {
		assert.doesNotMatch(notice, /subagent\(|Resume it|Intercom/, notice);
		assert.match(
			notice,
			/\n\nThis execution has ended\. Do not restart it merely to retrieve its result\. The user can inspect retained output with \/tasks\.$/,
		);
	}
});

test("a resumable subagent's card keeps its line and shows the id its notice names only when expanded", () => {
	initTheme("dark");
	const launched = {
		...task,
		agentName: "worker",
		launchOperationId: `${FINISHED_CHILD_ID}:resume:uuid`,
	} as typeof task;
	const card = (result: TaskCompletionEnvelope["result"], record?: typeof task) =>
		completionNoticeFromDetails(
			JSON.parse(JSON.stringify(taskCompletionMessage({ ...envelope, result }, record, "the answer").details)),
		);
	const completed = card({ kind: "completed", output: task.output }, launched);
	const paused = card({ kind: "cancelled", cause: "pause" }, launched);
	assert.equal(completed?.resumeId, FINISHED_CHILD_ID);
	assert.equal(paused?.resumeId, FINISHED_CHILD_ID);
	assert.equal(card({ kind: "completed", output: task.output })?.resumeId, undefined, "unknown kind");
	assert.equal(card({ kind: "cancelled", cause: "user" }, launched)?.resumeId, undefined, "killed");
	for (const result of [
		{ kind: "completed", output: task.output, exitCode: 0 },
		{ kind: "cancelled", cause: "quit" },
	] as const)
		assert.equal(card(result, taskRecord("shell", "command"))?.resumeId, undefined, `shell ${result.kind}`);
	assert.equal(card({ kind: "cancelled", cause: "quit" })?.resumeId, undefined, "a quit task of unknown kind");
	assert.ok(completed);
	// A notice saved before it carried the id renders as it always did, collapsed and expanded.
	const { resumeId: _id, ...saved } = completed;
	const rows = (notice: typeof completed, expanded: boolean) =>
		new TaskCompletionMessage(notice, expanded).render(100).map((row) => stripVTControlCharacters(row));
	assert.deepEqual(rows(completed, false), rows(saved, false));
	assert.deepEqual(rows(completed, true), [
		rows(saved, true)[0],
		`   resume id ${FINISHED_CHILD_ID}`,
		...rows(saved, true).slice(1),
	]);
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
		/Its execution timeout stopped it after 300 seconds, before it finished\. If its result is still needed, run it again with a larger timeout, or with none so it runs until it finishes\.$/,
	);
	assert.doesNotMatch(notice, /Do not restart it/);
});

test.each([
	["session-close", "session closed"],
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
		/Its execution timeout stopped it, before it finished\. If its result is still needed, run it again with a larger timeout, or with none so it runs until it finishes\.$/,
	);
});

test("a shell a day-long timeout stopped is not told to split its run: a timeout has no maximum (#4639)", () => {
	const notice = formatTaskCompletion(
		{ ...envelope, result: { kind: "cancelled", cause: "execution-timeout", executionTimeoutMs: 86_400_000 } },
		taskRecord("day-timeout-shell", "command"),
	);
	assert.match(notice, /^Background shell timed out after 86400 seconds: /);
	assert.match(
		notice,
		/Its execution timeout stopped it after 86400 seconds, before it finished\. If its result is still needed, run it again with a larger timeout, or with none so it runs until it finishes\.$/,
	);
	assert.doesNotMatch(notice, /split/);
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
	assert.equal(cancelReasonText({ kind: "cancelled", cause: "user", ownerClose: "session-close" }), "stop requested");
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
	vi.stubEnv("NO_COLOR", undefined);
	onTestFinished(() => {
		vi.unstubAllEnvs();
	});
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
			[160, ' ● Background command "Print six ticks spaced 30 seconds apart" completed (exit code 0) · 3m 2s'],
			[80, ' ● Background command "Print six ticks spaced …" completed (exit code 0) · 3m 2s'],
		] as const) {
			const rows = new TaskCompletionMessage(shell, false).render(width);
			assert.deepEqual(
				rows.map((row) => stripVTControlCharacters(row)),
				[text],
			);
			assert.ok(rows.every((row) => visibleWidth(row) <= width));
			assert.ok(!rows[0]!.includes(theme.getBgAnsi("customMessageBg")), "no card shading");
			assert.ok(rows[0]!.startsWith(` ${theme.fg("success", "●")}`));
		}
		const expanded = new TaskCompletionMessage(shell, true).render(80).map((row) => stripVTControlCharacters(row));
		assert.deepEqual(expanded.slice(1), ["   ⎿  tick 1", "      tick 2", "      tick 3", "      tick 4"]);
	}
});

test.each([
	{
		result: { kind: "failed", code: "exit", message: "exit 1", exitCode: 1 },
		line: /^ ✗ Background command "npm test" failed \(exit code 1\)/,
	},
	{ result: { kind: "cancelled", cause: "user" }, line: /^ ◯ Task "npm test" was stopped by the user$/ },
	{
		result: { kind: "cancelled", cause: "execution-timeout", executionTimeoutMs: 300_000 },
		line: /^ ◯ Background command "npm test" timed out after 300 seconds$/,
	},
	{
		result: { kind: "cancelled", cause: "owner-close", ownerClose: "session-close" },
		line: /^ ◯ Background command "npm test" was stopped \(session closed\)$/,
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
		' ● Background command "build" completed (exit code 0)',
		"",
		' ◯ Task "sleep 300" was stopped by the user',
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
	assert.match(collapsed, /^ ● worker finished$/m);
	assert.match(collapsed, /⎿ {2}PR #5221 open: atomic lock creation/);
	assert.doesNotMatch(collapsed, /second line|inspect the sandbox/);
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

test("agent completion notices render agent-name finished/failed/stopped with elapsed time and first plain result row (#5350)", () => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
	const finished = taskCompletionNotice(
		envelope,
		{
			kind: "agent",
			title: "#5220 spawn lock",
			agentName: "debugger",
			model: "anthropic/claude-haiku-4-5",
			thinking: "low",
			metrics: { elapsedMs: 5_460_000 },
		},
		"PR #5221 open: atomic lock creation, 4 race tests red-first\ndetailed body line 2",
	);
	const failed = taskCompletionNotice(
		{ ...envelope, result: { kind: "failed", code: "AgentFailed", message: "Lock contention reproduced" } },
		{
			kind: "agent",
			title: "#5220 spawn lock",
			agentName: "debugger",
			model: undefined,
			thinking: undefined,
			metrics: { elapsedMs: 120_000 },
		},
		"",
	);
	const stopped = taskCompletionNotice(
		{ ...envelope, result: { kind: "cancelled", cause: "user" } },
		{
			kind: "agent",
			title: "#5220 spawn lock",
			agentName: "debugger",
			model: undefined,
			thinking: undefined,
			metrics: { elapsedMs: 12_000 },
		},
		"",
	);

	for (const width of [80, 160]) {
		const finishedRows = new TaskCompletionMessage(finished, false).render(width);
		assert.deepEqual(
			finishedRows.map((row) => stripVTControlCharacters(row)),
			[
				" ● debugger finished · 1h 31m",
				"   ⎿  PR #5221 open: atomic lock creation, 4 race tests red-first",
				"      (ctrl+o for the full result)",
			],
		);
		assert.ok(finishedRows.every((row) => visibleWidth(row) <= width));
		assert.ok(!finishedRows.join("").includes("\u001b[48;"));
	}

	const narrowFinished = new TaskCompletionMessage(finished, false).render(24);
	assert.ok(narrowFinished.every((row) => visibleWidth(row) <= 24));
	assert.match(stripVTControlCharacters(narrowFinished[1]!), /^ {3}⎿ {2}PR #5221.*…$/);

	assert.deepEqual(
		new TaskCompletionMessage(failed, false).render(80).map((row) => stripVTControlCharacters(row)),
		[" ✗ debugger failed · 2m 0s", "   ⎿  Lock contention reproduced"],
	);
	assert.deepEqual(
		new TaskCompletionMessage(stopped, false).render(80).map((row) => stripVTControlCharacters(row)),
		[" ◯ debugger stopped · 12s"],
	);

	setKeybindings(new KeybindingsManager({ "app.tools.expand": "ctrl+e" }));
	assert.match(
		stripVTControlCharacters(new TaskCompletionMessage(finished, false).render(80).join("\n")),
		/\(ctrl\+e for the full result\)/,
	);
	setKeybindings(new KeybindingsManager({ "app.tools.expand": [] }));
	assert.doesNotMatch(
		stripVTControlCharacters(new TaskCompletionMessage(finished, false).render(80).join("\n")),
		/for the full result/,
	);
	setKeybindings(new KeybindingsManager());
});

function agentNotice(preview: string) {
	return taskCompletionNotice(
		envelope,
		{ kind: "agent", title: "review", agentName: "debugger", metrics: { elapsedMs: 395_000 } },
		preview,
	);
}

test.each([80, 160])(
	"an agent's result preview shows its Markdown styled, never its markers, at %i columns",
	(width) => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const muted = theme.fg("muted", "\0").split("\0")[0]!;
		const bold = theme.bold("\0").split("\0")[0]!;
		const previews: readonly (readonly [string, string])[] = [
			[
				"**Medium — pending selection survives a scope reset**\nScope reset keeps the old identity.",
				"Medium — pending selection survives a scope reset",
			],
			[
				"Use `prepareSessionClaim`, see [the claim docs](https://example.com/claims) and **retry**.",
				"Use prepareSessionClaim, see the claim docs and retry.",
			],
			["## Findings\n\nOne medium.", "Findings"],
			["### Deep heading\n\nbody", "Deep heading"],
			["```ts\nconst claim = await prepare();\n```", "const claim = await prepare();"],
		];
		for (const [preview, firstRow] of previews) {
			const rows = new TaskCompletionMessage(agentNotice(preview), false).render(width);
			assert.equal(stripVTControlCharacters(rows[1]!), `   ⎿  ${firstRow}`, preview);
			assert.ok(
				rows.every((row) => visibleWidth(row) <= width),
				preview,
			);
			assert.doesNotMatch(stripVTControlCharacters(rows.join("\n")), /\*\*|`|\]\(|^ *#/m, preview);
			assert.ok(rows[1]!.includes(muted), `${preview}: muted tone`);
		}
		const [, headline] = new TaskCompletionMessage(agentNotice(previews[0]![0]), false).render(width);
		assert.ok(headline!.includes(`${bold}${muted}Medium`), "bold stays bold within the muted tone");
		const expanded = new TaskCompletionMessage(
			agentNotice("**Medium** finding with `code`\n\n- first\n- second"),
			true,
		)
			.render(width)
			.map((row) => stripVTControlCharacters(row));
		// Expanded, the card names the id its resume call takes under its line, before the result.
		assert.equal(expanded[1], "   resume id completion");
		assert.equal(expanded[2], "   ⎿  Medium finding with code");
		assert.doesNotMatch(expanded.join("\n"), /\*\*|`/);
		assert.ok(expanded.some((row) => /first$/.test(row)) && expanded.some((row) => /second$/.test(row)));
	},
);

test("an agent's Markdown result preview is plain text under NO_COLOR", () => {
	vi.stubEnv("NO_COLOR", "1");
	onTestFinished(() => {
		vi.unstubAllEnvs();
	});
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
	const notice = agentNotice("**Medium** `claim` [docs](https://example.com/d)\nmore");
	for (const expanded of [false, true]) {
		const rows = new TaskCompletionMessage(notice, expanded).render(80);
		assert.deepEqual(rows, rows.map(stripVTControlCharacters), `expanded=${expanded}`);
		assert.equal(
			rows[expanded ? 2 : 1],
			expanded ? "   ⎿  Medium claim docs (https://example.com/d)" : "   ⎿  Medium claim docs",
			`expanded=${expanded}`,
		);
	}
});

test("a styled result preview cut to the width keeps within it and closes its styles", () => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
	const notice = agentNotice(`**${"pending selection survives a scope reset ".repeat(5).trim()}** then \`code\``);
	for (const width of [24, 40, 80]) {
		const [, row] = new TaskCompletionMessage(notice, false).render(width);
		assert.ok(visibleWidth(row!) <= width, `width ${width}`);
		assert.match(stripVTControlCharacters(row!), /^ {3}⎿ {2}pending selection.*…$/);
		assert.doesNotMatch(stripVTControlCharacters(row!), /\*/);
		assert.ok(row!.endsWith("\u001b[0m"), `width ${width}: styles closed`);
	}
});

test("a result preview whose first row holds a very long token is cut with an ellipsis, not wrapped before it", () => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
	const long = agentNotice(`**Intro ${"X".repeat(2000)}**`);
	const softBreak = agentNotice("**Bold that runs\nonto a second line**");
	for (const width of [24, 80]) {
		const [, cut] = new TaskCompletionMessage(long, false).render(width);
		assert.ok(visibleWidth(cut!) <= width, `width ${width}`);
		assert.match(stripVTControlCharacters(cut!), /^ {3}⎿ {2}Intro X+…$/, `width ${width}`);
		assert.ok(cut!.endsWith("\u001b[0m"), `width ${width}: styles closed`);
		const [, open] = new TaskCompletionMessage(softBreak, false).render(width);
		assert.equal(stripVTControlCharacters(open!), "   ⎿  Bold that runs", `width ${width}`);
		assert.ok(open!.endsWith("\u001b[0m"), `width ${width}: a row that fits closes its styles too`);
	}
});

test("agent completion previews emit no colour under NO_COLOR, like their notice line", async () => {
	vi.stubEnv("NO_COLOR", "1");
	onTestFinished(() => {
		vi.unstubAllEnvs();
	});
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
	const notice = taskCompletionNotice(
		envelope,
		{ kind: "agent", title: "review", agentName: "debugger", metrics: { elapsedMs: 12_000 } },
		"first finding\nsecond finding",
	);
	for (const expanded of [false, true]) {
		const rows = new TaskCompletionMessage(notice, expanded).render(80);
		assert.ok(rows.length > 1, `expanded=${expanded}: preview rows`);
		assert.deepEqual(rows, rows.map(stripVTControlCharacters), `expanded=${expanded}`);
	}
	let rendered = 0;
	const loaded = new TaskCompletionMessage(notice, true, {
		loadTranscript: () =>
			[{ type: "message", message: { role: "user", content: "Fix **the lock**", timestamp: 1 } }] as never,
		requestRender: () => {
			rendered += 1;
		},
	});
	loaded.render(80);
	for (let i = 0; i < 20 && rendered === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
	const transcriptRows = loaded.render(80);
	assert.match(transcriptRows.join("\n"), /Prompt[\s\S]*the lock[\s\S]*Tool calls[\s\S]*Result/);
	assert.deepEqual(transcriptRows, transcriptRows.map(stripVTControlCharacters), "loaded transcript");
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
	// The line, then the id its resume call takes, then the result.
	const result = rows
		.slice(2)
		.map((row) => row.slice(6))
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

test("agent completion notice with settled getEntries()=>[] loads Prompt, Tool calls, and Result asynchronously via loadHistory and releases cache on collapse (#5350)", async () => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
	const store = new MemorySessionStore();
	const childSession = await SessionManager.create(store, process.cwd());
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	await childSession.appendMessage({ role: "user", content: "Inherited fork message", timestamp: 1 });
	await childSession.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: "inherited-call", name: "edit", arguments: { path: "inherited.ts" } }],
		api: "test",
		provider: "test",
		model: "test",
		usage,
		stopReason: "toolUse",
		timestamp: 2,
	});
	const inheritedSnapshot = [...childSession.getEntries()];
	let loadCount = 0;
	const host = new AgentTaskHost({ scope: { kind: "session", sessionId: "notice-tx-session" }, authorizeLaunch() {} });
	try {
		const started = await host.startAgentTask(
			{ kind: "agent", agent: "debugger", task: "#5220 spawn lock", cwd: process.cwd() },
			"op-notice-tx" as OperationId,
			(context) => {
				context.bindTranscript({
					getSessionId: () => childSession.getSessionId(),
					getEntries: () => inheritedSnapshot,
				});
				return {
					result: (async () => {
						await childSession.appendMessage({
							role: "user",
							content: "Fix **#5220** spawn lock",
							timestamp: 3,
						});
						await childSession.appendMessage({
							role: "assistant",
							content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/lock.ts" } }],
							api: "test",
							provider: "test",
							model: "test",
							usage,
							stopReason: "toolUse",
							timestamp: 4,
						});
						await childSession.appendMessage({
							role: "toolResult",
							toolCallId: "call-1",
							toolName: "read",
							content: [{ type: "text", text: "export const lock = 1;\n" }],
							isError: false,
							timestamp: 5,
						});
						const fullEntries = [...childSession.getEntries()];
						context.bindTranscript({
							getSessionId: () => childSession.getSessionId(),
							getEntries: () => [],
							loadHistory: async () => {
								loadCount += 1;
								return { entries: fullEntries };
							},
						});
						return {
							kind: "completed" as const,
							output: {
								ownerId: context.ref.ownerId,
								taskId: context.ref.taskId,
								artifactId: `output:${context.ref.taskId}`,
								byteCount: "10",
								omittedRanges: [],
							},
						};
					})(),
					cleanup: Promise.resolve({ kind: "reaped" as const }),
				};
			},
		);
		assert.equal(started.ok, true);
		if (!started.ok) return;
		await host.waitForTask(started.value.taskId);
		const notice = taskCompletionNotice(
			{
				...envelope,
				ownerId: host.taskRecords(new Set([started.value.taskId]))[0]!.ref.ownerId,
				taskId: started.value.taskId,
			},
			{
				kind: "agent",
				title: "#5220 spawn lock",
				agentName: "debugger",
				model: undefined,
				thinking: undefined,
				metrics: { elapsedMs: 5_460_000 },
			},
			"PR #5221 open: atomic lock creation, 4 race tests red-first",
		);
		let renderRequests = 0;
		const options = {
			loadTranscript: async (taskId: TaskId) => {
				const lease = host.resolveTask(taskId);
				return lease.ok ? loadTaskOwnTranscriptEntries(lease.value) : undefined;
			},
			requestRender: () => {
				renderRequests += 1;
			},
		};
		const component = new TaskCompletionMessage(notice, false, options);
		const collapsed = component.render(100).map((r) => stripVTControlCharacters(r));
		assert.deepEqual(collapsed, [
			" ● debugger finished · 1h 31m",
			"   ⎿  PR #5221 open: atomic lock creation, 4 race tests red-first",
			"      (ctrl+o for prompt, tool calls and full result)",
		]);
		assert.equal(loadCount, 0, "collapsed notice never loads full transcript history");

		component.setExpanded(true);
		component.render(100);
		for (let i = 0; i < 20 && renderRequests === 0; i++) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.equal(loadCount, 1);
		assert.equal(renderRequests, 1);
		const expanded = component
			.render(100)
			.map((r) => stripVTControlCharacters(r).trimEnd())
			.join("\n");
		assert.match(expanded, /⎿ {2}Prompt[\s\S]*Fix #5220 spawn lock/);
		assert.match(expanded, /⎿ {2}Tool calls[\s\S]*^ {6}● Read\(src\/lock\.ts\)$/m);
		assert.match(expanded, /⎿ {2}Result[\s\S]*PR #5221 open: atomic lock creation/);
		assert.doesNotMatch(expanded, /Inherited fork message|inherited\.ts/);

		component.render(80);
		assert.equal(loadCount, 1, "re-rendering while expanded reuses the loaded transcript");

		component.setExpanded(false);
		component.render(100);
		component.setExpanded(true);
		component.render(100);
		for (let i = 0; i < 20 && loadCount < 2; i++) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.equal(loadCount, 2, "collapsing releases the cached transcript so re-expanding loads afresh");

		let lateRender = 0;
		const deferred = Promise.withResolvers<undefined>();
		const disposable = new TaskCompletionMessage(notice, true, {
			loadTranscript: () => deferred.promise,
			requestRender: () => {
				lateRender += 1;
			},
		});
		disposable.render(100);
		disposable.dispose();
		deferred.resolve(undefined);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(lateRender, 0, "disposed notice never triggers requestRender from a late load");

		const brokenForkStarted = await host.startAgentTask(
			{ kind: "agent", agent: "debugger", task: "Broken fork task", cwd: process.cwd() },
			"op-broken-fork-tx" as OperationId,
			(context) => {
				context.bindTranscript({
					getSessionId: () => childSession.getSessionId(),
					getEntries: () => [
						{
							id: "missing-inherited-anchor",
							type: "message",
							parentId: null,
							timestamp: "0",
							message: { role: "user", content: "Anchor" },
						} as never,
					],
				});
				context.bindTranscript({
					getSessionId: () => childSession.getSessionId(),
					getEntries: () => [],
					loadHistory: async () => ({ entries: inheritedSnapshot }),
				});
				return {
					result: Promise.resolve({
						kind: "completed" as const,
						output: {
							ownerId: context.ref.ownerId,
							taskId: context.ref.taskId,
							artifactId: `output:${context.ref.taskId}`,
							byteCount: "10",
							omittedRanges: [],
						},
					}),
					cleanup: Promise.resolve({ kind: "reaped" as const }),
				};
			},
		);
		assert.equal(brokenForkStarted.ok, true);
		if (brokenForkStarted.ok) {
			await host.waitForTask(brokenForkStarted.value.taskId);
			const brokenLease = host.resolveTask(brokenForkStarted.value.taskId);
			assert.equal(brokenLease.ok, true);
			if (brokenLease.ok) {
				const ownEntries = await loadTaskOwnTranscriptEntries(brokenLease.value);
				assert.deepEqual(
					ownEntries,
					[],
					"missing inherited anchor fails closed instead of returning inherited entries",
				);
			}
		}

		const unavailStarted = await host.startAgentTask(
			{ kind: "agent", agent: "debugger", task: "Unavailable history task", cwd: process.cwd() },
			"op-unavail-tx" as OperationId,
			(context) => {
				context.bindTranscript({
					getSessionId: () => "missing-session",
					getEntries: () => [],
					loadHistory: async () => ({
						entries: [
							{
								id: "kept-prompt",
								type: "message",
								parentId: null,
								timestamp: "1",
								message: { role: "user", content: "Inspect unavailable session" },
							} as never,
						],
						unavailable: "History unavailable: missing session file",
					}),
				});
				return {
					result: Promise.resolve({
						kind: "completed" as const,
						output: {
							ownerId: context.ref.ownerId,
							taskId: context.ref.taskId,
							artifactId: `output:${context.ref.taskId}`,
							byteCount: "10",
							omittedRanges: [],
						},
					}),
					cleanup: Promise.resolve({ kind: "reaped" as const }),
				};
			},
		);
		assert.equal(unavailStarted.ok, true);
		if (unavailStarted.ok) {
			await host.waitForTask(unavailStarted.value.taskId);
			const unavailNotice = taskCompletionNotice(
				{
					...envelope,
					ownerId: host.taskRecords(new Set([unavailStarted.value.taskId]))[0]!.ref.ownerId,
					taskId: unavailStarted.value.taskId,
				},
				{
					kind: "agent",
					title: "Unavailable history task",
					agentName: "debugger",
					model: undefined,
					thinking: undefined,
					metrics: { elapsedMs: 10_000, toolCount: 4 },
				},
				"Retained final preview line",
			);
			let unavailRenders = 0;
			const unavailComp = new TaskCompletionMessage(unavailNotice, true, {
				loadTranscript: async (taskId: TaskId) => {
					const lease = host.resolveTask(taskId);
					return lease.ok ? loadTaskOwnTranscriptHistory(lease.value) : undefined;
				},
				requestRender: () => {
					unavailRenders += 1;
				},
			});
			unavailComp.render(100);
			for (let i = 0; i < 20 && unavailRenders === 0; i++) {
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			const unavailExpanded = unavailComp
				.render(100)
				.map((r) => stripVTControlCharacters(r).trimEnd())
				.join("\n");
			assert.match(unavailExpanded, /⎿ {2}Prompt[\s\S]*Inspect unavailable session/);
			assert.match(unavailExpanded, /⎿ {2}Tool calls[\s\S]*Transcript unavailable/);
			assert.doesNotMatch(unavailExpanded, /Tool calls\n {6}\(none\)/);
			assert.match(unavailExpanded, /⎿ {2}Result[\s\S]*Retained final preview line/);
		}

		const extSession = await SessionManager.create(store, process.cwd());
		await extSession.appendMessage({ role: "user", content: "Coordinate with peer", timestamp: 1 });
		await extSession.appendMessage({
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "ic-ask-1",
					name: "intercom",
					arguments: { action: "ask", to: "worker-2", message: "status?" },
				},
				{
					type: "toolCall",
					id: "sup-1",
					name: "contact_supervisor",
					arguments: { reason: "progress_update", message: "UPDATE: halfway" },
				},
				{
					type: "toolCall",
					id: "vault-1",
					name: "secret_vault",
					arguments: { apiKey: "super-secret-key-999" },
				},
			],
			api: "test",
			provider: "test",
			model: "test",
			usage,
			stopReason: "toolUse",
			timestamp: 2,
		});
		await extSession.appendMessage({
			role: "toolResult",
			toolCallId: "ic-ask-1",
			toolName: "intercom",
			content: [
				{
					type: "text",
					text: 'Ask 12345678-1234-1234-1234-123456789abc delivered to worker-2 (busy). The ask stays pending: its reply will arrive later as a message. Cancel it with intercom({ action: "cancel", askId: "12345678-1234-1234-1234-123456789abc" }).',
				},
			],
			details: { action: "ask", to: "worker-2", pending: true, askId: "12345678-1234-1234-1234-123456789abc" },
			isError: false,
			timestamp: 3,
		});
		await extSession.appendMessage({
			role: "toolResult",
			toolCallId: "sup-1",
			toolName: "contact_supervisor",
			content: [{ type: "text", text: "Progress update delivered to supervisor." }],
			details: { reason: "progress_update", delivered: true },
			isError: false,
			timestamp: 4,
		});
		await extSession.appendMessage({
			role: "toolResult",
			toolCallId: "vault-1",
			toolName: "secret_vault",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 5,
		});
		const extEntries = [...extSession.getEntries()];
		const extNotice = taskCompletionNotice(
			{ ...envelope, taskId: "task-ext-notice" as TaskId },
			{ kind: "agent", title: "Coordinate", agentName: "debugger", model: undefined, thinking: undefined },
			"Coordination complete",
		);
		let extRenders = 0;
		const extComp = new TaskCompletionMessage(extNotice, true, {
			loadTranscript: async () => ({ entries: extEntries }),
			getToolDefinition: (name: string) => {
				if (name === "intercom") return { renderCall: renderIntercomCall, renderResult: renderIntercomResult };
				if (name === "contact_supervisor")
					return { renderCall: renderContactSupervisorCall, renderResult: renderContactSupervisorResult };
				if (name === "secret_vault")
					return {
						renderCall: () => new Text("SecretVault(redacted)", 0, 0),
						renderResult: () => new Text("Stored", 0, 0),
					};
				return undefined;
			},
			requestRender: () => {
				extRenders += 1;
			},
		});
		extComp.render(100);
		for (let i = 0; i < 20 && extRenders === 0; i++) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		const extExpanded = extComp
			.render(100)
			.map((r) => stripVTControlCharacters(r).trimEnd())
			.join("\n");
		assert.match(extExpanded, /● Intercom\(ask → worker-2\)/);
		assert.match(extExpanded, /⎿ {2}Asked · reply will arrive as a message/);
		assert.doesNotMatch(extExpanded, /12345678-1234|action: "cancel"/);
		assert.match(extExpanded, /● Supervisor\(progress update\)/);
		assert.match(extExpanded, /● SecretVault\(redacted\)/);
		assert.doesNotMatch(extExpanded, /super-secret-key-999/);
	} finally {
		await host.close("session-close");
		await store.close();
	}
});
