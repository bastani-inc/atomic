import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { fromBinary } from "@bufbuild/protobuf";
import type { Context } from "@earendil-works/pi-ai/compat";
import {
	AgentClientMessageSchema,
	ConversationStepSchema,
	ConversationTurnStructureSchema,
	UserMessageSchema,
} from "../../packages/cursor/src/proto/cursor-protocol.js";
import { parseHistoricalTurns } from "../../packages/cursor/src/proto/protobuf-codec-request.js";
import { CursorProtobufProtocolCodec } from "../../packages/cursor/src/transport.js";
import { cursorProtoTest } from "./cursor-proto-test-helpers.js";
import { model } from "./cursor-stream-helpers.js";
import { cursorRouteReference } from "./cursor-test-helpers.js";

const assistantBase = {
	api: "cursor-agent" as const,
	provider: "cursor",
	model: "composer-2",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "toolUse" as const,
	timestamp: 2,
};

function history(): Context {
	return { messages: [
		{ role: "user", content: [{ type: "text", text: "before" }, { type: "image", data: "not-base64", mimeType: "image/png" }, { type: "text", text: "after" }], timestamp: 1 },
		{ role: "assistant", content: [
			{ type: "thinking", thinking: "verified thought" },
			{ type: "text", text: "answer" },
			{ type: "toolCall", id: "repeat", name: "Read", arguments: { path: "one" } },
			{ type: "toolCall", id: "repeat", name: "Read", arguments: { path: "two" } },
		], ...assistantBase },
		{ role: "toolResult", toolCallId: "repeat", toolName: "Read", content: [{ type: "text", text: "first" }], isError: false, timestamp: 3 },
		{ role: "toolResult", toolCallId: "orphan", toolName: "Read", content: [{ type: "text", text: "orphan" }, { type: "image", data: "not-base64", mimeType: "image/png" }, { type: "text", text: " result" }], isError: false, timestamp: 4 },
		{ role: "toolResult", toolCallId: "repeat", toolName: "Read", content: [{ type: "text", text: "second" }], isError: false, timestamp: 5 },
		{ role: "user", content: "continue", timestamp: 6 },
	] };
}

function readBlob(codec: CursorProtobufProtocolCodec, requestId: string, blobId: Uint8Array): Uint8Array {
	const frame = cursorProtoTest.encodeMessageField(4, cursorProtoTest.concatBytes(
		cursorProtoTest.encodeVarintField(1, 7n),
		cursorProtoTest.encodeMessageField(2, cursorProtoTest.encodeMessageField(1, blobId)),
	));
	const control = codec.decodeRunFrame({ flags: 0, data: frame, endStream: false })[0];
	assert.ok(control);
	const response = codec.encodeServerResponse(control, requestId);
	assert.ok(response);
	const kv = cursorProtoTest.readFields(response).find((field) => field.fieldNumber === 3)?.value;
	const result = kv instanceof Uint8Array ? cursorProtoTest.readFields(kv).find((field) => field.fieldNumber === 2)?.value : undefined;
	const bytes = result instanceof Uint8Array ? cursorProtoTest.readFields(result).find((field) => field.fieldNumber === 1)?.value : undefined;
	assert.ok(bytes instanceof Uint8Array);
	return bytes;
}

