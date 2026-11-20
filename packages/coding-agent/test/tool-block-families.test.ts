import assert from "node:assert/strict";
import { getKeybindings, setKeybindings, stripTerminalSequences, visibleWidth } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test } from "vitest";
import { renderFetchContentResult, renderWebSearchResult } from "../../web-access/result-renderers.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { chunkedToolResult, chunkedToolResultEntry } from "../src/core/storage/session/chunked-tool-result.js";
import { ToolBlock } from "../src/modes/interactive/components/tool-block.ts";
import {
	type BuiltinToolBlockInput,
	builtinToolBlockPresentation,
} from "../src/modes/interactive/components/tool-block-families.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

test("a saved image read keeps its dimensions and byte count without decoding the image payload (#5593)", async () => {
	const data = Buffer.alloc(1_200_000);
	data.writeUint32BE(0x89504e47, 0);
	data.writeUInt32BE(321, 16);
	data.writeUInt32BE(123, 20);
	const input = {
		role: "toolResult",
		toolCallId: "picture",
		toolName: "read",
		isError: false,
		timestamp: 1,
		content: [{ type: "image", mimeType: "image/png", data: data.toString("base64") }],
	};
	const text = Buffer.from(JSON.stringify({ type: "message", message: input }));
	const summary = await chunkedToolResult(
		(async function* () {
			for (let i = 0; i < text.length; i += 257) yield text.subarray(i, i + 257);
		})(),
	);
	assert.ok(summary);
	const entry = chunkedToolResultEntry(summary, "picture-entry", "Saved image body is available in history");
	assert.ok(entry.type === "message" && entry.message.role === "toolResult");
	const view = (result: BuiltinToolBlockInput["result"]) =>
		plain(
			renderFamily({ toolName: "read", args: { path: "picture.png" }, result, expanded: false, isPartial: false }),
		);
	const expected = view(input);
	assert.match(expected.join("\n"), /Read image · 321×123/);
	assert.deepEqual(view(entry.message), expected);
	assert.ok(JSON.stringify(entry).length < 5000, "the saved projection holds no image payload");
});

const previousKeys = getKeybindings();
const CWD = "/workspace/project";

beforeEach(() => {
	initTheme("dark", false);
	setKeybindings(new KeybindingsManager());
});

afterEach(() => {
	setKeybindings(previousKeys);
});

function plain(lines: readonly string[]): string[] {
	return lines.map((line) => stripTerminalSequences(line).trimEnd());
}

function renderFamily(
	input: Omit<BuiltinToolBlockInput, "cwd" | "executionStarted" | "argsComplete"> & {
		cwd?: string;
		executionStarted?: boolean;
		argsComplete?: boolean;
	},
	width = 80,
): string[] {
	const presentation = builtinToolBlockPresentation({
		cwd: CWD,
		executionStarted: true,
		argsComplete: true,
		...input,
	});
	assert.ok(presentation, `Expected presentation for ${input.toolName}`);
	const block = new ToolBlock({
		status:
			presentation.status ??
			(input.isPartial || !input.result ? "running" : input.result.isError ? "failure" : "success"),
		title: presentation.title,
		args: presentation.args,
		meta: presentation.meta,
		details: presentation.details,
	});
	const rows = block.render(width);
	assert.ok(rows.every((line) => visibleWidth(line) <= width));
	assert.ok(!rows.join("").includes("\u001b[48;"));
	return rows;
}

