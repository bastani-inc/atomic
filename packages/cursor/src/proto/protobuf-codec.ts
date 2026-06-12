import { createCursorExperimentalProtocolError, readNumberField, readStringField } from "../config.js";
import type { CursorUsableModel } from "../model-mapper.js";
import type { CursorConnectFrame, CursorDoneReason, CursorProtocolCodec, CursorRunRequest, CursorServerMessage } from "../transport.js";

// Minimal Cursor protobuf codec derived from protocol field numbers documented from
// MIT-licensed ndraiman/pi-cursor-provider and ephraimduncan/opencode-cursor.
// Keep all private Cursor wire-format handling isolated in this module.

type WireField = { readonly fieldNumber: number; readonly wireType: number; readonly value: bigint | Uint8Array };

const WIRE_VARINT = 0;
const WIRE_LENGTH_DELIMITED = 2;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class CursorProtobufProtocolCodec implements CursorProtocolCodec {
	encodeGetUsableModelsRequest(): Uint8Array {
		return new Uint8Array();
	}

	decodeGetUsableModelsResponse(data: Uint8Array): readonly CursorUsableModel[] {
		try {
			return readFields(data).flatMap((field) => {
				if (field.fieldNumber !== 1 || !(field.value instanceof Uint8Array)) return [];
				const model = decodeModelDetails(field.value);
				return model ? [model] : [];
			});
		} catch (error) {
			throw createCursorExperimentalProtocolError(`Cursor protobuf GetUsableModels decoding failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	encodeRunRequest(request: CursorRunRequest): Uint8Array {
		const modelDetails = encodeMessageField(3, encodeModelDetails(request.resolvedModelId, request.model.name ?? request.resolvedModelId));
		const conversationId = encodeStringField(5, request.requestId);
		const customSystemPrompt = request.context.systemPrompt ? encodeStringField(8, request.context.systemPrompt) : new Uint8Array();
		const userText = extractLastUserText(request);
		const action = userText ? encodeMessageField(2, encodeUserMessageAction(userText, request.requestId)) : new Uint8Array();
		const runRequest = concatBytes(action, modelDetails, conversationId, customSystemPrompt);
		return encodeMessageField(1, runRequest);
	}

	decodeRunFrame(frame: CursorConnectFrame): readonly CursorServerMessage[] {
		try {
			return decodeAgentServerMessage(frame.data);
		} catch (error) {
			throw createCursorExperimentalProtocolError(`Cursor protobuf Run decoding failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	encodeCancelRequest(): Uint8Array {
		// AgentClientMessage.conversation_action = 4 -> ConversationAction.cancel_action = 3 -> CancelAction {}
		return encodeMessageField(4, encodeMessageField(3, new Uint8Array()));
	}

	encodeHeartbeatRequest(): Uint8Array {
		// AgentClientMessage.client_heartbeat = 7 -> ClientHeartbeat {}
		return encodeMessageField(7, new Uint8Array());
	}
}

function decodeModelDetails(data: Uint8Array): CursorUsableModel | undefined {
	let id: string | undefined;
	let displayName: string | undefined;
	let contextWindow: number | undefined;
	let maxTokens: number | undefined;
	let supportsThinking = false;
	let maxMode = false;
	for (const field of readFields(data)) {
		if (field.fieldNumber === 1 && field.value instanceof Uint8Array) id = decodeString(field.value);
		else if (field.fieldNumber === 4 && field.value instanceof Uint8Array) displayName = decodeString(field.value);
		else if (field.fieldNumber === 2 && field.value instanceof Uint8Array) supportsThinking = true;
		else if (field.fieldNumber === 7 && typeof field.value === "bigint") maxMode = field.value !== 0n;
		else if (field.fieldNumber === 11 && typeof field.value === "bigint") contextWindow = Number(field.value);
		else if (field.fieldNumber === 12 && typeof field.value === "bigint") maxTokens = Number(field.value);
	}
	if (!id) return undefined;
	return { id, displayName, supportsThinking, supportsReasoning: supportsThinking || maxMode, contextWindow, maxTokens };
}

function decodeAgentServerMessage(data: Uint8Array): readonly CursorServerMessage[] {
	const messages: CursorServerMessage[] = [];
	for (const field of readFields(data)) {
		if (field.fieldNumber === 1 && field.value instanceof Uint8Array) {
			messages.push(...decodeInteractionUpdate(field.value));
		}
		if (field.fieldNumber === 3 && field.value instanceof Uint8Array) {
			const usage = decodeCheckpointUsage(field.value);
			if (usage) messages.push(usage);
		}
	}
	return messages;
}

function decodeInteractionUpdate(data: Uint8Array): readonly CursorServerMessage[] {
	const messages: CursorServerMessage[] = [];
	for (const field of readFields(data)) {
		if (field.fieldNumber === 1 && field.value instanceof Uint8Array) messages.push({ type: "textDelta", text: decodeTextFieldMessage(field.value) });
		else if (field.fieldNumber === 4 && field.value instanceof Uint8Array) messages.push({ type: "thinkingDelta", text: decodeTextFieldMessage(field.value) });
		else if (field.fieldNumber === 8 && field.value instanceof Uint8Array) messages.push({ type: "usage", inputTokens: 0, outputTokens: decodeTokenDelta(field.value) });
		else if (field.fieldNumber === 14 && field.value instanceof Uint8Array) messages.push({ type: "done", reason: "stop" satisfies CursorDoneReason });
		else if ((field.fieldNumber === 2 || field.fieldNumber === 7 || field.fieldNumber === 15) && field.value instanceof Uint8Array) {
			const tool = decodeToolLikeUpdate(field.value);
			if (tool) messages.push(tool);
		}
	}
	return messages;
}

function decodeTextFieldMessage(data: Uint8Array): string {
	for (const field of readFields(data)) {
		if (field.fieldNumber === 1 && field.value instanceof Uint8Array) return decodeString(field.value);
	}
	return "";
}

function decodeTokenDelta(data: Uint8Array): number {
	for (const field of readFields(data)) {
		if (field.fieldNumber === 1 && typeof field.value === "bigint") return Number(field.value);
	}
	return 0;
}

function decodeCheckpointUsage(data: Uint8Array): CursorServerMessage | undefined {
	for (const field of readFields(data)) {
		if (field.value instanceof Uint8Array) {
			const nested = Object.fromEntries(readFields(field.value).flatMap((nestedField) => typeof nestedField.value === "bigint" ? [[nestedField.fieldNumber, Number(nestedField.value)]] : []));
			const inputTokens = readNumberField(nested, "1") ?? 0;
			const outputTokens = readNumberField(nested, "2") ?? 0;
			if (inputTokens || outputTokens) return { type: "usage", inputTokens, outputTokens };
		}
	}
	return undefined;
}

function decodeToolLikeUpdate(data: Uint8Array): CursorServerMessage | undefined {
	let id = "cursor-tool";
	let name = "cursor_tool";
	let args = "{}";
	for (const field of readFields(data)) {
		if (field.fieldNumber === 1 && field.value instanceof Uint8Array) id = decodeString(field.value) || id;
		if (field.value instanceof Uint8Array) {
			const maybeText = decodeString(field.value);
			if (field.fieldNumber === 2 && maybeText) name = readStringField({ value: maybeText }, "value") ?? maybeText;
			if ((field.fieldNumber === 3 || field.fieldNumber === 4) && maybeText) args = maybeText;
		}
	}
	return { type: "toolCall", id, name, argumentsJson: args };
}

function encodeUserMessageAction(text: string, requestId: string): Uint8Array {
	// AgentRunRequest.action = 2 -> ConversationAction.user_message_action = 1 -> UserMessageAction.user_message = 1 -> UserMessage { text = 1, message_id = 2 }
	const userMessage = concatBytes(encodeStringField(1, text), encodeStringField(2, `${requestId}-user`));
	return encodeMessageField(1, encodeMessageField(1, userMessage));
}

function extractLastUserText(request: CursorRunRequest): string {
	for (const message of [...request.context.messages].reverse()) {
		if (message.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		const text = message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
		if (text) return text;
	}
	return "";
}

function encodeModelDetails(modelId: string, displayName: string): Uint8Array {
	return concatBytes(encodeStringField(1, modelId), encodeStringField(4, displayName));
}

function readFields(data: Uint8Array): readonly WireField[] {
	const fields: WireField[] = [];
	let offset = 0;
	while (offset < data.length) {
		const tag = readVarint(data, offset);
		offset = tag.offset;
		const fieldNumber = Number(tag.value >> 3n);
		const wireType = Number(tag.value & 0x7n);
		if (fieldNumber <= 0) throw new Error("invalid field number");
		if (wireType === WIRE_VARINT) {
			const value = readVarint(data, offset);
			offset = value.offset;
			fields.push({ fieldNumber, wireType, value: value.value });
		} else if (wireType === WIRE_LENGTH_DELIMITED) {
			const length = readVarint(data, offset);
			offset = length.offset;
			const end = offset + Number(length.value);
			if (end > data.length) throw new Error("truncated length-delimited field");
			fields.push({ fieldNumber, wireType, value: data.slice(offset, end) });
			offset = end;
		} else {
			throw new Error(`unsupported wire type ${wireType}`);
		}
	}
	return fields;
}

function readVarint(data: Uint8Array, startOffset: number): { readonly value: bigint; readonly offset: number } {
	let result = 0n;
	let shift = 0n;
	let offset = startOffset;
	while (offset < data.length) {
		const byte = data[offset++] ?? 0;
		result |= BigInt(byte & 0x7f) << shift;
		if ((byte & 0x80) === 0) return { value: result, offset };
		shift += 7n;
		if (shift > 63n) throw new Error("varint too long");
	}
	throw new Error("truncated varint");
}

function encodeStringField(fieldNumber: number, value: string): Uint8Array {
	return encodeLengthDelimitedField(fieldNumber, textEncoder.encode(value));
}

function encodeMessageField(fieldNumber: number, value: Uint8Array): Uint8Array {
	return encodeLengthDelimitedField(fieldNumber, value);
}

function encodeLengthDelimitedField(fieldNumber: number, value: Uint8Array): Uint8Array {
	return concatBytes(encodeVarint(BigInt((fieldNumber << 3) | WIRE_LENGTH_DELIMITED)), encodeVarint(BigInt(value.length)), value);
}

function encodeVarint(value: bigint): Uint8Array {
	const bytes: number[] = [];
	let current = value;
	do {
		let byte = Number(current & 0x7fn);
		current >>= 7n;
		if (current !== 0n) byte |= 0x80;
		bytes.push(byte);
	} while (current !== 0n);
	return new Uint8Array(bytes);
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
	const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.length;
	}
	return output;
}

function decodeString(data: Uint8Array): string {
	return textDecoder.decode(data);
}

export const __cursorProtoTest = { encodeStringField, encodeMessageField, concatBytes };
