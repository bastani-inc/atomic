import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, test } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/index.ts";
import { harnessPool, toolResultIds } from "./helpers/detached-tools.ts";

const pool = harnessPool();
afterEach(() => pool.cleanup());

function textResult(text: string): AgentToolResult {
	return { content: [{ type: "text", text }], details: undefined };
}

async function turns(count: number): Promise<void> {
	for (let turn = 0; turn < count; turn++) await new Promise((resolve) => setImmediate(resolve));
}

describe("a detachable call keeps its session's tool order (#4326)", () => {
	test("an exclusive detachable call starts only after the earlier call of its message has finished", async () => {
		const events: string[] = [];
		const build = Promise.withResolvers<AgentToolResult>();
		const builder: ToolDefinition = {
			name: "build",
			label: "Build",
			description: "Builds the project",
			parameters: Type.Object({}),
			execute: async () => {
				events.push("build started");
				const result = await build.promise;
				events.push("build finished");
				return result;
			},
		};
		const waiter: ToolDefinition = {
			name: "wait_for_build",
			label: "Wait for build",
			description: "Waits for the build's artifacts",
			parameters: Type.Object({}),
			concurrency: "exclusive",
			detachable: true,
			execute: async () => {
				events.push("wait started");
				return new Promise<AgentToolResult>(() => {});
			},
		};
		const harness = await pool.harnessWith([builder, waiter]);
		harness.session.setToolDetachment({ afterMs: 0 });
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("build", {}, { id: "b-1" }), fauxToolCall("wait_for_build", {}, { id: "w-1" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("never requested"),
		]);

		const run = harness.session.prompt("build, then wait for it");
		for (let turn = 0; turn < 50 && events.length === 0; turn++) await turns(1);
		await turns(20);
		try {
			assert.deepEqual(events, ["build started"], "the exclusive call waits for the call before it");
		} finally {
			build.resolve(textResult("built"));
		}
		await run;

		assert.deepEqual(events, ["build started", "build finished", "wait started"]);
		const detached = harness.session.takeDetachedToolCalls();
		assert.deepEqual(
			detached.map((call) => call.toolCallId),
			["w-1"],
		);
		assert.deepEqual(toolResultIds(harness.sessionManager), ["b-1"]);
		for (const call of detached) call.abort("test over");
	});
});
