import assert from "node:assert/strict";
import { applyPatch } from "diff";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { access } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { computeEditsDiff } from "../src/core/tools/edit-diff.js";
import { EditTargetError, isEditTargetError } from "../src/core/tools/file-tool-errors.js";
import { createEditTool } from "../src/index.js";

const readOnlyErrorCode = process.platform === "win32" ? "EPERM" : "EACCES";

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>();
	return { ...actual, access: vi.fn(actual.access) };
});

const editTool = createEditTool(process.cwd());

// Helper to extract text from content blocks
function getTextOutput(result: any): string {
	return (
		result.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") || ""
	);
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

	describe("edit tool", () => {
		it("should replace text in file", async () => {
			const testFile = join(testDir, "edit-test.txt");
			const originalContent = "Hello, world!";
			writeFileSync(testFile, originalContent);

			const result = await editTool.execute("test-call-5", {
				path: testFile,
				edits: [{ oldText: "world", newText: "testing" }],
			});

			assert.ok(getTextOutput(result).includes("Successfully replaced"));
			assert.notEqual(result.details, undefined);
			assert.notEqual(result.details.diff, undefined);
			assert.equal(typeof result.details.diff, "string");
			assert.ok(result.details.diff.includes("testing"));
			assert.ok(result.details.patch.includes("--- "));
			assert.ok(result.details.patch.includes("+++ "));
			assert.ok(result.details.patch.includes("@@"));
			assert.ok(result.details.patch.includes("-Hello, world!"));
			assert.ok(result.details.patch.includes("+Hello, testing!"));
			assert.equal(applyPatch(originalContent, result.details.patch), "Hello, testing!");
		});

		it("should fail if text not found", async () => {
			const testFile = join(testDir, "edit-test.txt");
			const originalContent = "Hello, world!";
			writeFileSync(testFile, originalContent);

			await assert.rejects(
				editTool.execute("test-call-6", {
					path: testFile,
					edits: [{ oldText: "nonexistent", newText: "testing" }],
				}),
				/Could not find the exact text/,
			);
		});

		it("should include ENOENT when the edit target does not exist", async () => {
			const missingFile = join(testDir, "missing.txt");

			await assert.rejects(
				editTool.execute("test-call-6b", {
					path: missingFile,
					edits: [{ oldText: "hello", newText: "world" }],
				}),
				(error: unknown) =>
					error instanceof Error &&
					error.message.includes(`Could not edit file: ${missingFile}. Error code: ENOENT.`),
			);
		});

		it("should fail if text appears multiple times", async () => {
			const testFile = join(testDir, "edit-test.txt");
			const originalContent = "foo foo foo";
			writeFileSync(testFile, originalContent);

			await assert.rejects(
				editTool.execute("test-call-7", {
					path: testFile,
					edits: [{ oldText: "foo", newText: "bar" }],
				}),
				/Found 3 occurrences/,
			);
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

			assert.ok(getTextOutput(result).includes("Successfully replaced 2 block(s)"));
			assert.equal(readFileSync(testFile, "utf-8"), "ALPHA\nbeta\nGAMMA\ndelta\n");
			assert.ok(result.details?.diff.includes("ALPHA"));
			assert.ok(result.details?.diff.includes("GAMMA"));
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
			assert.ok(diff.includes("LINE 100"));
			assert.ok(diff.includes("LINE 300"));
			assert.ok(diff.includes("LINE 500"));
			assert.ok(diff.includes("..."));
			assert.ok(!diff.includes("line 250"));
			assert.ok(diff.split("\n").length < 50);
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

			assert.equal(readFileSync(testFile, "utf-8"), "foo bar\nBAR\nbaz\n");
		});

		it("should fail when edits is empty", async () => {
			const testFile = join(testDir, "edit-empty-edits.txt");
			writeFileSync(testFile, "hello\nworld\n");

			await assert.rejects(
				editTool.execute("test-call-11", {
					path: testFile,
					edits: [],
				}),
				/edits must contain at least one replacement/,
			);
		});

		it("should fail when multi-edit regions overlap", async () => {
			const testFile = join(testDir, "edit-overlap.txt");
			writeFileSync(testFile, "one\ntwo\nthree\n");

			await assert.rejects(
				editTool.execute("test-call-12", {
					path: testFile,
					edits: [
						{ oldText: "one\ntwo\n", newText: "ONE\nTWO\n" },
						{ oldText: "two\nthree\n", newText: "TWO\nTHREE\n" },
					],
				}),
				/overlap/,
			);
		});

		it("should not partially apply edits when one edit fails", async () => {
			const testFile = join(testDir, "edit-no-partial.txt");
			const originalContent = "alpha\nbeta\ngamma\n";
			writeFileSync(testFile, originalContent);

			await assert.rejects(
				editTool.execute("test-call-13", {
					path: testFile,
					edits: [
						{ oldText: "alpha\n", newText: "ALPHA\n" },
						{ oldText: "missing\n", newText: "MISSING\n" },
					],
				}),
				/Could not find/,
			);

			assert.equal(readFileSync(testFile, "utf-8"), originalContent);
		});

		it("should include EACCES for read-only files", async () => {
			const testFile = join(testDir, "edit-readonly.txt");
			writeFileSync(testFile, "hello\n");
			chmodSync(testFile, 0o444);

			await assert.rejects(
				editTool.execute("test-call-14", {
					path: testFile,
					edits: [{ oldText: "hello", newText: "world" }],
				}),
				(error: unknown) =>
					error instanceof Error &&
					error.message.includes(`Could not edit file: ${testFile}. Error code: ${readOnlyErrorCode}.`),
			);
		});

		it.each(["EACCES", "EPERM"])(
			"should reject a %s access failure as a typed target error before reading or writing",
			async (errnoCode) => {
				const denied = Object.assign(new Error("permission denied"), { code: errnoCode });
				const calls: string[] = [];
				const deniedTool = createEditTool(testDir, {
					operations: {
						access: async () => {
							calls.push("access");
							throw denied;
						},
						readFile: async () => {
							calls.push("readFile");
							return Buffer.from("hello\n", "utf-8");
						},
						writeFile: async () => {
							calls.push("writeFile");
						},
					},
				});

				const failure = await deniedTool
					.execute("test-call-denied", {
						path: "denied.txt",
						edits: [{ oldText: "hello", newText: "world" }],
					})
					.then(
						() => undefined,
						(error: unknown) => error,
					);

				assert.equal(isEditTargetError(failure), true);
				assert.ok(failure instanceof EditTargetError);
				const error = failure as EditTargetError;
				assert.equal(error.code, "target-inaccessible");
				assert.deepEqual(error.fields, { path: "denied.txt", errnoCode });
				assert.equal(error.cause, denied);
				assert.equal(error.retryable, false);
				assert.deepEqual(calls, ["access"]);
			},
		);

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

			await assert.rejects(
				genericFailureTool.execute("test-call-16", {
					path: "broken.txt",
					edits: [{ oldText: "hello", newText: "world" }],
				}),
				(error: unknown) =>
					error instanceof Error &&
					error.message.includes("Could not edit file: broken.txt. Error: disk offline."),
			);
		});

		it("should include ENOENT in diff preview for missing files", async () => {
			const missingFile = join(testDir, "missing-preview.txt");
			const result = await computeEditsDiff(missingFile, [{ oldText: "hello", newText: "world" }], testDir);

			assert.deepEqual(result, { error: `Could not edit file: ${missingFile}. Error code: ENOENT.` });
		});

		it("should include EACCES in diff preview for unreadable files", async () => {
			const unreadableFile = join(testDir, "unreadable-preview.txt");
			writeFileSync(unreadableFile, "hello\n");
			vi.mocked(access).mockRejectedValueOnce(Object.assign(new Error("permission denied"), { code: "EACCES" }));

			const result = await computeEditsDiff(unreadableFile, [{ oldText: "hello", newText: "world" }], testDir);

			assert.deepEqual(result, { error: `Could not edit file: ${unreadableFile}. Error code: EACCES.` });
		});
	});
});

