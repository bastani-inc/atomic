import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { TUI } from "@bastani/atomic-tui";
import { beforeAll, test, vi } from "vitest";
import type { ToolDefinition } from "../../packages/coding-agent/src/core/extensions/types.js";
import type { CustomMessage } from "../../packages/coding-agent/src/core/messages.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import {
	TASK_COMPLETION_MESSAGE_TYPE,
	type TaskCompletionEnvelope,
	taskCompletionNotice,
} from "../../packages/coding-agent/src/core/tasks/completion.js";
import type { Sequence, TaskRecord, TaskResult } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { ChatSessionHost } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host.js";
import { STATUS_MARKERS } from "../../packages/coding-agent/src/modes/interactive/components/notice-line.js";
import { renderBoardRow } from "../../packages/coding-agent/src/modes/interactive/components/task-board.js";
import {
	completionNoticeFromDetails,
	TaskCompletionMessage,
} from "../../packages/coding-agent/src/modes/interactive/components/task-completion-message.js";
import { renderTaskFooter } from "../../packages/coding-agent/src/modes/interactive/components/task-list.js";
import { TaskRow } from "../../packages/coding-agent/src/modes/interactive/components/task-row.js";
import { themedChatHostStyle } from "../../packages/coding-agent/src/modes/interactive/components/task-transcript-page.js";
import { ToolExecutionComponent } from "../../packages/coding-agent/src/modes/interactive/components/tool-execution.js";
import { getEditorTheme, initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { SubagentParams } from "../../packages/subagents/src/extension/schemas.js";
import {
	renderSubagentToolCall,
	renderSubagentToolResult,
} from "../../packages/subagents/src/extension/tool-rendering.js";
import type { SubagentParamsLike } from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import { taskToolResult } from "../../packages/subagents/src/runs/foreground/task-execution.js";
import type { Details } from "../../packages/subagents/src/shared/types.js";
import type { SubagentResultRenderState } from "../../packages/subagents/src/tui/render.js";
import {
	WorkflowToolResultBlock,
	workflowBlockTheme,
} from "../../packages/workflows/src/extension/workflow-tool-block.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { StageChatView } from "../../packages/workflows/src/tui/stage-chat-view.js";
import savedNotices from "../fixtures/saved-subagent-notices.json" with { type: "json" };
import { withDiskSessions } from "../helpers/on-disk-session.js";
import { taskRecord } from "../helpers/task-record.js";
import { setupRun } from "./stage-chat-view-helpers.js";

beforeAll(() => {
	initTheme("dark");
});

const RELEASED: TaskResult = {
	kind: "cancelled",
	cause: "pause",
	released: { waitingOn: [{ toolCallId: "toolu_1", toolName: "bash" }] },
};

function agentTask(result: TaskResult): TaskRecord {
	return {
		...taskRecord("worker-1"),
		agentName: "worker",
		title: "Update docs and changelog",
		wasBackground: true,
		metrics: { elapsedMs: 976_000 },
		execution: { kind: "settled", result },
	};
}

function envelope(task: TaskRecord, result: TaskResult): TaskCompletionEnvelope {
	return {
		completionId: `completion-${task.ref.taskId}`,
		ownerId: task.ref.ownerId,
		taskId: task.ref.taskId,
		terminalSequence: "1" as Sequence,
		result,
		display: false,
		taskKind: "agent",
	};
}

/** The completion notice as a chat shows it: read back from the details saved with the message. */
function noticeRows(task: TaskRecord, result: TaskResult): string[] {
	const saved = completionNoticeFromDetails(
		JSON.parse(JSON.stringify({ notification: taskCompletionNotice(envelope(task, result), task) })),
	);
	assert.ok(saved, "the saved notice reads back");
	return new TaskCompletionMessage(saved, false).render(120);
}

/** The parent's launch card of the subagent, reading the child's live task record. */
function launchCardRows(task: TaskRecord): string[] {
	const definition: ToolDefinition<typeof SubagentParams, Details, SubagentResultRenderState> = {
		name: "subagent",
		label: "Subagent",
		description: "Subagent launch card",
		parameters: SubagentParams,
		execute: async () => {
			throw new Error("Rendering must not execute the tool");
		},
		renderCall: (args, callTheme, context) => renderSubagentToolCall(args as SubagentParamsLike, callTheme, context),
		renderResult: renderSubagentToolResult,
	};
	const card = new ToolExecutionComponent(
		"subagent",
		"waiting-mark-card",
		{ agent: "worker", task: task.title },
		{ getTaskRecord: (taskId) => (taskId === task.ref.taskId ? task : undefined) },
		definition,
		{ requestRender() {} } as TUI,
		process.cwd(),
	);
	try {
		const result = taskToolResult({
			kind: "admitted",
			observation: { kind: "settled", taskId: task.ref.taskId, result: RELEASED },
		});
		card.updateResult({ ...result, isError: false });
		return card.render(120);
	} finally {
		card.dispose();
	}
}

/** The row of `rows` that names the child, with its mark: the first thing on it after indentation. */
function markedRow(
	surface: string,
	rows: readonly string[],
	name: RegExp,
): { raw: string; text: string; mark: string } {
	const raw = rows.find((row) => name.test(stripVTControlCharacters(row)));
	assert.ok(raw !== undefined, `${surface} shows the child: ${rows.map(stripVTControlCharacters).join("\n")}`);
	const text = stripVTControlCharacters(raw);
	const mark = /^\s*(\S+)/u.exec(text)?.[1] ?? "";
	return { raw, text, mark };
}

test("a released subagent wears the same waiting mark in its notice, /tasks, the agent panel and its launch card (#5489)", () => {
	const task = agentTask(RELEASED);
	const waiting = STATUS_MARKERS.waiting;
	const coloured = theme.fg(waiting.color, waiting.glyph);
	const surfaces = {
		"completion notice": markedRow("completion notice", noticeRows(task, RELEASED), /worker/),
		"/tasks row": markedRow("/tasks row", [renderBoardRow({ id: "r", kind: "task", task }, false, 120)], /worker/),
		"/tasks detail": markedRow("/tasks detail", new TaskRow(task).render(120), /worker/),
		"agent panel and task footer": markedRow("agent panel", renderTaskFooter([task], 120), /worker/),
		"launch card": markedRow("launch card", launchCardRows(task), /Agent/),
	};
	for (const [surface, row] of Object.entries(surfaces)) {
		assert.equal(row.mark, waiting.glyph, `${surface}: ${row.text}`);
		assert.ok(row.raw.includes(coloured), `${surface} colours its mark as waiting: ${JSON.stringify(row.raw)}`);
		assert.doesNotMatch(row.text, /⏸|paused|awaiting resume/i, `${surface}: ${row.text}`);
	}
	assert.match(surfaces["completion notice"].text, /^\s*◌ worker is waiting on bash \(toolu_1\) · 16m 16s$/);
});

test("a paused or quit subagent keeps the pause mark on its notice (#5489)", () => {
	for (const [cause, outcome] of [
		["pause", "paused · awaiting resume"],
		["quit", "quit · awaiting resume"],
	] as const) {
		const result: TaskResult = { kind: "cancelled", cause };
		const row = markedRow(cause, noticeRows(agentTask(result), result), /worker/);
		assert.equal(row.mark, STATUS_MARKERS.paused.glyph, row.text);
		assert.match(row.text, new RegExp(`worker ${outcome}`));
	}
});

// Golden notices from taskCompletionNotice in 0.9.86–0.9.89 and the first release-aware writer, d1f05495c6.
// Read their saved fields, not copies produced by today's writer.
test.each([
	[savedNotices.release088, "◌ worker is waiting on bash (toolu_1)"],
	[savedNotices.releaseBeforeKind, "◌ 审阅 é is waiting on bash (build:1), intercom (ask-2)"],
	[savedNotices.recordless088, "◌ Task is waiting on a tool call"],
] as const)(
	"reopening the title-only notice '$title' shows what the child waits on (#5563)",
	(notification, expected) => {
		const saved = completionNoticeFromDetails({ notification });
		assert.ok(saved);
		for (const expanded of [false, true]) {
			const line: string | undefined = new TaskCompletionMessage(saved, expanded).render(120)[0];
			assert.ok(line);
			assert.equal(stripVTControlCharacters(line).trim(), expected);
			assert.ok(line.includes(theme.fg(STATUS_MARKERS.waiting.color, STATUS_MARKERS.waiting.glyph)));
		}
	},
);

test.each([
	[savedNotices.pauseOrRelease086, "⏸ worker paused · awaiting resume"],
	[savedNotices.quit087, "⏸ worker quit · awaiting resume"],
	[savedNotices.pause088, "⏸ worker paused · awaiting resume"],
	[savedNotices.quit088, "⏸ agent quit · awaiting resume"],
	[savedNotices.pause089, "⏸ worker paused · awaiting resume · 16m 16s"],
	[savedNotices.quit089, "⏸ worker quit · awaiting resume · 16m 16s"],
	[savedNotices.stopped088, "◼ worker stopped"],
] as const)("reopening '$title' preserves the recorded stop (#5563)", (notification, expected) => {
	const saved = completionNoticeFromDetails({ notification });
	assert.ok(saved);
	const line = new TaskCompletionMessage(saved, false).render(120)[0];
	assert.ok(line);
	assert.equal(stripVTControlCharacters(line).trim(), expected);
});

test.each(["sweep_worker ops", "sweep_worker docs", "sweep_worker:qa", "sweep_worker:ui"])(
	"reopened chats keep the complete identity of %s, with and without a separately saved name (#5690)",
	async (name) => {
		const title = `Subagent ${name} killed (non-resumable): paused · awaiting resume: A`;
		for (const fields of [savedNotices.quit087, savedNotices.stopped088]) {
			await expectReopenedNotice(
				title,
				{ notification: { ...fields, title } },
				`⏸ ${name} killed (non-resumable): paused · awaiting resume`,
			);
		}
		await expectReopenedNotice(
			title,
			{ notification: { ...savedNotices.stopped088, title, agentName: name } },
			`◼ ${name} stopped`,
		);
	},
);

test("a reopened nameless subagent notice uses its own settlement, not another task with the same number (#5690)", async () => {
	const title = "Subagent docs worker killed (non-resumable): paused · awaiting resume: check the queue";
	const taskId = savedNotices.stopped088.taskId;
	const intent = { taskId, ownerId: "owner-1-0", terminalSequence: "7", taskKind: "agent", display: false };
	for (const [cause, expected] of [
		["user", "◼ docs worker stopped"],
		["pause", "⏸ docs worker killed (non-resumable): paused · awaiting resume"],
	] as const) {
		await expectReopenedNotice(
			title,
			{ ...intent, completionId: "settlement", notification: { ...savedNotices.stopped088, title } },
			expected,
			undefined,
			async (session) => {
				await session.appendCustomEntry("task-completion-intent", {
					...intent,
					completionId: "settlement",
					result: { kind: "cancelled", cause },
				});
				await session.appendCustomEntry("task-completion-intent", {
					...intent,
					completionId: "another-settlement",
					result: { kind: "cancelled", cause: cause === "user" ? "pause" : "user" },
				});
			},
		);
	}
});

test("a reopened card neither borrows a sibling branch's intent nor invents an ambiguous agent name (#5690)", async () => {
	const title =
		"Subagent docs worker killed (non-resumable): paused · awaiting resume: more killed (non-resumable): check the queue";
	const taskId = savedNotices.stopped088.taskId;
	for (const sibling of [false, true]) {
		await expectReopenedNotice(
			title,
			{ notification: { ...savedNotices.stopped088, title } },
			sibling ? "⏸ docs worker killed (non-resumable): paused · awaiting resume" : "◼ Subagent stopped",
			undefined,
			async (session) => {
				const root = await session.appendMessage({ role: "user", content: "Check the queue", timestamp: 1 });
				await session.appendCustomEntry("task-completion-intent", {
					completionId: "receipt",
					ownerId: "owner-1-0",
					terminalSequence: "7",
					taskId,
					taskKind: "agent",
					display: false,
					result: { kind: "cancelled", cause: "user" },
				});
				if (sibling) await session.recordBranch(root);
			},
			"receipt",
		);
	}
});

test("a surviving pause result takes precedence over a previously reopened header (#5690)", async () => {
	const session = SessionManager.inMemory();
	const title = "Subagent docs worker killed (non-resumable): paused · awaiting resume: verify";
	const saved = { completionId: "settlement", taskId: savedNotices.stopped088.taskId };
	await session.appendCustomEntry("task-completion-intent", {
		...saved,
		result: { kind: "cancelled", cause: "user" },
	});
	await session.appendCustomMessageEntry("task-completion", title, true, {
		...saved,
		notification: { ...savedNotices.stopped088, title },
	});
	const message = session.buildSessionContext().messages.find((message) => message.role === "custom");
	assert.ok(message);
	message.details = {
		...saved,
		notification: { ...savedNotices.stopped088, title },
		result: { kind: "cancelled", cause: "pause" },
	};
	const card = TaskCompletionMessage.fromMessage(message, false);
	assert.ok(card);
	assert.equal(
		stripVTControlCharacters(card.render(120)[0]!).trim(),
		"⏸ docs worker killed (non-resumable): paused · awaiting resume",
	);
});

test("a compacted chat can show the stop recorded before its delivered card (#5690)", async () => {
	const title = "Subagent docs worker timed out: quit · paused, awaiting resume: check the queue";
	const taskId = savedNotices.stopped088.taskId;
	await expectReopenedNotice(
		title,
		{ notification: { ...savedNotices.stopped088, title } },
		"◼ docs worker stopped",
		undefined,
		async (session) => {
			await session.appendCustomEntry("task-completion-intent", {
				completionId: "receipt",
				ownerId: "owner-1-0",
				taskId,
				terminalSequence: "7",
				taskKind: "agent",
				display: false,
				result: { kind: "cancelled", cause: "execution-timeout" },
			});
			const last = await session.appendMessage({ role: "user", content: "Check the queue", timestamp: 1 });
			await session.appendCompaction(
				"Checked the queue",
				null,
				100,
				{
					strategy: "verbatim-lines",
					promptVersion: 7,
					form: "compacted",
					parameters: { query: "queue" },
					stats: {
						linesBefore: 2,
						linesDeleted: 1,
						linesKept: 1,
						rangeCount: 1,
						tokensBefore: 100,
						tokensAfter: 50,
						percentReduction: 50,
					},
				},
				undefined,
				last,
			);
		},
		"receipt",
	);
});

test("a separately saved name identifies a stopped child even when its task starts with pause or wait wording (#5690)", async () => {
	for (const stop of ["killed (non-resumable)", "timed out", "stopped (session closed)", "stopped"]) {
		for (const description of [
			"paused · awaiting resume: check the queue",
			"quit · paused, awaiting resume: check the queue",
			"released while waiting on bash (queue).",
		]) {
			const title = `Subagent worker ${stop}: ${description}`;
			await expectReopenedNotice(
				title,
				{ notification: { ...savedNotices.stopped088, agentName: "worker", title } },
				"◼ worker stopped",
			);
		}
	}
	for (const [name, agentName] of [
		["triage:", undefined],
		["triage stopped:", "triage stopped:"],
	] as const) {
		const named = completionNoticeFromDetails({
			notification: { ...savedNotices.pause088, agentName, title: `Subagent ${name} paused · awaiting resume.` },
		});
		assert.ok(named);
		assert.equal(
			stripVTControlCharacters(new TaskCompletionMessage(named, false).render(120)[0]!).trim(),
			`⏸ ${name} paused · awaiting resume`,
		);
	}
});

test.each([
	...["triage timed out:", "triage stopped (session closed):", "worker killed (non-resumable):"].map((name) => ({
		notification: savedNotices.pauseOrRelease086,
		title: `Subagent ${name} paused · awaiting resume: check the queue`,
		expected: `⏸ ${name} paused · awaiting resume`,
	})),
	{
		title: "Subagent triage timed out after 1 second: released while waiting on bash (ci): Review docs",
		expected: "◌ triage timed out after 1 second: is waiting on bash (ci)",
	},
	{
		notification: savedNotices.quit087,
		title: "Subagent triage interrupted by a restart: paused · awaiting resume: Review docs",
		expected: "⏸ triage interrupted by a restart: paused · awaiting resume",
	},
	{
		title: "Subagent triage interrupted by a restart: released while waiting on bash (ci): Review docs",
		expected: "◌ triage interrupted by a restart: is waiting on bash (ci)",
	},
	{
		title: "Subagent triage stopped (QA): paused · awaiting resume: Review docs",
		expected: "⏸ triage stopped (QA): paused · awaiting resume",
	},
	{
		title: `Subagent triage stopped: released while waiting on bash (ci): ${"x".repeat(240)}`,
		expected: "◌ triage stopped: is waiting on bash (ci)",
	},
	{
		title: "Subagent triage stopped: paused · awaiting resume: Review docs",
		agentName: "triage\tstopped:",
		expected: "⏸ triage stopped: paused · awaiting resume",
	},
])("main and detached stage chats reopen '$expected' from the saved title (#5690)", (entry) => {
	const { title, expected } = entry;
	const fields = ("notification" in entry ? entry.notification : undefined) ?? savedNotices.pause088;
	const agentName = "agentName" in entry ? entry.agentName : undefined;
	return expectReopenedNotice(title, { notification: { ...fields, agentName, title } }, expected);
});

const { detailsWithoutResult, releasedBody, stoppedBody } = savedNotices.releaseOrStop088;
const waitTitle = detailsWithoutResult.notification.title;
const waitRow = "◌ triage stopped: is waiting on bash (ci)";

test.each([
	{ form: "release body", body: releasedBody },
	{ form: "shutdown body with the same title", body: stoppedBody },
	{ form: "release body in a text block", body: [{ type: "text", text: releasedBody }] },
	{
		form: "release body with a multiline model ID",
		body: releasedBody.replace(
			"\nStop reason:",
			"\nModel: ran on custom/review\nmodel, not the requested remote/review.\nStop reason:",
		),
		fields: { model: "custom/review\nmodel", requestedModel: "remote/review" },
	},
	{
		form: "release body with a multiline call ID",
		body: releasedBody.replaceAll("bash (ci)", "bash (ci).\nstep)"),
		fields: { title: "Subagent triage stopped: released while waiting on bash (ci)." },
	},
	{ form: "whitespace after the title", body: `${waitTitle} ` },
	{
		form: "image after the title",
		body: [
			{ type: "text", text: waitTitle },
			{ type: "image", mimeType: "image/png", data: "AA==" },
		],
	},
] satisfies {
	form: string;
	body: CustomMessage["content"];
	fields?: { title?: string; model?: string; requestedModel?: string };
}[])("main and detached stage chats keep the legacy row without its result: $form (#5690)", ({ body, fields }) =>
	expectReopenedNotice(
		body,
		{ ...detailsWithoutResult, notification: { ...detailsWithoutResult.notification, ...fields } },
		waitRow,
	),
);

test("the visible preview preserves a named release even when the message body is just its title (#5690)", () => {
	const preview = "Checkpoint B remains pending";
	return expectReopenedNotice(
		waitTitle,
		{ ...detailsWithoutResult, notification: { ...detailsWithoutResult.notification, preview } },
		waitRow,
		preview,
	);
});

test("even a separately saved name does not override a surviving body or preview (#5690)", async () => {
	const title = "Subagent triage killed (non-resumable): paused · awaiting resume: A";
	const fields = { ...savedNotices.stopped088, agentName: "triage", title };
	const original = "⏸ triage killed (non-resumable): paused · awaiting resume";
	await expectReopenedNotice(`${title}\nRetained text`, { notification: fields }, original);
	await expectReopenedNotice([{ type: "text", text: title }], { notification: fields }, original);
	await expectReopenedNotice(
		title,
		{ notification: { ...fields, preview: "Checkpoint B" } },
		original,
		"Checkpoint B",
	);
});

test("a saved completion survives a sparse custom body on reopen and refresh (#5690)", () => {
	const result: TaskResult = { kind: "completed", output: agentTask(RELEASED).output };
	const task = agentTask(result);
	const notification = taskCompletionNotice(envelope(task, result), task);
	return expectReopenedNotice(Array(1), { result, notification }, "● worker finished · 16m 16s");
});

test("opening and refreshing a saved pause does not scan its hidden text blocks (#5690)", async () => {
	const notification = savedNotices.pause089;
	const body = Array.from({ length: 2048 }, () => ({ type: "text" as const, text: "" }));
	body.push({ type: "text", text: `${notification.title}\nRetained body` });
	const startsWith = String.prototype.startsWith;
	let checks = 0;
	String.prototype.startsWith = function (this: string, prefix: string, offset?: number) {
		if (this === notification.title && prefix === "") checks++;
		return startsWith.call(this, prefix, offset);
	};
	try {
		await expectReopenedNotice(
			body,
			{ notification, result: { kind: "cancelled", cause: "pause" } },
			"⏸ worker paused · awaiting resume · 16m 16s",
		);
	} finally {
		String.prototype.startsWith = startsWith;
	}
	assert.equal(checks, 0);
});

test("a saved title split across blocks cannot disambiguate a stop from a release by triage stopped: (#5690)", () =>
	expectReopenedNotice(
		[
			{ type: "text", text: waitTitle.slice(0, 9) },
			{ type: "text", text: waitTitle.slice(9) },
		],
		detailsWithoutResult,
		waitRow,
	));

async function expectReopenedNotice(
	body: CustomMessage["content"],
	details: unknown,
	expected: string,
	preview?: string,
	beforeNotice?: (session: SessionManager) => Promise<void>,
	admissionKey?: string,
): Promise<void> {
	for (const backend of ["sqlite", "jsonl"] as const)
		await withDiskSessions(backend, async (open) => {
			const writer = await open();
			const session = await SessionManager.create(writer.store, process.cwd());
			await beforeNotice?.(session);
			await session.appendCustomMessageEntry(
				TASK_COMPLETION_MESSAGE_TYPE,
				body,
				true,
				details,
				undefined,
				undefined,
				admissionKey,
			);
			if (admissionKey) await session.appendCustomEntry("task-completion-ack", { completionId: admissionKey });
			const sessionId = session.getSessionId();
			await writer.close();

			const { store: reader } = await open();
			const main = new ChatSessionHost({ style: themedChatHostStyle(), editorTheme: getEditorTheme() });
			const store = createStore();
			setupRun(store, "run-1", "stage-a", "completed");
			store.recordStageSession("run-1", "stage-a", { sessionId });
			const stage = new StageChatView({
				store,
				sessionStore: reader,
				graphTheme: deriveGraphTheme({}),
				runId: "run-1",
				stageId: "stage-a",
				workflowName: "review",
				onDetach() {},
				onClose() {},
			});
			try {
				assert.equal(await main.loadSession(reader, sessionId), true);
				const notice = (rows: string[]) =>
					rows.map((row) => stripVTControlCharacters(row).trim()).find((row) => /^[◼⏸◌●!] /u.test(row));
				const stageRow = await vi.waitFor(() => {
					const row = notice(stage.render(120));
					assert.ok(row, "stage loads its archived notice");
					return row;
				});
				assert.deepEqual(
					{ main: notice(main.renderBody(120, 25)), stage: stageRow },
					{ main: expected, stage: expected },
					backend,
				);
				if (preview)
					for (const rows of [main.renderBody(120, 25), stage.render(120)])
						assert.ok(
							rows.some((row) => stripVTControlCharacters(row).includes(preview)),
							preview,
						);
				main.toolOutputToggled();
				stage.invalidate();
				assert.deepEqual(
					[notice(main.renderBody(120, 25)), notice(stage.render(120))],
					[expected, expected],
					backend,
				);
			} finally {
				stage.dispose();
				main.dispose();
			}
		});
}

test("the saved result distinguishes a release from punctuation and release wording in a name (#5563)", () => {
	const released = completionNoticeFromDetails(savedNotices.punctuated088Details);
	const stopped = completionNoticeFromDetails(savedNotices.killed088Details);
	assert.ok(released && stopped);
	assert.equal(
		stripVTControlCharacters(new TaskCompletionMessage(released, false).render(120)[0]!).trim(),
		"◌ docs: reviewer is waiting on bash (ci): part 2)",
	);
	assert.match(
		stripVTControlCharacters(new TaskCompletionMessage(stopped, false).render(120)[0]!),
		/^\s*◼ .* stopped$/,
	);
});

test("a subagent whose name starts with its release wording still shows its saved wait (#5563)", () => {
	const saved = completionNoticeFromDetails(savedNotices.nameStartsWithOutcome088Details);
	assert.ok(saved);
	assert.equal(
		stripVTControlCharacters(new TaskCompletionMessage(saved, false).render(120)[0]!).trim(),
		"◌ released while waiting on bash (toolu_1): reviewer is waiting on bash (toolu_1)",
	);
});

test("a release whose title ended mid-call still shows the whole saved wait on one row (#5563)", () => {
	const saved = completionNoticeFromDetails(savedNotices.firstLine088Details);
	assert.ok(saved);
	const rows = new TaskCompletionMessage(saved, false).render(120).map((row) => stripVTControlCharacters(row).trim());
	assert.deepEqual(rows, ["◌ worker is waiting on bash (ci step)"]);
});

test("a released subagent's notice saved by an earlier version shows the waiting mark too (#5489)", () => {
	const saved = completionNoticeFromDetails({ notification: savedNotices.release089 });
	assert.ok(saved);
	const row = markedRow("saved notice", new TaskCompletionMessage(saved, false).render(120), /worker/);
	assert.equal(row.mark, STATUS_MARKERS.waiting.glyph, row.text);
	assert.ok(row.raw.includes(theme.fg(STATUS_MARKERS.waiting.color, STATUS_MARKERS.waiting.glyph)), row.raw);
	assert.match(row.text, /worker is waiting on bash \(toolu_1\) · 16m 16s$/);
});

test("a workflow stage released while it waits wears the same waiting mark on the workflow card (#5489)", () => {
	const store = createStore();
	store.recordRunStart({
		id: "run-1",
		name: "release",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [],
		startedAt: 1_000,
	});
	store.recordStageStart("run-1", {
		id: "docs",
		name: "docs",
		status: "suspended",
		parentIds: [],
		toolEvents: [],
		startedAt: 1_000,
		wait: { kind: "tool", since: 2_000, toolCalls: [{ toolCallId: "toolu_1", toolName: "bash" }] },
	});
	const card = new WorkflowToolResultBlock(store, workflowBlockTheme(theme), { now: () => 5_000 }).update(
		{ action: "run", name: "release", runId: "run-1", status: "running", message: "started in background" },
		{ expanded: true, isError: false, invalidate: () => {}, args: { workflow: "release" } },
	);
	const row = markedRow("workflow card", card.render(120), /docs/);
	assert.equal(row.mark, STATUS_MARKERS.waiting.glyph, row.text);
	assert.ok(row.raw.includes(theme.fg(STATUS_MARKERS.waiting.color, STATUS_MARKERS.waiting.glyph)), row.raw);
});
