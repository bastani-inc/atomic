import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { type JsonRpcMessage, StdioTransport } from "../../src/extensions/mcp/client/index.js";

/**
 * Chaos coverage for the stdio framing (pi #11791): a server that writes a message one byte at a time, writes
 * an oversized message, and is SIGKILLed in the middle of the next message. The invariants: complete messages
 * arrive intact in order, an oversized message is reported and skipped without ending the stream, and a message
 * cut off by the crash is reported as incomplete exactly once, followed by close.
 */

// Each case runs a real child process.
const CHILD_PROCESS_TEST_TIMEOUT_MS = 20_000;
const MAX_MESSAGE_BYTES = 4096;

const SERVER = `
const write = (text) => new Promise((resolve) => process.stdout.write(text, resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const first = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "héllo 🌍".repeat(20) } }) + "\\n";
for (const char of first) {
	await write(char);
	await sleep(1);
}
await write(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { text: "x".repeat(${MAX_MESSAGE_BYTES * 2}) } }) + "\\n");
await write(JSON.stringify({ jsonrpc: "2.0", id: 3, result: {} }) + "\\n");
const partial = JSON.stringify({ jsonrpc: "2.0", id: 4, result: { text: "y".repeat(1000) } });
await write(partial.slice(0, partial.length / 2));
await sleep(50);
process.kill(process.pid, "SIGKILL");
`;

describe.skipIf(process.platform === "win32")("StdioTransport framing chaos (pi #11791)", () => {
	it(
		"keeps complete messages through a byte-at-a-time writer, an oversized message and a SIGKILL mid-message",
		async () => {
			const transport = new StdioTransport({
				command: process.execPath,
				args: ["--input-type=module", "-e", SERVER],
				maxMessageBytes: MAX_MESSAGE_BYTES,
			});
			const messages: JsonRpcMessage[] = [];
			const errors: string[] = [];
			const closed = new Promise<void>((resolve) => transport.onClose(() => resolve()));
			transport.onMessage((message) => messages.push(message));
			transport.onError((error) => errors.push(error.message));

			await transport.start();
			await closed;

			assert.deepEqual(
				messages.map((message) => ("id" in message ? message.id : undefined)),
				[1, 3],
			);
			assert.deepEqual(messages[0], { jsonrpc: "2.0", id: 1, result: { text: "héllo 🌍".repeat(20) } });
			assert.deepEqual(errors, [
				`MCP stdio message exceeds ${MAX_MESSAGE_BYTES} bytes`,
				"MCP stdio server closed with an incomplete JSON-RPC message",
			]);
			await transport.close();
		},
		CHILD_PROCESS_TEST_TIMEOUT_MS,
	);
});
