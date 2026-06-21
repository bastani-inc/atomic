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

	describe("edit tool", () => {
		it("should replace text in file", async () => {
			const testFile = join(testDir, "edit-test.txt");
			const originalContent = "Hello, world!";
			writeFileSync(testFile, originalContent);

			const result = await editTool.execute("test-call-5", {
				path: testFile,
				edits: [{ oldText: "world", newText: "testing" }],
			});

			expect(getTextOutput(result)).toContain("Successfully replaced");
			expect(result.details).toBeDefined();
			expect(result.details.diff).toBeDefined();
			expect(typeof result.details.diff).toBe("string");
			expect(result.details.diff).toContain("testing");
			expect(result.details.patch).toContain("--- ");
			expect(result.details.patch).toContain("+++ ");
			expect(result.details.patch).toContain("@@");
			expect(result.details.patch).toContain("-Hello, world!");
			expect(result.details.patch).toContain("+Hello, testing!");
			expect(applyPatch(originalContent, result.details.patch)).toBe("Hello, testing!");
		});
		it("should fail if text not found", async () => {
			const testFile = join(testDir, "edit-test.txt");
			const originalContent = "Hello, world!";
			writeFileSync(testFile, originalContent);

			await expect(
				editTool.execute("test-call-6", {
					path: testFile,
					edits: [{ oldText: "nonexistent", newText: "testing" }],
				}),
			).rejects.toThrow(/Could not find the exact text/);
		});
		it("should include ENOENT when the edit target does not exist", async () => {
			const missingFile = join(testDir, "missing.txt");

			await expect(
				editTool.execute("test-call-6b", {
					path: missingFile,
					edits: [{ oldText: "hello", newText: "world" }],
				}),
			).rejects.toThrow(`Could not edit file: ${missingFile}. Error code: ENOENT.`);
		});
		it("should fail if text appears multiple times", async () => {
			const testFile = join(testDir, "edit-test.txt");
			const originalContent = "foo foo foo";
			writeFileSync(testFile, originalContent);

			await expect(
				editTool.execute("test-call-7", {
					path: testFile,
					edits: [{ oldText: "foo", newText: "bar" }],
				}),
			).rejects.toThrow(/Found 3 occurrences/);
		});
		it("should replace multiple disjoint regions in one call", async () => {
			const testFile = join(testDir, "edit-multi.txt");
			writeFileSync(testFile, "alpha\nbeta\ngamma\ndelta\n");

			const result = await editTool.execute("test-call-8", {
				path: testFile,
				edits: [
					{ oldText: "alpha\n", newText: "ALPHA\n" },
					{ oldText: "gamma\n", newText: "GAMMA\n" },
				],
			});

			expect(getTextOutput(result)).toContain("Successfully replaced 2 block(s)");
			expect(readFileSync(testFile, "utf-8")).toBe("ALPHA\nbeta\nGAMMA\ndelta\n");
			expect(result.details?.diff).toContain("ALPHA");
			expect(result.details?.diff).toContain("GAMMA");
		});
		it("should collapse large unchanged gaps in multi-edit diffs", async () => {
			const testFile = join(testDir, "edit-multi-large-gap.txt");
			const lines = Array.from({ length: 600 }, (_, i) => `line ${String(i + 1).padStart(3, "0")}`);
			writeFileSync(testFile, `${lines.join("\n")}\n`);

			const result = await editTool.execute("test-call-8b", {
				path: testFile,
				edits: [
					{ oldText: "line 100\n", newText: "LINE 100\n" },
					{ oldText: "line 300\n", newText: "LINE 300\n" },
					{ oldText: "line 500\n", newText: "LINE 500\n" },
				],
			});

			const diff = result.details?.diff ?? "";
			expect(diff).toContain("LINE 100");
			expect(diff).toContain("LINE 300");
			expect(diff).toContain("LINE 500");
			expect(diff).toContain("...");
			expect(diff).not.toContain("line 250");
			expect(diff.split("\n").length).toBeLessThan(50);
		});
		it("should preserve the correct occurrence when fuzzy replacement equals a nearby line", async () => {
			const testFile = join(testDir, "fuzzy-preserve-duplicate-line.txt");
			writeFileSync(testFile, "const keep = ‘same’;   \nconst target = ‘same’;   \n");

			const result = await editTool.execute("test-fuzzy-preserve-duplicate-line", {
				path: testFile,
				edits: [{ oldText: "const target = 'same';", newText: "const target = 'changed';" }],
			});

			expect(readFileSync(testFile, "utf-8")).toBe("const keep = ‘same’;   \nconst target = 'changed';\n");
			expect(applyPatch("const keep = ‘same’;   \nconst target = ‘same’;   \n", result.details.patch)).toBe(
				"const keep = ‘same’;   \nconst target = 'changed';\n",
			);
		});

		it("should preserve untouched lines and produce an applicable patch for fuzzy multi-edits", async () => {
			const testFile = join(testDir, "fuzzy-preserve-multi.txt");
			const originalContent = [
				"header with trailing spaces   ",
				"alpha = ‘one’;   ",
				"middle with em dash — and spaces   ",
				"beta = ‘two’;   ",
				"footer with non-breaking space\u00A0",
				"",
			].join("\n");
			writeFileSync(testFile, originalContent);

			const result = await editTool.execute("test-fuzzy-preserve-multi", {
				path: testFile,
				edits: [
					{ oldText: "alpha = 'one';", newText: "alpha = 'ONE';" },
					{ oldText: "beta = 'two';", newText: "beta = 'TWO';" },
				],
			});

			const expected = [
				"header with trailing spaces   ",
				"alpha = 'ONE';",
				"middle with em dash — and spaces   ",
				"beta = 'TWO';",
				"footer with non-breaking space\u00A0",
				"",
			].join("\n");
			expect(readFileSync(testFile, "utf-8")).toBe(expected);
			expect(applyPatch(originalContent, result.details.patch)).toBe(expected);
		});

		it("should match edits against the original file, not incrementally", async () => {
			const testFile = join(testDir, "edit-multi-original.txt");
			writeFileSync(testFile, "foo\nbar\nbaz\n");

			await editTool.execute("test-call-9", {
				path: testFile,
				edits: [
					{ oldText: "foo\n", newText: "foo bar\n" },
					{ oldText: "bar\n", newText: "BAR\n" },
				],
			});

			expect(readFileSync(testFile, "utf-8")).toBe("foo bar\nBAR\nbaz\n");
		});
		it("should fail when edits is empty", async () => {
			const testFile = join(testDir, "edit-empty-edits.txt");
			writeFileSync(testFile, "hello\nworld\n");

			await expect(
				editTool.execute("test-call-11", {
					path: testFile,
					edits: [],
				}),
			).rejects.toThrow(/edits must contain at least one replacement/);
		});
		it("should fail when multi-edit regions overlap", async () => {
			const testFile = join(testDir, "edit-overlap.txt");
			writeFileSync(testFile, "one\ntwo\nthree\n");

			await expect(
				editTool.execute("test-call-12", {
					path: testFile,
					edits: [
						{ oldText: "one\ntwo\n", newText: "ONE\nTWO\n" },
						{ oldText: "two\nthree\n", newText: "TWO\nTHREE\n" },
					],
				}),
			).rejects.toThrow(/overlap/);
		});
		it("should not partially apply edits when one edit fails", async () => {
			const testFile = join(testDir, "edit-no-partial.txt");
			const originalContent = "alpha\nbeta\ngamma\n";
			writeFileSync(testFile, originalContent);

			await expect(
				editTool.execute("test-call-13", {
					path: testFile,
					edits: [
						{ oldText: "alpha\n", newText: "ALPHA\n" },
						{ oldText: "missing\n", newText: "MISSING\n" },
					],
				}),
			).rejects.toThrow(/Could not find/);

			expect(readFileSync(testFile, "utf-8")).toBe(originalContent);
		});
		it("should include EACCES for read-only files", async () => {
			const testFile = join(testDir, "edit-readonly.txt");
			writeFileSync(testFile, "hello\n");
			chmodSync(testFile, 0o444);

			await expect(
				editTool.execute("test-call-14", {
					path: testFile,
					edits: [{ oldText: "hello", newText: "world" }],
				}),
			).rejects.toThrow(`Could not edit file: ${testFile}. Error code: EACCES.`);
		});
		it("should include the original error message for unknown edit access errors", async () => {
			const genericFailureTool = createEditTool(testDir, {
				operations: {
					access: async () => {
						throw new Error("disk offline");
					},
					readFile: async () => Buffer.from("hello\n", "utf-8"),
					writeFile: async () => {},
				},
			});

			await expect(
				genericFailureTool.execute("test-call-16", {
					path: "broken.txt",
					edits: [{ oldText: "hello", newText: "world" }],
				}),
			).rejects.toThrow("Could not edit file: broken.txt. Error: disk offline.");
		});
		it("should include ENOENT in diff preview for missing files", async () => {
			const missingFile = join(testDir, "missing-preview.txt");
			const result = await computeEditsDiff(missingFile, [{ oldText: "hello", newText: "world" }], testDir);

			expect(result).toEqual({ error: `Could not edit file: ${missingFile}. Error code: ENOENT.` });
		});
		it("should include EACCES in diff preview for unreadable files", async () => {
			const unreadableFile = join(testDir, "unreadable-preview.txt");
			writeFileSync(unreadableFile, "hello\n");
			chmodSync(unreadableFile, 0o222);

			const result = await computeEditsDiff(unreadableFile, [{ oldText: "hello", newText: "world" }], testDir);

			expect(result).toEqual({ error: `Could not edit file: ${unreadableFile}. Error code: EACCES.` });
		});
	});
});
