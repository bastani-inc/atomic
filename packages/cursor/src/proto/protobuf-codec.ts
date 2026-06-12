import { createCursorExperimentalProtocolError, type JsonObject, type JsonValue } from "../config.js";
import type { CursorUsableModel } from "../model-mapper.js";
import type { CursorConnectFrame, CursorDoneReason, CursorProtocolCodec, CursorRunRequest, CursorServerMessage, CursorToolResultMessage } from "../transport.js";

// Minimal Cursor protobuf codec derived from protocol field numbers documented from
// MIT-licensed ndraiman/pi-cursor-provider and ephraimduncan/opencode-cursor.
// Keep all private Cursor wire-format handling isolated in this module.

type WireField = { readonly fieldNumber: number; readonly wireType: number; readonly value: bigint | Uint8Array | number };

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH_DELIMITED = 2;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const strictTextDecoder = new TextDecoder("utf-8", { fatal: true });

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
		const conversationId = encodeStringField(5, request.conversationId ?? request.requestId);
		const customSystemPrompt = request.context.systemPrompt ? encodeStringField(8, request.context.systemPrompt) : new Uint8Array();
		const conversationState = encodeConversationState(request);
		const tools = encodeMcpTools(request);
		const userText = extractCurrentActionText(request);
		const action = userText ? encodeMessageField(2, encodeUserMessageAction(userText, request.requestId)) : new Uint8Array();
		const runRequest = concatBytes(conversationState, action, modelDetails, tools, conversationId, customSystemPrompt);
		return encodeMessageField(1, runRequest);
	}

	decodeRunFrame(frame: CursorConnectFrame): readonly CursorServerMessage[] {
		try {
			return decodeAgentServerMessage(frame.data);
		} catch (error) {
			throw createCursorExperimentalProtocolError(`Cursor protobuf Run decoding failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	encodeToolResult(result: CursorToolResultMessage): Uint8Array {
		return encodeMcpToolResult(result);
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
		if (field.fieldNumber === 2 && field.value instanceof Uint8Array) {
			messages.push(...decodeExecServerMessage(field.value));
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
		else if (field.fieldNumber === 8 && field.value instanceof Uint8Array) messages.push({ type: "usage", kind: "outputDelta", outputTokens: decodeTokenDelta(field.value) });
		else if (field.fieldNumber === 14 && field.value instanceof Uint8Array) messages.push({ type: "done", reason: "stop" satisfies CursorDoneReason });
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
		if (field.fieldNumber !== 5 || !(field.value instanceof Uint8Array)) continue;
		let usedTokens: number | undefined;
		for (const tokenField of readFields(field.value)) {
			if (tokenField.fieldNumber === 1 && typeof tokenField.value === "bigint") usedTokens = Number(tokenField.value);
		}
		if (usedTokens !== undefined) return { type: "usage", kind: "checkpoint", usedTokens };
	}
	return undefined;
}

function decodeExecServerMessage(data: Uint8Array): readonly CursorServerMessage[] {
	let execNumericId: number | undefined;
	let execId: string | undefined;
	const mcpPayloads: Uint8Array[] = [];
	const nonMcpFieldNumbers: number[] = [];
	for (const field of readFields(data)) {
		if (field.fieldNumber === 1 && typeof field.value === "bigint") execNumericId = Number(field.value);
		else if (field.fieldNumber === 15 && field.value instanceof Uint8Array) execId = decodeString(field.value);
		else if (field.fieldNumber === 11 && field.value instanceof Uint8Array) mcpPayloads.push(field.value);
		else if (field.fieldNumber !== 1 && field.fieldNumber !== 11 && field.fieldNumber !== 15) nonMcpFieldNumbers.push(field.fieldNumber);
	}
	return [
		...mcpPayloads.map((payload) => decodeMcpArgs(payload, execId, execNumericId)),
		...nonMcpFieldNumbers.map((fieldNumber) => ({
			type: "nonMcpExec" as const,
			fieldNumber,
			...(execId ? { execId } : {}),
			...(execNumericId !== undefined ? { execNumericId } : {}),
		})),
	];
}

function decodeMcpArgs(data: Uint8Array, execId: string | undefined, execNumericId: number | undefined): CursorServerMessage {
	let id = execId ?? "cursor-tool";
	let name = "cursor_tool";
	let toolName: string | undefined;
	const args: Record<string, JsonValue> = {};
	for (const field of readFields(data)) {
		if (field.fieldNumber === 1 && field.value instanceof Uint8Array) name = decodeString(field.value) || name;
		else if (field.fieldNumber === 3 && field.value instanceof Uint8Array) id = decodeString(field.value) || id;
		else if (field.fieldNumber === 5 && field.value instanceof Uint8Array) toolName = decodeString(field.value);
		else if (field.fieldNumber === 2 && field.value instanceof Uint8Array) {
			const entry = decodeMapStringBytesEntry(field.value);
			if (entry) args[entry.key] = decodeMcpArgValue(entry.value);
		}
	}
	return {
		type: "toolCall",
		id,
		name: toolName ?? name,
		argumentsJson: JSON.stringify(args),
		...(execId ? { execId } : {}),
		...(execNumericId !== undefined ? { execNumericId } : {}),
	};
}

function decodeMapStringBytesEntry(data: Uint8Array): { readonly key: string; readonly value: Uint8Array } | undefined {
	let key: string | undefined;
	let value: Uint8Array | undefined;
	for (const field of readFields(data)) {
		if (field.fieldNumber === 1 && field.value instanceof Uint8Array) key = decodeString(field.value);
		else if (field.fieldNumber === 2 && field.value instanceof Uint8Array) value = field.value;
	}
	return key !== undefined && value !== undefined ? { key, value } : undefined;
}

function decodeMcpArgValue(data: Uint8Array): JsonValue {
	try {
		const protobuf = tryDecodeProtobufValue(data);
		if (protobuf.recognized) return protobuf.value;
	} catch {
		// Cursor can send raw UTF-8 bytes in McpArgs.args map values; fall through to raw decoding.
	}
	try {
		// Raw bytes are Cursor's string fallback; typed values should arrive as
		// protobuf Value. Do not JSON-parse raw UTF-8, or strings such as "2024"
		// and "true" would silently change JS type before reaching Atomic tools.
		return strictTextDecoder.decode(data);
	} catch {
		throw new Error("Cursor MCP argument value was neither protobuf Value nor valid UTF-8.");
	}
}

function decodeProtobufValue(data: Uint8Array): JsonValue {
	const result = tryDecodeProtobufValue(data);
	if (!result.recognized) throw new Error("unrecognized protobuf Value");
	return result.value;
}

function tryDecodeProtobufValue(data: Uint8Array): { readonly recognized: true; readonly value: JsonValue } | { readonly recognized: false } {
	let output: JsonValue | undefined;
	let recognized = false;
	for (const field of readFields(data)) {
		if (field.fieldNumber === 1 && typeof field.value === "bigint") {
			output = null;
			recognized = true;
		} else if (field.fieldNumber === 2 && typeof field.value === "number") {
			output = field.value;
			recognized = true;
		} else if (field.fieldNumber === 3 && field.value instanceof Uint8Array) {
			output = decodeString(field.value);
			recognized = true;
		} else if (field.fieldNumber === 4 && typeof field.value === "bigint") {
			output = field.value !== 0n;
			recognized = true;
		} else if (field.fieldNumber === 5 && field.value instanceof Uint8Array) {
			output = decodeStructValue(field.value);
			recognized = true;
		} else if (field.fieldNumber === 6 && field.value instanceof Uint8Array) {
			output = decodeListValue(field.value);
			recognized = true;
		} else {
			return { recognized: false };
		}
	}
	return recognized && output !== undefined ? { recognized: true, value: output } : { recognized: false };
}

function decodeStructValue(data: Uint8Array): JsonObject {
	const output: JsonObject = {};
	for (const field of readFields(data)) {
		if (field.fieldNumber !== 1 || !(field.value instanceof Uint8Array)) continue;
		const entry = decodeStructEntry(field.value);
		if (entry) output[entry.key] = entry.value;
	}
	return output;
}

function decodeStructEntry(data: Uint8Array): { readonly key: string; readonly value: JsonValue } | undefined {
	let key: string | undefined;
	let value: JsonValue | undefined;
	for (const field of readFields(data)) {
		if (field.fieldNumber === 1 && field.value instanceof Uint8Array) key = decodeString(field.value);
		else if (field.fieldNumber === 2 && field.value instanceof Uint8Array) value = decodeProtobufValue(field.value);
	}
	return key !== undefined && value !== undefined ? { key, value } : undefined;
}

function decodeListValue(data: Uint8Array): JsonValue[] {
	const values: JsonValue[] = [];
	for (const field of readFields(data)) {
		if (field.fieldNumber === 1 && field.value instanceof Uint8Array) values.push(decodeProtobufValue(field.value));
	}
	return values;
}

function encodeUserMessageAction(text: string, requestId: string): Uint8Array {
	// AgentRunRequest.action = 2 -> ConversationAction.user_message_action = 1 -> UserMessageAction.user_message = 1 -> UserMessage { text = 1, message_id = 2 }
	return encodeMessageField(1, encodeMessageField(1, encodeUserMessage(text, `${requestId}-user`)));
}

function encodeUserMessage(text: string, messageId: string): Uint8Array {
	return concatBytes(encodeStringField(1, text), encodeStringField(2, messageId));
}

function encodeMcpArgs(id: string, name: string, toolName: string, argsJson: string): Uint8Array {
	return concatBytes(encodeStringField(1, name), encodeMessageField(2, concatBytes(encodeStringField(1, "arguments"), encodeMessageField(2, textEncoder.encode(argsJson)))), encodeStringField(3, id), encodeStringField(4, "atomic"), encodeStringField(5, toolName));
}

function encodeMcpSuccessResult(text: string, isError: boolean): Uint8Array {
	const textContent = encodeMessageField(1, encodeStringField(1, text));
	const success = concatBytes(encodeMessageField(1, textContent), encodeVarintField(2, isError ? 1n : 0n));
	return encodeMessageField(1, success);
}

function encodeMcpToolResult(result: CursorToolResultMessage): Uint8Array {
	const execFields = concatBytes(
		result.execNumericId !== undefined ? encodeVarintField(1, BigInt(result.execNumericId)) : new Uint8Array(),
		encodeMessageField(11, encodeMcpSuccessResult(result.text, result.isError)),
		result.execId ? encodeStringField(15, result.execId) : new Uint8Array(),
	);
	return encodeMessageField(2, execFields);
}

function encodeConversationState(request: CursorRunRequest): Uint8Array {
	interface HistoricalToolStep {
		readonly kind: "tool";
		readonly id: string;
		readonly name: string;
		readonly argsJson: string;
		result?: { readonly text: string; readonly isError: boolean };
	}
	type HistoricalStep = Uint8Array | HistoricalToolStep;

	const fields: Uint8Array[] = [];
	if (request.context.systemPrompt) fields.push(encodeMessageField(1, textEncoder.encode(JSON.stringify({ role: "system", content: request.context.systemPrompt }))));
	let currentUser: Uint8Array | undefined;
	let requestIndex = 0;
	const steps: HistoricalStep[] = [];
	const pendingToolSteps = new Map<string, HistoricalToolStep>();
	const encodeHistoricalStep = (step: HistoricalStep): Uint8Array => {
		if (step instanceof Uint8Array) return step;
		return encodeMcpToolHistoryStep(step);
	};
	const flushTurn = (): void => {
		if (!currentUser && steps.length === 0) return;
		const user = currentUser ?? encodeUserMessage("", `${request.requestId}-history-user-${requestIndex}`);
		const agentTurn = concatBytes(encodeMessageField(1, user), ...steps.map((step) => encodeMessageField(2, encodeHistoricalStep(step))), encodeStringField(3, `${request.requestId}-history-${requestIndex++}`));
		fields.push(encodeMessageField(8, encodeMessageField(1, agentTurn)));
		currentUser = undefined;
		steps.length = 0;
	};
	for (const message of request.context.messages.slice(0, -1)) {
		if (message.role === "user") {
			flushTurn();
			currentUser = encodeUserMessage(textFromMessage(message), `${request.requestId}-history-user-${requestIndex}`);
		} else if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type === "text") steps.push(encodeMessageField(1, encodeStringField(1, part.text)));
				else if (part.type === "thinking") steps.push(encodeMessageField(3, encodeStringField(1, part.thinking)));
				else {
					if (pendingToolSteps.has(part.id)) throw new Error(`Duplicate historical Cursor tool call id ${part.id}.`);
					const toolStep: HistoricalToolStep = { kind: "tool", id: part.id, name: part.name, argsJson: JSON.stringify(part.arguments) };
					pendingToolSteps.set(part.id, toolStep);
					steps.push(toolStep);
				}
			}
		} else {
			const toolStep = pendingToolSteps.get(message.toolCallId);
			if (!toolStep) throw new Error(`Orphan historical Cursor tool result ${message.toolCallId}.`);
			if (toolStep.result) throw new Error(`Duplicate historical Cursor tool result ${message.toolCallId}.`);
			toolStep.result = { text: rawToolResultText(message), isError: message.isError };
			pendingToolSteps.delete(message.toolCallId);
		}
	}
	flushTurn();
	return fields.length === 0 ? new Uint8Array() : encodeMessageField(1, concatBytes(...fields));
}

function encodeMcpToolHistoryStep(step: { readonly id: string; readonly name: string; readonly argsJson: string; readonly result?: { readonly text: string; readonly isError: boolean } }): Uint8Array {
	const toolCall = concatBytes(
		encodeMessageField(1, encodeMcpArgs(step.id, step.name, step.name, step.argsJson)),
		step.result ? encodeMessageField(2, encodeMcpSuccessResult(step.result.text, step.result.isError)) : new Uint8Array(),
	);
	return encodeMessageField(2, encodeMessageField(15, toolCall));
}

function encodeMcpTools(request: CursorRunRequest): Uint8Array {
	const tools = request.context.tools ?? [];
	if (tools.length === 0) return new Uint8Array();
	const definitions = tools.map((tool) => encodeMessageField(1, concatBytes(
		encodeStringField(1, tool.name),
		encodeStringField(2, tool.description),
		encodeMessageField(3, textEncoder.encode(JSON.stringify(tool.parameters))),
		encodeStringField(4, "atomic"),
		encodeStringField(5, tool.name),
	)));
	return encodeMessageField(4, concatBytes(...definitions));
}

function extractCurrentActionText(request: CursorRunRequest): string {
	const last = request.context.messages.at(-1);
	return last ? textFromMessage(last) : "";
}

function rawToolResultText(message: Extract<CursorRunRequest["context"]["messages"][number], { readonly role: "toolResult" }>): string {
	return message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
}

function textFromMessage(message: CursorRunRequest["context"]["messages"][number]): string {
	if (message.role === "user") {
		if (typeof message.content === "string") return message.content;
		return message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
	}
	if (message.role === "assistant") {
		return message.content.map((part) => {
			if (part.type === "text") return part.text;
			if (part.type === "thinking") return part.thinking;
			return `toolCall:${part.id}:${part.name}:${JSON.stringify(part.arguments)}`;
		}).join("\n");
	}
	return `toolResult:${message.toolCallId}:${message.toolName}:${message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n")}`;
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
		} else if (wireType === WIRE_FIXED64) {
			const end = offset + 8;
			if (end > data.length) throw new Error("truncated fixed64 field");
			const view = new DataView(data.buffer, data.byteOffset + offset, 8);
			fields.push({ fieldNumber, wireType, value: view.getFloat64(0, true) });
			offset = end;
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

function encodeVarintField(fieldNumber: number, value: bigint): Uint8Array {
	return concatBytes(encodeVarint(BigInt((fieldNumber << 3) | WIRE_VARINT)), encodeVarint(value));
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
