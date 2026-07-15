import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { CursorProtobufProtocolCodec } from "../../packages/cursor/src/transport.js";
import { cursorProtoTest } from "./cursor-proto-test-helpers.js";

function bytesField(fields: ReturnType<typeof cursorProtoTest.readFields>, fieldNumber: number): Uint8Array {
	const value = fields.find((field) => field.fieldNumber === fieldNumber)?.value;
	assert.ok(value instanceof Uint8Array, `expected length-delimited field ${fieldNumber}`);
	return value;
}

function stringField(fields: ReturnType<typeof cursorProtoTest.readFields>, fieldNumber: number): string {
	return cursorProtoTest.decodeString(bytesField(fields, fieldNumber));
}

function boolField(fields: ReturnType<typeof cursorProtoTest.readFields>, fieldNumber: number): boolean {
	const value = fields.find((field) => field.fieldNumber === fieldNumber)?.value;
	if (value === undefined) return false;
	assert.equal(typeof value, "bigint", `expected varint field ${fieldNumber}`);
	return value !== 0n;
}

// Field numbers are pinned independently from oh-my-pi commit
// 1f619dcf18a68527176b619d40e84d492ca74e83 (`agent.proto` and Cursor request
// construction). These helpers write/read raw protobuf wire bytes and never use
// Atomic's or upstream's generated message schemas.
function manualModelDetails(id: string, displayName: string, maxMode: boolean): Uint8Array {
	return cursorProtoTest.concatBytes(
		cursorProtoTest.encodeStringField(1, id),
		cursorProtoTest.encodeStringField(4, displayName),
		cursorProtoTest.encodeVarintField(7, maxMode ? 1n : 0n),
	);
}

function model(id: string): Model<Api> {
	return {
		id,
		name: id,
		provider: "cursor",
		api: "cursor-agent",
		baseUrl: "https://api2.cursor.sh",
		input: ["text"],
		reasoning: false,
		contextWindow: 200_000,
		maxTokens: 64_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

function assertManualRunWire(id: string, maxMode: boolean): void {
	const encoded = new CursorProtobufProtocolCodec().encodeRunRequest({
		accessToken: "test-secret",
		requestId: `request-${id}`,
		model: model(id),
		resolvedModelId: id,
		maxMode,
		context: { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
	});
	const clientFields = cursorProtoTest.readFields(encoded);
	assert.deepEqual(clientFields.map((field) => field.fieldNumber), [1]);
	const runFields = cursorProtoTest.readFields(bytesField(clientFields, 1));
	const modelDetails = cursorProtoTest.readFields(bytesField(runFields, 3));
	const requestedModel = cursorProtoTest.readFields(bytesField(runFields, 9));
	assert.equal(stringField(modelDetails, 1), id);
	assert.equal(stringField(requestedModel, 1), id);
	assert.equal(boolField(modelDetails, 7), maxMode);
	assert.equal(boolField(requestedModel, 2), maxMode);
	assert.equal(requestedModel.some((field) => field.fieldNumber === 3), false);
}

describe("Cursor independent protobuf wire contracts", () => {
	test("decodes manually assembled GetUsable exact IDs, display names, and Max state", () => {
		const fixture = cursorProtoTest.concatBytes(
			cursorProtoTest.encodeMessageField(1, manualModelDetails("cursor-grok-4.5-high", "Grok 4.5 High", true)),
			cursorProtoTest.encodeMessageField(1, manualModelDetails("cursor-grok-4.5-low", "Grok 4.5 Low", false)),
		);
		assert.deepEqual(new CursorProtobufProtocolCodec().decodeGetUsableModelsResponse(fixture), [
			{ id: "cursor-grok-4.5-high", displayName: "Grok 4.5 High", maxMode: true },
			{ id: "cursor-grok-4.5-low", displayName: "Grok 4.5 Low", maxMode: false },
		]);
	});

	test("manually inspects exact dual IDs, dual Max, and absent parameters", () => {
		assertManualRunWire("cursor-grok-4.5-high", true);
		assertManualRunWire("cursor-grok-4.5-low", false);
	});
});
