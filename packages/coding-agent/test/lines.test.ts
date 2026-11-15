import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import { describe, test } from "vitest";
import { attachLineReader, LineSplitter, readLines } from "../src/utils/lines.ts";

async function collect(chunks: readonly (Buffer | string)[]): Promise<string[]> {
	const lines: string[] = [];
	for await (const line of readLines(Readable.from(chunks))) lines.push(line);
	return lines;
}

describe("line splitting (#4957)", () => {
	test("splits only at newlines, keeping U+2028, U+2029 and a lone CR inside the line (#4957)", async () => {
		assert.deepEqual(await collect(['{"t":"a\u2028b\u2029c"}\n{"t":"x\ry"}\n']), [
			'{"t":"a\u2028b\u2029c"}',
			'{"t":"x\ry"}',
		]);
	});

	test("drops the CR of a CRLF and keeps empty lines, but a final newline starts no line (#4957)", async () => {
		assert.deepEqual(await collect(["a\r\n\r\n\nb\r\n"]), ["a", "", "", "b"]);
		assert.deepEqual(await collect(["\n"]), [""]);
		assert.deepEqual(await collect([]), []);
		assert.deepEqual(await collect([""]), []);
	});

	test("returns a last line that has no newline, without dropping its last character (#4957)", async () => {
		assert.deepEqual(await collect(["first\nlast"]), ["first", "last"]);
		assert.deepEqual(await collect(["only\r"]), ["only"]);
	});

	test("joins a line and a character split between chunks (#4957)", async () => {
		const bytes = Buffer.from("é\u2028x\r\nnext\n");
		const chunks = [...bytes].map((byte) => Buffer.from([byte]));
		assert.deepEqual(await collect(chunks), ["é\u2028x", "next"]);
		assert.deepEqual(await collect(["par", "tial\nlin", "e\n"]), ["partial", "line"]);
	});

	test("a splitter returns each line once, as the chunk that completes it arrives (#4957)", () => {
		const splitter = new LineSplitter();
		assert.deepEqual(splitter.push("a\nb"), ["a"]);
		assert.deepEqual(splitter.push("c\nd\ne"), ["bc", "d"]);
		assert.deepEqual(splitter.end(), ["e"]);
		assert.deepEqual(splitter.end(), []);
		assert.deepEqual(splitter.push(Buffer.from("f\n")), ["f"]);
	});

	test("an attached reader delivers every line, the unterminated last one at the end (#4957)", async () => {
		const input = new PassThrough();
		const lines: string[] = [];
		attachLineReader(input, (line) => lines.push(line));
		input.write("a\u2028b\nc");
		input.end("d\u2029");
		await new Promise((resolve) => input.on("end", resolve));
		assert.deepEqual(lines, ["a\u2028b", "cd\u2029"]);
	});

	test("an attached reader delivers no line once detached, even later lines of the same chunk (#4957)", async () => {
		const input = new PassThrough();
		const lines: string[] = [];
		let detach = (): void => {};
		detach = attachLineReader(input, (line) => {
			lines.push(line);
			if (line === "stop") detach();
		});
		input.write("go\nstop\nafter\n");
		input.end("tail");
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(lines, ["go", "stop"]);
		assert.equal(input.listenerCount("data"), 0);
		assert.equal(input.listenerCount("end"), 0);
	});
});
