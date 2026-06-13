import { createHash } from "node:crypto";
import { createCursorExperimentalProtocolError, parseJsonObject, parseJsonValue, type JsonObject, type JsonValue } from "../config.js";
import type { CursorUsableModel } from "../model-mapper.js";
import type { CursorConnectFrame, CursorControlMessage, CursorDoneReason, CursorProtocolCodec, CursorProtocolMessage, CursorRunRequest, CursorServerMessage, CursorToolResultMessage } from "../transport.js";

// Minimal Cursor protobuf codec derived from protocol field numbers documented from
// MIT-licensed ndraiman/pi-cursor-provider and ephraimduncan/opencode-cursor.
// Keep all private Cursor wire-format handling isolated in this module.

type WireField = { readonly fieldNumber: number; readonly wireType: number; readonly value: bigint | Uint8Array | number };

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_START_GROUP = 3;
const WIRE_END_GROUP = 4;
const WIRE_FIXED32 = 5;
const CURSOR_PROTO_CLIENT_NAME = "pi";
const NATIVE_EXEC_REJECT_REASON = "Atomic executes tools through MCP only; Cursor native tools are disabled for this provider.";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const strictTextDecoder = new TextDecoder("utf-8", { fatal: true });

export class CursorProtobufProtocolCodec implements CursorProtocolCodec {
	readonly #blobStores = new Map<string, Map<string, Uint8Array>>();
	readonly #toolDefinitions = new Map<string, readonly Uint8Array[]>();
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
		const blobStore = new Map<string, Uint8Array>();
		const systemBlobId = storeAsBlob(textEncoder.encode(JSON.stringify({ role: "system", content: request.context.systemPrompt ?? "" })), blobStore);
		const selectedContextBlob = storeAsBlob(encodeSelectedContextBlob([systemBlobId]), blobStore);
		this.#blobStores.set(request.requestId, blobStore);
		this.#toolDefinitions.set(request.requestId, encodeMcpToolDefinitions(request));
		const modelDetails = encodeMessageField(3, encodeModelDetails(request.resolvedModelId, request.resolvedModelId));
		const conversationId = encodeStringField(5, request.conversationId ?? request.requestId);
		const conversationState = encodeConversationState(request, blobStore, systemBlobId, selectedContextBlob);
		const userText = extractCurrentActionText(request);
		const action = userText ? encodeMessageField(2, encodeUserMessageAction(userText, request.requestId, selectedContextBlob)) : new Uint8Array();
		const runRequest = concatBytes(conversationState, action, modelDetails, conversationId);
		return encodeMessageField(1, runRequest);
	}

	decodeRunFrame(frame: CursorConnectFrame): readonly CursorProtocolMessage[] {
		try {
			return decodeAgentServerMessage(frame.data);
		} catch (error) {
			throw createCursorExperimentalProtocolError(`Cursor protobuf Run decoding failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	encodeServerResponse(message: CursorProtocolMessage, requestId: string): Uint8Array | undefined {
		if (message.type === "kvGetBlob") {
			const data = this.#blobStores.get(requestId)?.get(blobKey(message.blobId));
			return encodeKvGetBlobResult(message.id, data);
		}
		if (message.type === "kvSetBlob") {
			const store = this.#blobStores.get(requestId);
			if (store) store.set(blobKey(message.blobId), message.blobData);
			return encodeKvSetBlobResult(message.id);
		}
		if (message.type === "requestContext") {
			return encodeRequestContextResult(message, this.#toolDefinitions.get(requestId) ?? []);
		}
		if (message.type === "nonMcpExec") {
			return encodeNativeExecRejection(message);
		}
		return undefined;
	}

	disposeRun(requestId: string): void {
		this.#blobStores.delete(requestId);
		this.#toolDefinitions.delete(requestId);
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

function decodeAgentServerMessage(data: Uint8Array): readonly CursorProtocolMessage[] {
	const messages: CursorProtocolMessage[] = [];
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
		if (field.fieldNumber === 4 && field.value instanceof Uint8Array) {
			const kv = decodeKvServerMessage(field.value);
			if (kv) messages.push(kv);
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

function decodeExecServerMessage(data: Uint8Array): readonly CursorProtocolMessage[] {
	let execNumericId: number | undefined;
	let execId: string | undefined;
	const mcpPayloads: Uint8Array[] = [];
	const nonMcpFieldNumbers: number[] = [];
	for (const field of readFields(data)) {
		if (field.fieldNumber === 1 && typeof field.value === "bigint") execNumericId = Number(field.value);
		else if (field.fieldNumber === 15 && field.value instanceof Uint8Array) execId = decodeString(field.value);
		else if (field.fieldNumber === 10 && field.value instanceof Uint8Array) nonMcpFieldNumbers.push(10);
		else if (field.fieldNumber === 11 && field.value instanceof Uint8Array) mcpPayloads.push(field.value);
		else if (field.fieldNumber !== 1 && field.fieldNumber !== 11 && field.fieldNumber !== 15) nonMcpFieldNumbers.push(field.fieldNumber);
	}
	return [
		...mcpPayloads.map((payload) => decodeMcpArgs(payload, execId, execNumericId)),
		...nonMcpFieldNumbers.map((fieldNumber) => fieldNumber === 10
			? ({ type: "requestContext" as const, ...(execId ? { execId } : {}), ...(execNumericId !== undefined ? { execNumericId } : {}) })
			: ({
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

function decodeKvServerMessage(data: Uint8Array): CursorControlMessage | undefined {
	let id: number | undefined;
	let getBlob: Uint8Array | undefined;
	let setBlobId: Uint8Array | undefined;
	let setBlobData: Uint8Array | undefined;
	for (const field of readFields(data)) {
		if (field.fieldNumber === 1 && typeof field.value === "bigint") id = Number(field.value);
		else if (field.fieldNumber === 2 && field.value instanceof Uint8Array) getBlob = decodeBlobIdArg(field.value);
		else if (field.fieldNumber === 3 && field.value instanceof Uint8Array) {
			const setArgs = decodeSetBlobArgs(field.value);
			setBlobId = setArgs?.blobId;
			setBlobData = setArgs?.blobData;
		}
	}
	if (id === undefined) return undefined;
	if (getBlob) return { type: "kvGetBlob", id, blobId: getBlob };
	if (setBlobId && setBlobData) return { type: "kvSetBlob", id, blobId: setBlobId, blobData: setBlobData };
	return undefined;
}

function decodeBlobIdArg(data: Uint8Array): Uint8Array | undefined {
	for (const field of readFields(data)) {
		if (field.fieldNumber === 1 && field.value instanceof Uint8Array) return field.value;
	}
	return undefined;
}

function decodeSetBlobArgs(data: Uint8Array): { readonly blobId: Uint8Array; readonly blobData: Uint8Array } | undefined {
	let blobId: Uint8Array | undefined;
	let blobData: Uint8Array | undefined;
	for (const field of readFields(data)) {
		if (field.fieldNumber === 1 && field.value instanceof Uint8Array) blobId = field.value;
		else if (field.fieldNumber === 2 && field.value instanceof Uint8Array) blobData = field.value;
	}
	return blobId && blobData ? { blobId, blobData } : undefined;
}

function encodeProtobufValue(value: JsonValue): Uint8Array {
	if (value === null) return encodeVarintField(1, 0n);
	if (typeof value === "number") return encodeDoubleField(2, value);
	if (typeof value === "string") return encodeStringField(3, value);
	if (typeof value === "boolean") return encodeVarintField(4, value ? 1n : 0n);
	if (Array.isArray(value)) return encodeMessageField(6, concatBytes(...value.map((item) => encodeMessageField(1, encodeProtobufValue(item)))));
	return encodeMessageField(5, concatBytes(...Object.entries(value).map(([key, item]) => encodeMessageField(1, concatBytes(encodeStringField(1, key), encodeMessageField(2, encodeProtobufValue(item)))))));
}

function serializableJsonValue(value: object): JsonValue {
	return parseJsonValue(JSON.stringify(value)) ?? {};
}

function encodeUserMessageAction(text: string, requestId: string, selectedContextBlob: Uint8Array): Uint8Array {
	// AgentRunRequest.action = 2 -> ConversationAction.user_message_action = 1 -> UserMessageAction.user_message = 1 -> UserMessage.
	return encodeMessageField(1, encodeMessageField(1, encodeUserMessage(text, `${requestId}-user`, selectedContextBlob)));
}

function encodeUserMessage(text: string, messageId: string, selectedContextBlob: Uint8Array): Uint8Array {
	return concatBytes(
		encodeStringField(1, text),
		encodeStringField(2, messageId),
		encodeMessageField(3, new Uint8Array()),
		encodeVarintField(4, 1n),
		encodeMessageField(10, selectedContextBlob),
		encodeStringField(17, messageId),
	);
}

function encodeMcpArgs(id: string, name: string, toolName: string, args: JsonObject): Uint8Array {
	return concatBytes(
		encodeStringField(1, name),
		...Object.entries(args).map(([key, value]) => encodeMessageField(2, encodeMcpArgEntry(key, value))),
		encodeStringField(3, id),
		encodeStringField(4, CURSOR_PROTO_CLIENT_NAME),
		encodeStringField(5, toolName),
	);
}

function encodeMcpArgEntry(key: string, value: JsonValue): Uint8Array {
	return concatBytes(encodeStringField(1, key), encodeMessageField(2, encodeProtobufValue(value)));
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

function encodeKvGetBlobResult(id: number, blobData: Uint8Array | undefined): Uint8Array {
	const result = blobData ? encodeMessageField(1, blobData) : new Uint8Array();
	return encodeMessageField(3, concatBytes(encodeVarintField(1, BigInt(id)), encodeMessageField(2, result)));
}

function encodeKvSetBlobResult(id: number): Uint8Array {
	return encodeMessageField(3, concatBytes(encodeVarintField(1, BigInt(id)), encodeMessageField(3, new Uint8Array())));
}

function encodeRequestContextResult(message: Extract<CursorControlMessage, { readonly type: "requestContext" }>, toolDefinitions: readonly Uint8Array[]): Uint8Array {
	const requestContext = concatBytes(...toolDefinitions.map((definition) => encodeMessageField(7, definition)));
	const success = encodeMessageField(1, requestContext);
	return encodeExecClientMessage(message.execNumericId, message.execId, encodeMessageField(10, encodeMessageField(1, success)));
}

function encodeNativeExecRejection(message: Extract<CursorServerMessage, { readonly type: "nonMcpExec" }>): Uint8Array | undefined {
	const result = encodeNativeExecResult(message.fieldNumber);
	return result ? encodeExecClientMessage(message.execNumericId, message.execId, result) : undefined;
}

function encodeNativeExecResult(fieldNumber: number): Uint8Array {
	switch (fieldNumber) {
		case 2:
			return encodeMessageField(2, encodeMessageField(4, encodeShellRejected()));
		case 3:
			return encodeMessageField(3, encodePathRejected(6));
		case 4:
			return encodeMessageField(4, encodePathRejected(6));
		case 5:
			return encodeMessageField(5, encodeMessageField(2, encodeStringField(1, NATIVE_EXEC_REJECT_REASON)));
		case 7:
			return encodeMessageField(7, encodePathRejected(3));
		case 8:
			return encodeMessageField(8, encodePathRejected(3));
		case 9:
			return encodeMessageField(9, encodeMessageField(1, new Uint8Array()));
		case 14:
			return encodeMessageField(14, encodeMessageField(5, encodeShellRejected()));
		case 16:
			return encodeMessageField(16, encodeMessageField(3, encodeShellRejected()));
		case 20:
			return encodeMessageField(20, encodeMessageField(2, concatBytes(encodeStringField(1, ""), encodeStringField(2, NATIVE_EXEC_REJECT_REASON))));
		case 23:
			return encodeMessageField(23, encodeMessageField(2, encodeStringField(1, NATIVE_EXEC_REJECT_REASON)));
		case 17:
		case 18:
		case 21:
		case 22:
			return encodeMessageField(fieldNumber, new Uint8Array());
		default:
			return fieldNumber > 0 ? encodeMessageField(fieldNumber, new Uint8Array()) : new Uint8Array();
	}
}

function encodePathRejected(resultFieldNumber: number): Uint8Array {
	return encodeMessageField(resultFieldNumber, concatBytes(encodeStringField(1, ""), encodeStringField(2, NATIVE_EXEC_REJECT_REASON)));
}

function encodeShellRejected(): Uint8Array {
	return concatBytes(
		encodeStringField(1, ""),
		encodeStringField(2, ""),
		encodeStringField(3, NATIVE_EXEC_REJECT_REASON),
		encodeVarintField(4, 0n),
	);
}

function encodeExecClientMessage(execNumericId: number | undefined, execId: string | undefined, result: Uint8Array): Uint8Array {
	const execFields = concatBytes(
		execNumericId !== undefined ? encodeVarintField(1, BigInt(execNumericId)) : new Uint8Array(),
		result,
		execId ? encodeStringField(15, execId) : new Uint8Array(),
	);
	return encodeMessageField(2, execFields);
}

function encodeConversationState(request: CursorRunRequest, blobStore: Map<string, Uint8Array>, systemBlobId: Uint8Array, selectedContextBlob: Uint8Array): Uint8Array {
	interface HistoricalToolStep {
		readonly kind: "tool";
		readonly id: string;
		readonly name: string;
		readonly args: JsonObject;
		result?: { readonly text: string; readonly isError: boolean };
	}
	type HistoricalStep = Uint8Array | HistoricalToolStep;

	const turnBlobIds: Uint8Array[] = [];
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
		const user = currentUser ?? encodeUserMessage("", `${request.requestId}-history-user-${requestIndex}`, selectedContextBlob);
		const userBlobId = storeAsBlob(user, blobStore);
		const stepBlobIds = steps.map((step) => storeAsBlob(encodeHistoricalStep(step), blobStore));
		const agentTurn = concatBytes(encodeMessageField(1, userBlobId), ...stepBlobIds.map((stepBlobId) => encodeMessageField(2, stepBlobId)), encodeStringField(3, `${request.requestId}-history-${requestIndex++}`));
		turnBlobIds.push(storeAsBlob(encodeMessageField(1, agentTurn), blobStore));
		currentUser = undefined;
		steps.length = 0;
	};
	for (const message of request.context.messages.slice(0, -1)) {
		if (message.role === "user") {
			flushTurn();
			currentUser = encodeUserMessage(textFromMessage(message), `${request.requestId}-history-user-${requestIndex}`, selectedContextBlob);
		} else if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type === "text") steps.push(encodeMessageField(1, encodeStringField(1, part.text)));
				else if (part.type === "thinking") steps.push(encodeMessageField(3, encodeStringField(1, part.thinking)));
				else {
					if (pendingToolSteps.has(part.id)) throw new Error(`Duplicate historical Cursor tool call id ${part.id}.`);
					const toolStep: HistoricalToolStep = { kind: "tool", id: part.id, name: part.name, args: parseJsonObject(JSON.stringify(part.arguments)) ?? {} };
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
	const fields = [
		encodeMessageField(1, systemBlobId),
		...turnBlobIds.map((turnBlobId) => encodeMessageField(8, turnBlobId)),
		encodeStringField(9, `file://${process.cwd()}`),
		encodeVarintField(10, 1n),
		encodeStringField(22, CURSOR_PROTO_CLIENT_NAME),
	];
	return encodeMessageField(1, concatBytes(...fields));
}

function encodeMcpToolHistoryStep(step: { readonly id: string; readonly name: string; readonly args: JsonObject; readonly result?: { readonly text: string; readonly isError: boolean } }): Uint8Array {
	const toolCall = concatBytes(
		encodeMessageField(1, encodeMcpArgs(step.id, step.name, step.name, step.args)),
		step.result ? encodeMessageField(2, encodeMcpSuccessResult(step.result.text, step.result.isError)) : new Uint8Array(),
	);
	return encodeMessageField(2, encodeMessageField(15, toolCall));
}

function encodeMcpToolDefinitions(request: CursorRunRequest): readonly Uint8Array[] {
	return (request.context.tools ?? []).map((tool) => concatBytes(
		encodeStringField(1, tool.name),
		encodeStringField(2, tool.description),
		encodeMessageField(3, encodeProtobufValue(serializableJsonValue(tool.parameters))),
		encodeStringField(4, CURSOR_PROTO_CLIENT_NAME),
		encodeStringField(5, tool.name),
	));
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
	return concatBytes(encodeStringField(1, modelId), encodeStringField(3, modelId), encodeStringField(4, displayName));
}

function encodeSelectedContextBlob(rootPromptBlobIds: readonly Uint8Array[]): Uint8Array {
	return concatBytes(...rootPromptBlobIds.map((blobId) => encodeMessageField(1, blobId)), encodeStringField(22, CURSOR_PROTO_CLIENT_NAME));
}

function storeAsBlob(data: Uint8Array, blobStore: Map<string, Uint8Array>): Uint8Array {
	const blobId = new Uint8Array(createHash("sha256").update(data).digest());
	blobStore.set(blobKey(blobId), data);
	return blobId;
}

function blobKey(blobId: Uint8Array): string {
	return Buffer.from(blobId).toString("hex");
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
		} else if (wireType === WIRE_START_GROUP) {
			offset = skipGroup(data, offset, fieldNumber);
		} else if (wireType === WIRE_END_GROUP) {
			throw new Error("unexpected protobuf end-group tag");
		} else if (wireType === WIRE_FIXED32) {
			const end = offset + 4;
			if (end > data.length) throw new Error("truncated fixed32 field");
			offset = end;
		} else {
			throw new Error(`unsupported wire type ${wireType}`);
		}
	}
	return fields;
}

