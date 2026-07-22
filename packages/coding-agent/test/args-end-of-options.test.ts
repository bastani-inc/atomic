import { describe, expect, test } from "vitest";
import { insertForcedOptionsBeforeTerminator, parseArgs } from "../src/cli/args.ts";

describe("parseArgs -- end-of-options terminator", () => {
	test("preserves a prompt beginning with a single hyphen", () => {
		const prompt = "- leading-dash prompt";
		const result = parseArgs(["--", prompt]);

		expect(result.messages).toEqual([prompt]);
		expect(result.fileArgs).toEqual([]);
		expect(result.unknownFlags.size).toBe(0);
		expect(result.diagnostics).toEqual([]);
	});

	test("preserves a prompt beginning with two hyphens", () => {
		const prompt = "--leading-double-dash prompt";
		const result = parseArgs(["--", prompt]);

		expect(result.messages).toEqual([prompt]);
		expect(result.unknownFlags.size).toBe(0);
		expect(result.diagnostics).toEqual([]);
	});

	test("preserves a prompt beginning with @ as message text", () => {
		const prompt = "@literal-file-looking prompt";
		const result = parseArgs(["--", prompt]);

		expect(result.messages).toEqual([prompt]);
		expect(result.fileArgs).toEqual([]);
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

		expect(result.print).toBe(true);
		expect(result.mode).toBe("json");
		expect(result.provider).toBeUndefined();
		expect(result.messages).toEqual(["first", "--provider", "@context.md", "first"]);
		expect(result.fileArgs).toEqual([]);
		expect(result.unknownFlags.size).toBe(0);
		expect(result.diagnostics).toEqual([]);
	});
});

describe("insertForcedOptionsBeforeTerminator", () => {
	test("appends forced options when no terminator is present", () => {
		const args = insertForcedOptionsBeforeTerminator(["--print", "hello"], ["--mode", "rpc"]);

		expect(args).toEqual(["--print", "hello", "--mode", "rpc"]);
		expect(parseArgs(args).mode).toBe("rpc");
	});

	test("inserts forced options before the terminator so they still parse as options", () => {
		const args = insertForcedOptionsBeforeTerminator(
			["--print", "--", "- leading-dash prompt"],
			["--mode", "rpc"],
		);

		expect(args).toEqual(["--print", "--mode", "rpc", "--", "- leading-dash prompt"]);
		const result = parseArgs(args);
		expect(result.mode).toBe("rpc");
		expect(result.messages).toEqual(["- leading-dash prompt"]);
	});

	test("forced --mode still wins over a caller --mode before the terminator", () => {
		const args = insertForcedOptionsBeforeTerminator(
			["--mode", "json", "--", "--mode json as message"],
			["--mode", "rpc"],
		);

		const result = parseArgs(args);
		expect(result.mode).toBe("rpc");
		expect(result.messages).toEqual(["--mode json as message"]);
	});
});