test("Read family formats relative paths, line ranges, expanded line-number gutters, images and errors (#5350)", () => {
	const fortyTwoLines = Array.from({ length: 42 }, (_, index) => `const line${index + 1} = ${index + 1};`).join("\n");
	for (const width of [80, 160]) {
		const collapsed = plain(
			renderFamily(
				{
					toolName: "read",
					args: { path: `${CWD}/src/greet.ts` },
					result: { content: [{ type: "text", text: fortyTwoLines }], isError: false },
					expanded: false,
					isPartial: false,
				},
				width,
			),
		);
		assert.deepEqual(collapsed, [" ● Read(src/greet.ts)", "   ⎿  Read 42 lines"]);
	}

	const rangedText = ["[Lines 10-12 of 40]", "alpha", "beta", "gamma"].join("\n");
	const rangedCollapsed = plain(
		renderFamily({
			toolName: "read",
			args: { path: `${CWD}/src/greet.ts:10-12` },
			result: { content: [{ type: "text", text: rangedText }], isError: false },
			expanded: false,
			isPartial: false,
		}),
	);
	assert.deepEqual(rangedCollapsed, [" ● Read(src/greet.ts:10-12)", "   ⎿  Read 3 lines"]);

	const rangedExpanded = plain(
		renderFamily({
			toolName: "read",
			args: { path: `${CWD}/src/greet.ts:10-12` },
			result: { content: [{ type: "text", text: rangedText }], isError: false },
			expanded: true,
			isPartial: false,
		}),
	);
	assert.deepEqual(rangedExpanded, [
		" ● Read(src/greet.ts:10-12)",
		"   ⎿  10  alpha",
		"      11  beta",
		"      12  gamma",
	]);

	const imageData = Buffer.alloc(84 * 1024).toString("base64");
	const imageRows = plain(
		renderFamily({
			toolName: "read",
			args: { path: "assets/diagram.png" },
			result: {
				content: [
					{ type: "text", text: "Read image file [image/png]\n[Image: original 1280x720, displayed at 1280x720]" },
					{ type: "image", data: imageData, mimeType: "image/png" },
				],
				isError: false,
			},
			expanded: false,
			isPartial: false,
		}),
	);
	assert.deepEqual(imageRows, [" ● Read(assets/diagram.png)", "   ⎿  Read image · 1280×720 · 84 KB"]);

	const failedRows = plain(
		renderFamily({
			toolName: "read",
			args: { path: "src/nope.ts" },
			result: {
				content: [{ type: "text", text: "ENOENT: no such file or directory, open 'src/nope.ts'" }],
				isError: true,
			},
			expanded: false,
			isPartial: false,
		}),
	);
	assert.deepEqual(failedRows, [
		" ✗ Read(src/nope.ts) · not found",
		"   ⎿  ENOENT: no such file or directory, open 'src/nope.ts'",
	]);
});

test("Search, Find and List families enforce 8-row collapse budgets, remapped expand keys and empty states (#5350)", () => {
	setKeybindings(new KeybindingsManager({ "app.tools.expand": "ctrl+e" }));
	const searchLines = Array.from({ length: 12 }, (_, index) => {
		const file = `file${(index % 4) + 1}.ts`;
		return `${file}:${index + 1}: export const item${index + 1} = ${index + 1};`;
	});
	const searchCollapsed = plain(
		renderFamily({
			toolName: "search",
			args: { pattern: "export", paths: "*.ts" },
			result: {
				content: [{ type: "text", text: searchLines.join("\n") }],
				details: { matchCount: 12, fileCount: 4 },
				isError: false,
			},
			expanded: false,
			isPartial: false,
		}),
	);
	assert.deepEqual(searchCollapsed, [
		" ● Search(/export/ in *.ts)",
		"   ⎿  12 matches in 4 files",
		...searchLines.slice(0, 8).map((line) => `      ${line}`),
		"      … +4 lines (ctrl+e to expand)",
	]);

	const searchExpanded = plain(
		renderFamily({
			toolName: "search",
			args: { pattern: "export", paths: "*.ts" },
			result: {
				content: [{ type: "text", text: searchLines.join("\n") }],
				details: { matchCount: 12, fileCount: 4 },
				isError: false,
			},
			expanded: true,
			isPartial: false,
		}),
	);
	assert.equal(searchExpanded.length, 14);
	assert.equal(searchExpanded[1], "   ⎿  12 matches in 4 files");
	assert.equal(searchExpanded[13], `      ${searchLines[11]}`);

	const searchNone = plain(
		renderFamily({
			toolName: "search",
			args: { pattern: "missing", paths: "*.ts" },
			result: {
				content: [{ type: "text", text: "No matches found" }],
				details: { matchCount: 0, fileCount: 0 },
				isError: false,
			},
			expanded: false,
			isPartial: false,
		}),
	);
	assert.deepEqual(searchNone, [" ● Search(/missing/ in *.ts)", "   ⎿  No matches"]);

	const foundFiles = Array.from({ length: 10 }, (_, index) => `src/mod${index + 1}.ts`);
	const findCollapsed = plain(
		renderFamily({
			toolName: "find",
			args: { paths: ["*.ts"] },
			result: {
				content: [{ type: "text", text: foundFiles.join("\n") }],
				details: { fileCount: 10, files: foundFiles },
				isError: false,
			},
			expanded: false,
			isPartial: false,
		}),
	);
	assert.deepEqual(findCollapsed, [
		" ● Find(*.ts)",
		"   ⎿  10 files",
		...foundFiles.slice(0, 8).map((file) => `      ${file}`),
		"      … +2 lines (ctrl+e to expand)",
	]);

	const lsCollapsed = plain(
		renderFamily({
			toolName: "ls",
			args: { path: `${CWD}/src` },
			result: {
				content: [{ type: "text", text: "a.ts\nb.ts\nc.ts" }],
				isError: false,
			},
			expanded: false,
			isPartial: false,
		}),
	);
	assert.equal(lsCollapsed[0], " ● List(src)");
	assert.equal(lsCollapsed[1], "   ⎿  3 entries");
});

