import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall, type Message } from "@bastani/atomic-ai/compat";
import { setKeybindings, stripTerminalSequences, visibleWidth } from "@bastani/atomic-tui";
import { test } from "vitest";
import { createToolHtmlRenderer } from "../../packages/coding-agent/src/core/export-html/tool-renderer.ts";
import type { ToolDefinition } from "../../packages/coding-agent/src/core/extensions/types.ts";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { taskCompletionNotice } from "../../packages/coding-agent/src/core/tasks/completion.ts";
import type { Sequence } from "../../packages/coding-agent/src/core/tasks/contracts.ts";
import { codemodeRenderers } from "../../packages/coding-agent/src/extensions/codemode/renderer.ts";
import { TaskCompletionMessage } from "../../packages/coding-agent/src/modes/interactive/components/task-completion-message.ts";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { SubagentParams } from "../../packages/subagents/src/extension/schemas.ts";
import {
	renderSubagentToolCall,
	renderSubagentToolResult,
} from "../../packages/subagents/src/extension/tool-rendering.ts";
import type { SubagentParamsLike } from "../../packages/subagents/src/runs/foreground/subagent-executor-types.ts";
import type { Details } from "../../packages/subagents/src/shared/types.ts";
import type { SubagentResultRenderState } from "../../packages/subagents/src/tui/render.ts";
import { taskRecord } from "../helpers/task-record.ts";

// The script is longer than the 10 lines a collapsed codemode call shows, and its last lines are wider than a narrow
// card, so only an expanded call shows `v19`, the end of `note` and the CJK line's last character. The script made
// more nested calls than the 8 a collapsed result keeps, and the bash output is longer than the 5 lines a collapsed
// bash block keeps.
const SCRIPT = [
	...Array.from({ length: 20 }, (_, i) => `const v${i} = ${i};`),
	`const note = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda";`,
	`const wide = "漢字😀 e\u0301 漢字😀 漢字😀 漢字😀 漢字😀 漢字😀 漢字😀 漢字😀 漢字😀 末";`,
].join("\n");
const BASH_OUTPUT = Array.from({ length: 40 }, (_, i) => `out-${i + 1}`).join("\n");
const NESTED_CALLS = Array.from({ length: 12 }, (_, i) => ({
	id: `nested-${i}`,
	name: "read",
	args: JSON.stringify({ path: `nested-${i}.txt` }),
	status: "ok" as const,
}));