describe("Cursor canonical Atomic history", () => {
	test("preserves thinking/text/tool order and orphan text results without synthetic calls", () => {
		const parsed = parseHistoricalTurns(history().messages.slice(0, -1));
		assert.equal(parsed.length, 1);
		assert.deepEqual(parsed[0]?.steps.map((step) => step.kind), ["assistantThinking", "assistantText", "toolCall", "toolCall", "assistantText"]);
		const calls = parsed[0]?.steps.filter((step) => step.kind === "toolCall") ?? [];
		assert.deepEqual(calls.map((call) => call.result?.content), ["first", "second"]);
		const orphan = parsed[0]?.steps[4];
		assert.equal(orphan?.kind, "assistantText");
		if (orphan?.kind === "assistantText") assert.equal(orphan.text, "orphan result");
	});

	test("preserves empty assistant text and thinking blocks in canonical wire order", () => {
		const context: Context = { messages: [
			{ role: "user", content: "prior", timestamp: 1 },
			{ role: "assistant", content: [
				{ type: "text", text: "" },
				{ type: "thinking", thinking: "" },
				{ type: "text", text: "after" },
				{ type: "thinking", thinking: "later" },
			], ...assistantBase },
			{ role: "user", content: "current", timestamp: 3 },
		] };
		const parsed = parseHistoricalTurns(context.messages.slice(0, -1));
		assert.deepEqual(parsed[0]?.steps, [
			{ kind: "assistantText", text: "" },
			{ kind: "assistantThinking", text: "" },
			{ kind: "assistantText", text: "after" },
			{ kind: "assistantThinking", text: "later" },
		]);
		const codec = new CursorProtobufProtocolCodec();
		const requestId = "empty-history-blocks";
		const encoded = codec.encodeRunRequest({ accessToken: "secret", requestId, model: model(), routeReference: cursorRouteReference(), context });
		const message = fromBinary(AgentClientMessageSchema, encoded).message;
		if (message.case !== "runRequest") throw new Error("expected run request");
		const run = message.value;
		const turn = fromBinary(ConversationTurnStructureSchema, readBlob(codec, requestId, run.conversationState?.turns[0] ?? new Uint8Array())).turn;
		if (turn.case !== "agentConversationTurn") throw new Error("expected historical agent turn");
		const steps = turn.value.steps.map((blobId) => fromBinary(ConversationStepSchema, readBlob(codec, requestId, blobId)).message);
		assert.deepEqual(steps.map((step) => step.case), ["assistantMessage", "thinkingMessage", "assistantMessage", "thinkingMessage"]);
		assert.deepEqual(steps.map((step) => {
			if (step.case === "assistantMessage" || step.case === "thinkingMessage") return step.value.text;
			throw new Error("expected text or thinking history step");
		}), ["", "", "after", "later"]);
	});

	test("retains an empty text-image-text historical user turn", () => {
		const parsed = parseHistoricalTurns([
			{ role: "user", content: [
				{ type: "text", text: "" },
				{ type: "image", data: "not-base64", mimeType: "image/png" },
				{ type: "text", text: "" },
			], timestamp: 1 },
		]);
		assert.deepEqual(parsed, [{ userText: "", steps: [] }]);
	});

	test("fresh codec rebuilds historical ThinkingMessage and text-only user/tool history", () => {
		const codec = new CursorProtobufProtocolCodec();
		const requestId = "canonical-history";
		const encoded = codec.encodeRunRequest({ accessToken: "secret", requestId, model: model(), routeReference: cursorRouteReference(), context: history() });
		const message = fromBinary(AgentClientMessageSchema, encoded).message;
		assert.equal(message.case, "runRequest");
		if (message.case !== "runRequest") return;
		const action = message.value.action?.action;
		assert.equal(action?.case, "userMessageAction");
		if (action?.case !== "userMessageAction") return;
		assert.equal(action.value.userMessage?.text, "continue");
		const turn = fromBinary(ConversationTurnStructureSchema, readBlob(codec, requestId, message.value.conversationState?.turns[0] ?? new Uint8Array())).turn;
		assert.equal(turn.case, "agentConversationTurn");
		if (turn.case !== "agentConversationTurn") return;
		const priorUser = fromBinary(UserMessageSchema, readBlob(codec, requestId, turn.value.userMessage));
		assert.equal(priorUser.text, "beforeafter");
		assert.deepEqual(priorUser.selectedContext?.selectedImages, []);
		const steps = turn.value.steps.map((blobId) => fromBinary(ConversationStepSchema, readBlob(codec, requestId, blobId)));
		assert.deepEqual(steps.map((step) => step.message.case), ["thinkingMessage", "assistantMessage", "toolCall", "toolCall", "assistantMessage"]);
		const thinking = steps[0]?.message;
		const assistant = steps[1]?.message;
		assert.equal(thinking?.case, "thinkingMessage");
		assert.equal(assistant?.case, "assistantMessage");
		if (thinking?.case !== "thinkingMessage" || assistant?.case !== "assistantMessage") return;
		assert.equal(thinking.value.text, "verified thought");
		assert.equal(assistant.value.text, "answer");
		const results = steps.slice(2, 4).map((step) => {
			const message = step.message;
			assert.equal(message.case, "toolCall");
			if (message.case !== "toolCall" || message.value.tool.case !== "mcpToolCall") throw new Error("expected MCP tool history step");
			const result = message.value.tool.value.result?.result;
			if (!result) throw new Error("expected MCP tool result history");
			if (result.case !== "success") throw new Error("expected MCP tool success history");
			const content = result.value.content[0]?.content;
			if (content?.case !== "text") throw new Error("expected text-only MCP history");
			return content.value.text;
		});
		assert.deepEqual(results, ["first", "second"]);
		const orphan = steps[4]?.message;
		assert.equal(orphan?.case, "assistantMessage");
		if (orphan?.case === "assistantMessage") assert.equal(orphan.value.text, "orphan result");
	});
});