test("Bash and Wait families render running tail, collapsed tail, preserved indentation, exit failures, timeouts, interrupts and background state (#5350)", () => {
	const runningRows = plain(
		renderFamily({
			toolName: "bash",
			args: { command: "for i in $(seq 1 12); do echo tick $i; sleep 1; done", timeout: 60 },
			result: {
				content: [{ type: "text", text: "tick 1\ntick 2\ntick 3" }],
				isError: false,
			},
			expanded: false,
			isPartial: true,
			elapsedMs: 3000,
		}),
	);
	assert.deepEqual(runningRows, [
		" ∀ Bash(for i in $(seq 1 12); do echo tick $i; sleep 1; done) · 3s · timeout 60s",
		"   ⎿  tick 1",
		"      tick 2",
		"      tick 3",
	]);

	const seq150 = Array.from({ length: 150 }, (_, index) => String(index + 1)).join("\n");
	for (const width of [80, 160]) {
		const doneRows = plain(
			renderFamily(
				{
					toolName: "bash",
					args: { command: "seq 1 150" },
					result: {
						content: [{ type: "text", text: seq150 }],
						details: { exitCode: 0, wallTimeMs: 100 },
						isError: false,
						durationMs: 100,
					},
					expanded: false,
					isPartial: false,
				},
				width,
			),
		);
		assert.deepEqual(doneRows, [
			" ● Bash(seq 1 150) · 0.1s",
			"   ⎿  … +145 earlier lines (ctrl+o to expand)",
			"      146",
			"      147",
			"      148",
			"      149",
			"      150",
		]);
		const joined = doneRows.join("\n");
		assert.doesNotMatch(joined, /Took|Elapsed|Observed for|Command exited with code|ctrl\+o Expand/);
	}

	const indentedRows = plain(
		renderFamily({
			toolName: "bash",
			args: { command: "wc -l greet.ts sum.ts" },
			result: {
				content: [{ type: "text", text: "  3 greet.ts\n  6 sum.ts\n" }],
				details: { exitCode: 0 },
				isError: false,
			},
			expanded: false,
			isPartial: false,
		}),
	);
	assert.deepEqual(indentedRows, [" ● Bash(wc -l greet.ts sum.ts)", "   ⎿    3 greet.ts", "        6 sum.ts"]);

	const failedRows = plain(
		renderFamily({
			toolName: "bash",
			args: { command: "ls /nonexistent-dir" },
			result: {
				content: [
					{
						type: "text",
						text: "ls: cannot access '/nonexistent-dir': No such file or directory\n\nCommand exited with code 2",
					},
				],
				details: { exitCode: 2 },
				isError: true,
			},
			expanded: false,
			isPartial: false,
		}),
	);
	assert.deepEqual(failedRows, [
		" ✗ Bash(ls /nonexistent-dir) · exit 2",
		"   ⎿  ls: cannot access '/nonexistent-dir': No such file or directory",
	]);

	const timeoutRows = plain(
		renderFamily({
			toolName: "bash",
			args: { command: "sleep 120", timeout: 60 },
			result: {
				content: [{ type: "text", text: "Command timed out after 60 seconds" }],
				isError: true,
			},
			expanded: false,
			isPartial: false,
		}),
	);
	assert.equal(timeoutRows[0], " ✗ Bash(sleep 120) · timed out after 60s");

	const interruptedRows = plain(
		renderFamily({
			toolName: "bash",
			args: { command: "echo started; sleep 40; echo finished" },
			result: {
				content: [{ type: "text", text: "started\n\nCommand aborted" }],
				isError: true,
				durationMs: 1200,
			},
			expanded: false,
			isPartial: false,
		}),
	);
	assert.deepEqual(interruptedRows, [
		" ◼ Bash(echo started; sleep 40; echo finished) · interrupted after 1.2s",
		"   ⎿  started",
	]);

	const emptyRows = plain(
		renderFamily({
			toolName: "bash",
			args: { command: "git status --short" },
			result: {
				content: [{ type: "text", text: "(no output)" }],
				details: { exitCode: 0 },
				isError: false,
			},
			expanded: false,
			isPartial: false,
		}),
	);
	assert.deepEqual(emptyRows, [" ● Bash(git status --short)", "   ⎿  (no output)"]);

	const backgroundRows = plain(
		renderFamily({
			toolName: "bash",
			args: { command: "npm test", wait: { kind: "background" } },
			canManageTask: (taskId) => taskId === "task-1",
			result: {
				content: [
					{
						type: "text",
						text: "(no output)\n\nCommand is still running (task task-1). Its execution timeout stops it after 5m.",
					},
				],
				details: {
					observation: { kind: "yielded", taskId: "task-1", reason: "background" },
				},
				isError: false,
			},
			expanded: false,
			isPartial: false,
		}),
	);
	assert.deepEqual(backgroundRows, [
		" ● Bash(npm test) · background",
		"   ⎿  Running in background · /tasks to manage",
	]);

	const waitRows = plain(
		renderFamily({
			toolName: "bash",
			args: { action: "wait", id: "task-1-0-3" },
			result: {
				content: [
					{
						type: "text",
						text: "line 1\nline 2\n\nTask task-1-0-3 completed with exit code 0.",
					},
				],
				details: {
					observation: {
						kind: "settled",
						taskId: "task-1-0-3",
						result: { kind: "completed", exitCode: 0 },
					},
				},
				isError: false,
				durationMs: 12_000,
			},
			expanded: false,
			isPartial: false,
		}),
	);
	assert.deepEqual(waitRows, [
		" ● Wait(task-1-0-3) · 12s",
		"   ⎿  ✓ completed · exit 0",
		"      line 1",
		"      line 2",
	]);
});

