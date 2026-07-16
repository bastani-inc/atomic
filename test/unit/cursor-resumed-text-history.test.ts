import { test } from "bun:test";
import assert from "node:assert/strict";
import { fromBinary } from "@bufbuild/protobuf";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { CursorProtobufProtocolCodec } from "../../packages/cursor/src/proto/protobuf-codec.js";
import { AgentClientMessageSchema } from "../../packages/cursor/src/proto/agent_pb.js";
import { cursorProtoTest } from "./cursor-proto-test-helpers.js";

function makeKvBlobGetFrame(id: number, blobId: Uint8Array): Uint8Array {
	return cursorProtoTest.encodeMessageField(4, cursorProtoTest.concatBytes(
		cursorProtoTest.encodeVarintField(1, BigInt(id)),
		cursorProtoTest.encodeMessageField(2, cursorProtoTest.encodeMessageField(1, blobId)),
	));
}

function readRunBlob(codec: CursorProtobufProtocolCodec, requestId: string, blobId: Uint8Array, id: number): Uint8Array {
	const request = codec.decodeRunFrame({ flags: 0, data: makeKvBlobGetFrame(id, blobId), endStream: false })[0];
	assert.ok(request);
	const response = codec.encodeServerResponse(request, requestId);
	assert.ok(response);
	const client = cursorProtoTest.readFields(response).find((field) => field.fieldNumber === 3)?.value;
	assert.ok(client instanceof Uint8Array);
	const result = cursorProtoTest.readFields(client).find((field) => field.fieldNumber === 2)?.value;
	assert.ok(result instanceof Uint8Array);
	const blob = cursorProtoTest.readFields(result).find((field) => field.fieldNumber === 1)?.value;
	assert.ok(blob instanceof Uint8Array);
	return blob;
}

const model: Model<Api> = {
	id: "composer-2", name: "Composer 2", provider: "cursor", api: "cursor-agent", baseUrl: "https://api2.cursor.sh",
	input: ["text"], reasoning: false, contextWindow: 200_000, maxTokens: 64_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

test("resumed Cursor requests expose ordinary text history through root prompt blobs", () => {
	const codec = new CursorProtobufProtocolCodec();
	const requestId = "request-resumed-text-history";
	const encoded = codec.encodeRunRequest({
		accessToken: "test-access", requestId, model, resolvedModelId: model.id,
		context: {
			systemPrompt: "system prompt",
			messages: [
				{ role: "user", content: "The continuity code is VIOLET RIVER 83.", timestamp: 1 },
				{ role: "assistant", content: [{ type: "text", text: "ACK" }], api: "cursor-agent", provider: "cursor", model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 },
				{ role: "user", content: "What is the continuity code?", timestamp: 3 },
			],
		},
	});
	const decoded = fromBinary(AgentClientMessageSchema, encoded);
	assert.equal(decoded.message.case, "runRequest");
	if (decoded.message.case !== "runRequest") throw new Error("expected run request");
	const state = decoded.message.value.conversationState;
	assert.ok(state);
	const history = state.rootPromptMessagesJson.map((blobId, index) =>
		JSON.parse(new TextDecoder().decode(readRunBlob(codec, requestId, blobId, index + 1))),
	);
	assert.deepEqual(history, [
		{ role: "system", content: "system prompt" },
		{ role: "user", content: "The continuity code is VIOLET RIVER 83." },
		{ role: "assistant", content: "ACK" },
	]);
});