function skipGroup(data: Uint8Array, startOffset: number, groupFieldNumber: number): number {
	let offset = startOffset;
	while (offset < data.length) {
		const tag = readVarint(data, offset);
		offset = tag.offset;
		const fieldNumber = Number(tag.value >> 3n);
		const wireType = Number(tag.value & 0x7n);
		if (wireType === WIRE_END_GROUP) {
			if (fieldNumber !== groupFieldNumber) throw new Error("mismatched protobuf end-group tag");
			return offset;
		}
		offset = skipUnknownFieldValue(data, offset, wireType, fieldNumber);
	}
	throw new Error("unterminated protobuf group");
}

function skipUnknownFieldValue(data: Uint8Array, startOffset: number, wireType: number, fieldNumber: number): number {
	if (wireType === WIRE_VARINT) return readVarint(data, startOffset).offset;
	if (wireType === WIRE_FIXED64) {
		const end = startOffset + 8;
		if (end > data.length) throw new Error("truncated fixed64 field");
		return end;
	}
	if (wireType === WIRE_LENGTH_DELIMITED) {
		const length = readVarint(data, startOffset);
		const end = length.offset + Number(length.value);
		if (end > data.length) throw new Error("truncated length-delimited field");
		return end;
	}
	if (wireType === WIRE_START_GROUP) return skipGroup(data, startOffset, fieldNumber);
	if (wireType === WIRE_FIXED32) {
		const end = startOffset + 4;
		if (end > data.length) throw new Error("truncated fixed32 field");
		return end;
	}
	throw new Error(`unsupported wire type ${wireType}`);
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

function encodeDoubleField(fieldNumber: number, value: number): Uint8Array {
	const bytes = new Uint8Array(8);
	new DataView(bytes.buffer).setFloat64(0, value, true);
	return concatBytes(encodeVarint(BigInt((fieldNumber << 3) | WIRE_FIXED64)), bytes);
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
