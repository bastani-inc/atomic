import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { TUI } from "@bastani/atomic-tui";
import { beforeAll, test, vi } from "vitest";
import type { ToolDefinition } from "../../packages/coding-agent/src/core/extensions/types.js";
import type { CustomMessage } from "../../packages/coding-agent/src/core/messages.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
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
import { withNodeSqliteDatabase } from "../helpers/storage-database.js";
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

test("a stopped subagent's title-only notice does not take its outcome from the task description (#5690)", () => {
	for (const stop of ["killed (non-resumable)", "timed out", "stopped (session closed)", "stopped"]) {
		for (const description of [
			"paused · awaiting resume: check the queue",
			"quit · paused, awaiting resume: check the queue",
			"released while waiting on bash (queue).",
		]) {
			const title = `Subagent worker ${stop}: ${description}`;
			const saved = completionNoticeFromDetails({ notification: { ...savedNotices.stopped088, title } });
			assert.ok(saved);
			const [line] = new TaskCompletionMessage(saved, false).render(120);
			assert.equal(stripVTControlCharacters(line!).trim(), "◼ worker stopped", title);
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
])(
	"main and detached stage chats reopen '$expected' from the saved title (#5690)",
	({ title, expected, notification: fields = savedNotices.pause088, ...identity }) =>
		expectReopenedNotice(title, { notification: { ...fields, ...identity, title } }, expected),
);

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

test("a saved title split across text blocks is still title-only in both reopened chats (#5690)", () =>
	expectReopenedNotice(
		[
			{ type: "text", text: waitTitle.slice(0, 9) },
			{ type: "text", text: waitTitle.slice(9) },
		],
		detailsWithoutResult,
		"◼ triage stopped",
	));

async function expectReopenedNotice(body: CustomMessage["content"], details: unknown, expected: string): Promise<void> {
	await withNodeSqliteDatabase(async (db) => {
		const writer = await SqlSessionStore.open(db.database);
		const session = await SessionManager.create(writer, process.cwd());
		await session.appendCustomMessageEntry(TASK_COMPLETION_MESSAGE_TYPE, body, true, details);
		const sessionId = session.getSessionId();
		await writer.close();

		const reader = await SqlSessionStore.open(await db.reopen());
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
				rows.map((row) => stripVTControlCharacters(row).trim()).find((row) => row.includes("triage"));
			const stageRow = await vi.waitFor(() => {
				const row = notice(stage.render(120));
				assert.ok(row, "stage loads its archived notice");
				return row;
			});
			assert.deepEqual(
				{ main: notice(main.renderBody(120, 25)), stage: stageRow },
				{ main: expected, stage: expected },
			);
		} finally {
			stage.dispose();
			main.dispose();
			await reader.close();
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
