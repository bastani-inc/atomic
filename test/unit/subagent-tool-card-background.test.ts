import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { Terminal } from "@xterm/headless";
import { test } from "vitest";
import type { ToolDefinition } from "../../packages/coding-agent/src/core/extensions/types.js";
import type { ModelParallelResponse, TaskId, WaitId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { ToolExecutionComponent } from "../../packages/coding-agent/src/modes/interactive/components/tool-execution.js";
import { initTheme, type ThemeBg, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { SubagentParams } from "../../packages/subagents/src/extension/schemas.js";
import {
	renderSubagentToolCall,
	renderSubagentToolResult,
} from "../../packages/subagents/src/extension/tool-rendering.js";
import type { SubagentParamsLike } from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import { taskToolResult } from "../../packages/subagents/src/runs/foreground/task-execution.js";
import type { Details } from "../../packages/subagents/src/shared/types.js";
import type { SubagentResultRenderState } from "../../packages/subagents/src/tui/render.js";

const longTask =
	"Intercom foreground smoke test only. Do not edit files, inspect repository, or launch workflows/subagents. Report readiness and wait for the parent.";

function createCard(args: SubagentParamsLike): ToolExecutionComponent {
	const definition: ToolDefinition<typeof SubagentParams, Details, SubagentResultRenderState> = {
		name: "subagent",
		label: "Subagent",
		description: "Subagent rendering fixture",
		parameters: SubagentParams,
		execute: async () => {
			throw new Error("Rendering must not execute the tool");
		},
		renderCall: (args, theme, context) => renderSubagentToolCall(args as SubagentParamsLike, theme, context),
		renderResult: renderSubagentToolResult,
	};
	return new ToolExecutionComponent(
		"subagent",
		"background-card-fixture",
		args,
		{},
		definition,
		{ requestRender() {} } as TUI,
		process.cwd(),
	);
}

async function assertFullBackground(lines: string[], width: number, background: ThemeBg): Promise<void> {
	assert.equal(lines[0], "", "one unshaded spacer precedes the host card");
	// Wrapped content may contain blank rows; padding is the card's outer frame.
	assert.equal(stripVTControlCharacters(lines[1]!).trim(), "", "one top padding row");
	assert.notEqual(stripVTControlCharacters(lines[2]!).trim(), "", "heading immediately follows padding");
	assert.equal(stripVTControlCharacters(lines.at(-1)!).trim(), "", "one bottom padding row");
	assert.notEqual(stripVTControlCharacters(lines.at(-2)!).trim(), "", "content immediately precedes padding");
	const terminal = new Terminal({ cols: width, rows: lines.length + 1, allowProposedApi: true });
	try {
		// Let the terminal decode both the theme reference and the complete host-rendered ANSI.
		await new Promise<void>((resolve) =>
			terminal.write(`${theme.bg(background, " ")}\r\n${lines.join("\r\n")}`, resolve),
		);
		const expected = terminal.buffer.active.getLine(0)?.getCell(0);
		assert.ok(expected && !expected.isBgDefault(), "the theme reference is shaded");
		for (let row = 1; row < lines.length; row++) {
			assert.equal(visibleWidth(lines[row]!), width, `row ${row} fills ${width} columns`);
			for (let column = 0; column < width; column++) {
				const cell = terminal.buffer.active.getLine(row + 1)?.getCell(column);
				assert.ok(cell);
				assert.deepEqual(
					[cell.getBgColorMode(), cell.getBgColor()],
					[expected.getBgColorMode(), expected.getBgColor()],
					`row ${row}, column ${column}, width ${width}: ${JSON.stringify(lines[row])}`,
				);
			}
		}
	} finally {
		terminal.dispose();
	}
}

test("single background launch shades every terminal cell after truncating a long task", async () => {
	initTheme("dark");
	const card = createCard({ agent: "worker", task: longTask });
	try {
		const result = taskToolResult({
			kind: "admitted",
			observation: {
				kind: "yielded",
				taskId: "task-fixture" as TaskId,
				waitId: "wait-fixture" as WaitId,
				reason: "explicit",
			},
		});
		card.updateResult({ ...result, isError: false });
		const lines = card.render(120);
		const text = stripVTControlCharacters(lines.join("\n"));
		assert.match(text, /workflows\/s\.\.\./);
		assert.match(text, /∀ Launched in background/);
		assert.match(text, /\/tasks to inspect output and manage tasks/);
		await assertFullBackground(lines, 120, "toolSuccessBg");
	} finally {
		card.dispose();
	}
});

for (const themeName of ["dark", "light"] as const) {
	test(`single launch and result remain fully shaded through resize and expansion (${themeName})`, async () => {
		initTheme(themeName);
		const args = { agent: "worker", task: `Inspect ${"界".repeat(60)} ${longTask}` };
		const result = taskToolResult({
			kind: "admitted",
			observation: {
				kind: "yielded",
				taskId: "task-fixture" as TaskId,
				waitId: "wait-fixture" as WaitId,
				reason: "explicit",
			},
		});
		const original = JSON.stringify({ args, result });
		const card = createCard(args);
		try {
			for (const state of ["pending", "partial", "final", "expanded"]) {
				if (state !== "pending") card.updateResult({ ...result, isError: false }, state === "partial");
				card.setExpanded(state === "expanded");
				for (const width of [120, 48, 12, 120]) {
					const lines = card.render(width);
					await assertFullBackground(
						lines,
						width,
						state === "pending" || state === "partial" ? "toolPendingBg" : "toolSuccessBg",
					);
					const text = stripVTControlCharacters(lines.join("\n"));
					// Count the tool heading, not "subagents" inside the expanded task text.
					assert.equal(text.match(/^ +subagent(?: |$)/gm)?.length, 1, `${state} width ${width}:\n${text}`);
					if (state !== "pending") assert.equal(text.match(/\/tasks/g)?.length, 1);
					if (state === "expanded") assert.match(text.replace(/\s/g, ""), /task-fixture/);
					else assert.doesNotMatch(text, /task-fixture|wait-fixture/);
				}
			}
			assert.equal(JSON.stringify({ args, result }), original, "rendering preserves execution inputs and receipts");
		} finally {
			card.dispose();
		}
	});

	test(`parallel launch and result share one full-width background after resize (${themeName})`, async () => {
		initTheme(themeName);
		const args = { tasks: [{ agent: "worker", task: longTask, count: 2 }] };
		const response: ModelParallelResponse = {
			kind: "parallel",
			slots: [
				{
					ordinal: 0,
					outcome: {
						kind: "admitted",
						observation: {
							kind: "yielded",
							taskId: "task-a" as TaskId,
							waitId: "wait-a" as WaitId,
							reason: "explicit",
						},
					},
				},
				{
					ordinal: 1,
					outcome: {
						kind: "admitted",
						observation: {
							kind: "settled",
							taskId: "task-b" as TaskId,
							result: { kind: "failed", code: "Probe", message: "Check failed" },
						},
					},
				},
			],
		};
		const result = {
			content: [{ type: "text" as const, text: JSON.stringify(response) }],
			details: { mode: "parallel" as const, results: [], taskResponse: response },
			isError: true,
		};
		const original = JSON.stringify({ args, result });
		const card = createCard(args);
		try {
			for (const width of [120, 48, 12, 120]) await assertFullBackground(card.render(width), width, "toolPendingBg");
			card.updateResult(result);
			for (const expanded of [false, true, false]) {
				card.setExpanded(expanded);
				for (const width of [120, 48, 12, 120]) {
					const lines = card.render(width);
					await assertFullBackground(lines, width, "toolErrorBg");
					const text = stripVTControlCharacters(lines.join("\n"));
					assert.equal(
						text.match(/^ +subagent(?: |$)/gm)?.length,
						1,
						`expanded ${expanded} width ${width}:\n${text}`,
					);
					assert.equal(text.match(/\/tasks/g)?.length, 1);
					assert.match(text, /Launched\s+in\s+background/);
					// Collapsed, a failed child's error is one line cut to the card width (#4697).
					assert.match(text, expanded || width > 12 ? /Check\s+failed/ : / {3}Check ?\S*…/);
					if (expanded) assert.match(text, /task-a[\s\S]*task-b/);
					else assert.doesNotMatch(text, /task-a|task-b|wait-a/);
				}
			}
			assert.equal(
				JSON.stringify({ args, result }),
				original,
				"rendering preserves parallel identities and outcomes",
			);
		} finally {
			card.dispose();
		}
	});

	test(`status card preserves its full host background through resize and expansion (${themeName})`, async () => {
		initTheme(themeName);
		const card = createCard({ action: "status", id: "43ad4599" });
		const result = {
			content: [{ type: "text" as const, text: "Parent: 43ad4599" }],
			details: {
				mode: "management" as const,
				results: [],
				statusGroups: [
					{
						parentPath: "43ad4599",
						children: [
							{
								path: `43ad4599/debugger_${"界".repeat(70)}_1`,
								parentPath: "43ad4599",
								taskName: `debugger_${"界".repeat(70)}`,
								depth: 1,
								status: "running" as const,
								loaded: true,
								sessionFile: "/sessions/43ad4599/debugger_1.jsonl",
							},
						],
					},
				],
			},
			isError: false,
		};
		try {
			card.updateResult(result);
			for (const expanded of [false, true, false]) {
				card.setExpanded(expanded);
				for (const width of [120, 48, 12, 120]) {
					const lines = card.render(width);
					await assertFullBackground(lines, width, "toolSuccessBg");
					const text = stripVTControlCharacters(lines.join("\n"));
					assert.match(text, /Running/);
					if (expanded) assert.match(text.replace(/\s/g, ""), /Residency:loaded/);
					else assert.doesNotMatch(text, /Residency:|Session:/);
				}
			}
		} finally {
			card.dispose();
		}
	});
}
