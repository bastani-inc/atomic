import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import type { JsonRpcMessage } from "../../src/extensions/mcp/client/index.js";
import { JsonRpcLineReader } from "../../src/extensions/mcp/client/transports/lines.js";

function startReader(maxMessageBytes?: number, maxStderrBytes?: number) {
	const messages: JsonRpcMessage[] = [];
	const errors: string[] = [];
	const reader = new JsonRpcLineReader({
		maxMessageBytes,
		maxStderrBytes,
		onMessage: (message) => messages.push(message),
		onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
	});
	return { reader, messages, errors };
}

function feed(reader: JsonRpcLineReader, bytes: Buffer, chunkSize: number): void {
	for (let i = 0; i < bytes.length; i += chunkSize) reader.readStdout(bytes.subarray(i, i + chunkSize));
}

describe("JsonRpcLineReader", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("joins a message split across many chunks once, when its newline arrives (pi #11791)", () => {
		const { reader, messages, errors } = startReader();
		const text = "x".repeat(1024 * 1024);
		const bytes = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text } })}\n`);
		const concat = vi.spyOn(Buffer, "concat");
		feed(reader, bytes, 4096);
		assert.equal(concat.mock.calls.length, 1);
		assert.deepEqual(errors, []);
		assert.deepEqual(messages, [{ jsonrpc: "2.0", id: 1, result: { text } }]);
	});

	it("handles multi-byte characters, CRLF, blank lines, and several messages per chunk at any split", () => {
		const input = Buffer.from(
			[
				JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "héllo 🌍" } }),
				"",
				`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/x" })}\r`,
				"not json",
				JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} }),
				"",
			].join("\n"),
		);
		for (let chunkSize = 1; chunkSize <= input.length; chunkSize++) {
			const { reader, messages, errors } = startReader();
			feed(reader, input, chunkSize);
			reader.end();
			assert.deepEqual(messages, [
				{ jsonrpc: "2.0", id: 1, result: { text: "héllo 🌍" } },
				{ jsonrpc: "2.0", method: "notifications/x" },
				{ jsonrpc: "2.0", id: 2, result: {} },
			]);
			assert.equal(errors.length, 1);
		}
	});

	it("drops an oversized message and keeps reading the next one", () => {
		const { reader, messages, errors } = startReader(64);
		const next = JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} });
		feed(reader, Buffer.from(`${"a".repeat(50)}`), 10);
		feed(reader, Buffer.from(`${"a".repeat(50)}\n${next}\n`), 10);
		assert.equal(errors[0], "MCP stdio message exceeds 64 bytes");
		assert.deepEqual(messages, [{ jsonrpc: "2.0", id: 2, result: {} }]);
	});

	it("reports a message without its newline at the end", () => {
		const { reader, errors } = startReader();
		feed(reader, Buffer.from('{"jsonrpc":"2.0",'), 4);
		reader.end();
		assert.deepEqual(errors, ["MCP stdio server closed with an incomplete JSON-RPC message"]);
	});

	it("copies and joins nothing for messages that each arrive whole in one chunk", () => {
		const { reader, messages, errors } = startReader();
		const concat = vi.spyOn(Buffer, "concat");
		reader.readStdout(Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}\n'));
		reader.readStdout(Buffer.from('{"jsonrpc":"2.0","id":2,"result":{}}\n{"jsonrpc":"2.0","id":3,"result":{}}\n'));
		assert.equal(concat.mock.calls.length, 0);
		assert.deepEqual(errors, []);
		assert.deepEqual(
			messages.map((message) => (message as { id: number }).id),
			[1, 2, 3],
		);
	});

	it("accepts a message of exactly the size limit and drops one byte more", () => {
		const frame = (size: number) => {
			const head = '{"jsonrpc":"2.0","id":1,"result":{"p":"';
			const tail = '"}}';
			return head + "x".repeat(size - head.length - tail.length) + tail;
		};
		const limit = 100;
		const exact = startReader(limit);
		exact.reader.readStdout(Buffer.from(frame(limit)));
		assert.deepEqual(exact.errors, []);
		exact.reader.readStdout(Buffer.from("\n"));
		assert.deepEqual(exact.errors, []);
		assert.equal(exact.messages.length, 1);

		const over = startReader(limit);
		over.reader.readStdout(Buffer.from(`${frame(limit + 1)}\n`));
		assert.deepEqual(over.errors, [`MCP stdio message exceeds ${limit} bytes`]);
		assert.deepEqual(over.messages, []);
	});

	it("reports an oversized unfinished message as soon as it passes the limit, and forgets its bytes", () => {
		const { reader, messages, errors } = startReader(64);
		reader.readStdout(Buffer.from("a".repeat(70)));
		assert.deepEqual(errors, ["MCP stdio message exceeds 64 bytes"]);
		reader.end();
		assert.deepEqual(errors, ["MCP stdio message exceeds 64 bytes"]);
		assert.deepEqual(messages, []);
	});

	it("ignores lines of only whitespace, and an unfinished message of only whitespace at the end", () => {
		const { reader, messages, errors } = startReader();
		reader.readStdout(Buffer.from('   \n\t\r\n{"jsonrpc":"2.0","id":1,"result":{}}\n  \t '));
		reader.end();
		assert.deepEqual(errors, []);
		assert.equal(messages.length, 1);
	});

	it("strips only the carriage return that ends a line", () => {
		const { reader, messages, errors } = startReader();
		reader.readStdout(Buffer.from('{"jsonrpc":"2.0","id":1,"result":"a\rb"}\n'));
		assert.deepEqual(messages, []);
		assert.equal(errors.length, 1);
		reader.readStdout(Buffer.from('{"jsonrpc":"2.0","id":2,"result":"ok"}\r\n'));
		assert.deepEqual(messages, [{ jsonrpc: "2.0", id: 2, result: "ok" }]);
	});

	it("starts clean after the stream ended with an unfinished message", () => {
		const { reader, messages, errors } = startReader();
		reader.readStdout(Buffer.from('{"jsonrpc":"2.0",'));
		reader.end();
		assert.equal(errors.length, 1);
		reader.readStdout(Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}\n'));
		assert.equal(errors.length, 1);
		assert.equal(messages.length, 1);
	});

	it("keeps the last 64 KiB of stderr by default", () => {
		const { reader } = startReader();
		const keep = 64 * 1024;
		reader.readStderr(Buffer.from("A".repeat(10)));
		reader.readStderr(Buffer.from("B".repeat(keep - 5)));
		reader.readStderr(Buffer.from("C".repeat(5)));
		assert.equal(reader.stderr, "B".repeat(keep - 5) + "C".repeat(5));
	});

	it("keeps the configured tail of stderr, newest bytes last", () => {
		const { reader } = startReader(undefined, 8);
		reader.readStderr(Buffer.from("abcdef"));
		assert.equal(reader.stderr, "abcdef");
		reader.readStderr(Buffer.from("ghij"));
		assert.equal(reader.stderr, "cdefghij");
		reader.readStderr(Buffer.from("k"));
		assert.equal(reader.stderr, "defghijk");
	});
});
