import assert from "node:assert/strict";
import { test } from "vitest";
import { chunkedToolResult } from "../../packages/coding-agent/src/core/storage/session/chunked-tool-result.js";

/** `text` as stored bytes, in chunks of `size`, so keys and values split across chunk boundaries. */
async function* chunks(text: string, size: number): AsyncGenerator<Uint8Array> {
	const bytes = new TextEncoder().encode(text);
	for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
}

test("a saved tool result is read field by field: its call, tool, outcome and duration, never its body (#5593)", async () => {
	const body = "é".repeat(1024 * 1024);
	const entry = {
		type: "message",
		id: "e1",
		parentId: "p1",
		timestamp: "2026-11-19T00:00:00.000Z",
		message: {
			role: "toolResult",
			content: [{ type: "text", text: body }],
			details: { output: body },
			toolName: "bash",
			isError: true,
			timestamp: 7,
			durationMs: 1250,
			// The last of duplicate keys wins, as in a whole parse.
			toolCallId: "call-1",
		},
	};
	const text = JSON.stringify(entry).replace('"toolCallId":"call-1"', '"toolCallId":"ignored","toolCallId":"call-1"');
	assert.deepEqual(await chunkedToolResult(chunks(text, 7)), {
		id: "e1",
		parentId: "p1",
		timestamp: "2026-11-19T00:00:00.000Z",
		toolCallId: "call-1",
		toolName: "bash",
		isError: true,
		durationMs: 1250,
		messageTimestamp: 7,
	});
});

test("a saved row that is not a tool result reads as none, after its first bytes (#5593)", async () => {
	const reply = JSON.stringify({
		type: "message",
		id: "e2",
		parentId: null,
		timestamp: "t",
		message: { role: "assistant", content: [{ type: "text", text: "x".repeat(4096) }] },
	});
	assert.equal(await chunkedToolResult(chunks(reply, 1000)), undefined);
	const custom = JSON.stringify({ type: "custom", id: "e3", parentId: null, timestamp: "t", data: "y".repeat(4096) });
	assert.equal(await chunkedToolResult(chunks(custom, 1000)), undefined);
	const large = JSON.stringify({
		type: "message",
		id: "e4",
		parentId: null,
		timestamp: "t",
		message: { role: "assistant", content: [{ type: "text", text: "z".repeat(2 * 1024 * 1024) }] },
	});
	let read = 0;
	const counted = (async function* () {
		for await (const chunk of chunks(large, 1024)) {
			read += chunk.length;
			yield chunk;
		}
	})();
	assert.equal(await chunkedToolResult(counted), undefined);
	assert.ok(read <= 1024, `a reply is left after its kind (${read} bytes read)`);
});
