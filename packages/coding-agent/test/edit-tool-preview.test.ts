import { describe, expect, it } from "vitest";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";

describe("edit tool TUI rendering", () => {
	it("renders hashline edit calls without legacy replacement previews", () => {
		const definition = createEditToolDefinition(process.cwd());
		const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text } as never;
		const context = { cwd: process.cwd() } as never;
		const call = definition.renderCall?.({ input: "[file.txt#ABCD]\nreplace 1..1:\n+after" }, theme, context);
		const rendered = call?.render(80).join("\n") ?? "";
		expect(rendered).toContain("edit");
		expect(rendered).toContain("file.txt");
	});
});