function childMessages(): Message[] {
	return [
		{ role: "user", content: "Run the fixture", timestamp: 1 },
		fauxAssistantMessage(
			[
				fauxToolCall("codemode", { code: SCRIPT }, { id: "script" }),
				fauxToolCall("bash", { command: "seq" }, { id: "seq" }),
			],
			{ stopReason: "toolUse" },
		),
		{
			role: "toolResult",
			toolCallId: "script",
			toolName: "codemode",
			content: [{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" }],
			details: { calls: NESTED_CALLS },
			isError: false,
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "seq",
			toolName: "bash",
			content: [{ type: "text", text: BASH_OUTPUT }],
			isError: false,
			timestamp: 3,
		},
		fauxAssistantMessage("Fixture done"),
	];
}

const getToolDefinition = (name: string) => (name === "codemode" ? codemodeRenderers : undefined);

/** Every row fits, the last script line and the last output line show, and nothing offers an expansion. */
function assertExpandedWithin(rows: readonly string[], width: number): string {
	const plain = rows.map(stripTerminalSequences).join("\n");
	assert.match(plain, /末";/, plain);
	assert.match(plain, /\bout-40$/m, plain);
	assert.doesNotMatch(plain, /to expand/, plain);
	for (const row of rows) assert.ok(visibleWidth(row) <= width, `row wider than ${width}: ${row}`);
	return plain;
}

function assertInnerToolsExpanded(rows: readonly string[], width: number): void {
	const plain = assertExpandedWithin(rows, width);
	assert.match(plain, /const v19 = 19;/, plain);
	assert.match(plain, /lambda";/, plain);
	assert.match(plain, /Read\(nested-0\.txt\)/, plain);
	assert.match(plain, /\bout-1$/m, plain);
}

function subagentResultDetails(messages: Message[] = childMessages()): Details {
	const child = {
		agent: "worker",
		task: "Run the fixture",
		exitCode: 0,
		status: "ok",
		messages,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
	} as unknown as Details["results"][number];
	return { mode: "single", results: [child] } as Details;
}

/** The text an exported block shows, one row per line. */
function exportedText(html: string): string {
	return html
		.replace(/<\/div>/g, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#039;/g, "'")
		.replace(/&amp;/g, "&");
}

/** The expanded card of a finished foreground subagent, as the parent's chat draws it. */
function renderExpandedCard(width: number, messages?: Message[]): string[] {
	initTheme("dark", false);
	setKeybindings(new KeybindingsManager());
	return renderSubagentToolResult(
		{ content: [], details: subagentResultDetails(messages) },
		{ expanded: true, isPartial: false },
		theme,
		{ toolCallId: "parent", state: {}, invalidate() {}, getToolDefinition },
	).render(width);
}

/** The expanded finished-task notice of the same subagent, once it has loaded the child's transcript. */
async function renderExpandedNotice(width: number, messages: () => Message[] = childMessages): Promise<string[]> {
	initTheme("dark", false);
	setKeybindings(new KeybindingsManager());
	const task = taskRecord("inner-tools");
	const notice = taskCompletionNotice(
		{
			completionId: "completion-inner-tools",
			ownerId: task.ref.ownerId,
			taskId: task.ref.taskId,
			terminalSequence: "1" as Sequence,
			result: { kind: "completed", output: task.output },
			display: false,
		},
		{ kind: "agent", title: "Run the fixture", agentName: "worker" },
		"Fixture done",
	);
	let loaded = false;
	const message = new TaskCompletionMessage(notice, true, {
		loadTranscript: () => messages().map((message) => ({ type: "message", message })) as never,
		getToolDefinition,
		requestRender: () => {
			loaded = true;
		},
	});
	message.render(width);
	for (let i = 0; i < 20 && !loaded; i++) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.ok(loaded, "the notice loaded its transcript");
	// A notice holding many rows draws them a slice per render, asking for the next render until all are drawn.
	let rows: string[];
	do {
		loaded = false;
		rows = message.render(width);
		await new Promise((resolve) => setImmediate(resolve));
	} while (loaded);
	return rows;
}

test.each([50, 100, 160])(
	"an expanded subagent card draws its child's tool calls expanded, the whole script included, at width %i (#5525)",
	(width) => {
		assertInnerToolsExpanded(renderExpandedCard(width), width);
	},
);

test.each([24, 30])(
	"an expanded subagent card wraps its child's whole script and output within a narrow width %i (#5525)",
	(width) => {
		assertExpandedWithin(renderExpandedCard(width), width);
	},
);

test.each([50, 100, 160])(
	"an expanded finished-task notice draws the child's tool calls expanded, the whole script included, at width %i (#5525)",
	async (width) => {
		assertInnerToolsExpanded(await renderExpandedNotice(width), width);
	},
);

test.each([24, 30])(
	"an expanded finished-task notice wraps the child's whole script and output within a narrow width %i (#5525)",
	async (width) => {
		assertExpandedWithin(await renderExpandedNotice(width), width);
	},
);

test("an HTML export's expanded subagent card draws the child's tool calls with their own renderers, expanded (#5525)", () => {
	initTheme("dark", false);
	setKeybindings(new KeybindingsManager());
	const subagent: ToolDefinition<typeof SubagentParams, Details, SubagentResultRenderState> = {
		name: "subagent",
		label: "Subagent",
		description: "Export fixture",
		parameters: SubagentParams,
		execute: async () => {
			throw new Error("Rendering must not execute the tool");
		},
		renderCall: (args, theme, context) => renderSubagentToolCall(args as SubagentParamsLike, theme, context),
		renderResult: renderSubagentToolResult,
	};
	const renderer = createToolHtmlRenderer({
		getToolRenderers: (name) => (name === "subagent" ? subagent : getToolDefinition(name)),
		theme,
		cwd: process.cwd(),
	});
	renderer.renderCall("parent", "subagent", { agent: "worker", task: "Run the fixture" });
	const result = renderer.renderResult("parent", "subagent", [], subagentResultDetails(), false);
	const rows = exportedText(result?.expanded ?? "").split("\n");
	assertInnerToolsExpanded(rows, 100);
});

/** A script whose every line holds wide characters, an emoji and a combining mark. */
const WIDE_LINES = 11;
const WIDE_SCRIPT = `${"// 漢字😀e\u0301甲乙丙\n".repeat(WIDE_LINES)}return 1;`;
const WIDE_MARKS = ["漢", "字", "😀", "e\u0301", "甲", "乙", "丙"];

function wideScriptMessages(): Message[] {
	return [
		{ role: "user", content: "Run the fixture", timestamp: 1 },
		fauxAssistantMessage([fauxToolCall("codemode", { code: WIDE_SCRIPT }, { id: "wide" })], {
			stopReason: "toolUse",
		}),
		{
			role: "toolResult",
			toolCallId: "wide",
			toolName: "codemode",
			content: [{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" }],
			details: { calls: [] },
			isError: false,
			timestamp: 2,
		},
		fauxAssistantMessage("Fixture done"),
	];
}

/** The widths at which the rows lose a script character or overflow, with what they lose. */
function wideScriptLosses(rowsAt: (width: number) => readonly string[], widths: readonly number[]): unknown[] {
	const losses: unknown[] = [];
	for (const width of widths) {
		const rows = rowsAt(width);
		const plain = rows.map(stripTerminalSequences).join("\n");
		const lost = WIDE_MARKS.filter((mark) => plain.split(mark).length - 1 !== WIDE_LINES);
		const overflow = rows.filter((row) => visibleWidth(row) > width);
		if (lost.length > 0 || overflow.length > 0) losses.push({ width, lost, overflow });
	}
	return losses;
}

const NARROW_TO_WIDE = Array.from({ length: 197 }, (_, i) => i + 4);

test("an expanded subagent card keeps every character of the script, wide ones included, at every width from 4 to 200 (#5525)", () => {
	assert.deepEqual(
		wideScriptLosses((width) => renderExpandedCard(width, wideScriptMessages()), NARROW_TO_WIDE),
		[],
	);
});

test("an expanded finished-task notice keeps every character of the script, wide ones included, at every width from 4 to 200 (#5525)", async () => {
	const rows = new Map<number, string[]>();
	for (const width of NARROW_TO_WIDE) rows.set(width, await renderExpandedNotice(width, wideScriptMessages));
	assert.deepEqual(
		wideScriptLosses((width) => rows.get(width) ?? [], NARROW_TO_WIDE),
		[],
	);
});