test("Edit and Write families format diffs, hunk counts, collapse budgets, errors, rejections and line gutters (#5350)", () => {
	const rawDiff = [
		" 1 export function sum(values: number[]): number {",
		" 2    let total = 0;",
		"+3    // accumulate every value",
		" 3    for (const value of values) total += value;",
		"   ...",
		"-9    return 0;",
		"+9    return total;",
	].join("\n");

	const editRows = plain(
		renderFamily({
			toolName: "edit",
			args: { path: `${CWD}/src/sum.ts`, edits: [{ oldText: "return 0;", newText: "return total;" }] },
			result: {
				content: [{ type: "text", text: "Successfully replaced 2 block(s) in src/sum.ts." }],
				details: { diff: rawDiff, patch: "" },
				isError: false,
			},
			expanded: false,
			isPartial: false,
		}),
	);
	assert.deepEqual(editRows, [
		" ● Edit(src/sum.ts) · 2 hunks",
		"   ⎿  +2 −1",
		"       1  export function sum(values: number[]): number {",
		"       2     let total = 0;",
		"      +3     // accumulate every value",
		"       3     for (const value of values) total += value;",
		"      ⋮",
		"      -9     return 0;",
		"      +9     return total;",
	]);

	const longDiff = Array.from({ length: 15 }, (_, index) => `+${index + 1} line ${index + 1}`).join("\n");
	const collapsedLongEdit = plain(
		renderFamily({
			toolName: "edit",
			args: { path: "src/sum.ts", edits: [{ oldText: "a", newText: "b" }] },
			result: {
				content: [{ type: "text", text: "Successfully replaced 1 block(s) in src/sum.ts." }],
				details: { diff: longDiff, patch: "" },
				isError: false,
			},
			expanded: false,
			isPartial: false,
		}),
	);
	assert.equal(collapsedLongEdit[0], " ● Edit(src/sum.ts)");
	assert.equal(collapsedLongEdit[1], "   ⎿  +15 −0");
	assert.equal(collapsedLongEdit.at(-1), "      … +3 lines (ctrl+o to expand)");

	const editNoMatch = plain(
		renderFamily({
			toolName: "edit",
			args: { path: "src/sum.ts", edits: [{ oldText: "missing", newText: "present" }] },
			result: {
				content: [{ type: "text", text: "Could not find the exact text in src/sum.ts." }],
				isError: true,
			},
			expanded: false,
			isPartial: false,
		}),
	);
	assert.deepEqual(editNoMatch, [
		" ✗ Edit(src/sum.ts) · no match",
		"   ⎿  Could not find the exact text in src/sum.ts.",
	]);

	const editRejected = plain(
		renderFamily({
			toolName: "edit",
			args: { path: "src/sum.ts", edits: [{ oldText: "a", newText: "b" }] },
			result: {
				content: [{ type: "text", text: "Permission rejected by user" }],
				details: { rejected: true },
				isError: true,
			},
			expanded: false,
			isPartial: false,
		}),
	);
	assert.deepEqual(editRejected, [" ◼ Edit(src/sum.ts) · rejected", "   ⎿  Not run"]);

	const writeCollapsed = plain(
		renderFamily({
			toolName: "write",
			args: { path: `${CWD}/notes.md`, content: "one\ntwo\nthree\n" },
			result: {
				content: [{ type: "text", text: "Successfully wrote to notes.md" }],
				details: { isNewFile: true },
				isError: false,
			},
			expanded: false,
			isPartial: false,
		}),
	);
	assert.deepEqual(writeCollapsed, [" ● Write(notes.md)", "   ⎿  Wrote 3 lines · new file"]);

	const writeExpanded = plain(
		renderFamily({
			toolName: "write",
			args: { path: `${CWD}/notes.md`, content: "one\ntwo\nthree\n" },
			result: {
				content: [{ type: "text", text: "Successfully wrote to notes.md" }],
				isError: false,
			},
			expanded: true,
			isPartial: false,
		}),
	);
	assert.deepEqual(writeExpanded, [" ● Write(notes.md)", "   ⎿  1  one", "      2  two", "      3  three"]);
});