describe("edit tool fuzzy matching", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `coding-agent-fuzzy-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("should match text with trailing whitespace stripped", async () => {
		const testFile = join(testDir, "trailing-ws.txt");
		// File has trailing spaces on lines
		writeFileSync(testFile, "line one   \nline two  \nline three\n");

		// oldText without trailing whitespace should still match
		const result = await editTool.execute("test-fuzzy-1", {
			path: testFile,
			edits: [{ oldText: "line one\nline two\n", newText: "replaced\n" }],
		});

		assert.ok(getTextOutput(result).includes("Successfully replaced"));
		const content = readFileSync(testFile, "utf-8");
		assert.equal(content, "replaced\nline three\n");
	});

	it("should match fullwidth punctuation in Chinese text", async () => {
		const testFile = join(testDir, "chinese-punctuation.txt");
		writeFileSync(testFile, "你好，世界\n你好（世界）\n");

		const result = await editTool.execute("test-fuzzy-chinese", {
			path: testFile,
			edits: [{ oldText: "你好,世界\n你好(世界)\n", newText: "你好，pi\n你好(pi)\n" }],
		});

		assert.ok(getTextOutput(result).includes("Successfully replaced"));
		const content = readFileSync(testFile, "utf-8");
		assert.equal(content, "你好，pi\n你好(pi)\n");
	});

	it("should match compatibility-equivalent Unicode forms", async () => {
		const testFile = join(testDir, "unicode-compatibility.txt");
		writeFileSync(testFile, "ＡＢＣ１２３\ncafe\u0301\n");

		const result = await editTool.execute("test-fuzzy-unicode", {
			path: testFile,
			edits: [{ oldText: "ABC123\ncafé\n", newText: "XYZ789\ncoffee\n" }],
		});

		assert.ok(getTextOutput(result).includes("Successfully replaced"));
		const content = readFileSync(testFile, "utf-8");
		assert.equal(content, "XYZ789\ncoffee\n");
	});

	it("should match smart single quotes to ASCII quotes", async () => {
		const testFile = join(testDir, "smart-quotes.txt");
		// File has smart/curly single quotes (U+2018, U+2019)
		writeFileSync(testFile, "console.log(\u2018hello\u2019);\n");

		// oldText with ASCII quotes should match
		const result = await editTool.execute("test-fuzzy-2", {
			path: testFile,
			edits: [{ oldText: "console.log('hello');", newText: "console.log('world');" }],
		});

		assert.ok(getTextOutput(result).includes("Successfully replaced"));
		const content = readFileSync(testFile, "utf-8");
		assert.ok(content.includes("world"));
	});

	it("should match smart double quotes to ASCII quotes", async () => {
		const testFile = join(testDir, "smart-double-quotes.txt");
		// File has smart/curly double quotes (U+201C, U+201D)
		writeFileSync(testFile, "const msg = \u201CHello World\u201D;\n");

		// oldText with ASCII quotes should match
		const result = await editTool.execute("test-fuzzy-3", {
			path: testFile,
			edits: [{ oldText: 'const msg = "Hello World";', newText: 'const msg = "Goodbye";' }],
		});

		assert.ok(getTextOutput(result).includes("Successfully replaced"));
		const content = readFileSync(testFile, "utf-8");
		assert.ok(content.includes("Goodbye"));
	});

	it("should match Unicode dashes to ASCII hyphen", async () => {
		const testFile = join(testDir, "unicode-dashes.txt");
		// File has en-dash (U+2013) and em-dash (U+2014)
		writeFileSync(testFile, "range: 1\u20135\nbreak\u2014here\n");

		// oldText with ASCII hyphens should match
		const result = await editTool.execute("test-fuzzy-4", {
			path: testFile,
			edits: [{ oldText: "range: 1-5\nbreak-here", newText: "range: 10-50\nbreak--here" }],
		});

		assert.ok(getTextOutput(result).includes("Successfully replaced"));
		const content = readFileSync(testFile, "utf-8");
		assert.ok(content.includes("10-50"));
	});

	it("should match non-breaking space to regular space", async () => {
		const testFile = join(testDir, "nbsp.txt");
		// File has non-breaking space (U+00A0)
		writeFileSync(testFile, "hello\u00A0world\n");

		// oldText with regular space should match
		const result = await editTool.execute("test-fuzzy-5", {
			path: testFile,
			edits: [{ oldText: "hello world", newText: "hello universe" }],
		});

		assert.ok(getTextOutput(result).includes("Successfully replaced"));
		const content = readFileSync(testFile, "utf-8");
		assert.ok(content.includes("universe"));
	});

	it("should prefer exact match over fuzzy match", async () => {
		const testFile = join(testDir, "exact-preferred.txt");
		// File has both exact and fuzzy-matchable content
		writeFileSync(testFile, "const x = 'exact';\nconst y = 'other';\n");

		const result = await editTool.execute("test-fuzzy-6", {
			path: testFile,
			edits: [{ oldText: "const x = 'exact';", newText: "const x = 'changed';" }],
		});

		assert.ok(getTextOutput(result).includes("Successfully replaced"));
		const content = readFileSync(testFile, "utf-8");
		assert.equal(content, "const x = 'changed';\nconst y = 'other';\n");
	});

	it("should still fail when text is not found even with fuzzy matching", async () => {
		const testFile = join(testDir, "no-match.txt");
		writeFileSync(testFile, "completely different content\n");

		await assert.rejects(
			editTool.execute("test-fuzzy-7", {
				path: testFile,
				edits: [{ oldText: "this does not exist", newText: "replacement" }],
			}),
			/Could not find the exact text/,
		);
	});

	it("should detect duplicates after fuzzy normalization", async () => {
		const testFile = join(testDir, "fuzzy-dups.txt");
		// Two lines that are identical after trailing whitespace is stripped
		writeFileSync(testFile, "hello world   \nhello world\n");

		await assert.rejects(
			editTool.execute("test-fuzzy-8", {
				path: testFile,
				edits: [{ oldText: "hello world", newText: "replaced" }],
			}),
			/Found 2 occurrences/,
		);
	});

	it("should support fuzzy matching in multi-edit mode", async () => {
		const testFile = join(testDir, "fuzzy-multi.txt");
		writeFileSync(testFile, "console.log(\u2018hello\u2019);\nhello\u00A0world\n");

		await editTool.execute("test-fuzzy-9", {
			path: testFile,
			edits: [
				{ oldText: "console.log('hello');\n", newText: "console.log('world');\n" },
				{ oldText: "hello world\n", newText: "hello universe\n" },
			],
		});

		assert.equal(readFileSync(testFile, "utf-8"), "console.log('world');\nhello universe\n");
	});

	it("should preserve the correct occurrence when fuzzy replacement equals a nearby line", async () => {
		const testFile = join(testDir, "fuzzy-preserve-duplicate-line.txt");
		const originalContent = ["replace me\u0020\u0020\u0020", "after\u0020\u0020\u0020", ""].join("\n");
		writeFileSync(testFile, originalContent);

		const result = await editTool.execute("test-fuzzy-preserve-duplicate-line", {
			path: testFile,
			edits: [{ oldText: "replace me\n", newText: "after\n" }],
		});

		const expectedContent = ["after", "after\u0020\u0020\u0020", ""].join("\n");
		assert.equal(readFileSync(testFile, "utf-8"), expectedContent);
		assert.equal(applyPatch(originalContent, result.details?.patch ?? ""), expectedContent);
	});

	it("should preserve untouched lines and produce an applicable patch for fuzzy multi-edits", async () => {
		const testFile = join(testDir, "fuzzy-preserve-multi.txt");
		const originalContent = [
			"keep before\u0020\u0020",
			"first target\u0020\u0020",
			"first after",
			"keep middle\u0020\u0020\u0020",
			"second target\u0020\u0020",
			"second after",
			"keep after\u0020\u0020",
			"",
		].join("\n");
		writeFileSync(testFile, originalContent);

		const result = await editTool.execute("test-fuzzy-preserve-multi", {
			path: testFile,
			edits: [
				{ oldText: "first target\nfirst after", newText: "FIRST\nFIRST2" },
				{ oldText: "second target\nsecond after", newText: "SECOND\nSECOND2" },
			],
		});

		const expectedContent = [
			"keep before\u0020\u0020",
			"FIRST",
			"FIRST2",
			"keep middle\u0020\u0020\u0020",
			"SECOND",
			"SECOND2",
			"keep after\u0020\u0020",
			"",
		].join("\n");
		assert.equal(readFileSync(testFile, "utf-8"), expectedContent);
		assert.equal(applyPatch(originalContent, result.details?.patch ?? ""), expectedContent);
	});
});

describe("edit tool CRLF handling", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `coding-agent-crlf-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("should match LF oldText against CRLF file content", async () => {
		const testFile = join(testDir, "crlf-test.txt");

		writeFileSync(testFile, "line one\r\nline two\r\nline three\r\n");

		const result = await editTool.execute("test-crlf-1", {
			path: testFile,
			edits: [{ oldText: "line two\n", newText: "replaced line\n" }],
		});

		assert.ok(getTextOutput(result).includes("Successfully replaced"));
	});

	it("should preserve CRLF line endings after edit", async () => {
		const testFile = join(testDir, "crlf-preserve.txt");
		writeFileSync(testFile, "first\r\nsecond\r\nthird\r\n");

		await editTool.execute("test-crlf-2", {
			path: testFile,
			edits: [{ oldText: "second\n", newText: "REPLACED\n" }],
		});

		const content = readFileSync(testFile, "utf-8");
		assert.equal(content, "first\r\nREPLACED\r\nthird\r\n");
	});

	it("should preserve LF line endings for LF files", async () => {
		const testFile = join(testDir, "lf-preserve.txt");
		writeFileSync(testFile, "first\nsecond\nthird\n");

		await editTool.execute("test-lf-1", {
			path: testFile,
			edits: [{ oldText: "second\n", newText: "REPLACED\n" }],
		});

		const content = readFileSync(testFile, "utf-8");
		assert.equal(content, "first\nREPLACED\nthird\n");
	});

	it("should detect duplicates across CRLF/LF variants", async () => {
		const testFile = join(testDir, "mixed-endings.txt");

		writeFileSync(testFile, "hello\r\nworld\r\n---\r\nhello\nworld\n");

		await assert.rejects(
			editTool.execute("test-crlf-dup", {
				path: testFile,
				edits: [{ oldText: "hello\nworld\n", newText: "replaced\n" }],
			}),
			/Found 2 occurrences/,
		);
	});

	it("should preserve UTF-8 BOM after edit", async () => {
		const testFile = join(testDir, "bom-test.txt");
		writeFileSync(testFile, "\uFEFFfirst\r\nsecond\r\nthird\r\n");

		await editTool.execute("test-bom", {
			path: testFile,
			edits: [{ oldText: "second\n", newText: "REPLACED\n" }],
		});

		const content = readFileSync(testFile, "utf-8");
		assert.equal(content, "\uFEFFfirst\r\nREPLACED\r\nthird\r\n");
	});

	it("should preserve CRLF line endings and BOM in multi-edit mode", async () => {
		const testFile = join(testDir, "bom-crlf-multi.txt");
		writeFileSync(testFile, "\uFEFFfirst\r\nsecond\r\nthird\r\nfourth\r\n");

		await editTool.execute("test-crlf-multi", {
			path: testFile,
			edits: [
				{ oldText: "second\n", newText: "SECOND\n" },
				{ oldText: "fourth\n", newText: "FOURTH\n" },
			],
		});

		const content = readFileSync(testFile, "utf-8");
		assert.equal(content, "\uFEFFfirst\r\nSECOND\r\nthird\r\nFOURTH\r\n");
	});
});
