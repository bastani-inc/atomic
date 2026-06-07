import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { Agent, type AgentEvent, type AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

const emptyUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function createToolCallMessage() {
	return {
		role: "assistant" as const,
		content: [{ type: "toolCall" as const, id: "call-1", name: "delayed_tool", arguments: {} }],
		api: "test",
		provider: "test",
		model: "test",
		usage: emptyUsage,
		stopReason: "toolUse" as const,
		timestamp: Date.now(),
	};
}

function createAgentWithTool(input: {
	execute: (onUpdate?: AgentToolUpdateCallback<{ status: string }>) => Promise<void> | void;
}) {
	let streamCalls = 0;
	const agent = new Agent({
		streamFn: async () => ({
			async *[Symbol.asyncIterator]() {
				yield { type: "done" };
			},
			async result() {
				streamCalls++;
				if (streamCalls === 1) return createToolCallMessage();
				return {
					role: "assistant" as const,
					content: [{ type: "text" as const, text: "done" }],
					api: "test",
					provider: "test",
					model: "test",
					usage: emptyUsage,
					stopReason: "stop" as const,
					timestamp: Date.now(),
				};
			},
		}) as never,
		initialState: {
			tools: [{
				name: "delayed_tool",
				label: "Delayed Tool",
				description: "Streams updates for lifecycle tests",
				parameters: Type.Object({}),
				execute: async (_toolCallId, _params, _signal, onUpdate) => {
					await input.execute(onUpdate);
					return {
						content: [{ type: "text", text: "ok" }],
						details: { status: "done" },
						terminate: true,
					};
				},
			}],
		},
	});
	return agent;
}

describe("pi-agent-core late tool progress lifecycle guard", () => {
	test("emits active onUpdate as tool_execution_update", async () => {
		const events: AgentEvent[] = [];
		const agent = createAgentWithTool({
			execute: (onUpdate) => {
				onUpdate?.({
					content: [{ type: "text", text: "running" }],
					details: { status: "running" },
				});
			},
		});
		agent.subscribe((event) => {
			events.push(event);
		});

		await agent.prompt("run");

		const updates = events.filter((event) => event.type === "tool_execution_update");
		assert.equal(updates.length, 1);
		assert.deepEqual(updates[0]!.partialResult.details, { status: "running" });
	});

	test("drops delayed onUpdate after tool settlement without unhandled rejection", async () => {
		const events: AgentEvent[] = [];
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown) => {
			unhandled.push(error);
		};
		let delayedUpdate: AgentToolUpdateCallback<{ status: string }> | undefined;
		const agent = createAgentWithTool({
			execute: (onUpdate) => {
				delayedUpdate = onUpdate;
			},
		});
		agent.subscribe((event) => {
			events.push(event);
		});
		process.on("unhandledRejection", onUnhandled);
		try {
			await agent.prompt("run");
			const eventCountAfterPrompt = events.length;

			assert.doesNotThrow(() => delayedUpdate?.({
				content: [{ type: "text", text: "late" }],
				details: { status: "late" },
			}));
			await new Promise((resolve) => setTimeout(resolve, 0));

			assert.equal(events.length, eventCountAfterPrompt);
			assert.deepEqual(unhandled, []);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