test("Todo, WebSearch and Fetch families format compact headers, summaries, URLs without scheme and inert text (#5350)", () => {
	const todoCreate = plain(
		renderFamily({
			toolName: "todo",
			args: { action: "create", title: "Tool block demo" },
			result: {
				content: [{ type: "text", text: "{}" }],
				details: {
					action: "create",
					todo: {
						id: "3be83871",
						title: "Tool block demo",
						tags: [],
						status: "open",
						created_at: "2026-11-17",
						body: "",
					},
				},
				isError: false,
			},
			expanded: false,
			isPartial: false,
		}),
	);
	assert.deepEqual(todoCreate, [" ● Todo(create · Tool block demo)", "   ⎿  Created TODO-3be83871"]);

	const todoClose = plain(
		renderFamily({
			toolName: "todo",
			args: { action: "update", id: "3be83871", status: "closed" },
			result: {
				content: [{ type: "text", text: "{}" }],
				details: {
					action: "update",
					todo: {
						id: "3be83871",
						title: "Tool block demo",
						tags: [],
						status: "closed",
						created_at: "2026-11-17",
						body: "",
					},
				},
				isError: false,
			},
			expanded: false,
			isPartial: false,
		}),
	);
	assert.deepEqual(todoClose, [" ● Todo(update · TODO-3be83871)", "   ⎿  Closed TODO-3be83871"]);

	const todoList = plain(
		renderFamily({
			toolName: "todo",
			args: { action: "list" },
			result: {
				content: [{ type: "text", text: "{}" }],
				details: {
					action: "list",
					todos: [
						{ id: "3be83871", title: "Tool block demo", tags: [], status: "open", created_at: "2026-11-17" },
					],
				},
				isError: false,
			},
			expanded: false,
			isPartial: false,
		}),
	);
	assert.deepEqual(todoList, [
		" ● Todo(list)",
		"   ⎿  1 open · 0 assigned · 0 closed",
		"      TODO-3be83871  Tool block demo",
	]);

	const webSearchText = [
		"Synthesized answer.",
		"",
		"---",
		"",
		"**Sources:**",
		"1. Atomic TUI Guide",
		"   https://example.com/tui",
		"",
		"2. Markdown Renderer Docs",
		"   https://docs.example.org/md",
		"",
		"3. Terminal Blocks Spec",
		"   https://spec.example.net/blocks",
		"",
		"4. Extra Source One",
		"   https://one.example.test/a",
		"",
		"5. Extra Source Two",
		"   https://two.example.test/b",
	].join("\n");

	const webRows = plain(
		renderFamily({
			toolName: "web_search",
			args: { query: "atomic tui markdown renderer" },
			result: {
				content: [{ type: "text", text: webSearchText }],
				details: { queryCount: 1, successfulQueries: 1, totalResults: 5 },
				isError: false,
				durationMs: 2100,
			},
			expanded: false,
			isPartial: false,
		}),
	);
	assert.deepEqual(webRows, [
		" ● WebSearch(atomic tui markdown renderer) · 2.1s",
		"   ⎿  5 results",
		"      Atomic TUI Guide · example.com",
		"      Markdown Renderer Docs · docs.example.org",
		"      Terminal Blocks Spec · spec.example.net",
		"      … +2 lines (ctrl+o to expand)",
	]);

	const fetchRaw = renderFamily({
		toolName: "fetch_content",
		args: { urls: ["https://github.com/org/repo/blob/main/README.md"] },
		result: {
			content: [{ type: "text", text: "# Readme\n\u001b]8;;https://evil.test\u0007click\u001b]8;;\u0007" }],
			details: { urlCount: 1, successful: 1, totalChars: Math.round(12.4 * 1024), title: "README.md" },
			isError: false,
			durationMs: 800,
		},
		expanded: false,
		isPartial: false,
	});
	assert.deepEqual(plain(fetchRaw), [
		" ● Fetch(github.com/org/repo/blob/main/README.md) · 0.8s",
		"   ⎿  Fetched 12.4 KB · markdown",
	]);

	const fetchExpanded = renderFamily({
		toolName: "fetch_content",
		args: { urls: ["https://github.com/org/repo/blob/main/README.md"] },
		result: {
			content: [{ type: "text", text: "# Readme\n\u001b]8;;https://evil.test\u0007click\u001b]8;;\u0007" }],
			details: { urlCount: 1, successful: 1, totalChars: Math.round(12.4 * 1024), title: "README.md" },
			isError: false,
			durationMs: 800,
		},
		expanded: true,
		isPartial: false,
	});
	assert.ok(!fetchExpanded.join("").includes("\u001b]8;"));

	const directWebComponent = renderWebSearchResult(
		{
			content: [{ type: "text", text: webSearchText }],
			details: { queryCount: 1, successfulQueries: 1, totalResults: 5 },
		},
		{ expanded: false, isPartial: false },
		theme,
	);
	assert.deepEqual(plain(directWebComponent.render(80)), [
		"5 results",
		"Atomic TUI Guide · example.com",
		"Markdown Renderer Docs · docs.example.org",
		"Terminal Blocks Spec · spec.example.net",
		"… +2 lines (ctrl+o to expand)",
	]);

	const directFetchComponent = renderFetchContentResult(
		{
			content: [{ type: "text", text: "# Readme" }],
			details: { urlCount: 1, successful: 1, totalChars: Math.round(12.4 * 1024), title: "README.md" },
		},
		{ expanded: false, isPartial: false },
		theme,
	);
	assert.deepEqual(plain(directFetchComponent.render(80)), ["Fetched 12.4 KB · markdown"]);

	for (const narrowWidth of [12, 20]) {
		const narrowRows = renderFamily(
			{
				toolName: "bash",
				args: { command: "echo hello world from a very long command line" },
				result: { content: [{ type: "text", text: "output line" }], isError: false, durationMs: 1200 },
				expanded: false,
				isPartial: false,
			},
			narrowWidth,
		);
		assert.ok(narrowRows.every((line) => visibleWidth(line) <= narrowWidth));
	}

	assert.equal(
		builtinToolBlockPresentation({
			toolName: "custom_extension_tool",
			args: { secret: "hidden" },
			cwd: CWD,
			expanded: false,
			isPartial: false,
			executionStarted: true,
			argsComplete: true,
		}),
		undefined,
	);
});

