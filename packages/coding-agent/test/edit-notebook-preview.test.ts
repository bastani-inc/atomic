import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, it } from "vitest";
import { createToolDefinition } from "../src/core/tools/index.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

const tempDirs: string[] = [];
const ui = { requestRender() {} } as unknown as TUI;

beforeAll(() => {
	initTheme("dark");
});

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function settle(): Promise<void> {
	for (let index = 0; index < 10; index++) await new Promise((resolve) => setTimeout(resolve, 5));
}

const render = (component: ToolExecutionComponent) => stripAnsi(component.render(120).join("\n"));

async function runBuiltInEdit(file: string, content: string, args: Record<string, unknown>) {
	const dir = await mkdtemp(join(tmpdir(), "edit-preview-"));
	tempDirs.push(dir);
	await writeFile(join(dir, file), content);
	const row = new ToolExecutionComponent("edit", "edit-1", args, {}, undefined, ui, dir);
	row.setArgsComplete();
	await settle();
	const preview = render(row);
	const result = await createToolDefinition("edit", dir).execute(
		"edit-1",
		args as never,
		undefined,
		undefined,
		{} as never,
	);
	row.updateResult({ ...result, isError: false });
	await settle();
	return { dir, preview, final: render(row) };
}

const notebook = JSON.stringify({
	cells: [{ cell_type: "code", source: ["x = 1\n", "print(x)\n"], metadata: {}, outputs: [], execution_count: null }],
	metadata: {},
	nbformat: 4,
	nbformat_minor: 5,
});

describe("built-in edit previews", () => {
	it("render a notebook edit without a false no-match preview, then show the result's diff", async () => {
		const args = { path: "n.ipynb", edits: [{ oldText: "x = 1\nprint(x)", newText: "x = 2\nprint(x)" }] };
		const { dir, preview, final } = await runBuiltInEdit("n.ipynb", notebook, args);
		assert.ok(preview.includes("edit"));
		assert.ok(preview.includes("n.ipynb"));
		assert.ok(!preview.includes("Could not find"));
		assert.ok(!preview.includes("x = 2"));
		assert.ok(final.includes("x = 2"));
		assert.ok(!final.includes("Could not find"));
		assert.deepEqual(JSON.parse(await readFile(join(dir, "n.ipynb"), "utf8")).cells[0].source, [
			"x = 2\n",
			"print(x)\n",
		]);
	});

	it("also drop the preview for legacy file_path, oldText and newText notebook arguments", async () => {
		const dir = await mkdtemp(join(tmpdir(), "edit-preview-"));
		tempDirs.push(dir);
		await writeFile(join(dir, "n.ipynb"), notebook);
		const row = new ToolExecutionComponent(
			"edit",
			"edit-legacy",
			{ file_path: "n.ipynb", oldText: "x = 1\nprint(x)", newText: "x = 3\nprint(x)" },
			{},
			undefined,
			ui,
			dir,
		);
		row.setArgsComplete();
		await settle();
		const preview = render(row);
		assert.ok(preview.includes("n.ipynb"));
		assert.ok(!preview.includes("Could not find"));
	});

	it("render a call and a result without arguments", () => {
		const definition = createToolDefinition("edit", "/");
		const theme = {
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		};
		const context = {
			args: undefined,
			state: {},
			cwd: "/",
			argsComplete: true,
			outputPad: 0,
			invalidate: () => {},
			isError: true,
		};
		assert.ok(
			stripAnsi(
				definition.renderCall!(undefined as never, theme as never, context as never)
					.render(80)
					.join("\n"),
			).includes("edit"),
		);
		const result = definition.renderResult!(
			{ content: [{ type: "text", text: "boom" }], details: undefined },
			{ expanded: false, isPartial: false },
			theme as never,
			context as never,
		);
		assert.ok(stripAnsi(result.render(80).join("\n")).includes("boom"));
	});

	it("keep the diff preview for other files", async () => {
		const args = { path: "a.py", edits: [{ oldText: "x = 1", newText: "x = 2" }] };
		const { preview } = await runBuiltInEdit("a.py", "x = 1\nprint(x)\n", args);
		assert.ok(preview.includes("x = 2"));
	});
});
