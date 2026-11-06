import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_OFFLINE } from "../src/config.js";
import { createBashTool } from "../src/core/tools/bash.ts";
import { createGrepTool } from "../src/core/tools/grep.ts";
import { createEditTool, createFindTool, createLsTool, createReadTool, createWriteTool } from "../src/index.ts";
import { getToolPath } from "../src/utils/tools-manager.js";

// CI installs a pinned ripgrep before the suite and sets this; the ripgrep cases then never download one (#4389).
const requireProvisionedRipgrep = process.env.ATOMIC_REQUIRE_PROVISIONED_RIPGREP === "1";

const _readTool = createReadTool(process.cwd());
const _writeTool = createWriteTool(process.cwd());
const _editTool = createEditTool(process.cwd());
const _bashTool = createBashTool(process.cwd());
const grepTool = createGrepTool(process.cwd());
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

	describe("grep tool", () => {
		beforeAll(() => {
			if (requireProvisionedRipgrep) vi.stubEnv(ENV_OFFLINE, "1");
		});

		afterAll(() => {
			vi.unstubAllEnvs();
		});

		it.skipIf(!requireProvisionedRipgrep)("finds the ripgrep installed before the suite (#4389)", () => {
			assert.notEqual(
				getToolPath("rg"),
				null,
				"ATOMIC_REQUIRE_PROVISIONED_RIPGREP=1 needs ripgrep on PATH or in Atomic's bin directory before the suite starts",
			);
		});

		it("should include filename when searching a single file", async () => {
			const testFile = join(testDir, "example.txt");
			writeFileSync(testFile, "first line\nmatch line\nlast line");

			const result = await grepTool.execute("test-call-11", {
				pattern: "match",
				path: testFile,
			});

			const output = getTextOutput(result);
			expect(output).toContain("example.txt:2: match line");
		});
		it("should respect global limit and include context lines", async () => {
			const testFile = join(testDir, "context.txt");
			const content = ["before", "match one", "after", "middle", "match two", "after two"].join("\n");
			writeFileSync(testFile, content);

			const result = await grepTool.execute("test-call-12", {
				pattern: "match",
				path: testFile,
				limit: 1,
				context: 1,
			});

			const output = getTextOutput(result);
			expect(output).toContain("context.txt-1- before");
			expect(output).toContain("context.txt:2: match one");
			expect(output).toContain("context.txt-3- after");
			expect(output).toContain("[1 matches limit reached. Use limit=2 for more, or refine pattern]");
			// Ensure second match is not present
			expect(output).not.toContain("match two");
		});
		// literal: true takes the ripgrep path, which takes context lines from ripgrep; the default takes the native search.
		for (const literal of [false, true]) {
			it(`keeps context line numbers aligned with ripgrep when a file contains a lone CR (pi #11398, literal: ${literal})`, async () => {
				const testFile = join(testDir, "lone-cr.txt");
				writeFileSync(testFile, "before\rprogress\nneedle\nafter");

				const result = await grepTool.execute("test-call-lone-cr", {
					pattern: "needle",
					path: testFile,
					context: 1,
					literal,
				});

				assert.equal(
					getTextOutput(result),
					["lone-cr.txt-1- beforeprogress", "lone-cr.txt:2: needle", "lone-cr.txt-3- after"].join("\n"),
				);
			});
		}
		// The ripgrep path (literal: true, or custom operations) takes context lines from ripgrep (pi #9276).
		it("should print overlapping context once and keep the last match's trailing context (pi #9276)", async () => {
			const testFile = join(testDir, "rg-context.txt");
			writeFileSync(testFile, ["a", "match one", "b", "match two", "match three", "c", "match four"].join("\n"));

			const result = await grepTool.execute("test-call-rg-context", {
				pattern: "match",
				path: testFile,
				context: 1,
				limit: 2,
				literal: true,
			});
			assert.equal(
				getTextOutput(result).split("\n\n")[0],
				[
					"rg-context.txt-1- a",
					"rg-context.txt:2: match one",
					"rg-context.txt-3- b",
					"rg-context.txt:4: match two",
					// A match inside the last allowed match's trailing context is shown as context.
					"rg-context.txt-5- match three",
				].join("\n"),
			);
			assert.equal(result.details?.matchLimitReached, 2);
		});

		it("should keep counting matches past the byte cap (pi #9276)", async () => {
			const testFile = join(testDir, "byte-cap.txt");
			const line = `match ${"x".repeat(400)}`;
			writeFileSync(testFile, Array.from({ length: 200 }, () => line).join("\n"));

			const result = await grepTool.execute("test-call-byte-cap", {
				pattern: "match",
				path: testFile,
				limit: 150,
				literal: true,
			});

			const output = getTextOutput(result);
			assert.ok(output.includes("150 matches limit reached"));
			assert.ok(output.includes("50.0KB limit reached"));
			assert.equal(result.details?.matchLimitReached, 150);
			assert.equal(result.details?.truncation?.totalLines, 150);
			const fullOutput = Array.from({ length: 150 }, (_, index) => `byte-cap.txt:${index + 1}: ${line}`).join("\n");
			assert.equal(result.details?.truncation?.totalBytes, Buffer.byteLength(fullOutput, "utf-8"));
		});

		it("should truncate long lines and say so (ripgrep path)", async () => {
			const testFile = join(testDir, "long.txt");
			writeFileSync(testFile, `needle ${"x".repeat(600)}\nneedle short`);

			const result = await grepTool.execute("test-call-long-line", {
				pattern: "needle",
				path: testFile,
				literal: true,
			});

			assert.equal(
				getTextOutput(result),
				[
					`long.txt:1: needle ${"x".repeat(505)}... [truncated]`,
					"long.txt:2: needle short",
					"",
					"[Some lines truncated to 512 chars. Use read tool to see full lines]",
				].join("\n"),
			);
			assert.equal(result.details?.linesTruncated, true);
		});

		it("should count every match in count mode regardless of the limit (ripgrep path)", async () => {
			const testFile = join(testDir, "count.txt");
			writeFileSync(testFile, ["needle", "x", "needle", "needle"].join("\n"));

			const result = await grepTool.execute("test-call-count-mode", {
				pattern: "needle",
				path: testFile,
				mode: "count",
				limit: 1,
				context: 1,
				literal: true,
			});

			assert.equal(getTextOutput(result), "3");
			assert.equal(result.details, undefined);
		});

		it("should list the matching file once in filesWithMatches mode (ripgrep path)", async () => {
			const testFile = join(testDir, "files.txt");
			writeFileSync(testFile, ["needle", "x", "needle"].join("\n"));

			const result = await grepTool.execute("test-call-files-mode", {
				pattern: "needle",
				path: testFile,
				mode: "filesWithMatches",
				context: 1,
				literal: true,
			});

			assert.equal(getTextOutput(result), "files.txt");
		});

		it("should report truncation when stored output ends exactly at the byte cap (pi #9276)", async () => {
			const testFile = join(testDir, "x");
			// 103 rows of 500 bytes plus one of 12 bytes, with newlines, join to exactly 50KB; one more match follows.
			writeFileSync(testFile, [...Array(103).fill("x".repeat(490)), "x".repeat(7), "extra x"].join("\n"));

			const result = await grepTool.execute("test-call-byte-cap-boundary", {
				pattern: "x",
				path: testFile,
				limit: 1000,
				literal: true,
			});

			assert.ok(getTextOutput(result).includes("[50.0KB limit reached]"));
			assert.equal(result.details?.truncation?.totalLines, 105);
		});

		it("should accept a huge context value (pi #9276)", async () => {
			const testFile = join(testDir, "huge-context.txt");
			writeFileSync(testFile, "before\nneedle\nafter");

			for (const args of [{ context: 1e30 }, { contextBefore: 1e30, contextAfter: 1e30 }]) {
				const result = await grepTool.execute("test-call-huge-context", {
					pattern: "needle",
					path: testFile,
					literal: true,
					...args,
				});

				assert.equal(
					getTextOutput(result),
					["huge-context.txt-1- before", "huge-context.txt:2: needle", "huge-context.txt-3- after"].join("\n"),
				);
			}
		});

		// Context lines come from ripgrep, which decodes UTF-16; rereading the file as UTF-8 corrupted them (pi #11423).
		it("should decode UTF-16 files with context (pi #11423)", async () => {
			const testFile = join(testDir, "utf16.txt");
			writeFileSync(testFile, Buffer.from("\uFEFFbefore\nneedle 中文\nafter\n", "utf16le"));

			const result = await grepTool.execute("test-call-utf16-context", {
				pattern: "needle",
				path: testFile,
				context: 1,
				literal: true,
			});

			assert.equal(
				getTextOutput(result),
				["utf16.txt-1- before", "utf16.txt:2: needle 中文", "utf16.txt-3- after"].join("\n"),
			);
		});

		it("should decode base64-encoded non-UTF-8 lines and paths from ripgrep", async () => {
			const testFile = join(testDir, "latin1.txt");
			writeFileSync(testFile, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x0a]));

			const result = await grepTool.execute("test-call-bytes-context", {
				pattern: "needle",
				path: testFile,
				context: 1,
				literal: true,
			});

			assert.equal(getTextOutput(result), ["latin1.txt-1- caf\uFFFD", "latin1.txt:2: needle"].join("\n"));
		});

		it("should strip CRLF terminators from matched and context lines", async () => {
			const testFile = join(testDir, "mixed-cr.txt");
			writeFileSync(testFile, "one\rtwo needle\r\nnext\r\n");

			const plain = await grepTool.execute("test-call-cr-plain", {
				pattern: "needle",
				path: testFile,
				literal: true,
			});
			assert.equal(getTextOutput(plain), "mixed-cr.txt:1: onetwo needle");

			const withContext = await grepTool.execute("test-call-cr-context", {
				pattern: "needle",
				path: testFile,
				context: 1,
				literal: true,
			});
			assert.equal(getTextOutput(withContext), ["mixed-cr.txt:1: onetwo needle", "mixed-cr.txt-2- next"].join("\n"));
		});

		it("should not report the match limit when exactly limit matches exist (pi #9276)", async () => {
			const testFile = join(testDir, "exact-limit.txt");
			writeFileSync(testFile, ["match one", "x", "match two", "y"].join("\n"));

			for (const context of [0, 1]) {
				const exact = await grepTool.execute("test-call-exact-limit", {
					pattern: "match",
					path: testFile,
					limit: 2,
					context,
					literal: true,
				});
				assert.ok(!getTextOutput(exact).includes("limit reached"));
				assert.equal(exact.details?.matchLimitReached, undefined);

				const over = await grepTool.execute("test-call-over-limit", {
					pattern: "match",
					path: testFile,
					limit: 1,
					context,
					literal: true,
				});
				assert.ok(
					getTextOutput(over).includes("[1 matches limit reached. Use limit=2 for more, or refine pattern]"),
				);
				assert.equal(over.details?.matchLimitReached, 1);
			}

			const fractional = await grepTool.execute("test-call-fractional-limit", {
				pattern: "match",
				path: testFile,
				limit: 1.5,
				literal: true,
			});
			assert.ok(
				getTextOutput(fractional).includes("[1 matches limit reached. Use limit=2 for more, or refine pattern]"),
			);
		});

		it("should show only the leading context of matches after the offset", async () => {
			const testFile = join(testDir, "offset-context.txt");
			writeFileSync(testFile, ["a", "match one", "b", "c", "d", "match two", "e"].join("\n"));

			const result = await grepTool.execute("test-call-offset-context", {
				pattern: "match",
				path: testFile,
				offset: 1,
				contextBefore: 1,
				contextAfter: 1,
				literal: true,
			});

			assert.equal(
				getTextOutput(result),
				["offset-context.txt-5- d", "offset-context.txt:6: match two", "offset-context.txt-7- e"].join("\n"),
			);
		});

		it("should never read matched files with custom operations (pi #9276)", async () => {
			const testFile = join(testDir, "custom-ops.txt");
			writeFileSync(testFile, ["before", "needle", "after"].join("\n"));
			const readFile = vi.fn(() => "unexpected read");
			const operations = { isDirectory: () => false, readFile };
			const customGrep = createGrepTool(process.cwd(), { operations });

			const result = await customGrep.execute("test-call-custom-ops", {
				pattern: "needle",
				path: testFile,
				context: 1,
			});

			assert.equal(
				getTextOutput(result),
				["custom-ops.txt-1- before", "custom-ops.txt:2: needle", "custom-ops.txt-3- after"].join("\n"),
			);
			assert.equal(readFile.mock.calls.length, 0);
		});

		it("should treat flag-like patterns as search text", async () => {
			const marker = join(testDir, "grep-injection-marker");
			const payload = join(testDir, "payload.sh");
			const payloadPattern = payload.replace(/\\/g, "/");
			const testFile = join(testDir, "target.txt");
			writeFileSync(payload, `#!/bin/sh\necho executed > ${marker}\ncat "$1"\n`);
			chmodSync(payload, 0o755);
			writeFileSync(testFile, "target\n");

			const result = await grepTool.execute("test-call-grep-injection", {
				pattern: `--pre=${payloadPattern}`,
				path: testDir,
			});

			expect(getTextOutput(result)).toContain("No matches found");
			expect(existsSync(marker)).toBe(false);
		});
	});
});
