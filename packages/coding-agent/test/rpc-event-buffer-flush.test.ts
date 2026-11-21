import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { RpcEventBuffer } from "../src/modes/rpc/rpc-event-buffer.ts";
import type { RpcEvent } from "../src/modes/rpc/rpc-types.ts";

function toolUpdate(toolCallId: string): RpcEvent {
	return { type: "tool_execution_update", toolCallId, toolName: "bash", args: {}, partialResult: toolCallId };
}

const callOf = (event: RpcEvent) => (event.type === "tool_execution_update" ? event.toolCallId : event.type);

describe("RpcEventBuffer flush", () => {
	test("a flush whose emit throws keeps only the updates it has not delivered (#6107)", () => {
		const emitted: string[] = [];
		let failOn: string | undefined = "a";
		const buffer = new RpcEventBuffer((event) => {
			emitted.push(callOf(event));
			if (callOf(event) === failOn) throw new Error("listener failed");
		});
		buffer.enqueue(toolUpdate("a"));
		buffer.enqueue(toolUpdate("b"));

		assert.throws(() => buffer.flush(), /listener failed/);
		failOn = undefined;
		buffer.flush();

		assert.deepEqual(emitted, ["a", "b"]);
	});

	test("an emit that drains the buffer takes only the updates it has not delivered (#6107)", () => {
		const emitted: string[] = [];
		const drained: string[] = [];
		const buffer = new RpcEventBuffer((event) => {
			emitted.push(callOf(event));
			// A listener that stops the client while it handles an update: the stop drains what is left.
			if (callOf(event) === "a") drained.push(...buffer.drain().map(callOf));
		});
		buffer.enqueue(toolUpdate("a"));
		buffer.enqueue(toolUpdate("b"));
		buffer.enqueue(toolUpdate("c"));

		buffer.flush();

		assert.deepEqual(emitted, ["a"]);
		assert.deepEqual(drained, ["b", "c"]);
	});
});
