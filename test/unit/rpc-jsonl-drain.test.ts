/**
 * Drain completion for the JSONL reader.
 *
 * The host waits for this signal before deciding that a dead engine's requests
 * were never accepted, so it has to fire exactly once for every ended stream —
 * including a stream that ends with nothing buffered, where an earlier version
 * simply never announced completion and left the wait hanging until its timeout.
 */

import assert from "node:assert/strict";
import { PassThrough, type Readable } from "node:stream";
import { test } from "vitest";
import { attachJsonlLineReader } from "../../packages/coding-agent/src/modes/rpc/jsonl.ts";
import { sleep } from "../helpers/runtime.js";

function collect(
	stream: Readable,
	options?: { maxBytesPerTurn?: number },
): {
	lines: string[];
	drained: number;
	done: Promise<void>;
} {
	const lines: string[] = [];
	const state = { drained: 0 };
	const done = new Promise<void>((resolve) => {
		attachJsonlLineReader(stream, (line) => lines.push(line), {
			...options,
			onDrained: () => {
				state.drained += 1;
				resolve();
			},
		});
	});
	return {
		lines,
		get drained() {
			return state.drained;
		},
		done,
	} as never;
}

test("an empty stream still reports drained exactly once", async () => {
	const stream = new PassThrough();
	const reader = collect(stream);
	stream.end();
	await reader.done;
	await sleep(10);
	assert.deepEqual(reader.lines, []);
	assert.equal(reader.drained, 1);
});

test("a stream that ends with buffered frames reports drained after the last line", async () => {
	const stream = new PassThrough();
	const reader = collect(stream);
	stream.write('{"type":"a"}\n{"type":"b"}\n');
	stream.end('{"type":"c"}\n');
	await reader.done;
	assert.deepEqual(reader.lines, ['{"type":"a"}', '{"type":"b"}', '{"type":"c"}']);
	assert.equal(reader.drained, 1);
});

test("a multi-turn backlog is fully parsed before drained fires", async () => {
	const stream = new PassThrough();
	// Smaller than the backlog, so parsing spans several turns.
	const reader = collect(stream, { maxBytesPerTurn: 4 * 1024 });
	const frame = `${JSON.stringify({ type: "engine_heartbeat", at: 1, padding: "x".repeat(200) })}\n`;
	stream.write(frame.repeat(500));
	stream.end(`${JSON.stringify({ type: "engine_request_accepted", requestId: "req_1", command: "prompt" })}\n`);
	await reader.done;
	assert.equal(reader.lines.length, 501);
	assert.match(reader.lines.at(-1)!, /engine_request_accepted/, "the last frame must be parsed before drained");
	assert.equal(reader.drained, 1);
});

test("an unterminated final frame is delivered before drained fires", async () => {
	const stream = new PassThrough();
	const reader = collect(stream);
	stream.write('{"type":"a"}\n');
	stream.end('{"type":"partial"}');
	await reader.done;
	assert.deepEqual(reader.lines, ['{"type":"a"}', '{"type":"partial"}']);
	assert.equal(reader.drained, 1);
});
