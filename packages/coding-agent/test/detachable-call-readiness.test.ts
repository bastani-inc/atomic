import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, test } from "vitest";
import { markToolCallReadyForDetachment } from "../src/core/agent-session-detached-tools.ts";
import type { ToolDefinition } from "../src/core/extensions/index.ts";
import { harnessPool } from "./helpers/detached-tools.ts";

const pool = harnessPool();
afterEach(() => pool.cleanup());

test("a detachable call remains in its session until its durable handoff is ready (#4326)", async () => {
	const started = Promise.withResolvers<AbortSignal>();
	const result = Promise.withResolvers<{ content: [{ type: "text"; text: string }]; details: undefined }>();
	const tool: ToolDefinition = {
		name: "ask_peer",
		label: "Ask peer",
		description: "Asks a peer",
		parameters: Type.Object({}),
		detachable: true,
		detachmentRequiresReady: true,
		execute: async (_id, _params, signal) => {
			assert.ok(signal);
			started.resolve(signal);
			return result.promise;
		},
	};
	const harness = await pool.harnessWith([tool]);
	harness.session.setToolDetachment({ afterMs: 0 });
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("ask_peer", {}, { id: "ask-1" })], { stopReason: "toolUse" }),
	]);
	let runEnded = false;
	const run = harness.session.prompt("ask").then(() => {
		runEnded = true;
	});
	const signal = await started.promise;
	await new Promise((resolve) => setTimeout(resolve, 0));
	try {
		assert.equal(runEnded, false, "the call may not detach before its handoff is ready");
	} finally {
		markToolCallReadyForDetachment(signal);
	}
	await run;
	const detached = harness.session.takeDetachedToolCalls();
	assert.deepEqual(
		detached.map((call) => call.toolCallId),
		["ask-1"],
	);
	result.resolve({ content: [{ type: "text", text: "answer" }], details: undefined });
	assert.deepEqual((await detached[0]?.result)?.result.content, [{ type: "text", text: "answer" }]);
});

test("a call that fails before its handoff is ready returns its failure inline (#4326)", async () => {
	const started = Promise.withResolvers<void>();
	const failure = Promise.withResolvers<{
		content: [{ type: "text"; text: string }];
		details: undefined;
		isError: true;
	}>();
	const tool: ToolDefinition = {
		name: "ask_peer",
		label: "Ask peer",
		description: "Asks a peer",
		parameters: Type.Object({}),
		detachable: true,
		detachmentRequiresReady: true,
		execute: async () => {
			started.resolve();
			return failure.promise;
		},
	};
	const harness = await pool.harnessWith([tool]);
	harness.session.setToolDetachment({ afterMs: 0 });
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("ask_peer", {}, { id: "ask-1" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("not sent"),
	]);
	const run = harness.session.prompt("ask");
	await started.promise;
	await new Promise((resolve) => setTimeout(resolve, 0));
	failure.resolve({ content: [{ type: "text", text: "not delivered" }], details: undefined, isError: true });
	await run;
	assert.deepEqual(harness.session.takeDetachedToolCalls(), []);
	const toolResult = harness.sessionManager
		.buildSessionProjection()
		.messages.find((message) => message.role === "toolResult");
	assert.equal(toolResult?.role === "toolResult" && toolResult.isError, true);
});
