import { getKeybindings, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ToolDefinition } from "../../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { ToolExecutionComponent } from "../../../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";

const previousKeybindings = getKeybindings();

const PREVIEW_LINES = 10;
const OUTPUT_LINES = 42;

/** An extension tool with no renderer falls back to printing its raw text output. */
function createRendererlessToolDefinition(): ToolDefinition {
	return {
		name: "custom_tool",
		label: "custom_tool",
		description: "custom tool",
		parameters: Type.Unknown(),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	};
}

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

function renderFallback(expanded: boolean): string {
	const component = new ToolExecutionComponent(
		"custom_tool",
		"tool-fallback",
		{},
		{},
		createRendererlessToolDefinition(),
		createFakeTui(),
		process.cwd(),
	);
	component.updateResult(
		{
			content: [
				{
					type: "text",
					text: Array.from({ length: OUTPUT_LINES }, (_, index) => `line ${index + 1}`).join("\n"),
				},
			],
			details: {},
			isError: false,
		},
		false,
	);
	if (expanded) component.setExpanded(true);
	return stripAnsi(component.render(120).join("\n"));
}

/**
 * A rendererless extension tool used to print its entire output, so one verbose
 * call pushed the whole conversation off the screen.
 */
describe("regression #7979: fallback extension tool output collapses", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		setKeybindings(previousKeybindings);
	});

	it("previews ten lines and offers the bound expand key", () => {
		setKeybindings(new KeybindingsManager({ "app.tools.expand": ["ctrl+r"] }));
		const rendered = renderFallback(false);

		expect(rendered).toContain(`line ${PREVIEW_LINES}`);
		expect(rendered).not.toContain(`line ${PREVIEW_LINES + 1}`);
		expect(rendered).toContain(`(${OUTPUT_LINES - PREVIEW_LINES} more lines, ctrl+r Expand)`);
	});

	it("keeps the hidden-line count when the expand action is unbound", () => {
		setKeybindings(new KeybindingsManager({ "app.tools.expand": [] }));
		const rendered = renderFallback(false);

		expect(rendered).toContain(`(${OUTPUT_LINES - PREVIEW_LINES} more lines)`);
		expect(rendered).not.toMatch(/\b(?:Expand|Collapse)\b/);
	});

	it("prints every line once expanded, with no remaining-lines hint", () => {
		const rendered = renderFallback(true);

		expect(rendered).toContain(`line ${OUTPUT_LINES}`);
		expect(rendered).not.toContain("more lines");
	});

	it("leaves output shorter than the preview untouched", () => {
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-short",
			{},
			{},
			createRendererlessToolDefinition(),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "only line" }], details: {}, isError: false }, false);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("only line");
		expect(rendered).not.toContain("more lines");
	});
});
