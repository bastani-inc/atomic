import assert from "node:assert/strict";
import { resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { CURSOR_MARKER, getKeybindings, setKeybindings, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import {
	BUILTIN_SLASH_COMMANDS,
	BUNDLED_EXTENSION_SLASH_COMMANDS,
} from "../../packages/coding-agent/src/core/slash-commands.js";
import type { ModelParallelResponse, TaskId, WaitId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { ToolExecutionComponent } from "../../packages/coding-agent/src/modes/interactive/components/tool-execution.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agents.js";
import { DEFAULT_PROMPT_GUIDANCE } from "../../packages/subagents/src/extension/prompt-guidance.js";
import {
	renderSubagentToolCall,
	renderSubagentToolResult,
} from "../../packages/subagents/src/extension/tool-rendering.js";
import { taskToolResult } from "../../packages/subagents/src/runs/foreground/task-execution.js";
import { AgentBrowser } from "../../packages/subagents/src/tui/agent-browser.js";
import { moduleDir, readText } from "../helpers/runtime.js";
import { taskRecord } from "../helpers/task-record.js";

const agent = (name: string, source: AgentConfig["source"]): AgentConfig => ({
	name,
	source,
	description: `Investigate ${name} failures`,
	systemPrompt: "Read the evidence before proposing a fix.",
	filePath: `/agents/${name}.md`,
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
});

test("task and agent commands are discoverable through the command catalogs", () => {
	assert.ok(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "tasks"));
	assert.ok(BUNDLED_EXTENSION_SLASH_COMMANDS.find((command) => command.name === "agents"));
});

test("agent browser groups definitions, filters, opens details and returns without launching", () => {
	initTheme("dark");
	let closed = false;
	const browser = new AgentBrowser(
		[agent("worker", "builtin"), agent("review", "project")],
		theme,
		() => {
			closed = true;
		},
		() => 30,
	);
	const text = () => browser.render(80).map(stripVTControlCharacters).join("\n");
	assert.ok(text().indexOf("Project agents") < text().indexOf("Built-in agents"));
	browser.handleInput("worker");
	assert.ok(!text().includes("review"));
	browser.handleInput("\r");
	assert.match(text(), /Description/);
	assert.match(text(), /Inherits the current model/);
	assert.match(text(), /Inherited tools/);
	browser.handleInput("\x1b");
	assert.equal(closed, false);
	browser.handleInput("\x1b");
	assert.equal(closed, true);
});

test("agent browser bounds long labels and details at narrow dimensions", () => {
	initTheme("dark");
	const browser = new AgentBrowser(
		[agent("界".repeat(100), "user")],
		theme,
		() => {},
		() => 16,
	);
	for (const detail of [false, true]) {
		if (detail) browser.handleInput("\r");
		for (const width of [12, 48, 100]) {
			const rows = browser.render(width);
			assert.ok(rows.length <= 12);
			assert.ok(rows.every((row) => visibleWidth(row) <= width));
		}
	}
});

test("catalog pins focused search and selected name while scrolling or shrinking", () => {
	initTheme("dark");
	let height = 24;
	const browser = new AgentBrowser(
		Array.from({ length: 20 }, (_, i) => agent(`agent-${String(i).padStart(2, "0")}`, "user")),
		theme,
		() => {},
		() => height,
	);
	browser.focused = true;
	for (let i = 0; i < 14; i++) browser.handleInput("\x1b[B");
	for (height of [24, 8]) {
		const text = browser.render(48).join("\n");
		assert.ok(text.includes(CURSOR_MARKER), "focused input stays mounted");
		assert.match(stripVTControlCharacters(text), /› agent-14/);
	}
});

test("prefilled catalog search edits from the end", () => {
	initTheme("dark");
	const browser = new AgentBrowser(
		[agent("worker", "user")],
		theme,
		() => {},
		() => 24,
		"work",
	);
	browser.handleInput("er");
	assert.match(stripVTControlCharacters(browser.render(80).join("\n")), /› worker/);
	browser.handleInput("\x7f");
	assert.match(stripVTControlCharacters(browser.render(80).join("\n")), /Search: worke/);
});

test("background receipt is readable without changing model-facing task identity", () => {
	initTheme("dark");
	const result = taskToolResult({
		kind: "admitted",
		observation: {
			kind: "yielded",
			taskId: "task-fixture" as TaskId,
			waitId: "wait-fixture" as WaitId,
			reason: "explicit",
		},
	});
	const original = JSON.stringify(result);
	const view = renderSubagentToolResult(result, { expanded: false, isPartial: false }, theme, {
		toolCallId: "ui-fixture",
		state: {},
		invalidate() {},
	});
	const text = stripVTControlCharacters(view.render(80).join("\n"));
	assert.match(text, /Launched in background/);
	assert.match(text, /\/tasks/);
	assert.doesNotMatch(text, /wait-fixture|"observation"/);
	assert.equal(JSON.stringify(result), original);
});

test("parallel receipts identify each sibling and preserve errors at narrow widths", () => {
	initTheme("dark");
	const context = { toolCallId: "parallel-ui", state: {}, invalidate() {} };
	renderSubagentToolCall(
		{
			tasks: [
				{ agent: "reader", task: "Read" },
				{ agent: "checker", task: "Check" },
			],
		},
		theme,
		context,
	);
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
	};
	const text = (expanded: boolean) =>
		stripVTControlCharacters(
			renderSubagentToolResult(result, { expanded, isPartial: false }, theme, context).render(80).join("\n"),
		);
	assert.match(text(false), /2 agent tasks/);
	assert.match(text(false), /├─.*reader/);
	assert.match(text(false), /└─.*checker/);
	assert.match(text(false), /Check failed/);
	assert.doesNotMatch(text(false), /task-a/);
	assert.match(text(true), /task-a/);
	for (const width of [12, 48, 100])
		assert.ok(
			renderSubagentToolResult(result, { expanded: true, isPartial: false }, theme, context)
				.render(width)
				.every((line) => visibleWidth(line) <= width),
		);
});

test("wait and task status results use readable displays without relaunch language", () => {
	initTheme("dark");
	const context = { toolCallId: "wait-ui", state: {}, invalidate() {} };
	renderSubagentToolCall({ action: "wait", id: "task-a" }, theme, context);
	const result = taskToolResult({
		kind: "admitted",
		observation: { kind: "yielded", taskId: "task-a" as TaskId, waitId: "wait-a" as WaitId, reason: "elapsed" },
	});
	const text = stripVTControlCharacters(
		renderSubagentToolResult(result, { expanded: false, isPartial: false }, theme, context).render(80).join("\n"),
	);
	assert.match(text, /Still running in background/);
	assert.doesNotMatch(text, /Launched/);
	const status = renderSubagentToolResult(
		{
			content: [{ type: "text", text: "raw model receipt" }],
			details: { mode: "management", results: [], taskRecords: [taskRecord("task-a")] },
		},
		{ expanded: false, isPartial: false },
		theme,
		context,
	);
	assert.match(stripVTControlCharacters(status.render(80).join("\n")), /running/);
	assert.doesNotMatch(stripVTControlCharacters(status.render(80).join("\n")), /raw model receipt/);
});

test("orchestrator guidance acknowledges background subagent support", () => {
	const guidance = DEFAULT_PROMPT_GUIDANCE.join("\n");
	assert.match(guidance, /Background subagents are supported/);
	assert.doesNotMatch(guidance, /Foreground execution is the only/);
});

test("background bash results show observation status rather than finished timing or raw task receipts", () => {
	initTheme("dark");
	const component = new ToolExecutionComponent(
		"bash",
		"bash-ui",
		{ command: "sleep 20" },
		{},
		undefined,
		{ requestRender() {} } as TUI,
		process.cwd(),
	);
	const result = {
		content: [
			{
				type: "text" as const,
				text: "first output\n\nCommand is still running (task shell-id). Its execution timeout stops it after 300 seconds; launch it with a larger timeout (up to 3600 seconds) for a longer run.",
			},
		],
		details: { observation: { kind: "yielded", taskId: "shell-id", waitId: "wait-id", reason: "elapsed" } },
		isError: false,
	};
	const original = JSON.stringify(result);
	try {
		component.updateResult(result);
		const compact = stripVTControlCharacters(component.render(80).join("\n"));
		assert.match(compact, /Continued in background/);
		assert.match(compact, /first output/);
		assert.doesNotMatch(compact, /Command is still running|execution timeout|shell-id|Took/);
		component.setExpanded(true);
		assert.match(stripVTControlCharacters(component.render(80).join("\n")), /shell-id/);
		assert.equal(JSON.stringify(result), original);
	} finally {
		component.dispose();
	}
});

test("a background bash result hides exactly its still-running receipt (#4639)", () => {
	initTheme("dark");
	const render = (text: string): string => {
		const component = new ToolExecutionComponent(
			"bash",
			"bash-ui",
			{ command: "sleep 20" },
			{},
			undefined,
			{ requestRender() {} } as TUI,
			process.cwd(),
		);
		try {
			component.updateResult({
				content: [{ type: "text" as const, text }],
				details: { observation: { kind: "yielded", taskId: "shell-id", waitId: "wait-id", reason: "elapsed" } },
				isError: false,
			});
			return stripVTControlCharacters(component.render(80).join("\n"));
		} finally {
			component.dispose();
		}
	};
	const receipt =
		"Command is still running (task shell-id). Its execution timeout stops it after 300 seconds; launch it with a larger timeout (up to 3600 seconds) for a longer run.";
	assert.equal(render(`first output\n\n${receipt}`), render("first output"));
	assert.match(render("first output"), /first output/);
	assert.doesNotMatch(render(receipt), /still running|execution timeout/);
});

test("collapsed agent list advertises the actual expand binding", () => {
	initTheme("dark");
	const previous = getKeybindings();
	const context = { toolCallId: "agent-list", state: {}, invalidate() {} };
	const result = {
		content: [{ type: "text" as const, text: "Executable agents:\n- worker\n- debugger" }],
		details: { mode: "management" as const, results: [] },
	};
	const render = (expanded = false) =>
		stripVTControlCharacters(
			renderSubagentToolResult(result, { expanded, isPartial: false }, theme, context).render(100).join("\n"),
		);
	try {
		setKeybindings(new KeybindingsManager());
		assert.match(render(), /\(ctrl\+o Expand\)/);
		setKeybindings(new KeybindingsManager({ "app.tools.expand": "ctrl+e" }));
		assert.match(render(), /\(ctrl\+e Expand\)/);
		setKeybindings(new KeybindingsManager({ "app.tools.expand": [] }));
		assert.doesNotMatch(render(), /Expand/);
		assert.match(render(true), /worker[\s\S]*debugger/);
	} finally {
		setKeybindings(previous);
	}
});

test("bundled background documentation and guidance do not reintroduce foreground-only claims", async () => {
	const root = resolve(moduleDir(import.meta.url), "../..");
	for (const path of [
		"packages/subagents/README.md",
		"packages/subagents/skills/subagent/SKILL.md",
		"packages/subagents/skills/tmux/SKILL.md",
		"packages/coding-agent/docs/background-tasks.md",
	]) {
		const text = await readText(resolve(root, path));
		assert.match(text, /background/i, path);
		assert.doesNotMatch(
			text,
			/always run in the foreground|every execution request is foreground|All subagent execution runs in the foreground|Use foreground runs for every|tools do not provide background execution/i,
			path,
		);
	}
	assert.match(DEFAULT_PROMPT_GUIDANCE.join("\n"), /automatically yields on budget expiry/);
});
