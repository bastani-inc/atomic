import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { TUI } from "@bastani/atomic-tui";
import { beforeAll, test } from "vitest";
import type { ToolDefinition } from "../../packages/coding-agent/src/core/extensions/types.js";
import {
	type TaskCompletionEnvelope,
	taskCompletionNotice,
} from "../../packages/coding-agent/src/core/tasks/completion.js";
import type {
	CancelReceipt,
	Sequence,
	TaskId,
	TaskRecord,
	TaskResult,
	WaitId,
	WaitOutcome,
} from "../../packages/coding-agent/src/core/tasks/contracts.js";
import {
	rebuildKillResult,
	rebuildShellWaitResult,
} from "../../packages/coding-agent/src/core/tools/shell-task-render.js";
import { renderBoardRow } from "../../packages/coding-agent/src/modes/interactive/components/task-board.js";
import {
	completionNoticeFromDetails,
	TaskCompletionMessage,
} from "../../packages/coding-agent/src/modes/interactive/components/task-completion-message.js";
import { taskDetailSummary } from "../../packages/coding-agent/src/modes/interactive/components/task-detail.js";
import { renderTaskFooter } from "../../packages/coding-agent/src/modes/interactive/components/task-list.js";
import { TaskRow } from "../../packages/coding-agent/src/modes/interactive/components/task-row.js";
import { ToolBlock } from "../../packages/coding-agent/src/modes/interactive/components/tool-block.js";
import { builtinToolBlockPresentation } from "../../packages/coding-agent/src/modes/interactive/components/tool-block-families.js";
import { ToolExecutionComponent } from "../../packages/coding-agent/src/modes/interactive/components/tool-execution.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { SubagentParams } from "../../packages/subagents/src/extension/schemas.js";
import {
	renderSubagentToolCall,
	renderSubagentToolResult,
} from "../../packages/subagents/src/extension/tool-rendering.js";
import type { SubagentParamsLike } from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import { taskToolResult } from "../../packages/subagents/src/runs/foreground/task-execution.js";
import type { Details, SubagentStatusGroup } from "../../packages/subagents/src/shared/types.js";
import type { SubagentResultRenderState } from "../../packages/subagents/src/tui/render.js";
import { renderMultiCompact } from "../../packages/subagents/src/tui/render-result-compact.js";
import { renderSubagentStatus } from "../../packages/subagents/src/tui/render-status.js";
import { resultGlyph } from "../../packages/subagents/src/tui/render-status-progress.js";
import { taskRecord } from "../helpers/task-record.js";

beforeAll(() => {
	initTheme("dark");
});

type Mark = { readonly glyph: string; readonly color: "muted" | "dim" | "accent" | "success" | "error" | "warning" };

// The agent panel's marks (#6090), written out here rather than read from the code under test.
const RUNNING: Mark = { glyph: "◯", color: "muted" };
const SHELL: Mark = { glyph: "⧗", color: "accent" };
const DONE: Mark = { glyph: "●", color: "success" };
const FAILED: Mark = { glyph: "✗", color: "error" };
const STOPPED: Mark = { glyph: "◯", color: "error" };
const PAUSED: Mark = { glyph: "‖", color: "warning" };
const INPUT: Mark = { glyph: "◆", color: "warning" };
const STOPPING: Mark = { glyph: "◼", color: "warning" };
const QUEUED: Mark = { glyph: "○", color: "dim" };

/** The mark as drawn: its colour opens just before the glyph (a detail header colours its words with it too). */
const painted = (mark: Mark) => `${theme.fg(mark.color, "\u0000").split("\u0000")[0]}${mark.glyph}`;

/** The row of `rows` that names the task, its mark (the first thing on it) and whether it is drawn in `mark`'s colour. */
function markOf(surface: string, rows: readonly string[], name: RegExp, mark: Mark): void {
	const raw = rows.find((row) => name.test(stripVTControlCharacters(row)));
	assert.ok(raw !== undefined, `${surface} shows the task: ${rows.map(stripVTControlCharacters).join("\n")}`);
	const text = stripVTControlCharacters(raw);
	assert.equal(/^\s*(\S+)/u.exec(text)?.[1], mark.glyph, `${surface}: ${text}`);
	assert.ok(raw.includes(painted(mark)), `${surface} draws ${mark.glyph} in ${mark.color}: ${JSON.stringify(raw)}`);
}

function agent(id: string, change: Partial<TaskRecord>): TaskRecord {
	return {
		...taskRecord(id),
		agentName: "worker",
		title: "Update docs and changelog",
		wasBackground: true,
		metrics: { elapsedMs: 976_000 },
		...change,
	};
}

function settled(result: TaskResult): Partial<TaskRecord> {
	return { execution: { kind: "settled", result } };
}

