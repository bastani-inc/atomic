import type { TUI } from "@earendil-works/pi-tui";
import { beforeAll, expect, test } from "vitest";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeAll(() => initTheme("dark"));

test("read errors are not syntax-highlighted as requested file contents", () => {
	const tui = { requestRender: () => {} } as unknown as TUI;
	const component = new ToolExecutionComponent(
		"read",
		"tool-read-error-highlighting",
		{ path: "config.exs", offset: 120, limit: 130 },
		{},
		createReadToolDefinition(process.cwd()),
		tui,
		process.cwd(),
	);
	const error = "Offset 120 is beyond end of file (96 lines total)";
	component.updateResult({ content: [{ type: "text", text: error }], details: undefined, isError: true }, false);
	const rendered = component.render(120).join("\n");
	expect(stripAnsi(rendered)).toContain(error);
	expect(rendered).toContain(theme.fg("toolOutput", error));
});
