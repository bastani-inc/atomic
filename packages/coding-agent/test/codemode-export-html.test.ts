import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { parseHTML } from "linkedom";
import { test } from "vitest";
import { exportFromFile, exportSessionToHtml } from "../src/core/export-html/index.ts";
import { createToolHtmlRenderer } from "../src/core/export-html/tool-renderer.ts";
import { CURRENT_SESSION_VERSION, SessionManager } from "../src/core/session-manager.ts";
import { codemodeRenderers } from "../src/extensions/codemode/renderer.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

/** The exported page after its scripts have drawn the messages. */
function exportedDocument(htmlPath: string): Document {
	const { window, document } = parseHTML(readFileSync(htmlPath, "utf8"));
	Object.assign(window.HTMLElement.prototype, { scrollIntoView: () => undefined });
	const location = { search: "", hash: "" };
	Object.defineProperty(window, "location", { configurable: true, value: location });
	const context = {
		window,
		document,
		atob,
		TextDecoder,
		URLSearchParams,
		console,
		navigator: { clipboard: undefined },
		location,
		history: { replaceState: () => undefined },
		localStorage: { getItem: () => null, setItem: () => undefined },
		matchMedia: () => ({ matches: false, addEventListener: () => undefined }),
		requestAnimationFrame: (callback: () => void) => {
			callback();
			return 0;
		},
		setTimeout: () => 0,
		clearTimeout: () => undefined,
	};
	for (const script of document.querySelectorAll("script")) {
		if (script.getAttribute("type") === "application/json") continue;
		runInNewContext(script.textContent ?? "", context);
	}
	return document as unknown as Document;
}