test("expanded Read, Write and Bash wrap 300-character lines without losing characters at 80 and 160 columns (#5350)", () => {
	const longToken = Array.from({ length: 30 }, (_, index) => `seg${String(index + 1).padStart(2, "0")}abcdef`).join(
		"_",
	);
	assert.ok(longToken.length >= 300);

	for (const width of [80, 160]) {
		const readExpanded = plain(
			renderFamily(
				{
					toolName: "read",
					args: { path: "src/long.ts" },
					result: { content: [{ type: "text", text: longToken }], isError: false },
					expanded: true,
					isPartial: false,
				},
				width,
			),
		);
		const readReconstructed = readExpanded
			.slice(1)
			.map((line) => line.replace(/^\s*⎿\s*\d+\s+/, "").trim())
			.join("");
		assert.equal(readReconstructed, longToken);

		const writeExpanded = plain(
			renderFamily(
				{
					toolName: "write",
					args: { path: "src/long.ts", content: longToken },
					result: { content: [{ type: "text", text: "Successfully wrote to src/long.ts" }], isError: false },
					expanded: true,
					isPartial: false,
				},
				width,
			),
		);
		const writeReconstructed = writeExpanded
			.slice(1)
			.map((line) => line.replace(/^\s*⎿\s*\d+\s+/, "").trim())
			.join("");
		assert.equal(writeReconstructed, longToken);

		const bashExpanded = plain(
			renderFamily(
				{
					toolName: "bash",
					args: { command: "echo long" },
					result: {
						content: [{ type: "text", text: longToken }],
						details: { exitCode: 0, wallTimeMs: 1000 },
						isError: false,
						durationMs: 1000,
					},
					expanded: true,
					isPartial: false,
				},
				width,
			),
		);
		assert.equal(bashExpanded[0], " ● Bash(echo long) · 1.0s");
		const bashReconstructed = bashExpanded
			.slice(1)
			.map((line) => line.replace(/^\s*⎿\s*/, "").trim())
			.join("");
		assert.equal(bashReconstructed, longToken);
	}
});

