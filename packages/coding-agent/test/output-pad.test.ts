import assert from "node:assert/strict";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, test } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.js";
import { createEditToolDefinition } from "../src/core/tools/edit.js";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.js";
import { BranchSummaryMessageComponent } from "../src/modes/interactive/components/branch-summary-message.js";
import { renderChatMessageEntry } from "../src/modes/interactive/components/chat-message-renderer.js";
import { CompactionBoundaryMessageComponent } from "../src/modes/interactive/components/compaction-boundary-message.js";
import { CustomEntryComponent } from "../src/modes/interactive/components/custom-entry.js";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.js";
import type { InteractiveEngineCommand } from "../src/modes/interactive-engine/protocol.js";
import { stripAnsi } from "../src/utils/ansi.js";

const ui = {
	terminal: { columns: 80, rows: 24 },
	addInterval: () => ({ dispose: () => {} }),
	removeInterval: () => {},
	requestRender: () => {},
} as unknown as TUI;
const tool: ToolDefinition = {
	name: "custom_tool",
	label: "custom_tool",
	description: "custom tool",
	parameters: Type.Unknown(),
	execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
};
type OutputPaddedComponent = Component & { setOutputPad(outputPad: number): void };
function renderLines(component: Component): string[] {
	return component
		.render(60)
		.map((line) => stripAnsi(line).trimEnd())
		.filter((line) => /[\w$(]/.test(line));
}
function createTool(definition: ToolDefinition | undefined, outputPad: number): ToolExecutionComponent {
	const component = new ToolExecutionComponent("custom_tool", "id", {}, { outputPad }, definition, ui, "/");
	component.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
	return component;
}
const components: Array<{ name: string; create: (outputPad: number) => OutputPaddedComponent }> = [
	{
		name: "bash execution",
		create: (outputPad) => {
			const component = new BashExecutionComponent("pwd", ui, false, outputPad);
			component.appendOutput("/tmp");
			component.setComplete(1, false);
			return component;
		},
	},
	{ name: "tool execution", create: (outputPad) => createTool(tool, outputPad) },
	{ name: "tool execution without a definition", create: (outputPad) => createTool(undefined, outputPad) },
	{
		name: "edit result",
		create: (outputPad) => {
			const component = new ToolExecutionComponent(
				"edit",
				"id",
				{ input: "[file.txt#abcd]" },
				{ outputPad },
				createEditToolDefinition("/"),
				ui,
				"/",
			);
			component.updateResult({ content: [{ type: "text", text: "Could not find old text" }], isError: true });
			return component;
		},
	},
	{
		name: "compaction boundary",
		create: (outputPad) =>
			new CompactionBoundaryMessageComponent(
				{
					text: "summary",
					rung: "planned",
					stats: {
						linesBefore: 10,
						linesDeleted: 5,
						linesKept: 5,
						rangeCount: 1,
						tokensBefore: 10,
						tokensAfter: 5,
						percentReduction: 50,
					},
				},
				outputPad,
			),
	},
	{
		name: "branch summary",
		create: (outputPad) =>
			new BranchSummaryMessageComponent(
				{ role: "branchSummary", summary: "summary", fromId: "branch", timestamp: 0 },
				undefined,
				true,
				outputPad,
			),
	},
	{
		name: "custom message",
		create: (outputPad) =>
			new CustomMessageComponent(
				{ role: "custom", customType: "notice", content: "hello", display: true, timestamp: 0 },
				undefined,
				undefined,
				outputPad,
			),
	},
	{
		name: "custom entry renderer failure",
		create: (outputPad) =>
			new CustomEntryComponent(
				{
					type: "custom",
					customType: "notice",
					id: "entry",
					parentId: null,
					timestamp: new Date(0).toISOString(),
					data: {},
				},
				() => {
					throw new Error("failure");
				},
				outputPad,
			),
	},
];
components.push({
	name: "skill invocation with user message",
	create: (outputPad) =>
		renderChatMessageEntry(
			{
				kind: "user",
				role: "user",
				text: '<skill name="example" location="/tmp/example/SKILL.md">\nSkill instructions\n</skill>\nUser request',
			},
			{ ui, cwd: "/", outputPad },
		) as OutputPaddedComponent,
});
beforeAll(() => initTheme("dark"));
test.each(components)("$name renders at outputPad 0 and 1", ({ create }) => {
	const component = create(0);
	const lines = renderLines(component);
	assert.ok(lines.length > 0);
	assert.deepEqual(
		lines.filter((line) => line.startsWith(" ")),
		[],
	);
	component.setOutputPad(1);
	assert.deepEqual(
		renderLines(component),
		lines.map((line) => ` ${line}`),
	);
});

test("restored isolated tool rows preserve output padding and support updates", () => {
	const commands: InteractiveEngineCommand[] = [];
	const runtime = Object.assign(Object.create(IsolatedInteractiveRuntime.prototype), {
		onEngineMessage: () => () => {},
		sendEngineCommand: (command: InteractiveEngineCommand) => commands.push(command),
	}) as IsolatedInteractiveRuntime;
	const mode = {
		runtimeHost: runtime,
		ui,
		outputPad: 0,
		sessionManager: { getCwd: () => "/" },
		settingsManager: {
			getShowImages: () => false,
			getImageWidthCells: () => 60,
			getLatexRenderingEnabled: () => false,
		},
		getMarkdownThemeWithSettings: () => undefined,
		getMarkdownTransformers: () => [],
	} as unknown as InteractiveMode;
	const options = InteractiveMode.prototype.chatMessageRenderOptions.call(mode);
	const component = options.createToolComponent!({
		role: "tool",
		kind: "tool",
		toolName: "bash",
		toolCallId: "restored",
		args: {},
	}) as OutputPaddedComponent;
	component.render(60);
	assert.equal(commands.at(-1)?.type, "engine_tool_render");
	assert.equal((commands.at(-1) as Extract<InteractiveEngineCommand, { type: "engine_tool_render" }>).outputPad, 0);
	component.setOutputPad(1);
	component.render(60);
	assert.equal((commands.at(-1) as Extract<InteractiveEngineCommand, { type: "engine_tool_render" }>).outputPad, 1);
});
