import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall, type Message } from "@bastani/atomic-ai/compat";
import { type Component, setKeybindings, stripTerminalSequences } from "@bastani/atomic-tui";
import { test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { taskCompletionNotice } from "../../packages/coding-agent/src/core/tasks/completion.ts";
import type { Sequence } from "../../packages/coding-agent/src/core/tasks/contracts.ts";
import { createBashToolDefinition } from "../../packages/coding-agent/src/core/tools/bash.ts";
import { codemodeRenderers } from "../../packages/coding-agent/src/extensions/codemode/renderer.ts";
import { TaskCompletionMessage } from "../../packages/coding-agent/src/modes/interactive/components/task-completion-message.ts";
import { ToolExecutionComponent } from "../../packages/coding-agent/src/modes/interactive/components/tool-execution.ts";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { SubagentParams } from "../../packages/subagents/src/extension/schemas.ts";
import {
	renderSubagentToolCall,
	renderSubagentToolResult,
} from "../../packages/subagents/src/extension/tool-rendering.ts";
import type { SubagentParamsLike } from "../../packages/subagents/src/runs/foreground/subagent-executor-types.ts";
import type { Details } from "../../packages/subagents/src/shared/types.ts";
import { taskRecord } from "../helpers/task-record.ts";

/** The longest a turn of the event loop may take while a card opens. */
const TURN_BUDGET_MS = 50;
const OUTPUT_LINES = 3_000;
const OUTPUTS = 2;
const WIDTH = 100;

const bash = createBashToolDefinition(process.cwd());
const getToolDefinition = (name: string) =>
	name === "codemode" ? codemodeRenderers : name === "bash" ? bash : undefined;

/** A child that ran a script and then two commands, each printing 3,000 lines, as the tool kept them. */
function childMessages(): Message[] {
	const output = Array.from({ length: OUTPUT_LINES }, (_, i) => `LINE ${i + 1}`).join("\n");
	const messages: Message[] = [
		{ role: "user", content: "Print the fixture", timestamp: 1 },
		fauxAssistantMessage([fauxToolCall("codemode", { code: "// 漢字😀\nreturn 1;" }, { id: "script" })], {
			stopReason: "toolUse",
		}),
		{
			role: "toolResult",
			toolCallId: "script",
			toolName: "codemode",
			content: [{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" }],
			details: { calls: [] },
			isError: false,
			timestamp: 2,
		},
	];
	for (let index = 0; index < OUTPUTS; index++) {
		messages.push(
			fauxAssistantMessage([fauxToolCall("bash", { command: `seq ${OUTPUT_LINES}` }, { id: `seq-${index}` })], {
				stopReason: "toolUse",
			}),
			{
				role: "toolResult",
				toolCallId: `seq-${index}`,
				toolName: "bash",
				content: [{ type: "text", text: output }],
				isError: false,
				timestamp: 3,
			},
		);
	}
	messages.push(fauxAssistantMessage("Fixture done"));
	return messages;
}

function setup(): void {
	initTheme("dark", false);
	setKeybindings(new KeybindingsManager());
}

function childResult(): Details {
	const child = {
		agent: "worker",
		task: "Print the fixture",
		exitCode: 0,
		status: "ok",
		messages: childMessages(),
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
	} as unknown as Details["results"][number];
	return { mode: "single", results: [child] } as Details;
}

/** The same card as the main chat draws it: a tool row whose terminal asks for each next slice. */
function mainChatCard(requestRender: () => void): Component {
	const subagent = {
		name: "subagent",
		label: "Subagent",
		description: "Slices fixture",
		parameters: SubagentParams,
		execute: async () => {
			throw new Error("Rendering must not execute the tool");
		},
		renderCall: (args: unknown, theme: never, context: never) =>
			renderSubagentToolCall(args as SubagentParamsLike, theme, context),
		renderResult: renderSubagentToolResult,
	};
	const row = new ToolExecutionComponent(
		"subagent",
		"parent",
		{ agent: "worker", task: "Print the fixture" },
		{ getToolDefinition: getToolDefinition as never },
		subagent as never,
		{ requestRender } as never,
		process.cwd(),
	);
	row.setArgsComplete();
	row.markExecutionStarted();
	row.updateResult({ content: [], details: childResult(), isError: false });
	row.setExpanded(true);
	return row;
}

/** The expanded card of the finished subagent; with `requestRender`, it asks for each next slice through it. */
function expandedCard(requestRender?: () => void): Component {
	const child = {
		agent: "worker",
		task: "Print the fixture",
		exitCode: 0,
		status: "ok",
		messages: childMessages(),
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
	} as unknown as Details["results"][number];
	return renderSubagentToolResult(
		{ content: [], details: { mode: "single", results: [child] } as Details },
		{ expanded: true, isPartial: false },
		theme,
		{
			toolCallId: "parent",
			state: {},
			invalidate() {},
			getToolDefinition,
			...(requestRender ? { requestRender } : {}),
		},
	);
}

/** The expanded finished-task notice of the same subagent; it loads the child's transcript first. */
async function expandedNotice(requestRender: () => void): Promise<TaskCompletionMessage> {
	const task = taskRecord("render-slices");
	const notice = taskCompletionNotice(
		{
			completionId: "completion-render-slices",
			ownerId: task.ref.ownerId,
			taskId: task.ref.taskId,
			terminalSequence: "1" as Sequence,
			result: { kind: "completed", output: task.output },
			display: false,
		},
		{ kind: "agent", title: "Print the fixture", agentName: "worker" },
		"Fixture done",
	);
	let loaded = false;
	let afterLoad = (): void => {
		loaded = true;
	};
	const message = new TaskCompletionMessage(notice, true, {
		loadTranscript: () => childMessages().map((message) => ({ type: "message", message })) as never,
		getToolDefinition,
		requestRender: () => afterLoad(),
	});
	message.render(WIDTH);
	for (let i = 0; i < 100 && !loaded; i++) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.ok(loaded, "the notice loaded its transcript");
	afterLoad = requestRender;
	return message;
}

interface Opening {
	readonly rows: readonly string[];
	/** The main-thread time of each render: each runs in a turn of the event loop of its own. */
	readonly renders: readonly number[];
}

/**
 * Main-thread time since `from`, in milliseconds. Unlike wall time it leaves out the time a loaded machine kept the
 * process waiting for a core, so it measures the work a turn did rather than how busy the machine was.
 */
function threadMs(from: NodeJS.CpuUsage): number {
	const used = process.threadCpuUsage(from);
	return (used.user + used.system) / 1000;
}

/**
 * Opens a block as the terminal does: renders it, and renders it again in a later turn of the event loop each time it
 * asks, until it stops asking.
 */
async function open(build: (requestRender: () => void) => Promise<Component> | Component): Promise<Opening> {
	let requested = false;
	const component = await build(() => {
		requested = true;
	});
	const renders: number[] = [];
	let rows: string[] = [];
	do {
		requested = false;
		const started = process.threadCpuUsage();
		rows = component.render(WIDTH);
		renders.push(threadMs(started));
		// The next turn: a block that is not drawn yet asks for another render there.
		await new Promise((resolve) => setImmediate(resolve));
	} while (requested && renders.length < 1_000);
	return { rows, renders };
}

function assertEveryLine(rows: readonly string[]): void {
	const plain = rows.map(stripTerminalSequences);
	for (const line of ["LINE 1", `LINE ${OUTPUT_LINES}`]) {
		const shown = plain.filter((row) => row.trimEnd().endsWith(` ${line}`) || row.trim() === line).length;
		assert.equal(shown, OUTPUTS, `${line} shows once per output`);
	}
}

test("an expanded subagent card with 3,000-line outputs opens a slice per turn, none holding the event loop 50 ms, and then shows every line (#5525)", async () => {
	setup();
	const whole = expandedCard().render(WIDTH);
	assertEveryLine(whole);
	const opening = await open((requestRender) => expandedCard(requestRender));
	assert.ok(opening.renders.length > 1, "the card is drawn over more than one turn");
	assert.ok(Math.max(...opening.renders) < TURN_BUDGET_MS, `turns took ${opening.renders.map(Math.round)} ms`);
	assert.deepEqual(opening.rows, whole);
});

test("an expanded finished-task notice with 3,000-line outputs opens a slice per turn, none holding the event loop 50 ms, and then shows every line (#5525)", async () => {
	setup();
	const opening = await open((requestRender) => expandedNotice(requestRender));
	assertEveryLine(opening.rows);
	assert.ok(opening.renders.length > 1, "the notice is drawn over more than one turn");
	assert.ok(Math.max(...opening.renders) < TURN_BUDGET_MS, `turns took ${opening.renders.map(Math.round)} ms`);
});

test("the main chat's row of an expanded subagent card with 3,000-line outputs opens a slice per turn, none holding the event loop 50 ms (#5525)", async () => {
	setup();
	const opening = await open((requestRender) => mainChatCard(requestRender));
	assertEveryLine(opening.rows);
	assert.ok(opening.renders.length > 1, "the card is drawn over more than one turn");
	assert.ok(Math.max(...opening.renders) < TURN_BUDGET_MS, `turns took ${opening.renders.map(Math.round)} ms`);
});

test("an expanded card drawn once, as an HTML export draws it, shows every line in its first render (#5525)", () => {
	setup();
	assertEveryLine(expandedCard().render(WIDTH));
});