test("executed permission failures keep exit/error output while only trusted metadata marks rejected or waiting for approval (#5350)", () => {
	for (const width of [80, 160]) {
		const bashPermDenied = plain(
			renderFamily(
				{
					toolName: "bash",
					args: { command: "cat secret" },
					result: {
						content: [
							{
								type: "text",
								text: "cat: secret: Permission denied\n\nCommand exited with code 1",
							},
						],
						isError: true,
					},
					expanded: false,
					isPartial: false,
				},
				width,
			),
		);
		assert.deepEqual(bashPermDenied, [" ✗ Bash(cat secret) · exit 1", "   ⎿  cat: secret: Permission denied"]);

		const bashProgramRefused = plain(
			renderFamily(
				{
					toolName: "bash",
					args: { command: "./deploy.sh" },
					result: {
						content: [
							{
								type: "text",
								text: "remote: Permission rejected by user\n\nCommand exited with code 1",
							},
						],
						details: { exitCode: 1 },
						isError: true,
					},
					expanded: false,
					isPartial: false,
					executionStarted: true,
				},
				width,
			),
		);
		assert.deepEqual(bashProgramRefused, [
			" ✗ Bash(./deploy.sh) · exit 1",
			"   ⎿  remote: Permission rejected by user",
		]);

		const readPermDenied = plain(
			renderFamily(
				{
					toolName: "read",
					args: { path: "secret.txt" },
					result: {
						content: [{ type: "text", text: "EACCES: permission denied, open 'secret.txt'" }],
						isError: true,
					},
					expanded: false,
					isPartial: false,
				},
				width,
			),
		);
		assert.deepEqual(readPermDenied, [
			" ✗ Read(secret.txt) · permission denied",
			"   ⎿  EACCES: permission denied, open 'secret.txt'",
		]);

		const writePermDenied = plain(
			renderFamily(
				{
					toolName: "write",
					args: { path: "secret.txt", content: "top secret" },
					result: {
						content: [{ type: "text", text: "EACCES: permission denied, open 'secret.txt'" }],
						isError: true,
					},
					expanded: false,
					isPartial: false,
				},
				width,
			),
		);
		assert.deepEqual(writePermDenied, [
			" ✗ Write(secret.txt) · permission denied",
			"   ⎿  EACCES: permission denied, open 'secret.txt'",
		]);

		const trustedRejectedDetails = plain(
			renderFamily(
				{
					toolName: "bash",
					args: { command: "rm -rf build" },
					result: {
						content: [{ type: "text", text: "Action rejected" }],
						details: { status: "rejected" },
						isError: true,
					},
					expanded: false,
					isPartial: false,
				},
				width,
			),
		);
		assert.deepEqual(trustedRejectedDetails, [" ◼ Bash(rm -rf build) · rejected", "   ⎿  Not run"]);

		const notStartedHostRejected = plain(
			renderFamily(
				{
					toolName: "bash",
					args: { command: "rm -rf build" },
					result: {
						content: [{ type: "text", text: "Permission rejected by user" }],
						isError: true,
					},
					expanded: false,
					isPartial: false,
					executionStarted: false,
				},
				width,
			),
		);
		assert.deepEqual(notStartedHostRejected, [" ◼ Bash(rm -rf build) · rejected", "   ⎿  Not run"]);
	}
});

test("waiting for approval is derived from trusted result details rather than raw model args (#5350)", () => {
	for (const width of [80, 160]) {
		const spoofedWaitingInArgs = plain(
			renderFamily(
				{
					toolName: "bash",
					args: { command: "cat secret", waitingForApproval: true },
					expanded: false,
					isPartial: true,
				},
				width,
			),
		);
		assert.deepEqual(spoofedWaitingInArgs, [" ∀ Bash(cat secret)"]);

		const spoofedReadWaitingInArgs = plain(
			renderFamily(
				{
					toolName: "read",
					args: { path: "secret.txt", waitingForApproval: true },
					expanded: false,
					isPartial: true,
				},
				width,
			),
		);
		assert.deepEqual(spoofedReadWaitingInArgs, [" ∀ Read(secret.txt)"]);

		const trustedWaitingInDetails = plain(
			renderFamily(
				{
					toolName: "bash",
					args: { command: "cat secret" },
					result: {
						content: [],
						details: { waitingForApproval: true },
						isError: false,
					},
					expanded: false,
					isPartial: true,
				},
				width,
			),
		);
		assert.deepEqual(trustedWaitingInDetails, [" ! Bash(cat secret) · waiting for approval"]);
	}
});

test("background shell hints point to /tasks, where shells are managed, and require an available task row (#5350)", () => {
	const input = {
		toolName: "bash",
		args: { command: "sleep 40" },
		result: { content: [], details: { observation: { kind: "yielded", taskId: "task-1" } }, isError: false },
		isPartial: false,
		expanded: false,
		canManageTask: (id: string) => id === "task-1",
	};
	setKeybindings(new KeybindingsManager({ "app.agents.focus": "ctrl+g" }));
	assert.match(plain(renderFamily(input)).join("\n"), /Running in background · \/tasks to manage/);
	assert.doesNotMatch(plain(renderFamily(input)).join("\n"), /ctrl\+g/, "the agent panel does not list shells");
	setKeybindings(new KeybindingsManager({ "app.agents.focus": [] }));
	assert.match(plain(renderFamily(input)).join("\n"), /\/tasks to manage/);
	setKeybindings(new KeybindingsManager());
	assert.doesNotMatch(plain(renderFamily({ ...input, canManageTask: () => false })).join("\n"), /to manage/);
});

