import assert from "node:assert/strict";
import { stripTerminalSequences, Text, type TUI, visibleWidth } from "@bastani/atomic-tui";
import { Type } from "typebox";
import { beforeAll, test, vi } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { createToolDefinition } from "../src/core/tools/index.ts";
import { createPowerShellToolDefinition } from "../src/core/tools/powershell.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { ToolBlock } from "../src/modes/interactive/components/tool-block.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => initTheme("dark", false));
const ui = { requestRender() {} } as TUI;
const definition: ToolDefinition = {
	name: "sample",
	label: "Sample",
	description: "Inspect the sample",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: "result" }], details: {} }),
	renderCall: () => new Text("Sample(value)", 0, 0),
	renderResult: () => new Text("result\ncontinued", 0, 0),
};

test("the shared execution component owns glyph, result connectors and spacing for extension renderers (#5224)", () => {
	const component = new ToolExecutionComponent("sample", "sample-call", {}, {}, definition, ui, "/workspace");
	try {
		component.updateResult({ content: [{ type: "text", text: "result" }], isError: false });
		for (const width of [80, 160]) {
			const rows = component.render(width);
			assert.deepEqual(
				rows.map((line) => stripTerminalSequences(line).trimEnd()),
				["", " ● Sample(value)", "   ⎿  result", "      continued"],
			);
			assert.ok(rows.every((line) => visibleWidth(line) <= width));
			assert.ok(!rows.join("").includes("\u001b[48;"));
		}
	} finally {
		component.dispose();
	}
});

test("built-in presentation stays canonical while explicit renderer overrides keep private content hidden (#5224)", () => {
	const original = createReadToolDefinition("/workspace");
	const ordinary = new ToolExecutionComponent(
		"read",
		"read-call",
		{ path: "/workspace/sample.ts" },
		{},
		original,
		ui,
		"/workspace",
	);
	const custom = new ToolExecutionComponent(
		"read",
		"private-call",
		{ path: "/workspace/private-key.txt" },
		{},
		{
			...original,
			renderCall: () => new Text("Private inspection", 0, 0),
			renderResult: () => new Text("Redacted result", 0, 0),
		},
		ui,
		"/workspace",
	);
	try {
		ordinary.updateResult({ content: [{ type: "text", text: "first\nsecond" }], isError: false });
		custom.updateResult({ content: [{ type: "text", text: "secret content" }], isError: false });
		const plain = (component: ToolExecutionComponent) => component.render(80).map(stripTerminalSequences).join("\n");
		assert.match(plain(ordinary), /● Read\(sample\.ts\)/);
		assert.match(plain(ordinary), /⎿ {2}Read 2 lines/);
		assert.match(plain(custom), /Private inspection/);
		assert.match(plain(custom), /Redacted result/);
		assert.doesNotMatch(plain(custom), /private-key|secret content/);
	} finally {
		ordinary.dispose();
		custom.dispose();
	}
});

test("a background agent's canonical running block keeps the shared clock after its launch call returns (#5224)", () => {
	vi.useFakeTimers();
	const requestRender = vi.fn();
	const runningDefinition: ToolDefinition = {
		...definition,
		renderCall: () => new ToolBlock({ status: "running", title: "Agent", args: "worker" }),
		renderResult: (result) => {
			const running =
				typeof result.details === "object" &&
				result.details !== null &&
				"running" in result.details &&
				result.details.running === true;
			return new ToolBlock({ status: running ? "running" : "success", title: "Agent", args: "worker" });
		},
	};
	const component = new ToolExecutionComponent(
		"sample",
		"background-call",
		{},
		{},
		runningDefinition,
		{ requestRender } as TUI,
		"/workspace",
	);
	try {
		component.updateResult({ content: [], details: { running: true }, isError: false });
		assert.equal(vi.getTimerCount(), 1);
		const before = requestRender.mock.calls.length;
		vi.advanceTimersByTime(88);
		assert.ok(requestRender.mock.calls.length > before);
		component.updateResult({ content: [], details: { running: false }, isError: false });
		assert.equal(vi.getTimerCount(), 0);
	} finally {
		component.dispose();
		vi.useRealTimers();
	}
});

test("the registered edit wrapper preserves shared tool framing (#5350)", () => {
	const component = new ToolExecutionComponent(
		"edit",
		"wrapped-edit",
		{ path: "sample.ts", edits: [{ oldText: "old", newText: "new" }] },
		{},
		createToolDefinition("edit", "/workspace"),
		ui,
		"/workspace",
	);
	try {
		component.updateResult({
			content: [{ type: "text", text: "Updated sample.ts" }],
			details: { diff: "-1 old\n+1 new" },
			isError: false,
		});
		for (const width of [80, 160]) {
			const rows = component.render(width).map((line) => stripTerminalSequences(line).trimEnd());
			assert.equal(rows[1], " ● Edit(sample.ts)");
			assert.match(rows[2]!, /⎿ {2}\+1 −1/);
			assert.equal(rows.filter((line) => line === "").length, 1);
		}
	} finally {
		component.dispose();
	}
});

test("PowerShell keeps its shell identity when using the shared default renderer (#5350)", () => {
	const component = new ToolExecutionComponent(
		"powershell",
		"ps-call",
		{ command: "Get-Location" },
		{},
		createPowerShellToolDefinition("/workspace"),
		ui,
		"/workspace",
	);
	try {
		component.updateResult({ content: [{ type: "text", text: "sample" }], details: { exitCode: 0 }, isError: false });
		assert.match(component.render(80).map(stripTerminalSequences).join("\n"), /● PowerShell\(Get-Location\)/);
	} finally {
		component.dispose();
	}
});

test("default extension headers use their registered label (#5224)", () => {
	const component = new ToolExecutionComponent(
		"sample",
		"label-call",
		{ path: "sample.ts" },
		{},
		{ ...definition, label: "Helpful action", renderCall: undefined, renderResult: undefined },
		ui,
		"/workspace",
	);
	try {
		component.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
		assert.match(component.render(80).map(stripTerminalSequences).join("\n"), /● Helpful action\(path=sample\.ts\)/);
	} finally {
		component.dispose();
	}
});

test("a failed custom result renderer does not expose its hidden raw output (#5224)", () => {
	const component = new ToolExecutionComponent(
		"sample",
		"private-output-call",
		{},
		{},
		{
			...definition,
			renderResult: () => {
				throw new Error("private renderer detail");
			},
		},
		ui,
		"/workspace",
	);
	try {
		component.updateResult({ content: [{ type: "text", text: "secret raw output" }], isError: false });
		const text = component.render(80).map(stripTerminalSequences).join("\n");
		assert.match(text, /Result renderer failed/);
		assert.doesNotMatch(text, /secret raw output|private renderer detail/);
	} finally {
		component.dispose();
	}
});

test("unknown extension calls use a labeled compact header instead of raw JSON (#5224)", () => {
	const component = new ToolExecutionComponent(
		"custom_action",
		"unknown-call",
		{ path: "sample.ts" },
		{},
		undefined,
		ui,
		"/workspace",
	);
	try {
		component.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
		const text = component.render(80).map(stripTerminalSequences).join("\n");
		assert.match(text, /● custom_action\(path=sample\.ts\)/);
		assert.match(text, /⎿ {2}done/);
		assert.doesNotMatch(text, /"path":|\{\n/);
	} finally {
		component.dispose();
	}
});