function noticeRows(task: TaskRecord, result: TaskResult): string[] {
	const envelope: TaskCompletionEnvelope = {
		completionId: `completion-${task.ref.taskId}`,
		ownerId: task.ref.ownerId,
		taskId: task.ref.taskId,
		terminalSequence: "1" as Sequence,
		result,
		display: false,
		taskKind: task.kind,
	};
	const saved = completionNoticeFromDetails(
		JSON.parse(JSON.stringify({ notification: taskCompletionNotice(envelope, task) })),
	);
	assert.ok(saved, "the saved notice reads back");
	return new TaskCompletionMessage(saved, false).render(120);
}

/** The parent's launch card of a background subagent, reading the child's live task record. */
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
		`marks-card-${task.ref.taskId}`,
		{ agent: "worker", task: task.title },
		{ getTaskRecord: (taskId) => (taskId === task.ref.taskId ? task : undefined) },
		definition,
		{ requestRender() {} } as TUI,
		process.cwd(),
	);
	try {
		const observation: WaitOutcome =
			task.execution.kind === "settled"
				? { kind: "settled", taskId: task.ref.taskId, result: task.execution.result }
				: { kind: "yielded", taskId: task.ref.taskId, waitId: "wait-1" as WaitId, reason: "default-background" };
		card.updateResult({ ...taskToolResult({ kind: "admitted", observation }), isError: false });
		return card.render(120);
	} finally {
		card.dispose();
	}
}

const output = taskRecord("output").output;

