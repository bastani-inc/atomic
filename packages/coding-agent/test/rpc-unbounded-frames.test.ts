import { Readable, Writable } from "node:stream";
import { describe, expect, test } from "vitest";
import {
	parseInteractiveEngineMessage,
	serializeInteractiveEngineMessage,
} from "../src/modes/interactive-engine/protocol.ts";
import { attachJsonlLineReader, serializeJsonLine } from "../src/modes/rpc/jsonl.ts";
import { QueuedWriter } from "../src/modes/rpc/queued-writer.ts";
import { serializeRpcOutputRecord } from "../src/modes/rpc/rpc-output-buffer.ts";

const LARGE_TEXT = "x".repeat(2 * 1024 * 1024);

describe("unbounded RPC records", () => {
	test("reads a JSONL command larger than 1 MiB across drain turns", async () => {
		const input = serializeJsonLine({ type: "prompt", message: LARGE_TEXT });
		const stream = Readable.from([Buffer.from(input)]);
		const line = await new Promise<string>((resolve) => {
			attachJsonlLineReader(stream, resolve, { maxBytesPerTurn: 64 * 1024 });
		});

		expect(JSON.parse(line)).toEqual({ type: "prompt", message: LARGE_TEXT });
	});

	test("serializes RPC output larger than 1 MiB without truncation", () => {
		const line = serializeRpcOutputRecord({ type: "message_end", message: { content: LARGE_TEXT } });

		expect(JSON.parse(line)).toEqual({ type: "message_end", message: { content: LARGE_TEXT } });
	});

	test("round-trips interactive engine frames larger than 1 MiB", () => {
		const frame = serializeInteractiveEngineMessage({
			type: "engine_custom_frame",
			componentId: "large",
			requestId: 1,
			lines: [LARGE_TEXT],
		});

		expect(parseInteractiveEngineMessage(frame.trimEnd())).toEqual({
			type: "engine_custom_frame",
			componentId: "large",
			requestId: 1,
			lines: [LARGE_TEXT],
		});
	});

	test("writes queued frames larger than 1 MiB", async () => {
		const chunks: Buffer[] = [];
		const stream = new Writable({
			write(chunk: Buffer, _encoding, callback) {
				chunks.push(Buffer.from(chunk));
				callback();
			},
		});
		const writer = new QueuedWriter(stream);
		const frame = serializeJsonLine({ type: "prompt", message: LARGE_TEXT });

		await writer.write(frame);

		expect(Buffer.concat(chunks).toString("utf8")).toBe(frame);
	});

	test("accepts coalesced render frames larger than 1 MiB", async () => {
		let resolveChunk!: (chunk: Buffer) => void;
		const chunkWritten = new Promise<Buffer>((resolve) => {
			resolveChunk = resolve;
		});
		const stream = new Writable({
			write(chunk: Buffer, _encoding, callback) {
				resolveChunk(Buffer.from(chunk));
				callback();
			},
		});
		const writer = new QueuedWriter(stream);
		const frame = serializeJsonLine({ type: "engine_message_render", message: LARGE_TEXT });

		expect(writer.offerLatest("render:large", frame)).toBe(true);
		expect((await chunkWritten).toString("utf8")).toBe(frame);
	});
});
