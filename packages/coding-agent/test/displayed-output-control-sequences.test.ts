import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { type BashOperations, executeBashWithOperations } from "../src/core/bash-executor.ts";
import { formatToolCallWithArgs, getTextOutput } from "../src/core/tools/render-utils.ts";
import { stripTerminalControls } from "../src/utils/ansi.ts";

// Neutral 8-bit sequences: a window title OSC, an OSC hyperlink, a CSI clear, a DCS query and an APC string.
const EIGHT_BIT_SAMPLES: ReadonlyArray<readonly [string, string]> = [
	["pre \u009d0;title\u009c post", "pre  post"],
	["pre \u009d8;;http://a.example\u009clink\u009d8;;\u009c post", "pre link post"],
	["pre \u009b2J\u009bH post", "pre  post"],
	["pre \u0090q payload\u009c post", "pre  post"],
	["pre \u009fGa=T\u009c post", "pre  post"],
	["pre \u009d0;title\u0007 post", "pre  post"],
	["pre \u0085\u0099 post", "pre  post"],
];

const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const plainTheme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };

async function runBash(chunks: readonly Buffer[]): Promise<{ output: string; streamed: string }> {
	const streamed: string[] = [];
	const operations: BashOperations = {
		exec: async (_command, _cwd, options) => {
			for (const chunk of chunks) options.onData(chunk);
			return { exitCode: 0 };
		},
	};
	const result = await executeBashWithOperations("x", process.cwd(), operations, {
		onChunk: (chunk) => streamed.push(chunk),
	});
	return { output: result.output, streamed: streamed.join("") };
}

function splitAt(bytes: Buffer, points: readonly number[]): Buffer[] {
	const chunks: Buffer[] = [];
	let at = 0;
	for (const point of [...points, bytes.length]) {
		if (point > at) chunks.push(bytes.subarray(at, point));
		at = Math.max(at, point);
	}
	return chunks;
}

describe("displayed output control sequences", () => {
	test("8-bit control characters are removed from displayed tool output", () => {
		for (const [input, expected] of EIGHT_BIT_SAMPLES) {
			const output = getTextOutput({ content: [{ type: "text", text: input }] }, false);
			assert.equal(output, expected, JSON.stringify(input));
		}
	});

	test("8-bit control characters are removed from displayed tool call arguments", () => {
		for (const [input, expected] of EIGHT_BIT_SAMPLES) {
			for (const expanded of [true, false]) {
				const call = formatToolCallWithArgs("bash", { command: input }, plainTheme, expanded);
				assert.ok(!UNSAFE.test(call), `${JSON.stringify(input)} -> ${JSON.stringify(call)}`);
				if (expanded) assert.ok(call.endsWith(expected), JSON.stringify(call));
			}
		}
	});

	test("8-bit control characters are removed from displayed messages", () => {
		for (const [input, expected] of EIGHT_BIT_SAMPLES) {
			assert.equal(stripTerminalControls(input), expected, JSON.stringify(input));
		}
	});

	test("8-bit control sequences split across bash output chunks are removed whole", async () => {
		const bytes = Buffer.from("pre \u009d52;c;aGVsbG8=\u009c mid \u001b]8;;http://a.example\u001b\\post", "utf8");
		for (let point = 1; point < bytes.length; point++) {
			const { output, streamed } = await runBash(splitAt(bytes, [point]));
			assert.equal(output, "pre  mid post", `split at ${point}`);
			assert.equal(streamed, "pre  mid post", `split at ${point}`);
		}
	});

	test("long control strings split across bash output chunks leave no payload", async () => {
		const url = `http://a.example/${"u".repeat(400)}`;
		const params = "1;".repeat(150);
		const bytes = Buffer.from(`a\u001b]8;;${url}\u0007b\u001b[${params}mc`, "utf8");
		for (const point of [10, 200, 300, 420, 450, 600]) {
			const { output } = await runBash(splitAt(bytes, [point]));
			assert.equal(output, "abc", `split at ${point}`);
		}
	});

	test("bidirectional overrides are shown escaped in displayed text", () => {
		const input = "file \u202Etxt.exe\u202C and \u2066isolate\u2069";
		const expected = "file <U+202E>txt.exe<U+202C> and <U+2066>isolate<U+2069>";
		assert.equal(stripTerminalControls(input), expected);
		assert.equal(getTextOutput({ content: [{ type: "text", text: input }] }, false), expected);
		const call = formatToolCallWithArgs("read", { path: input }, plainTheme, true);
		assert.ok(call.endsWith(expected), call);
	});

	test("valid multibyte text survives byte-level chunking unchanged", async () => {
		const text = "wörld 日本語 😀 «ok» é\n\ttab";
		const bytes = Buffer.from(text, "utf8");
		for (let point = 1; point < bytes.length; point++) {
			const { output } = await runBash(splitAt(bytes, [point]));
			assert.equal(output, text, `split at ${point}`);
		}
	});

	test("random chunkings never pass control characters and preserve the other text", async () => {
		let seed = 0x5eed;
		const random = () => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};
		const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
		// [raw piece, the text it contributes once rendered]
		const atoms: ReadonlyArray<readonly [string, string]> = [
			["hello ", "hello "],
			["wörld ", "wörld "],
			["日本語", "日本語"],
			["😀", "😀"],
			["\n", "\n"],
			["\t", "\t"],
			["\r\n", "\n"],
			["\u001b[31m", ""],
			["\u001b[38;5;196m", ""],
			["\u001b[?25l", ""],
			["\u001b[<35;59;1M", ""],
			["\u001b]0;title\u0007", ""],
			["\u001b]8;;http://x.example\u001b\\", ""],
			["\u001b]52;c;aGVsbG8=\u0007", ""],
			["\u001bP1$r0m\u001b\\", ""],
			["\u001b_Ga=T\u001b\\", ""],
			["\u001bc", ""],
			["\u001b(B", ""],
			["\u0007", ""],
			["\u0000\u0008\u007f", ""],
			["\u009b2J", ""],
			["\u009d0;t\u009c", ""],
			["\u009d52;c;aGVsbG8=\u0007", ""],
			["\u0090x\u009c", ""],
			["\u009fGa=T\u009c", ""],
			["\u0085", ""],
			[`\u001b]8;;${"u".repeat(300)}\u0007`, ""],
			[`\u001b[${"1;".repeat(150)}m`, ""],
			["\u202e", "<U+202E>"],
			["\u2068", "<U+2068>"],
		];
		for (let iteration = 0; iteration < 400; iteration++) {
			const pieces = Array.from({ length: 1 + Math.floor(random() * 10) }, () => pick(atoms));
			const raw = pieces.map(([piece]) => piece).join("");
			const expected = pieces.map(([, shown]) => shown).join("");
			const bytes = Buffer.from(raw, "utf8");
			const points = Array.from({ length: Math.floor(random() * 8) }, () =>
				Math.floor(random() * bytes.length),
			).sort((a, b) => a - b);
			const { output } = await runBash(splitAt(bytes, points));
			const shown = getTextOutput({ content: [{ type: "text", text: output }] }, false);
			assert.ok(!UNSAFE.test(shown), `${JSON.stringify(raw)} -> ${JSON.stringify(shown)}`);
			assert.equal(shown, expected, `${JSON.stringify(raw)} split at ${JSON.stringify(points)}`);
			assert.equal(stripTerminalControls(raw), expected, JSON.stringify(raw));
		}
	});
});