test("large expanded read gutters keep every retained source line (#5350)", () => {
	const count = 150_000;
	const content = `[Lines 1-${count} of ${count}]\n${Array<string>(count).fill("kept source").join("\n")}`;
	const view = builtinToolBlockPresentation({
		toolName: "read",
		args: { path: "large.txt" },
		result: { content: [{ type: "text", text: content }], isError: false },
		expanded: true,
		isPartial: false,
		cwd: "/workspace",
		executionStarted: true,
		argsComplete: true,
	});
	const rows = view!.details!.render(80).map(stripTerminalSequences);
	assert.equal(rows.length, count);
	assert.match(rows.at(-1)!, /150000 {2}kept source/);
});

test("Bash derives final state from settled metadata and does not let program output or requested background wait override completion (#5350)", () => {
	for (const width of [80, 160]) {
		const stdoutCommandAborted = plain(
			renderFamily(
				{
					toolName: "bash",
					args: { command: "echo 'Command aborted'" },
					result: {
						content: [{ type: "text", text: "Command aborted" }],
						details: { exitCode: 0 },
						isError: false,
					},
					expanded: false,
					isPartial: false,
				},
				width,
			),
		);
		assert.deepEqual(stdoutCommandAborted, [" ● Bash(echo 'Command aborted')", "   ⎿  Command aborted"]);

		const stdoutTimeoutLooking = plain(
			renderFamily(
				{
					toolName: "bash",
					args: { command: "./check-logs.sh" },
					result: {
						content: [{ type: "text", text: "step 1\n\nCommand timed out after 60 seconds" }],
						details: { timeoutSeconds: 300, wallTimeMs: 80 },
						isError: false,
					},
					expanded: false,
					isPartial: false,
				},
				width,
			),
		);
		assert.deepEqual(stdoutTimeoutLooking, [
			" ● Bash(./check-logs.sh) · 0.1s",
			"   ⎿  step 1",
			"",
			"      Command timed out after 60 seconds",
		]);

		const stdoutExitLooking = plain(
			renderFamily(
				{
					toolName: "bash",
					args: { command: "echo 'Command exited with code 2'" },
					result: {
						content: [{ type: "text", text: "Command exited with code 2" }],
						isError: false,
					},
					expanded: false,
					isPartial: false,
				},
				width,
			),
		);
		assert.deepEqual(stdoutExitLooking, [
			" ● Bash(echo 'Command exited with code 2')",
			"   ⎿  Command exited with code 2",
		]);

		const stdoutBackgroundLooking = plain(
			renderFamily(
				{
					toolName: "bash",
					args: { command: "echo status" },
					result: {
						content: [
							{
								type: "text",
								text: "Command is still running (task task-9).",
							},
						],
						details: { exitCode: 0 },
						isError: false,
					},
					expanded: false,
					isPartial: false,
				},
				width,
			),
		);
		assert.deepEqual(stdoutBackgroundLooking, [
			" ● Bash(echo status)",
			"   ⎿  Command is still running (task task-9).",
		]);

		const failedExitWithAbortOutput = plain(
			renderFamily(
				{
					toolName: "bash",
					args: { command: "./run-job.sh" },
					result: {
						content: [{ type: "text", text: "Command aborted\n\nCommand exited with code 1" }],
						details: { exitCode: 1 },
						isError: true,
					},
					expanded: false,
					isPartial: false,
				},
				width,
			),
		);
		assert.deepEqual(failedExitWithAbortOutput, [" ✗ Bash(./run-job.sh) · exit 1", "   ⎿  Command aborted"]);

		const settledWithBackgroundWaitArg = plain(
			renderFamily(
				{
					toolName: "bash",
					args: { command: "echo ready", wait: { kind: "background" } },
					result: {
						content: [{ type: "text", text: "ready" }],
						details: {
							observation: {
								kind: "settled",
								taskId: "task-2",
								result: {
									kind: "completed",
									output: {
										ownerId: "owner-1" as never,
										taskId: "task-2" as never,
										artifactId: "art-1",
										byteCount: "5",
										omittedRanges: [],
									},
									exitCode: 0,
								},
							},
						},
						isError: false,
					},
					expanded: false,
					isPartial: false,
				},
				width,
			),
		);
		assert.deepEqual(settledWithBackgroundWaitArg, [" ● Bash(echo ready)", "   ⎿  ready"]);
	}
});
