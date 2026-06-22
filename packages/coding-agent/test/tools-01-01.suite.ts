import { applyPatch } from "diff";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import { type BashOperations, createBashTool, createLocalBashOperations } from "../src/core/tools/bash.ts";
import { computeEditsDiff } from "../src/core/tools/edit-diff.ts";
import {
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "../src/index.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import * as shellModule from "../src/utils/shell.ts";

const readTool = createReadTool(process.cwd());
const writeTool = createWriteTool(process.cwd());
const editTool = createEditTool(process.cwd());
const bashTool = createBashTool(process.cwd());
const grepTool = createGrepTool(process.cwd());
const findTool = createFindTool(process.cwd());
const lsTool = createLsTool(process.cwd());

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
		testDir = join(tmpdir(), `coding-agent-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		// Clean up test directory
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("read tool", () => {
		it("should read file contents that fit within limits", async () => {
			const testFile = join(testDir, "test.txt");
			const content = "Hello, world!\nLine 2\nLine 3";
			writeFileSync(testFile, content);

			const result = await readTool.execute("test-call-1", { path: testFile });

			expect(getTextOutput(result)).toBe(content);
			// No truncation message since file fits within limits
			expect(getTextOutput(result)).not.toContain("Use offset=");
			expect(result.details).toBeUndefined();
		});
		it("should handle non-existent files", async () => {
			const testFile = join(testDir, "nonexistent.txt");

			await expect(readTool.execute("test-call-2", { path: testFile })).rejects.toThrow(/ENOENT|not found/i);
		});
		it("should truncate files exceeding line limit", async () => {
			const testFile = join(testDir, "large.txt");
			const lines = Array.from({ length: 2500 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-3", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("Line 1");
			expect(output).toContain("Line 2000");
			expect(output).not.toContain("Line 2001");
			expect(output).toContain("[Showing lines 1-2000 of 2500. Use offset=2001 to continue.]");
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
			expect(output).toMatch(/\[Showing lines 1-\d+ of 300 \(.* limit\)\. Use offset=\d+ to continue\.\]/);
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
			expect(result.details).toBeUndefined();
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
			expect(output).toContain("grep({");
			expect(output).toContain("\"offset\": 1");
			expect(output).toContain("\"limit\": 200");
			expect(output).toContain("targeted snippet");
			expect(output).not.toContain(sentinel);
			expect(output).not.toContain(fillerPrefix);
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
				path: testFile,
				offset: 100,
				limit: 3,
			});
			const output = getTextOutput(result);

			expect(output).not.toContain("File read blocked");
			expect(result.details?.oversizedRead).toBeUndefined();
			expect(output).toContain("Line 100:");
			expect(output).toContain("Line 102:");
			expect(output).not.toContain("Line 103:");
			expect(output).toContain("[898 more lines in file. Use offset=103 to continue.]");
		});
		it("should show byte-slice guidance for oversized single-line reads", async () => {
			const testFile = join(testDir, "single-line-large.txt");
			const content = "x".repeat(50_001);
			writeFileSync(testFile, content);

			const result = await readTool.execute("test-call-single-line-blocked", { path: testFile, limit: 1 });
			const output = getTextOutput(result);

			expect(output).toContain("File read blocked");
			expect(output).toContain("Requested line limit: 1");
			expect(output).toContain("line pagination is not useful");
			expect(output).toContain(`sed -n '1p' ${shellQuoteForTest(testFile)} | head -c 51200`);
			expect(output).toContain("tail -c +51201");
			expect(output).not.toContain('"offset": 120');
			expect(output).not.toContain("Read a targeted snippet");
			expect(result.details?.oversizedRead?.byteGuidance).toBe(true);
			expect(result.details?.oversizedRead?.requestedLimit).toBe(1);
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
			const result = await toolDefinition.execute("test-call-render-oversized", { path: testFile }, undefined, undefined, {} as any);
			const markerTheme = {
				fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
				bold: (text: string) => text,
			} as any;

			const component = toolDefinition.renderResult?.(
				result,
				{ expanded: false, isPartial: false },
				markerTheme,
				{
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
				} as any,
			);
			const rendered = component?.render(200).join("\n") ?? "";

			expect(rendered).toContain("<toolOutput>File read blocked");
			expect(rendered).toContain("</toolOutput>");
		});
		it("should handle offset parameter", async () => {
			const testFile = join(testDir, "offset-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-5", { path: testFile, offset: 51 });
			const output = getTextOutput(result);

			expect(output).not.toContain("Line 50");
			expect(output).toContain("Line 51");
			expect(output).toContain("Line 100");
			// No truncation message since file fits within limits
			expect(output).not.toContain("Use offset=");
		});
		it("should handle limit parameter", async () => {
			const testFile = join(testDir, "limit-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-6", { path: testFile, limit: 10 });
			const output = getTextOutput(result);

			expect(output).toContain("Line 1");
			expect(output).toContain("Line 10");
			expect(output).not.toContain("Line 11");
			expect(output).toContain("[90 more lines in file. Use offset=11 to continue.]");
		});
		it("should handle offset + limit together", async () => {
			const testFile = join(testDir, "offset-limit-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-7", {
				path: testFile,
				offset: 41,
				limit: 20,
			});
			const output = getTextOutput(result);

			expect(output).not.toContain("Line 40");
			expect(output).toContain("Line 41");
			expect(output).toContain("Line 60");
			expect(output).not.toContain("Line 61");
			expect(output).toContain("[40 more lines in file. Use offset=61 to continue.]");
		});
		it("should show error when offset is beyond file length", async () => {
			const testFile = join(testDir, "short.txt");
			writeFileSync(testFile, "Line 1\nLine 2\nLine 3");

			await expect(readTool.execute("test-call-8", { path: testFile, offset: 100 })).rejects.toThrow(
				/Offset 100 is beyond end of file \(3 lines total\)/,
			);
		});
		it("should include truncation details when truncated", async () => {
			const testFile = join(testDir, "large-file.txt");
			const lines = Array.from({ length: 2500 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-9", { path: testFile });

			expect(result.details).toBeDefined();
			expect(result.details?.truncation).toBeDefined();
			expect(result.details?.truncation?.truncated).toBe(true);
			expect(result.details?.truncation?.truncatedBy).toBe("lines");
			expect(result.details?.truncation?.totalLines).toBe(2500);
			expect(result.details?.truncation?.outputLines).toBe(2000);
		});
		it("should detect image MIME type from file magic (not extension)", async () => {
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
		});
		it("should treat files with image extension but non-image content as text", async () => {
			const testFile = join(testDir, "not-an-image.png");
			writeFileSync(testFile, "definitely not a png");

			const result = await readTool.execute("test-call-img-2", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("definitely not a png");
			expect(result.content.some((c: any) => c.type === "image")).toBe(false);
		});
	});
});
