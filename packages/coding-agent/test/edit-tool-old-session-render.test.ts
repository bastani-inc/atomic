import assert from "node:assert/strict";
import type { TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, test } from "vitest";
import { createEditToolDefinition } from "../src/core/tools/edit.js";
import { createWriteToolDefinition } from "../src/core/tools/write.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

const ui = { requestRender() {} } as unknown as TUI;

function render(component: ToolExecutionComponent): string {
	return stripAnsi(component.render(100).join("\n"));
}

describe("sessions recorded before #4328 still render", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("a stored patch-language edit call renders its stored diff", () => {
		const component = new ToolExecutionComponent(
			"edit",
			"old-edit",
			{ input: "[src/app.ts#1A2B]\nreplace 2..2:\n+const value = 2;" },
			{},
			createEditToolDefinition("/repo"),
			ui,
			"/repo",
		);
		component.setArgsComplete();
		component.updateResult({
			content: [{ type: "text", text: "[src/app.ts#3C4D]\n2:const value = 2;" }],
			details: { diff: "-2 const value = 1;\n+2 const value = 2;", patch: "", firstChangedLine: 2 },
			isError: false,
		});
		const rendered = render(component);
		assert.ok(rendered.includes("edit"));
		assert.ok(rendered.includes("const value = 2;"));
	});

	test("a stored failed edit call renders its error text", () => {
		const component = new ToolExecutionComponent(
			"edit",
			"old-failed-edit",
			{ input: "[src/app.ts#1A2B]\ndelete 9" },
			{},
			createEditToolDefinition("/repo"),
			ui,
			"/repo",
		);
		component.setArgsComplete();
		component.updateResult({ content: [{ type: "text", text: "stale snapshot tag" }], isError: true });
		assert.ok(render(component).includes("stale snapshot tag"));
	});

	test("a stored write result with a snapshot header renders without error", () => {
		const component = new ToolExecutionComponent(
			"write",
			"old-write",
			{ path: "notes.md", content: "hello\n" },
			{},
			createWriteToolDefinition("/repo"),
			ui,
			"/repo",
		);
		component.setArgsComplete();
		component.updateResult({
			content: [{ type: "text", text: "[notes.md#5E6F]\nSuccessfully wrote to notes.md" }],
			details: { resolvedPath: "/repo/notes.md" },
			isError: false,
		});
		const rendered = render(component);
		assert.ok(rendered.includes("write"));
		assert.ok(rendered.includes("hello"));
	});
});
