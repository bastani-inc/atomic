import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Component, Container } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, it, vi } from "vitest";
import type { ToolRenderContext } from "../src/core/extensions/types.js";
import type { EditToolDetails } from "../src/core/tools/edit.js";
import { type EditRenderState, editRenderers } from "../src/core/tools/renderers/edit.js";
import { initTheme, type Theme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

const theme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bg: (color: string, text: string) => `{${color}}${text}`,
	bold: (text: string) => text,
} as unknown as Theme;

type EditArgs = {
	path?: unknown;
	file_path?: unknown;
	edits?: unknown;
	oldText?: unknown;
	newText?: unknown;
};

const tempDirs: string[] = [];

beforeAll(() => {
	initTheme("dark");
});

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(content = "alpha\nbeta\n"): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "edit-renderer-"));
	tempDirs.push(dir);
	await writeFile(join(dir, "a.txt"), content);
	return dir;
}

function createRow(cwd: string) {
	const state: EditRenderState = {};
	const invalidate = vi.fn();
	let callComponent: Component | undefined;
	let resultComponent: Component | undefined;
	const context = (args: EditArgs, overrides: Partial<ToolRenderContext<EditRenderState, EditArgs>> = {}) =>
		({
			args,
			toolCallId: "edit-1",
			invalidate,
			lastComponent: undefined,
			state,
			cwd,
			executionStarted: false,
			argsComplete: false,
			isPartial: false,
			expanded: false,
			showImages: false,
			isError: false,
			durationMs: undefined,
			outputPad: 1,
			keyText: () => "",
			keyHint: () => "",
			...overrides,
		}) as ToolRenderContext<EditRenderState, EditArgs>;
	return {
		state,
		invalidate,
		call(args: EditArgs, argsComplete: boolean) {
			callComponent = editRenderers.renderCall!(
				args as never,
				theme,
				context(args, { argsComplete, lastComponent: callComponent }) as never,
			);
			return callComponent;
		},
		result(
			args: EditArgs,
			result: { content: Array<{ type: "text"; text: string }>; details?: EditToolDetails },
			isError: boolean,
		) {
			resultComponent = editRenderers.renderResult!(
				result as never,
				{ expanded: false, isPartial: false },
				theme,
				context(args, { isError, lastComponent: resultComponent }) as never,
			);
			return resultComponent;
		},
		get callComponent() {
			return callComponent;
		},
	};
}

function text(component: Component | undefined): string {
	return stripAnsi(component?.render(160).join("\n") ?? "");
}

function trimmed(component: Component): string {
	return component
		.render(160)
		.map((line) => stripAnsi(line).trimEnd())
		.join("\n");
}

const editArgs = (oldText = "beta", newText = "BETA"): EditArgs => ({ path: "a.txt", edits: [{ oldText, newText }] });

