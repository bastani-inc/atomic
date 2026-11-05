import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBashTool } from "../src/core/tools/bash.ts";
import { createGrepTool } from "../src/core/tools/grep.ts";
import { createEditTool, createFindTool, createLsTool, createReadTool, createWriteTool } from "../src/index.ts";

const _readTool = createReadTool(process.cwd());
const _writeTool = createWriteTool(process.cwd());
const _editTool = createEditTool(process.cwd());
const _bashTool = createBashTool(process.cwd());
const _grepTool = createGrepTool(process.cwd());
const _findTool = createFindTool(process.cwd());
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

function _shellQuoteForTest(value: string): string {
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

	describe("ls tool", () => {
		it("should list dotfiles and directories", async () => {
			writeFileSync(join(testDir, ".hidden-file"), "secret");
			mkdirSync(join(testDir, ".hidden-dir"));

			const result = await lsTool.execute("test-call-15", { path: testDir });
			const output = getTextOutput(result);

			expect(output).toContain(".hidden-file");
			expect(output).toContain(".hidden-dir/");
		});

		it("should treat limits below 1 as 1 and floor fractional limits (pi #11747)", async () => {
			for (const name of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(testDir, name), name);

			for (const limit of [0, -5, 0.5, 1.9]) {
				const result = await lsTool.execute("test-call-ls-small-limit", { path: testDir, limit });
				assert.equal(getTextOutput(result), "a.txt\n\n[1 entries limit reached. Use limit=2 for more]");
				assert.deepEqual(result.details, { entryLimitReached: 1 });
			}
		});

		it("should report the entry limit only when more entries exist (pi #11747)", async () => {
			for (const name of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(testDir, name), name);

			const result = await lsTool.execute("test-call-ls-exact-limit", { path: testDir, limit: 3 });
			assert.equal(getTextOutput(result), "a.txt\nb.txt\nc.txt");
			assert.equal(result.details, undefined);
		});
	});
});