test("HTML export shows a codemode call's script in its header, all of it on a click, and not again in the result", async () => {
	initTheme("dark");
	const dir = mkdtempSync(join(tmpdir(), "atomic-codemode-export-"));
	try {
		const code = Array.from({ length: 20 }, (_, index) => `const v${index} = ${index};`).join("\n");
		const session = SessionManager.inMemory(dir);
		await session.appendMessage(
			fauxAssistantMessage([fauxToolCall("codemode", { code }, { id: "script-call" })], { stopReason: "toolUse" }),
		);
		await session.appendMessage({
			role: "toolResult",
			toolCallId: "script-call",
			toolName: "codemode",
			content: [
				{ type: "text", text: "Script completed\nWall time 1.0 seconds\nOutput:\n" },
				{ type: "text", text: "script output" },
			],
			details: { calls: [] },
			isError: false,
			timestamp: Date.now(),
		});
		const output = await exportSessionToHtml(session, undefined, {
			outputPath: join(dir, "export.html"),
			toolRenderer: createToolHtmlRenderer({
				getToolRenderers: (name) => (name === "codemode" ? codemodeRenderers : undefined),
				theme,
				cwd: dir,
			}),
		});
		const execution = exportedDocument(output).getElementById("tool-call-script-call");
		assert.ok(execution);
		const header = execution.querySelector(".tool-header");
		assert.ok(header);
		const preview = header.querySelector(".output-preview")?.textContent ?? "";
		const full = header.querySelector(".output-full")?.textContent ?? "";
		assert.match(preview, /codemode\(\s*const v0 = 0;/);
		assert.doesNotMatch(preview, /const v19/);
		assert.match(full, /const v0 = 0;[\s\S]*const v19 = 19;\s*\)/);
		assert.ok(header.classList.contains("expandable"));
		const result = execution.querySelector(".tool-output")?.textContent ?? "";
		assert.match(result, /script output/);
		assert.doesNotMatch(result, /const v0/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test.each([
	["one long JSON record", JSON.stringify({ sample: "a".repeat(180) })],
	["multiple lines and ANSI", "\n  first\r\n\n\t\x1b[31mred\x1b[0m & <tag>\nlast  \n"],
])(
	"a saved codemode call shows its formatted script, nested calls and verbatim result: %s (#5525, #5531)",
	async (_label, outputText) => {
		initTheme("dark");
		const dir = mkdtempSync(join(tmpdir(), "atomic-codemode-file-export-"));
		try {
			const code = Array.from({ length: 20 }, (_, index) => `const v${index} = ${index};`).join("\n");
			const call = fauxAssistantMessage([fauxToolCall("codemode", { code }, { id: "script-call" })], {
				stopReason: "toolUse",
			});
			const scriptHeader = "Script completed\nWall time 1.0 seconds\nOutput:\n";
			const result = {
				role: "toolResult",
				toolCallId: "script-call",
				toolName: "codemode",
				content: [
					{ type: "text", text: scriptHeader },
					{ type: "text", text: outputText },
				],
				details: { calls: [{ id: "nested", name: "read", args: JSON.stringify({ path: "a.txt" }), status: "ok" }] },
				isError: false,
				timestamp: Date.now(),
			};
			const lines = [
				{
					type: "session",
					version: CURRENT_SESSION_VERSION,
					id: "file-export",
					timestamp: new Date(0).toISOString(),
					cwd: dir,
				},
				{ type: "message", id: "e1", parentId: null, timestamp: new Date(1).toISOString(), message: call },
				{ type: "message", id: "e2", parentId: "e1", timestamp: new Date(2).toISOString(), message: result },
			];
			const sessionPath = join(dir, "session.jsonl");
			writeFileSync(sessionPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
			const execution = exportedDocument(await exportFromFile(sessionPath, join(dir, "out.html"))).getElementById(
				"tool-call-script-call",
			);
			assert.ok(execution);
			const header = execution.querySelector(".tool-header");
			assert.ok(header?.classList.contains("expandable"), "a click on the call shows the whole script");
			assert.match(header.querySelector(".output-preview")?.textContent ?? "", /codemode\(\s*const v0 = 0;/);
			assert.match(header.querySelector(".output-full")?.textContent ?? "", /const v19 = 19;\s*\)/);
			assert.doesNotMatch(header.textContent ?? "", /\\n|"code"/, "not the arguments as JSON");
			assert.match(execution.querySelector(".tool-output")?.textContent ?? "", /Read\(a\.txt\)/);
			const savedText = `${scriptHeader}\n${outputText}`;
			const outputs = Array.from(
				execution.querySelectorAll(".tool-output"),
				(block) => block.querySelector(".output-full") ?? block,
			);
			const resultBlock = outputs.find((block) => block.textContent === savedText);
			assert.ok(resultBlock, JSON.stringify(outputs.map((block) => block.textContent)));
			if (savedText.endsWith("\n")) {
				assert.ok(
					resultBlock.querySelector("br:last-child"),
					"the final empty line is rendered so selection includes its newline",
				);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
);

test("exporting a saved session keeps every argument and note, including codemode's extra saved arguments and completion lines (#5531)", async () => {
	initTheme("dark");
	const dir = mkdtempSync(join(tmpdir(), "atomic-tool-file-export-"));
	try {
		const calls = [
			{
				id: "find-call",
				name: "find",
				args: { paths: ["*.txt"], limit: 2, hidden: false, gitignore: false },
				text: "b.txt\nbig.txt\n\n[2 results limit reached. Refine pattern or path to narrow results]",
				details: { scopePath: ".", fileCount: 2, files: ["b.txt", "big.txt"], resultLimitReached: 2 },
			},
			{
				id: "grep-call",
				name: "grep",
				args: { pattern: "needle", paths: ["src"], limit: 1, ignoreCase: true },
				text: "src/a.ts:1: needle\n\n[1 matches limit reached. Use limit=2 for more]",
				details: { matchCount: 1, fileCount: 1 },
			},
			{
				id: "search-call",
				name: "search",
				args: { pattern: "needle", paths: ["src"], context: 2 },
				text: "src/a.ts:1: needle\n\n[Skipped missing paths: lib]",
				details: { matchCount: 1, fileCount: 1 },
			},
			{
				id: "todo-call",
				name: "todo",
				args: { action: "list", status: "open" },
				text: "Open todos: 1\nTODO-1 write the report",
				details: { action: "list", todos: [] },
			},
			{
				id: "script-call",
				name: "codemode",
				args: { code: "return 1 + 1;", rationale: "export-key-431", decorated: { priority: 3 } },
				text: "Script completed\nWall time 1.0 seconds\nOutput:\n",
				more: "2",
				details: { calls: [] },
			},
		];
		const lines: unknown[] = [
			{
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: "file-export-notes",
				timestamp: new Date(0).toISOString(),
				cwd: dir,
			},
		];
		let parentId: string | null = null;
		for (const [index, call] of calls.entries()) {
			const message = fauxAssistantMessage([fauxToolCall(call.name, call.args, { id: call.id })], {
				stopReason: "toolUse",
			});
			const result = {
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [
					{ type: "text", text: call.text },
					...(call.more === undefined ? [] : [{ type: "text", text: call.more }]),
				],
				details: call.details,
				isError: false,
				timestamp: Date.now(),
			};
			for (const [offset, entry] of [message, result].entries()) {
				const id = `e${index}-${offset}`;
				lines.push({
					type: "message",
					id,
					parentId,
					timestamp: new Date(1 + lines.length).toISOString(),
					message: entry,
				});
				parentId = id;
			}
		}
		const sessionPath = join(dir, "session.jsonl");
		writeFileSync(sessionPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
		const page = exportedDocument(await exportFromFile(sessionPath, join(dir, "out.html")));

		for (const call of calls) {
			const shown = page.getElementById(`tool-call-${call.id}`)?.textContent ?? "";
			if (call.name === "codemode") {
				assert.match(shown, /codemode\(return 1 \+ 1;\)/);
				assert.ok(
					shown.includes(JSON.stringify({ rationale: "export-key-431", decorated: { priority: 3 } }, null, 2)),
					shown,
				);
			} else {
				assert.ok(shown.includes(JSON.stringify(call.args, null, 2)), `${call.name} shows its arguments: ${shown}`);
			}
			for (const line of call.text.split("\n").filter(Boolean)) {
				assert.ok(shown.includes(line), `${call.name} shows ${JSON.stringify(line)}: ${shown}`);
			}
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