test("a subagent reads with the agent panel's mark for its state in /tasks, its task row and detail, its notice and its launch card (#6122)", () => {
	const cases: readonly [string, TaskRecord, Mark][] = [
		["running", agent("running", {}), RUNNING],
		["done", agent("done", settled({ kind: "completed", output })), DONE],
		["failed", agent("failed", settled({ kind: "failed", code: "Probe", message: "check failed", output })), FAILED],
		["stopped for good", agent("killed", settled({ kind: "cancelled", cause: "user" })), STOPPED],
		["paused until resumed", agent("paused", settled({ kind: "cancelled", cause: "pause" })), STOPPED],
		["quit until resumed", agent("quit", settled({ kind: "cancelled", cause: "quit" })), STOPPED],
		["paused with Esc", agent("turn", { turnInterrupted: true }), PAUSED],
		[
			"waiting for an answer",
			agent("input", {
				attention: { kind: "input-needed", prompt: "Approve the plan?" } as TaskRecord["attention"],
			}),
			INPUT,
		],
	];
	for (const [state, task, mark] of cases) {
		// A chat's task footer lists the subagents that work or wait for an answer; the others leave it.
		if (state === "running" || state === "waiting for an answer")
			markOf(`${state}: agent panel task footer`, renderTaskFooter([task], 120), /worker/, mark);
		markOf(`${state}: /tasks row`, [renderBoardRow({ id: "r", kind: "task", task }, false, 120)], /worker/, mark);
		markOf(`${state}: task row`, new TaskRow(task).render(120), /worker/, mark);
		markOf(`${state}: task detail`, [taskDetailSummary(task)], /./, mark);
		markOf(`${state}: launch card`, launchCardRows(task), /Agent\(/, mark);
		if (task.execution.kind === "settled")
			markOf(`${state}: completion notice`, noticeRows(task, task.execution.result), /worker/, mark);
	}
});

const shellResult = (kind: "completed" | "cancelled"): TaskResult =>
	kind === "completed" ? { kind, output, exitCode: 0 } : { kind, cause: "user", output };

function waitLine(observation: WaitOutcome): string {
	const container = new (class {
		readonly children: { render(width: number): string[] }[] = [];
		clear() {
			this.children.length = 0;
		}
		addChild(child: { render(width: number): string[] }) {
			this.children.push(child);
		}
	})();
	const handled = rebuildShellWaitResult(
		container as never,
		{ content: [{ type: "text", text: "line" }], details: { observation } },
		{ expanded: false },
		{ showImages: false, isError: false, taskId: observation.taskId, timerText: undefined, cwd: process.cwd() },
	);
	assert.ok(handled);
	return container.children[0]!.render(120)[0]!;
}

function killLine(receipt: CancelReceipt): string {
	const children: { render(width: number): string[] }[] = [];
	rebuildKillResult(
		{
			clear: () => (children.length = 0),
			addChild: (child: { render(width: number): string[] }) => children.push(child),
		} as never,
		{ content: [{ type: "text", text: "" }], details: receipt },
		{ isError: false, taskId: receipt.taskId },
	);
	return children[0]!.render(120)[0]!;
}

test("a background shell reads with the /tasks mark for its state in its wait and kill lines, its blocks and its task row (#6122)", () => {
	const taskId = "task-shell" as TaskId;
	const shell: TaskRecord = { ...taskRecord("task-shell", "command"), title: "sleep 60" };
	markOf("/tasks row", [renderBoardRow({ id: "r", kind: "task", task: shell }, false, 120)], /shell|bash/, SHELL);
	markOf("task row", new TaskRow(shell).render(120), /bash/, SHELL);

	const yielded: WaitOutcome = { kind: "yielded", taskId, waitId: "wait-1" as WaitId, reason: "elapsed" };
	markOf("wait, still running", [waitLine(yielded)], /still running/, SHELL);
	markOf(
		"wait, completed",
		[waitLine({ kind: "settled", taskId, result: shellResult("completed") })],
		/completed/,
		DONE,
	);
	markOf(
		"wait, cancelled",
		[waitLine({ kind: "settled", taskId, result: shellResult("cancelled") })],
		/cancelled/,
		STOPPED,
	);

	const receipt = (execution: CancelReceipt["execution"]): CancelReceipt => ({
		taskId,
		decision: "cancellation-requested",
		execution,
		cleanup: { kind: "active" },
	});
	markOf("kill, stopping", [killLine(receipt({ kind: "cancelling", cause: "user" }))], /stopping/, STOPPING);
	markOf("kill, still running", [killLine(receipt({ kind: "running" }))], /still running/, SHELL);
	markOf("kill, still queued", [killLine(receipt({ kind: "queued" }))], /still queued/, QUEUED);
	markOf(
		"kill, already completed",
		[killLine({ ...receipt({ kind: "settled", result: shellResult("completed") }), decision: "already-settled" })],
		/already completed/,
		DONE,
	);

	const block = (toolName: string, args: Record<string, unknown>, details: Record<string, unknown>, text: string) => {
		const presentation = builtinToolBlockPresentation({
			toolName,
			args,
			result: { content: [{ type: "text", text }], details, isError: false },
			expanded: false,
			isPartial: false,
			cwd: process.cwd(),
			executionStarted: true,
			argsComplete: true,
		});
		assert.ok(presentation?.status);
		return new ToolBlock({ ...presentation, status: presentation.status, outputPad: 0 }).render(120);
	};
	markOf(
		"bash block, sent to the background",
		block("bash", { command: "sleep 60" }, { observation: yielded }, `Command is still running (task ${taskId}).`),
		/Bash\(/,
		SHELL,
	);
	markOf(
		"wait block, still running",
		block(
			"bash",
			{ action: "wait", id: taskId },
			{ observation: yielded },
			`\n\nTask ${taskId} is still running (yielded: elapsed).`,
		),
		/Wait\(/,
		SHELL,
	);
});

test("subagent result rows and status lists read with the agent panel's marks (#6122)", () => {
	const tagged = {
		fg: (color: string, text: string) => `<${color}>${text}</>`,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Parameters<typeof resultGlyph>[2];
	const tag = (mark: Mark) => `<${mark.color}>${mark.glyph}</>`;
	const base = {
		agent: "worker",
		task: "fix shipping batches",
		exitCode: 0,
		messages: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
		finalOutput: "done",
	} as unknown as Details["results"][number];
	const result = (change: Partial<Details["results"][number]>) =>
		({ ...base, ...change }) as Details["results"][number];
	assert.equal(resultGlyph(result({ status: "ok" }), "done", tagged, true), tag(RUNNING), "running");
	assert.equal(
		resultGlyph(result({ status: "continued", detached: true }), "", tagged, false),
		tag(RUNNING),
		"continued",
	);
	assert.equal(resultGlyph(result({ status: "interrupted", interrupted: true }), "", tagged, false), tag(STOPPED));
	assert.equal(resultGlyph(result({ status: "killed" }), "", tagged, false), tag(STOPPED), "killed");
	assert.equal(resultGlyph(result({ status: "error" }), "", tagged, false), tag(FAILED), "failed");
	assert.equal(resultGlyph(result({ status: "ok" }), "done", tagged, false), tag(DONE), "done");

	const summary = (...children: Details["results"][number][]) =>
		renderMultiCompact({ mode: "parallel", results: children } as Details, tagged).render(120)[0]!;
	assert.ok(
		summary(result({ status: "ok" }), result({ status: "continued", detached: true })).startsWith(tag(RUNNING)),
	);
	assert.ok(summary(result({ status: "ok" }), result({ status: "killed" })).startsWith(tag(STOPPED)));
	assert.ok(summary(result({ status: "ok" }), result({ status: "ok" })).startsWith(tag(DONE)));

	const group = (status: SubagentStatusGroup["children"][number]["status"]): SubagentStatusGroup[] => [
		{
			parentPath: "parent",
			children: [
				{ path: "parent/worker", parentPath: "parent", taskName: "worker", depth: 1, loaded: true, status },
			] as SubagentStatusGroup["children"],
		},
	];
	for (const [status, mark] of [
		["pending", QUEUED],
		["running", RUNNING],
		["continued", RUNNING],
		["ok", DONE],
		["error", FAILED],
		["interrupted", STOPPED],
		["killed", STOPPED],
	] as const) {
		const [line] = renderSubagentStatus(group(status), false, tagged).render(120);
		assert.ok(line?.startsWith(tag(mark)), `${status}: ${line}`);
	}
	// Only the mark changes: the words keep their colour.
	const [running] = renderSubagentStatus(group("running"), false, tagged).render(120);
	assert.ok(running?.includes("<accent>Running</>"), running);
	const [continued] = renderSubagentStatus(group("continued"), false, tagged).render(120);
	assert.ok(continued?.includes("<warning>Continued</>"), continued);
});

test("pause, quit and resume results mark each child with the agent panel's mark (#6122)", () => {
	const children = (["running", "finishing", "paused", "quit"] as const).map((state, index) => ({
		childId: `run:${index}`,
		runId: "run",
		index,
		agent: `worker${index}`,
		state,
	}));
	const rows = renderSubagentToolResult(
		{
			content: [{ type: "text", text: "" }],
			details: { mode: "management", results: [], runControl: { action: "resume", children } } as unknown as Details,
		},
		{ expanded: false, isPartial: false },
		theme,
		{ toolCallId: "run-control", state: {}, invalidate() {} } as never,
	).render(120);
	markOf("resumed", rows, /Resumed · worker0/, RUNNING);
	markOf("finishing its worktree", rows, /Finishing worktree cleanup · worker1/, RUNNING);
	markOf("paused until resumed", rows, /Paused · worker2/, STOPPED);
	markOf("quit until resumed", rows, /Quit \(resumable\) · worker3/, STOPPED);
});

test("a foreground subagent's card keeps its clock while it runs, and one that continued on its own reads running without one (#6122)", () => {
	const child = (change: Partial<Details["results"][number]>) =>
		({
			agent: "worker",
			task: "fix shipping batches",
			exitCode: 0,
			messages: [],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
			status: "ok",
			...change,
		}) as unknown as Details["results"][number];
	const card = (result: Details["results"][number], isPartial: boolean) =>
		renderSubagentToolResult(
			{ content: [{ type: "text", text: "" }], details: { mode: "single", results: [result] } as Details },
			{ expanded: false, isPartial },
			theme,
			{ toolCallId: `fg-${result.status}`, state: {}, invalidate() {} } as never,
		) as { render(width: number): string[]; isWorking?: () => boolean };

	const running = card(
		child({
			progress: {
				index: 0,
				agent: "worker",
				status: "running",
				task: "fix shipping batches",
				recentTools: [],
				recentOutput: [],
				toolCount: 1,
				tokens: 10,
				durationMs: 2_000,
			} as unknown as Details["results"][number]["progress"],
		}),
		true,
	);
	markOf("running foreground card", running.render(120), /Agent\(/, RUNNING);
	assert.equal(running.isWorking?.(), true, "its elapsed time keeps updating");

	const continued = card(
		child({ status: "continued", detached: true, detachedReason: "intercom-coordination" }),
		false,
	);
	const rows = continued.render(120);
	markOf("continued foreground card", rows, /Agent\(/, RUNNING);
	assert.match(rows.map(stripVTControlCharacters).join("\n"), /⎿ {2}Continued/);
	assert.equal(continued.isWorking?.(), false, "a card for work that continues elsewhere starts no clock");
});

test("a call header drawn with an earlier version's stopped or paused mark still yields its title (#6122)", () => {
	for (const mark of ["◼", "⏸", "◯", "⧗"]) {
		const header = {
			toolBlockKind: "block" as const,
			render: () => [` ${mark} Descriptive argument`],
			invalidate() {},
		};
		const component = new ToolExecutionComponent(
			"custom",
			`legacy-${mark}`,
			{},
			{},
			{
				name: "custom",
				label: "generic-label",
				description: "custom",
				parameters: SubagentParams,
				execute: async () => {
					throw new Error("Rendering must not execute the tool");
				},
				renderCall: () => header as never,
			},
			{ requestRender() {} } as TUI,
			process.cwd(),
		);
		try {
			component.updateResult({ content: [{ type: "text", text: "response" }], isError: false });
			const text = component.render(80).map(stripVTControlCharacters).join("\n");
			assert.match(text, /Descriptive argument/, `${mark}: ${text}`);
			assert.doesNotMatch(text, /generic-label/, `${mark}: ${text}`);
		} finally {
			component.dispose();
		}
	}
});
