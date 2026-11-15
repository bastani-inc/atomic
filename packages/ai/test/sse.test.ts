import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { type ServerSentEvent, ServerSentEventDecoder } from "../src/utils/sse.ts";

const encoder = new TextEncoder();

function decodeChunks(chunks: Uint8Array[]): ServerSentEvent[] {
	const decoder = new ServerSentEventDecoder();
	return [...chunks.flatMap((chunk) => decoder.decode(chunk)), ...decoder.end()];
}

function decodeText(text: string): ServerSentEvent[] {
	return decodeChunks([encoder.encode(text)]);
}

const STREAM_LINES = [
	": keep-alive",
	"event: message_start",
	'data: {"text":"Hé"}',
	"",
	"event: content_block_delta",
	'data: {"text":"llo 👋"}',
	"data:wörld",
	"id: 7",
	"",
	"data: [DONE]",
	"",
];

const EXPECTED_EVENTS: ServerSentEvent[] = [
	{
		event: "message_start",
		data: '{"text":"Hé"}',
		raw: [": keep-alive", "event: message_start", 'data: {"text":"Hé"}'],
	},
	{
		event: "content_block_delta",
		data: '{"text":"llo 👋"}\nwörld',
		raw: ["event: content_block_delta", 'data: {"text":"llo 👋"}', "data:wörld", "id: 7"],
	},
	{ event: null, data: "[DONE]", raw: ["data: [DONE]"] },
];

describe("ServerSentEventDecoder", () => {
	for (const [name, eol] of [
		["LF", "\n"],
		["CRLF", "\r\n"],
		["CR", "\r"],
	] as const) {
		it(`decodes a ${name} stream identically when split at every byte`, () => {
			const bytes = encoder.encode(STREAM_LINES.map((line) => line + eol).join(""));
			assert.deepEqual(decodeChunks([bytes]), EXPECTED_EVENTS);
			for (let split = 1; split < bytes.length; split++) {
				assert.deepEqual(
					decodeChunks([bytes.subarray(0, split), bytes.subarray(split)]),
					EXPECTED_EVENTS,
					`split at byte ${split}`,
				);
			}
		});

		it(`decodes a ${name} stream identically when fed one byte at a time`, () => {
			const bytes = encoder.encode(STREAM_LINES.map((line) => line + eol).join(""));
			assert.deepEqual(decodeChunks(Array.from(bytes, (byte) => Uint8Array.of(byte))), EXPECTED_EVENTS);
		});
	}

	it("holds a chunk-final CR until the next chunk shows whether an LF follows (#4899)", () => {
		const decoder = new ServerSentEventDecoder();
		assert.deepEqual(decoder.decode(encoder.encode("data: a\r\n\r")), []);
		assert.deepEqual(decoder.decode(encoder.encode("\ndata: b\r\n\r\n")), [
			{ event: null, data: "a", raw: ["data: a"] },
			{ event: null, data: "b", raw: ["data: b"] },
		]);
		assert.deepEqual(decoder.end(), []);
	});

	it("treats a CR at the end of the stream as a line ending", () => {
		const decoder = new ServerSentEventDecoder();
		assert.deepEqual(decoder.decode(encoder.encode("data: a\r")), []);
		assert.deepEqual(decoder.end(), [{ event: null, data: "a", raw: ["data: a"] }]);
	});

	it("dispatches an event left pending at the end of the stream", () => {
		assert.deepEqual(decodeText("event: done\ndata: x"), [
			{ event: "done", data: "x", raw: ["event: done", "data: x"] },
		]);
	});

	it("parses fields without a value or with a colon in the value", () => {
		assert.deepEqual(decodeText("data\ndata:  two spaces\ndata: a:b\n\n"), [
			{ event: null, data: "\n two spaces\na:b", raw: ["data", "data:  two spaces", "data: a:b"] },
		]);
	});

	it("dispatches an event with a name and no data, and drops blocks with neither", () => {
		assert.deepEqual(decodeText(": comment\n\nevent:\n\nevent: ping\n\nretry: 5\n\nevent:\n\ndata: x\n\n"), [
			{ event: "ping", data: "", raw: ["event: ping"] },
			{ event: null, data: "x", raw: ["data: x"] },
		]);
	});

	it("dispatches each event as soon as its blank line arrives", () => {
		const decoder = new ServerSentEventDecoder();
		assert.deepEqual(decoder.decode(encoder.encode("data: a\n\n")), [{ event: null, data: "a", raw: ["data: a"] }]);
		assert.deepEqual(decoder.decode(encoder.encode("data: b\r\n\r\ndata: c")), [
			{ event: null, data: "b", raw: ["data: b"] },
		]);
		assert.deepEqual(decoder.decode(encoder.encode("\r\rdata: d\r\rdata: e")), [
			{ event: null, data: "c", raw: ["data: c"] },
			{ event: null, data: "d", raw: ["data: d"] },
		]);
		assert.deepEqual(decoder.end(), [{ event: null, data: "e", raw: ["data: e"] }]);
	});
});
