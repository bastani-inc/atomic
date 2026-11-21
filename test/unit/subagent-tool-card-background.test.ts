import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { type TUI, visibleWidth } from "@bastani/atomic-tui";
import { test } from "vitest";
import type { ToolDefinition } from "../../packages/coding-agent/src/core/extensions/types.js";
import type { ModelParallelResponse, TaskId, WaitId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { ToolExecutionComponent } from "../../packages/coding-agent/src/modes/interactive/components/tool-execution.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
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

function assertUnshadedToolBlock(lines: string[], width: number): void {
	assert.equal(lines[0], "", "one unshaded spacer precedes the host block");
	assert.notEqual(stripVTControlCharacters(lines[1] ?? "").trim(), "", "header immediately follows spacer");
	assert.ok(!lines.join("").includes("\u001b[48;"), "no tool block row paints a background color");
	for (const [index, line] of lines.entries()) {
		assert.ok(visibleWidth(line) <= width, `row ${index} fits ${width} columns`);
	}
}

test("single background launch renders unshaded Agent tool block with short task title", () => {
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
		assert.match(text, /◯ Agent\(worker · Intercom foreground smoke test only\.\)/);
		assert.match(text, /⎿ {2}Running/);
		assert.doesNotMatch(text, /\/tasks to inspect output and manage tasks|Do not edit files/);
		assertUnshadedToolBlock(lines, 120);
	} finally {
		card.dispose();
	}
});

test("subagent tool call heading truncates a long task with a styled ellipsis (#5243)", () => {
	initTheme("dark");
	const callHeading =
		renderSubagentToolCall({ agent: "worker", task: longTask }, theme, {
			toolCallId: "heading-fixture",
			state: {},
			invalidate() {},
		}).render(140)[0] ?? "";
	assert.doesNotMatch(callHeading, /\x1b\[0m\.\.\.\x1b\[0m/);
});

for (const themeName of ["dark", "light"] as const) {
	test(`single launch and result remain unshaded and bounded through resize and expansion (${themeName})`, () => {
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
					assertUnshadedToolBlock(lines, width);
					const text = stripVTControlCharacters(lines.join("\n"));
					if (width >= 20) {
						assert.equal(text.match(/Agent\(/g)?.length, 1, `${state} width ${width}:\n${text}`);
					}
					assert.doesNotMatch(text, /\/tasks|wait-fixture/);
					if (state === "expanded" && width >= 24) {
						assert.match(text, /Prompt[\s\S]*Tool calls[\s\S]*Result/);
					}
				}
			}
			assert.equal(JSON.stringify({ args, result }), original, "rendering preserves execution inputs and receipts");
		} finally {
			card.dispose();
		}
	});

	test(`parallel launch and result render one unshaded block per child after resize (${themeName})`, () => {
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
			for (const width of [120, 48, 12, 120]) assertUnshadedToolBlock(card.render(width), width);
			card.updateResult(result);
			for (const expanded of [false, true, false]) {
				card.setExpanded(expanded);
				for (const width of [120, 48, 12, 120]) {
					const lines = card.render(width);
					assertUnshadedToolBlock(lines, width);
					const text = stripVTControlCharacters(lines.join("\n"));
					if (width >= 20) {
						assert.equal(text.match(/Agent\(/g)?.length, 2, `expanded ${expanded} width ${width}:\n${text}`);
					}
					assert.doesNotMatch(text, /\/tasks|wait-a/);
					if (width >= 48) {
						assert.match(text, /Running/);
						assert.match(text, /Failed · Check failed/);
					}
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

	test(`status card renders unshaded through resize and expansion (${themeName})`, () => {
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
					assertUnshadedToolBlock(lines, width);
					const text = stripVTControlCharacters(lines.join("\n"));
					if (width >= 24) assert.match(text, /Running/);
					if (expanded && width >= 48) assert.match(text.replace(/\s/g, ""), /Residency:loaded/);
					else if (!expanded) assert.doesNotMatch(text, /Residency:|Session:/);
				}
			}
		} finally {
			card.dispose();
		}
	});
}

test("a child released while it waits shows waiting on its launch card, not paused or stopped (#5031)", () => {
	initTheme("dark");
	const response = {
		kind: "admitted" as const,
		observation: {
			kind: "settled" as const,
			taskId: "task-released" as TaskId,
			result: {
				kind: "cancelled" as const,
				cause: "pause" as const,
				released: { waitingOn: [{ toolCallId: "wait-1", toolName: "bash" }] },
			},
		},
	};
	const card = createCard({ agent: "worker", task: "build" });
	card.updateResult({
		content: [{ type: "text" as const, text: JSON.stringify(response) }],
		details: { mode: "single" as const, results: [], taskResponse: response },
		isError: false,
	});
	const text = stripVTControlCharacters(card.render(120).join("\n"));
	assert.match(text, /◌ Agent/);
	assert.match(text, /Waiting on bash/);
	assert.doesNotMatch(text, /⏸|Paused|awaiting resume|Stopped/);
});