async function settled(): Promise<void> {
	for (let index = 0; index < 5; index++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("edit call rendering", () => {
	it("shows the tool and path on a pending background with the row's padding", async () => {
		const row = createRow(await fixture());
		const rendered = text(row.call(editArgs(), false));
		assert.ok(rendered.includes("{toolPendingBg}"));
		assert.ok(rendered.includes("<toolTitle>edit</toolTitle> <accent>a.txt</accent>"));
		assert.match(rendered, /\{toolPendingBg\} <toolTitle>/);
		assert.equal(vi.mocked(row.invalidate).mock.calls.length, 0);
	});

	it("shows a placeholder for a missing path and an invalid marker for a non-string path", async () => {
		const row = createRow(await fixture());
		assert.ok(
			text(row.call({ edits: [] }, false)).includes("<toolTitle>edit</toolTitle> <toolOutput>...</toolOutput>"),
		);
		assert.ok(text(createRow("/").call({ path: 7 }, false)).includes("<error>"));
	});

	it("previews the diff once the arguments are complete, with a success background", async () => {
		const row = createRow(await fixture());
		row.call(editArgs(), true);
		await vi.waitFor(() => assert.equal(vi.mocked(row.invalidate).mock.calls.length, 1));
		const rendered = text(row.call(editArgs(), true));
		assert.ok(rendered.includes("{toolSuccessBg}"));
		assert.ok(rendered.includes("BETA"));
		await settled();
		assert.equal(vi.mocked(row.invalidate).mock.calls.length, 1);
	});

	it("does not preview incomplete, pathless or malformed arguments", async () => {
		const row = createRow(await fixture());
		row.call(editArgs(), false);
		row.call({ edits: [{ oldText: "beta", newText: "x" }] }, true);
		row.call({ path: "a.txt", edits: [] }, true);
		row.call({ path: "a.txt", edits: [{ oldText: 1, newText: "x" }] }, true);
		row.call({ path: "a.txt", edits: [{ oldText: "beta", newText: null }] }, true);
		row.call({ path: "a.txt", oldText: "beta" }, true);
		await settled();
		assert.equal(vi.mocked(row.invalidate).mock.calls.length, 0);
	});

	it("previews legacy oldText/newText and file_path arguments", async () => {
		const row = createRow(await fixture());
		const args = { file_path: "a.txt", oldText: "alpha", newText: "ALPHA" };
		row.call(args, true);
		await vi.waitFor(() => assert.equal(vi.mocked(row.invalidate).mock.calls.length, 1));
		const rendered = text(row.call(args, true));
		assert.ok(rendered.includes("<accent>a.txt</accent>"));
		assert.ok(rendered.includes("ALPHA"));
	});

	it("shows a preview error in the error colour on an error background", async () => {
		const row = createRow(await fixture());
		row.call(editArgs("missing"), true);
		await vi.waitFor(() => assert.equal(vi.mocked(row.invalidate).mock.calls.length, 1));
		const rendered = text(row.call(editArgs("missing"), true));
		assert.ok(rendered.includes("{toolErrorBg}"));
		assert.ok(rendered.includes("<error>Could not find the exact text in a.txt."));
	});

	it("drops a preview when the arguments change and ignores a preview for superseded arguments", async () => {
		const row = createRow(await fixture());
		row.call(editArgs("alpha", "first"), true);
		row.call(editArgs("beta", "second"), true);
		await vi.waitFor(() => assert.equal(vi.mocked(row.invalidate).mock.calls.length, 1));
		await settled();
		assert.equal(vi.mocked(row.invalidate).mock.calls.length, 1);
		const second = text(row.call(editArgs("beta", "second"), true));
		assert.ok(second.includes("second"));
		assert.ok(!second.includes("first"));
		const changed = text(row.call(editArgs("beta", "third"), false));
		assert.ok(changed.includes("{toolPendingBg}"));
		assert.ok(!changed.includes("second"));
	});

	it("keeps the pending background for arguments that cannot be previewed", async () => {
		const row = createRow(await fixture());
		assert.ok(text(row.call({ edits: [] }, true)).includes("{toolPendingBg}"));
	});

	it("takes over a box handed in as the previous component", async () => {
		const box = createRow(await fixture()).call(editArgs(), false);
		const state: EditRenderState = {};
		const rendered = editRenderers.renderCall!(editArgs() as never, theme, {
			args: editArgs(),
			state,
			cwd: "/",
			lastComponent: box,
			argsComplete: false,
			outputPad: 0,
			invalidate: () => {},
		} as never);
		assert.equal(rendered, box);
		assert.equal(state.callComponent, box);
	});

	it("renders without arguments", async () => {
		const row = createRow(await fixture());
		assert.ok(
			text(row.call(undefined as unknown as EditArgs, true)).includes(
				"<toolTitle>edit</toolTitle> <toolOutput>...</toolOutput>",
			),
		);
		assert.ok(
			text(
				row.result(undefined as unknown as EditArgs, { content: [{ type: "text", text: "boom" }] }, true),
			).includes("boom"),
		);
		await settled();
		assert.equal(vi.mocked(row.invalidate).mock.calls.length, 0);
	});

	it.each([
		["a non-string file_path", { file_path: 5, edits: [{ oldText: "beta", newText: "x" }] }],
		["an empty edits array", { path: "a.txt", edits: [] }],
		["a null edit", { path: "a.txt", edits: [null] }],
		["a non-string oldText", { path: "a.txt", edits: [{ oldText: 1, newText: "x" }] }],
		["a non-string newText", { path: "a.txt", edits: [{ oldText: "beta", newText: null }] }],
		[
			"one good and one bad edit",
			{ path: "a.txt", edits: [{ oldText: "beta", newText: "x" }, { oldText: "alpha" }] },
		],
		["oldText without newText", { path: "a.txt", oldText: "beta" }],
		["newText without oldText", { path: "a.txt", newText: "beta" }],
	])("never previews %s", async (_name, args) => {
		const row = createRow(await fixture());
		row.call(args, true);
		await settled();
		assert.equal(vi.mocked(row.invalidate).mock.calls.length, 0);
	});

	it("separates the header from the preview with a blank line", async () => {
		const row = createRow(await fixture());
		row.call(editArgs(), true);
		await vi.waitFor(() => assert.equal(vi.mocked(row.invalidate).mock.calls.length, 1));
		const lines = row
			.call(editArgs(), true)
			.render(160)
			.map((line) =>
				stripAnsi(line)
					.replace(/\{[a-zA-Z]+\}/, "")
					.trim(),
			);
		const header = lines.findIndex((line) => line.includes("<toolTitle>edit</toolTitle>"));
		assert.equal(lines[header + 1], "");
		assert.notEqual(lines[header + 2], "");
	});

	it("computes one preview while a preview is pending", async () => {
		const row = createRow(await fixture());
		row.call(editArgs(), true);
		row.call(editArgs(), true);
		await vi.waitFor(() => assert.ok(vi.mocked(row.invalidate).mock.calls.length > 0));
		await settled();
		assert.equal(vi.mocked(row.invalidate).mock.calls.length, 1);
	});

	it("keeps rendering into the row's existing box", async () => {
		const row = createRow(await fixture());
		const first = row.call(editArgs(), false);
		assert.equal(row.call(editArgs(), false), first);
		assert.equal(row.state.callComponent, first);
		const state: EditRenderState = {};
		const fromState = editRenderers.renderCall!(editArgs() as never, theme, {
			args: editArgs(),
			state,
			cwd: "/",
			lastComponent: undefined,
			argsComplete: false,
			outputPad: 0,
			invalidate: () => {},
		} as never);
		assert.equal(
			editRenderers.renderCall!(editArgs() as never, theme, {
				args: editArgs(),
				state,
				cwd: "/",
				lastComponent: new Container(),
				argsComplete: false,
				outputPad: 0,
				invalidate: () => {},
			} as never),
			fromState,
		);
	});
});

describe("edit result rendering", () => {
	const success = (diff: string, firstChangedLine = 2) => ({
		content: [{ type: "text" as const, text: "Successfully replaced 1 block(s) in a.txt." }],
		details: { diff, patch: "", firstChangedLine },
	});

	it("moves a successful diff into the call row and leaves the result empty", async () => {
		const row = createRow(await fixture());
		row.call(editArgs(), false);
		const result = row.result(editArgs(), success("-2 beta\n+2 BETA"), false);
		assert.equal(text(result), "");
		const call = text(row.callComponent);
		assert.ok(call.includes("{toolSuccessBg}"));
		assert.ok(call.includes("BETA"));
	});

	it("shows the diff in the result when there is no call row", async () => {
		const row = createRow(await fixture());
		assert.ok(text(row.result(editArgs(), success("-2 beta\n+2 BETA"), false)).includes("BETA"));
		assert.equal(text(row.result({}, { content: [] }, false)), "");
	});

	it("shows an error result once, and not when the preview already shows it", async () => {
		const row = createRow(await fixture());
		row.call(editArgs("missing"), true);
		await vi.waitFor(() => assert.equal(vi.mocked(row.invalidate).mock.calls.length, 1));
		row.call(editArgs("missing"), true);
		const previewError =
			"Could not find the exact text in a.txt. The old text must match exactly including all whitespace and newlines.";
		assert.equal(
			text(row.result(editArgs("missing"), { content: [{ type: "text", text: previewError }] }, true)),
			"",
		);
		const other = text(row.result(editArgs("missing"), { content: [{ type: "text", text: "disk full" }] }, true));
		assert.ok(other.includes("<error>disk full</error>"));
		assert.equal(text(row.result(editArgs("missing"), { content: [] }, true)), "");
		assert.ok(text(row.callComponent).includes("{toolErrorBg}"));
	});

	it("marks a failed call row with the error background", async () => {
		const row = createRow(await fixture());
		row.call(editArgs(), false);
		row.result(editArgs(), { content: [{ type: "text", text: "boom" }] }, true);
		assert.ok(text(row.callComponent).includes("{toolErrorBg}"));
		row.result(editArgs(), success("+2 BETA"), false);
		assert.ok(text(row.callComponent).includes("{toolSuccessBg}"));
	});

	it("rebuilds the call row only when the preview or outcome changes", async () => {
		const row = createRow(await fixture());
		row.call(editArgs(), false);
		row.result(editArgs(), success("+2 BETA", 2), false);
		const clear = vi.spyOn(row.state.callComponent!, "clear");
		row.result(editArgs(), success("+2 BETA", 2), false);
		assert.equal(vi.mocked(clear).mock.calls.length, 0);
		row.result(editArgs(), success("+2 BETA", 3), false);
		assert.equal(vi.mocked(clear).mock.calls.length, 1);
		row.result(editArgs(), success("+2 OTHER", 3), false);
		assert.equal(vi.mocked(clear).mock.calls.length, 2);
		row.result(editArgs(), { content: [{ type: "text", text: "boom" }] }, true);
		assert.equal(vi.mocked(clear).mock.calls.length, 3);
	});

	it("treats a change between an error preview and a diff, or between two errors, as a change", async () => {
		const row = createRow(await fixture());
		row.call(editArgs("missing"), true);
		await vi.waitFor(() => assert.equal(vi.mocked(row.invalidate).mock.calls.length, 1));
		row.call(editArgs("missing"), true);
		const clear = vi.spyOn(row.state.callComponent!, "clear");
		row.result(editArgs("missing"), success("+2 BETA"), false);
		assert.equal(vi.mocked(clear).mock.calls.length, 1);
		assert.ok(text(row.callComponent).includes("BETA"));
	});

	it("keeps a result diff as the preview for later renders of the same arguments", async () => {
		const row = createRow(await fixture());
		row.call(editArgs(), false);
		row.result(editArgs(), success("-2 beta\n+2 FROM-RESULT"), false);
		assert.ok(text(row.call(editArgs(), true)).includes("FROM-RESULT"));
		await settled();
		assert.equal(vi.mocked(row.invalidate).mock.calls.length, 0);
	});

	it("renders no lines for an empty result and a blank line before an error", async () => {
		const row = createRow(await fixture());
		row.call(editArgs(), false);
		assert.deepEqual(row.result(editArgs(), success("+2 BETA"), false).render(80), []);
		const lines = row.result(editArgs(), { content: [{ type: "text", text: "boom" }] }, true).render(80);
		assert.equal(stripAnsi(lines[0] ?? "").trim(), "");
		assert.ok(stripAnsi(lines[1] ?? "").includes("<error>boom</error>"));
	});

	it("joins only the text blocks of an error, keeping empty ones", async () => {
		const row = createRow(await fixture());
		const rendered = trimmed(
			row.result(
				editArgs(),
				{
					content: [
						{ type: "image", data: "", mimeType: "image/png" },
						{ type: "text", text: "" },
						{ type: "text", text: "second" },
					] as never,
				},
				true,
			),
		);
		assert.equal(rendered, "\n <error>\n second</error>");
		assert.ok(!rendered.includes("Stryker"));
	});

	it("reuses the previous result container", async () => {
		const row = createRow(await fixture());
		const first = row.result(editArgs(), { content: [{ type: "text", text: "boom" }] }, true);
		assert.equal(row.result(editArgs(), { content: [{ type: "text", text: "again" }] }, true), first);
		assert.ok(text(first).includes("again"));
		assert.ok(!text(first).includes("boom"));
	});
});
