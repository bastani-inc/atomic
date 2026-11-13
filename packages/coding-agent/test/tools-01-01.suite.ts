import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { TUI } from "@earendil-works/pi-tui";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import { createBashTool } from "../src/core/tools/bash.ts";
import { createGrepTool } from "../src/core/tools/grep.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { createEditTool, createFindTool, createLsTool, createReadTool, createWriteTool } from "../src/index.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";

const readTool = createReadTool(process.cwd());
const _writeTool = createWriteTool(process.cwd());
const _editTool = createEditTool(process.cwd());
const _bashTool = createBashTool(process.cwd());
const _grepTool = createGrepTool(process.cwd());
const _findTool = createFindTool(process.cwd());
const _lsTool = createLsTool(process.cwd());

// Helper to extract text from content blocks
function getTextOutput(result: any): string {
	return (
		result.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") || ""
	);
}

function shellQuoteForTest(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

describe("Coding Agent Tools", () => {
	let testDir: string;

	beforeEach(() => {
		// Create a unique temporary directory for each test
		testDir = join(tmpdir(), `coding-agent-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		// Clean up test directory
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("read tool", () => {
		it("should read file contents that fit within limits (#10251)", async () => {
			const testFile = join(testDir, "test.txt");
			const content = "Hello, world!\nLine 2\nLine 3";
			writeFileSync(testFile, content);

			const result = await readTool.execute("test-call-1", { path: testFile });

			expect(getTextOutput(result)).toBe(content);
			// No truncation message since file fits within limits
			expect(getTextOutput(result)).not.toContain("Continue with path selector");
			expect(result.details?.meta?.source).toBe(testFile);
			expect(result.structuredContent).toBe(getTextOutput(result));
		});
		it("should handle non-existent files", async () => {
			const testFile = join(testDir, "nonexistent.txt");

			await expect(readTool.execute("test-call-2", { path: testFile })).rejects.toThrow(/ENOENT|not found/i);
		});
		it("should truncate files exceeding line limit", async () => {
			const testFile = join(testDir, "large.txt");
			const lines = Array.from({ length: 3500 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-3", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("Line 1");
			expect(output).toContain("Line 3000");
			expect(output).not.toContain("Line 3001");
			expect(output).toContain("[Showing lines 1-3000 of 3500. Continue with path selector :3001.]");
		});
		it("should truncate when byte limit exceeded", async () => {
			const testFile = join(testDir, "large-bytes.txt");
			// Create file that exceeds the 50KB byte limit but stays within the oversized-read char threshold.
			const lines = Array.from({ length: 300 }, (_, i) => `Line ${i + 1}: ${"é".repeat(100)}`);
			const content = lines.join("\n");
			expect(content.length).toBeLessThanOrEqual(50_000);
			expect(Buffer.byteLength(content, "utf-8")).toBeGreaterThan(50 * 1024);
			writeFileSync(testFile, content);

			const result = await readTool.execute("test-call-4", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("Line 1:");
			expect(output).not.toContain("File read blocked");
			// Should show byte limit message
			expect(output).toMatch(/\[Showing lines 1-\d+ of 300 \(.* limit\)\. Continue with path selector :\d+\.\]/);
		});
		it("should allow text reads at the oversized-read char threshold", async () => {
			const testFile = join(testDir, "threshold-allowed.txt");
			const content = "x".repeat(50_000);
			expect(content.length).toBe(50_000);
			writeFileSync(testFile, content);

			const result = await readTool.execute("test-call-threshold-allowed", { path: testFile });
			const output = getTextOutput(result);

			expect(output).not.toContain("File read blocked");
			expect(result.details?.oversizedRead).toBeUndefined();
			expect(result.details?.meta?.source).toBe(testFile);
			expect(output).toBe(content);
		});
		it("should block text reads above the oversized-read char threshold without leaking content", async () => {
			const testFile = join(testDir, "too-large.txt");
			const sentinel = "DO_NOT_LEAK_1323_CONTENT";
			const fillerPrefix = "z".repeat(100);
			const content = `${sentinel}\n${fillerPrefix}${"z".repeat(50_000)}`;
			expect(content.length).toBeGreaterThan(50_000);
			writeFileSync(testFile, content);

			const result = await readTool.execute("test-call-threshold-blocked", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("File read blocked");
			expect(output).toContain(testFile);
			expect(output).toContain(`${content.length.toLocaleString("en-US")} chars`);
			expect(output).toContain("threshold: 50,000 chars");
			expect(output).toContain("search({");
			expect(output).toContain(":1+200");
			expect(output).toContain("targeted snippet");
			expect(output).not.toContain(sentinel);
			expect(output).not.toContain(fillerPrefix);
			expect(result.isError).toBe(true);
			expect(result.details?.oversizedRead?.blocked).toBe(true);
			expect(result.details?.oversizedRead?.path).toBe(testFile);
			expect(result.details?.oversizedRead?.chars).toBe(content.length);
			expect(result.details?.oversizedRead?.maxChars).toBe(50_000);
			expect(result.details?.truncation).toBeUndefined();
		});
		it("should allow small ranges from files that would be oversized as whole-file reads", async () => {
			const testFile = join(testDir, "large-with-range.txt");
			const lines = Array.from({ length: 1_000 }, (_, i) => `Line ${i + 1}: ${"x".repeat(100)}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-range-allowed", {
				path: `${testFile}:100+3`,
			});
			const output = getTextOutput(result);

			expect(output).not.toContain("File read blocked");
			expect(result.details?.oversizedRead).toBeUndefined();
			expect(output).toContain("Line 100:");
			expect(output).toContain("Line 102:");
			expect(output).not.toContain("Line 106:");
			expect(output).toContain("[895 more lines in file. Continue with path selector :106.]");
		});
		it("should show byte-slice guidance for oversized single-line reads", async () => {
			const testFile = join(testDir, "single-line-large.txt");
			const content = "x".repeat(50_001);
			writeFileSync(testFile, content);

			const result = await readTool.execute("test-call-single-line-blocked", { path: `${testFile}:1+1` });
			const output = getTextOutput(result);

			expect(output).toContain("File read blocked");

			expect(output).toContain("line pagination is not useful");
			expect(output).toContain(`sed -n '1p' ${shellQuoteForTest(testFile)} | head -c 51200`);
			expect(output).toContain("tail -c +51201");
			expect(output).not.toContain('"offset": 120');
			expect(output).not.toContain("Read a targeted snippet");
			expect(result.details?.oversizedRead?.byteGuidance).toBe(true);
			expect(result.details?.oversizedRead?.requestedLimit).toBeUndefined();
		});
		it("should treat oversized single-line reads with a trailing newline as byte-slice cases", async () => {
			const testFile = join(testDir, "single-line-large-trailing-newline.txt");
			writeFileSync(testFile, `${"x".repeat(50_001)}\n`);

			const result = await readTool.execute("test-call-single-line-newline-blocked", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("File read blocked");
			expect(output).toContain("line pagination is not useful");
			expect(output).toContain(`sed -n '1p' ${shellQuoteForTest(testFile)} | head -c 51200`);
			expect(output).not.toContain('"offset": 120');
			expect(output).not.toContain("Read a targeted snippet");
			expect(result.details?.oversizedRead?.byteGuidance).toBe(true);
		});
		it("should shell-escape paths in oversized single-line byte guidance", async () => {
			const testFile = join(testDir, "evil$(touch HACKED)'file.txt");
			writeFileSync(testFile, "x".repeat(50_001));

			const result = await readTool.execute("test-call-single-line-shell-escaped", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain(`sed -n '1p' ${shellQuoteForTest(testFile)} | head -c 51200`);
			expect(output).toContain(`tail -c +51201 | head -c 51200`);
			expect(output).not.toContain(`${JSON.stringify(testFile)} | head -c 51200`);
			expect(result.details?.oversizedRead?.byteGuidance).toBe(true);
		});
		it("should render oversized read blocks as tool output instead of source-highlighted code", async () => {
			const testFile = join(testDir, "oversized.ts");
			writeFileSync(testFile, `const value = "${"x".repeat(50_001)}";`);
			const toolDefinition = createReadToolDefinition(testDir);
			const result = await toolDefinition.execute(
				"test-call-render-oversized",
				{ path: testFile },
				undefined,
				undefined,
				{} as any,
			);
			const markerTheme = {
				fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
				bold: (text: string) => text,
			} as any;

			const component = toolDefinition.renderResult?.(result, { expanded: false, isPartial: false }, markerTheme, {
				args: { path: testFile },
				toolCallId: "test-call-render-oversized",
				invalidate: () => {},
				lastComponent: undefined,
				state: undefined,
				cwd: testDir,
				executionStarted: true,
				argsComplete: true,
				isPartial: false,
				expanded: false,
				showImages: false,
				isError: false,
			} as any);
			const rendered = component?.render(200).join("\n") ?? "";

			expect(rendered).toContain("<toolOutput>File read blocked");
			expect(rendered).toContain("</toolOutput>");
		});
		it("should handle line selectors embedded in path", async () => {
			const testFile = join(testDir, "selector.txt");
			writeFileSync(testFile, "one\ntwo\nthree\nfour");
			const raw = getTextOutput(await readTool.execute("test-call-selector-raw", { path: `${testFile}:raw` }));
			expect(raw).toBe("one\ntwo\nthree\nfour");
			const ranged = getTextOutput(await readTool.execute("test-call-selector", { path: `${testFile}:2-3` }));
			expect(ranged).toBe("one\ntwo\nthree\nfour");
			const counted = getTextOutput(await readTool.execute("test-call-selector-plus", { path: `${testFile}:3+1` }));
			expect(counted).toBe("[Lines 2-4 of 4]\ntwo\nthree\nfour");
			const outOfRange = getTextOutput(
				await readTool.execute("test-call-selector-oob", { path: `${testFile}:5-5` }),
			);
			expect(outOfRange).toContain("Requested line 5 is beyond end of file");
			const open = getTextOutput(await readTool.execute("test-call-selector-open", { path: `${testFile}:2` }));
			expect(open).toBe("two\nthree\nfour");
			const comma = getTextOutput(
				await readTool.execute("test-call-selector-comma", { path: `${testFile}:2-2,4-4` }),
			);
			expect(comma).toBe("one\ntwo\nthree\nfour");
		});

		it("should handle open-ended line selector", async () => {
			const testFile = join(testDir, "offset-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-5", { path: `${testFile}:51` });
			const output = getTextOutput(result);

			expect(output).not.toContain("Line 50");
			expect(output).toContain("Line 51");
			expect(output).toContain("Line 100");
			// No truncation message since file fits within limits
			expect(output).not.toContain("Continue with path selector");
		});
		it("should handle counted line selector", async () => {
			const testFile = join(testDir, "limit-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-6", { path: `${testFile}:1+10` });
			const output = getTextOutput(result);

			expect(output).toContain("Line 1");
			expect(output).toContain("Line 10");
			expect(output).toContain("Line 13");
			expect(output).toContain("[87 more lines in file. Continue with path selector :14.]");
		});
		it("should handle counted line selector away from file start", async () => {
			const testFile = join(testDir, "offset-limit-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-7", {
				path: `${testFile}:41+20`,
			});
			const output = getTextOutput(result);

			expect(output).toContain("Line 40");
			expect(output).toContain("Line 41");
			expect(output).toContain("Line 60");
			expect(output).toContain("Line 63");
			expect(output).toContain("[37 more lines in file. Continue with path selector :64.]");
		});
		it("should show EOF guidance when offset is beyond file length", async () => {
			const testFile = join(testDir, "short.txt");
			writeFileSync(testFile, "Line 1\nLine 2\nLine 3");

			const result = await readTool.execute("test-call-8", { path: `${testFile}:100` });
			expect(getTextOutput(result)).toContain("beyond end of file");
		});
		it("should include truncation details when truncated", async () => {
			const testFile = join(testDir, "large-file.txt");
			const lines = Array.from({ length: 3500 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-9", { path: testFile });

			expect(result.details).toBeDefined();
			expect(result.details?.truncation).toBeDefined();
			expect(result.details?.truncation?.truncated).toBe(true);
			expect(result.details?.truncation?.truncatedBy).toBe("lines");
			expect(result.details?.truncation?.totalLines).toBe(3500);
			expect(result.details?.truncation?.outputLines).toBe(3000);
		});
		it("should detect image MIME type from file magic (not extension) (#10251)", async () => {
			const png1x1Base64 =
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";
			const pngBuffer = Buffer.from(png1x1Base64, "base64");

			const testFile = join(testDir, "image.txt");
			writeFileSync(testFile, pngBuffer);

			const result = await readTool.execute("test-call-img-1", { path: testFile });

			expect(result.content[0]?.type).toBe("text");
			expect(getTextOutput(result)).toContain("Read image file [image/png]");

			const imageBlock = result.content.find(
				(c): c is { type: "image"; mimeType: string; data: string } => c.type === "image",
			);
			expect(imageBlock).toBeDefined();
			expect(imageBlock?.mimeType).toBe("image/png");
			expect(typeof imageBlock?.data).toBe("string");
			expect((imageBlock?.data ?? "").length).toBeGreaterThan(0);
			expect(result.structuredContent).toEqual({
				type: "image",
				data: imageBlock?.data,
				mimeType: "image/png",
				note: getTextOutput(result),
			});
		});
		it("should keep a text-only model's image warning out of what the model gets (#12131)", async () => {
			const png1x1Base64 =
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";
			const testFile = join(testDir, "text-model.png");
			writeFileSync(testFile, Buffer.from(png1x1Base64, "base64"));
			const textOnlyCtx = {
				cwd: testDir,
				model: { id: "text-only", input: ["text"] },
			} as unknown as ExtensionContext;

			const result = await createReadToolDefinition(testDir).execute(
				"test-call-img-text-model",
				{ path: testFile },
				undefined,
				undefined,
				textOnlyCtx,
			);

			assert.equal(getTextOutput(result), "Read image file [image/png]");
			const imageBlock = result.content.find(
				(c): c is { type: "image"; mimeType: string; data: string } => c.type === "image",
			);
			assert.ok(imageBlock);
			assert.equal(result.details?.imageUnsupportedByModel, "text-only");
			assert.equal(result.details?.meta?.source, testFile);
			assert.deepEqual(result.structuredContent, {
				type: "image",
				data: imageBlock.data,
				mimeType: "image/png",
				note: "Read image file [image/png]",
			});

			initTheme("dark");
			const component = new ToolExecutionComponent(
				"read",
				"test-call-img-text-model",
				{ path: testFile },
				{},
				createReadToolDefinition(testDir),
				{ requestRender() {} } as TUI,
				testDir,
			);
			component.updateResult({ ...result, isError: false });
			const warning = "[text-only does not support images; it saw a placeholder instead]";
			assert.ok(stripVTControlCharacters(component.render(120).join("\n")).includes(warning));
			component.setExpanded(true);
			assert.ok(stripVTControlCharacters(component.render(120).join("\n")).includes(warning));

			const visionCtx = {
				cwd: testDir,
				model: { id: "vision-ok", input: ["text", "image"] },
			} as unknown as ExtensionContext;
			const visionResult = await createReadToolDefinition(testDir).execute(
				"test-call-img-vision-model",
				{ path: testFile },
				undefined,
				undefined,
				visionCtx,
			);
			assert.equal(visionResult.details?.imageUnsupportedByModel, undefined);
			assert.equal(visionResult.details?.meta?.source, testFile);
			const visionComponent = new ToolExecutionComponent(
				"read",
				"test-call-img-vision-model",
				{ path: testFile },
				{},
				createReadToolDefinition(testDir),
				{ requestRender() {} } as TUI,
				testDir,
			);
			visionComponent.updateResult({ ...visionResult, isError: false });
			assert.equal(
				stripVTControlCharacters(visionComponent.render(120).join("\n")).includes("does not support images"),
				false,
			);
			visionComponent.setExpanded(true);
			assert.equal(
				stripVTControlCharacters(visionComponent.render(120).join("\n")).includes("does not support images"),
				false,
			);
		});
		it("renders no extra result text without an image capability warning (#4729)", () => {
			initTheme("dark");
			const definition = createReadToolDefinition(testDir);
			const result = { content: [{ type: "text" as const, text: "file contents" }], details: undefined };
			for (const expanded of [false, true]) {
				const component = definition.renderResult!(result, { expanded, isPartial: false }, theme, {
					args: { path: "file.txt" },
					toolCallId: "read-without-warning",
					invalidate: () => {},
					lastComponent: undefined,
					state: undefined,
					cwd: testDir,
					executionStarted: true,
					argsComplete: true,
					isPartial: false,
					expanded,
					showImages: false,
					isError: false,
					durationMs: undefined,
					outputPad: 0,
					keyText: () => "",
					keyHint: () => "",
				});
				assert.equal(
					stripVTControlCharacters(component.render(120).join("\n")).trim(),
					expanded ? "file contents" : "",
				);
			}
		});
		it("keeps image conversion failures in the result without a stale model warning (#4729)", async () => {
			const definition = createReadToolDefinition(testDir, {
				operations: {
					access: async () => {},
					readFile: async () => Buffer.from("not a convertible image"),
					detectImageMimeType: async () => "image/tiff",
				},
			});
			const context = {
				cwd: testDir,
				model: { id: "text-only", input: ["text"] },
			} as ExtensionContext;
			const result = await definition.execute(
				"read-unconvertible-image",
				{ path: "unconvertible.tiff" },
				undefined,
				undefined,
				context,
			);
			const expected =
				"Read image file [image/tiff]\n[Image omitted: could not be converted to a supported inline image format.]";
			assert.equal(getTextOutput(result), expected);
			assert.equal(result.structuredContent, expected);
			assert.equal(
				result.content.some((content) => content.type === "image"),
				false,
			);
			assert.equal(result.details?.imageUnsupportedByModel, undefined);
		});
		it("should treat files with image extension but non-image content as text", async () => {
			const testFile = join(testDir, "not-an-image.png");
			writeFileSync(testFile, "definitely not a png");

			const result = await readTool.execute("test-call-img-2", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("definitely not a png");
			expect(result.content.some((c: any) => c.type === "image")).toBe(false);
			expect(result.structuredContent).toBe(getTextOutput(result));
		});
	});
});
