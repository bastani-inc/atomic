import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/cli/args.ts";

describe("parseArgs -- end-of-options terminator", () => {
	test("preserves a prompt beginning with a single hyphen", () => {
		const prompt = "- leading-dash prompt";
		const result = parseArgs(["--", prompt]);

		assert.deepStrictEqual(result.messages, [prompt]);
		assert.deepStrictEqual(result.fileArgs, []);
		assert.strictEqual(result.unknownFlags.size, 0);
		assert.deepStrictEqual(result.diagnostics, []);
	});

	test("preserves a prompt beginning with two hyphens", () => {
		const prompt = "--leading-double-dash prompt";
		const result = parseArgs(["--", prompt]);

		assert.deepStrictEqual(result.messages, [prompt]);
		assert.strictEqual(result.unknownFlags.size, 0);
		assert.deepStrictEqual(result.diagnostics, []);
	});

	test("preserves a prompt beginning with @ as message text", () => {
		const prompt = "@literal-file-looking prompt";
		const result = parseArgs(["--", prompt]);

		assert.deepStrictEqual(result.messages, [prompt]);
		assert.deepStrictEqual(result.fileArgs, []);
	});

	test("consumes the terminator, parses preceding options, and preserves every following argument", () => {
		const result = parseArgs([
			"--print",
			"--mode",
			"json",
			"--",
			"first",
			"--provider",
			"@context.md",
			"first",
		]);

		assert.strictEqual(result.print, true);
		assert.strictEqual(result.mode, "json");
		assert.strictEqual(result.provider, undefined);
		assert.deepStrictEqual(result.messages, ["first", "--provider", "@context.md", "first"]);
		assert.deepStrictEqual(result.fileArgs, []);
		assert.strictEqual(result.unknownFlags.size, 0);
		assert.deepStrictEqual(result.diagnostics, []);
	});
});
