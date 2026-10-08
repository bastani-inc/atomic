import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Component } from "@earendil-works/pi-tui";
import { beforeAll, test } from "vitest";
import type { ToolRenderContext } from "../src/core/extensions/types.js";
import { codemodeRenderers } from "../src/extensions/codemode/renderer.js";
import type { CodemodeToolDetails } from "../src/extensions/codemode/tool.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";

beforeAll(() => initTheme("dark"));
function context(expanded: boolean): ToolRenderContext {
	return {
		args: { code: "" },
		toolCallId: "call",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd: "/",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded,
		showImages: false,
		isError: false,
		durationMs: undefined,
		outputPad: 1,
	};
}
function render(result: AgentToolResult<CodemodeToolDetails | undefined>, expanded = true, width = 200): string {
	const component = codemodeRenderers.renderResult?.(
		result,
		{ expanded, isPartial: false },
		theme,
		context(expanded),
	) as Component;
	return stripVTControlCharacters(component.render(width).join("\n"))
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
}

test("codemode renderer hides the script header and shows the output", () => {
	assert.equal(
		render({
			content: [
				{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
				{ type: "text", text: "hello" },
			],
			details: { calls: [{ id: "call/1", name: "read", args: '{"path":"a"}', status: "ok", durationMs: 5 }] },
		}),
		'✓ read {"path":"a"} 5ms\n\nhello',
	);
});

test("codemode renderer shows model call costs and their total", () => {
	const call = { name: "models.classify", args: "scorer/judge", status: "ok" as const, durationMs: 5 };
	assert.equal(
		render({
			content: [],
			details: {
				calls: [
					{ ...call, id: "1", cost: 0.000012936 },
					{ ...call, id: "2", cost: 0.02 },
					{ ...call, id: "3" },
				],
			},
		}),
		[
			"✓ models.classify scorer/judge 5ms $0.000013",
			"✓ models.classify scorer/judge 5ms $0.02",
			"✓ models.classify scorer/judge 5ms",
			"Model calls: $0.02",
		].join("\n"),
	);
});

test("codemode renderer shows rejected options without a script header", () => {
	assert.equal(
		render({
			content: [{ type: "text", text: "The @options line must be followed by JavaScript source" }],
			details: undefined,
		}),
		"The @options line must be followed by JavaScript source",
	);
});

test("codemode collapsed output is limited by wrapped lines and keeps the full output path", () => {
	const result = {
		content: [
			{ type: "text" as const, text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
			{ type: "text" as const, text: "x".repeat(1000) },
		],
		details: { calls: [], fullOutputPath: "/tmp/out.txt" },
	};
	const lines = render(result, false, 50).split("\n");
	assert.equal(lines.length, 7);
	assert.deepEqual(lines.slice(0, 5), Array(5).fill("x".repeat(50)));
	assert.match(lines[5], /^\.\.\. \(15 more lines,/);
	assert.equal(lines[6], "Full output: /tmp/out.txt");
	assert.equal(render(result, true, 50).split("\n").length, 20);
});

test("codemode collapsed script call is limited by wrapped lines", () => {
	const component = codemodeRenderers.renderCall?.({ code: "x".repeat(1000) }, theme, context(false)) as Component;
	const lines = component.render(50).map(stripVTControlCharacters);
	assert.equal(lines.length, 12);
	assert.match(lines[11], /10 more lines/);
});
