import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { create, fromBinary, fromJson, type JsonValue as ProtobufJsonValue, toBinary, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import type { ImageContent } from "@earendil-works/pi-ai";
import { createCursorExperimentalProtocolError, parseJsonObject, parseJsonValue, type JsonObject, type JsonValue } from "../config.js";
import type { CursorUsableModel } from "../model-mapper.js";
import type { CursorConnectFrame, CursorControlMessage, CursorProtocolCodec, CursorProtocolMessage, CursorRunRequest, CursorServerMessage, CursorToolResultMessage } from "../transport.js";
import {
	AgentClientMessageSchema,
	AgentConversationTurnStructureSchema,
	AgentRunRequestSchema,
	AgentServerMessageSchema,
	AssistantMessageSchema,
	BackgroundShellSpawnResultSchema,
	CancelActionSchema,
	ClientHeartbeatSchema,
	ConversationActionSchema,
	ConversationStateStructureSchema,
	ConversationStepSchema,
	ConversationTurnStructureSchema,
	DeleteRejectedSchema,
	DeleteResultSchema,
	DiagnosticsResultSchema,
	ExecClientMessageSchema,
	FetchErrorSchema,
	FetchResultSchema,
	GetBlobResultSchema,
	GetUsableModelsRequestSchema,
	GetUsableModelsResponseSchema,
	GrepErrorSchema,
	GrepResultSchema,
	KvClientMessageSchema,
	LsRejectedSchema,
	LsResultSchema,
	McpArgsSchema,
	McpErrorSchema,
	McpResultSchema,
	McpSuccessSchema,
	McpTextContentSchema,
	McpToolCallSchema,
	McpToolDefinitionSchema,
	McpToolErrorSchema,
	McpToolResultContentItemSchema,
	McpToolResultSchema,
	ModelDetailsSchema,
	ReadRejectedSchema,
	ReadResultSchema,
	RequestContextResultSchema,
	RequestContextSchema,
	RequestContextSuccessSchema,
	SelectedContextSchema,
	SelectedImageSchema,
	SetBlobResultSchema,
	ShellRejectedSchema,
	ShellResultSchema,
	ShellStreamSchema,
	ToolCallSchema,
	UserMessageActionSchema,
	UserMessageSchema,
	WriteRejectedSchema,
	WriteResultSchema,
	WriteShellStdinErrorSchema,
	WriteShellStdinResultSchema,
	type AgentServerMessage,
	type ConversationStateStructure,
	type ExecServerMessage,
	type KvServerMessage,
	type McpToolDefinition,
	type ModelDetails,
	type SelectedImage,
	type UserMessage,
} from "./agent_pb.js";

// Cursor protocol codec intentionally follows the MIT-licensed
// ndraiman/pi-cursor-provider implementation. The request/control bytes are
// built through Cursor's generated protobuf descriptors instead of inferred
// hand-written field concatenation so the private API sees the same semantic
// messages as the reference provider.

interface StoredCursorConversationState {
	checkpoint?: Uint8Array;
	blobStore: Map<string, Uint8Array>;
}


interface ParsedAssistantTextStep {
	readonly kind: "assistantText";
	readonly text: string;
}

interface ParsedToolCallStep {
	readonly kind: "toolCall";
	readonly toolCallId: string;
	readonly toolName: string;
	readonly arguments: JsonObject;
	result?: { readonly content: string; readonly isError: boolean };
}

type ParsedTurnStep = ParsedAssistantTextStep | ParsedToolCallStep;

interface ParsedTurn {
	readonly userText: string;
	readonly steps: ParsedTurnStep[];
}

const CURSOR_PROTO_CLIENT_NAME = "pi";
const NATIVE_EXEC_REJECT_REASON = "Tool not available in this environment. Use the MCP tools provided instead.";
const CURSOR_IMAGE_SERIALIZATION_OPT_IN_ERROR = "Cursor experimental image input serialization requires explicit opt-in before encoding image content.";
const CURSOR_TOOL_RESULT_IMAGE_SERIALIZATION_ERROR = "Cursor experimental image input serialization does not support tool-result images.";
const CURSOR_IMAGE_DECODE_ERROR = "Cursor experimental image input could not decode an image content block because the image payload is not valid base64/data URL base64. Remove image content or switch to a vision-capable provider.";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const EXEC_CASE_FIELD_NUMBERS: ReadonlyMap<string, number> = new Map([
	["shellArgs", 2],
	["writeArgs", 3],
	["deleteArgs", 4],
	["grepArgs", 5],
	["readArgs", 7],
	["lsArgs", 8],
	["diagnosticsArgs", 9],
	["requestContextArgs", 10],
	["mcpArgs", 11],
	["shellStreamArgs", 14],
	["backgroundShellSpawnArgs", 16],
	["listMcpResourcesExecArgs", 17],
	["readMcpResourceExecArgs", 18],
	["fetchArgs", 20],
	["recordScreenArgs", 21],
	["computerUseArgs", 22],
	["writeShellStdinArgs", 23],
]);

export class CursorProtobufProtocolCodec implements CursorProtocolCodec {
	readonly #blobStores = new Map<string, Map<string, Uint8Array>>();
	readonly #toolDefinitions = new Map<string, readonly McpToolDefinition[]>();
	readonly #runConversationIds = new Map<string, string>();
	readonly #conversationStates = new Map<string, StoredCursorConversationState>();

	encodeGetUsableModelsRequest(): Uint8Array {
		return toBinary(GetUsableModelsRequestSchema, create(GetUsableModelsRequestSchema, {}));
	}

	decodeGetUsableModelsResponse(data: Uint8Array): readonly CursorUsableModel[] {
		try {
			try {
				const direct = decodeGetUsableModelsBody(data);
				if (direct.length > 0) return direct;
			} catch {
				// Some Cursor deployments reply to unary calls with a Connect envelope;
				// fall through and try the reference provider's unwrap behavior.
			}
			const unwrapped = unwrapConnectUnaryBody(data);
			return unwrapped ? decodeGetUsableModelsBody(unwrapped) : [];
		} catch (error) {
			throw createCursorExperimentalProtocolError(`Cursor protobuf GetUsableModels decoding failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	encodeRunRequest(request: CursorRunRequest): Uint8Array {
		validateCursorImageSerializationContext(request);
		const currentImages = extractCurrentActionImages(request);
		const conversationIdValue = request.conversationId ?? request.requestId;
		const storedState = this.#conversationStates.get(conversationIdValue);
		const payload = buildCursorRequest(
			request.resolvedModelId,
			request.context.systemPrompt ?? "",
			extractCurrentActionText(request),
			currentImages,
			parseHistoricalTurns(request.context.messages.slice(0, -1)),
			conversationIdValue,
			storedState?.checkpoint ?? null,
			storedState?.blobStore,
		);
		this.#blobStores.set(request.requestId, payload.blobStore);
		this.#toolDefinitions.set(request.requestId, buildMcpToolDefinitions(request));
		this.#runConversationIds.set(request.requestId, conversationIdValue);
		return payload.requestBytes;
	}

	decodeRunFrame(frame: CursorConnectFrame): readonly CursorProtocolMessage[] {
		try {
			const message = fromBinary(AgentServerMessageSchema, frame.data);
			return decodeAgentServerMessage(message);
		} catch (error) {
			throw createCursorExperimentalProtocolError(`Cursor protobuf Run decoding failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	encodeServerResponse(message: CursorProtocolMessage, requestId: string): Uint8Array | undefined {
		if (message.type === "kvGetBlob") {
			const data = this.#blobStores.get(requestId)?.get(blobKey(message.blobId));
			return encodeKvClientMessage(message.id, "getBlobResult", create(GetBlobResultSchema, data ? { blobData: data } : {}));
		}
		if (message.type === "kvSetBlob") {
			const store = this.#blobStores.get(requestId);
			if (store) store.set(blobKey(message.blobId), message.blobData);
			this.commitRunState(requestId);
			return encodeKvClientMessage(message.id, "setBlobResult", create(SetBlobResultSchema, {}));
		}
		if (message.type === "conversationCheckpoint") {
			this.commitRunState(requestId, message.checkpoint);
			return undefined;
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
		this.commitRunState(requestId);
		this.cleanupRun(requestId);
	}

	discardRun(requestId: string): void {
		const conversationId = this.#runConversationIds.get(requestId);
		if (conversationId) this.discardConversation(conversationId);
		this.cleanupRun(requestId);
	}

	discardConversation(conversationId: string): void {
		this.#conversationStates.delete(conversationId);
	}

	private cleanupRun(requestId: string): void {
		this.#blobStores.delete(requestId);
		this.#toolDefinitions.delete(requestId);
		this.#runConversationIds.delete(requestId);
	}

	private commitRunState(requestId: string, checkpoint?: Uint8Array): void {
		const conversationId = this.#runConversationIds.get(requestId);
		if (!conversationId) return;
		const runBlobStore = this.#blobStores.get(requestId);
		const stored = this.#conversationStates.get(conversationId) ?? { blobStore: new Map<string, Uint8Array>() };
		if (runBlobStore) {
			for (const [key, value] of runBlobStore) stored.blobStore.set(key, value);
		}
		if (checkpoint && checkpoint.byteLength > 0) stored.checkpoint = checkpoint.slice();
		this.#conversationStates.set(conversationId, stored);
	}

	encodeToolResult(result: CursorToolResultMessage): Uint8Array {
		const mcpResult = createMcpToolResult(result.text, result.isError);
		return encodeExecClientMessage(result.execNumericId, result.execId, "mcpResult", mcpResult);
	}

	encodeCancelRequest(): Uint8Array {
		const cancelAction = create(ConversationActionSchema, {
			action: { case: "cancelAction", value: create(CancelActionSchema, {}) },
		});
		const clientMessage = create(AgentClientMessageSchema, {
			message: { case: "conversationAction", value: cancelAction },
		});
		return toBinary(AgentClientMessageSchema, clientMessage);
	}

	encodeHeartbeatRequest(): Uint8Array {
		const clientMessage = create(AgentClientMessageSchema, {
			message: { case: "clientHeartbeat", value: create(ClientHeartbeatSchema, {}) },
		});
		return toBinary(AgentClientMessageSchema, clientMessage);
	}
}

function decodeGetUsableModelsBody(data: Uint8Array): readonly CursorUsableModel[] {
	const decoded = fromBinary(GetUsableModelsResponseSchema, data);
	return decoded.models.flatMap((model) => {
		const normalized = modelDetailsToCursorUsableModel(model);
		return normalized ? [normalized] : [];
	});
}

function modelDetailsToCursorUsableModel(model: ModelDetails): CursorUsableModel | undefined {
	const id = model.modelId.trim();
	if (!id) return undefined;
	return {
		id,
		displayName: model.displayName || model.displayNameShort || model.displayModelId || undefined,
		supportsThinking: Boolean(model.thinkingDetails),
		supportsReasoning: Boolean(model.thinkingDetails || model.maxMode),
	};
}

function unwrapConnectUnaryBody(data: Uint8Array): Uint8Array | undefined {
	let offset = 0;
	while (offset + 5 <= data.byteLength) {
		const flags = data[offset] ?? 0;
		const view = new DataView(data.buffer, data.byteOffset + offset, data.byteLength - offset);
		const length = view.getUint32(1, false);
		const frameEnd = offset + 5 + length;
		if (frameEnd > data.byteLength) return undefined;
		if ((flags & 0b0000_0001) !== 0) return undefined;
		if ((flags & 0b0000_0010) === 0) return data.slice(offset + 5, frameEnd);
		offset = frameEnd;
	}
	return undefined;
}

function buildMcpToolDefinitions(request: CursorRunRequest): readonly McpToolDefinition[] {
	return (request.context.tools ?? []).map((tool) => {
		const jsonSchema = serializableJsonValue(tool.parameters);
		return create(McpToolDefinitionSchema, {
			name: tool.name,
			description: tool.description,
			providerIdentifier: CURSOR_PROTO_CLIENT_NAME,
			toolName: tool.name,
			inputSchema: encodeProtobufValue(jsonSchema),
		});
	});
}

function buildCursorRequest(
	modelId: string,
	systemPrompt: string,
	userText: string,
	userImages: readonly ImageContent[],
	turns: readonly ParsedTurn[],
	conversationId: string,
	checkpoint: Uint8Array | null,
	existingBlobStore?: Map<string, Uint8Array>,
): { readonly requestBytes: Uint8Array; readonly blobStore: Map<string, Uint8Array> } {
	const blobStore = new Map<string, Uint8Array>(existingBlobStore ?? []);
	const systemBlobId = storeAsBlob(textEncoder.encode(JSON.stringify({ role: "system", content: systemPrompt })), blobStore);
	const selectedContextBlob = storeAsBlob(buildSelectedContextBlob([systemBlobId], CURSOR_PROTO_CLIENT_NAME), blobStore);
	const conversationState = checkpoint
		? fromBinary(ConversationStateStructureSchema, checkpoint)
		: buildConversationState(turns, blobStore, systemBlobId, selectedContextBlob);
	const userMessage = createUserMessage(userText, selectedContextBlob, userImages);
	const action = create(ConversationActionSchema, {
		action: { case: "userMessageAction", value: create(UserMessageActionSchema, { userMessage }) },
	});
	const modelDetails = create(ModelDetailsSchema, { modelId, displayModelId: modelId, displayName: modelId });
	const runRequest = create(AgentRunRequestSchema, { conversationState, action, modelDetails, conversationId });
	const clientMessage = create(AgentClientMessageSchema, {
		message: { case: "runRequest", value: runRequest },
	});
	return { requestBytes: toBinary(AgentClientMessageSchema, clientMessage), blobStore };
}

function buildConversationState(
	turns: readonly ParsedTurn[],
	blobStore: Map<string, Uint8Array>,
	systemBlobId: Uint8Array,
	selectedContextBlob: Uint8Array,
): ConversationStateStructure {
	const turnBlobIds: Uint8Array[] = [];
	for (const turn of turns) {
		const userMessage = createUserMessage(turn.userText, selectedContextBlob);
		const userMessageBlobId = storeAsBlob(toBinary(UserMessageSchema, userMessage), blobStore);
		const stepBlobIds = turn.steps.map((step) => storeAsBlob(buildTurnStepBytes(step), blobStore));
		const agentTurn = create(AgentConversationTurnStructureSchema, {
			userMessage: userMessageBlobId,
			steps: stepBlobIds,
			requestId: randomUUID(),
		});
		const turnStructure = create(ConversationTurnStructureSchema, {
			turn: { case: "agentConversationTurn", value: agentTurn },
		});
		turnBlobIds.push(storeAsBlob(toBinary(ConversationTurnStructureSchema, turnStructure), blobStore));
	}
	return create(ConversationStateStructureSchema, {
		rootPromptMessagesJson: [systemBlobId],
		turns: turnBlobIds,
		todos: [],
		pendingToolCalls: [],
		previousWorkspaceUris: [],
		mode: 1,
		fileStates: {},
		fileStatesV2: {},
		summaryArchives: [],
		turnTimings: [],
		subagentStates: {},
		selfSummaryCount: 0,
		readPaths: [],
		clientName: CURSOR_PROTO_CLIENT_NAME,
	});
}

function createUserMessage(text: string, selectedContextBlob: Uint8Array, images: readonly ImageContent[] = []): UserMessage {
	const messageId = randomUUID();
	return create(UserMessageSchema, {
		text,
		messageId,
		selectedContext: create(SelectedContextSchema, { selectedImages: images.map(createSelectedImage) }),
		mode: 1,
		selectedContextBlob,
		correlationId: messageId,
	});
}

function createSelectedImage(image: ImageContent): SelectedImage {
	return create(SelectedImageSchema, {
		uuid: randomUUID(),
		mimeType: image.mimeType,
		dataOrBlobId: { case: "data", value: decodeImageData(image) },
	});
}

function decodeImageData(image: ImageContent): Uint8Array {
	const encoded = extractBase64ImagePayload(image.data);
	return decodeStrictBase64ImagePayload(encoded);
}

function extractBase64ImagePayload(data: string): string {
	if (!data.startsWith("data:")) return data;
	const commaIndex = data.indexOf(",");
	if (commaIndex === -1) throw new Error(CURSOR_IMAGE_DECODE_ERROR);
	const metadata = data.slice("data:".length, commaIndex);
	const hasBase64Parameter = metadata.split(";").slice(1).some((parameter) => parameter.toLowerCase() === "base64");
	if (!hasBase64Parameter) throw new Error(CURSOR_IMAGE_DECODE_ERROR);
	return data.slice(commaIndex + 1);
}

function decodeStrictBase64ImagePayload(encoded: string): Uint8Array {
	if (encoded.length === 0 || /\s/u.test(encoded) || /[^A-Za-z0-9+/=]/u.test(encoded)) throw new Error(CURSOR_IMAGE_DECODE_ERROR);
	const firstPaddingIndex = encoded.indexOf("=");
	const hasPadding = firstPaddingIndex !== -1;
	if (hasPadding) {
		const padding = encoded.slice(firstPaddingIndex);
		if (!/^={1,2}$/u.test(padding) || encoded.length % 4 !== 0) throw new Error(CURSOR_IMAGE_DECODE_ERROR);
	} else if (encoded.length % 4 === 1) {
		throw new Error(CURSOR_IMAGE_DECODE_ERROR);
	}
	const padded = hasPadding ? encoded : encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=");
	const bytes = Buffer.from(padded, "base64");
	const canonical = bytes.toString("base64");
	const expected = hasPadding ? encoded : encoded;
	const actual = hasPadding ? canonical : canonical.replace(/=+$/u, "");
	if (actual !== expected) throw new Error(CURSOR_IMAGE_DECODE_ERROR);
	return Uint8Array.from(bytes);
}

function buildTurnStepBytes(step: ParsedTurnStep): Uint8Array {
	if (step.kind === "assistantText") {
		return toBinary(ConversationStepSchema, create(ConversationStepSchema, {
			message: { case: "assistantMessage", value: create(AssistantMessageSchema, { text: step.text }) },
		}));
	}
	const toolName = step.toolName || "tool";
	const mcpToolCall = create(McpToolCallSchema, {
		args: create(McpArgsSchema, {
			name: toolName,
			args: encodeMcpArgsMap(step.arguments),
			toolCallId: step.toolCallId,
			providerIdentifier: CURSOR_PROTO_CLIENT_NAME,
			toolName,
		}),
		...(step.result ? { result: createMcpToolCallResult(step.result.content, step.result.isError) } : {}),
	});
	return toBinary(ConversationStepSchema, create(ConversationStepSchema, {
		message: {
			case: "toolCall",
			value: create(ToolCallSchema, { tool: { case: "mcpToolCall", value: mcpToolCall } }),
		},
	}));
}

function validateCursorImageSerializationContext(request: CursorRunRequest): void {
	let hasUserImages = false;
	for (const message of request.context.messages) {
		if (message.role === "toolResult") {
			if (message.content.some((part) => part.type === "image")) throw new Error(CURSOR_TOOL_RESULT_IMAGE_SERIALIZATION_ERROR);
			continue;
		}
		if (message.role !== "user" || typeof message.content === "string") continue;
		if (message.content.some((part) => part.type === "image")) hasUserImages = true;
	}
	if (hasUserImages && request.experimentalImageInput !== true) throw new Error(CURSOR_IMAGE_SERIALIZATION_OPT_IN_ERROR);
}

function parseHistoricalTurns(messages: readonly CursorRunRequest["context"]["messages"][number][]): readonly ParsedTurn[] {
	const turns: ParsedTurn[] = [];
	let currentTurn: { userText: string; steps: ParsedTurnStep[]; toolCallById: Map<string, ParsedToolCallStep> } | undefined;
	const ensureTurn = (): { userText: string; steps: ParsedTurnStep[]; toolCallById: Map<string, ParsedToolCallStep> } => {
		currentTurn ??= { userText: "", steps: [], toolCallById: new Map() };
		return currentTurn;
	};
	const flushTurn = (): void => {
		if (!currentTurn) return;
		if (currentTurn.userText || currentTurn.steps.length > 0) turns.push({ userText: currentTurn.userText, steps: currentTurn.steps });
		currentTurn = undefined;
	};
	for (const message of messages) {
		if (message.role === "user") {
			flushTurn();
			currentTurn = { userText: textFromMessage(message), steps: [], toolCallById: new Map() };
		} else if (message.role === "assistant") {
			const turn = ensureTurn();
			for (const part of message.content) {
				if (part.type === "text") appendAssistantTextStep(turn.steps, part.text);
				else if (part.type === "thinking") appendAssistantTextStep(turn.steps, part.thinking);
				else {
					const step: ParsedToolCallStep = { kind: "toolCall", toolCallId: part.id, toolName: part.name, arguments: parseJsonObject(JSON.stringify(part.arguments)) ?? {} };
					turn.steps.push(step);
					turn.toolCallById.set(step.toolCallId, step);
				}
			}
		} else {
			const turn = ensureTurn();
			let step = turn.toolCallById.get(message.toolCallId);
			if (!step) {
				step = { kind: "toolCall", toolCallId: message.toolCallId, toolName: message.toolName, arguments: {} };
				turn.steps.push(step);
				turn.toolCallById.set(step.toolCallId, step);
			}
			step.result = { content: rawToolResultText(message), isError: message.isError };
		}
	}
	flushTurn();
	return turns;
}

function appendAssistantTextStep(steps: ParsedTurnStep[], text: string): void {
	if (!text) return;
	const last = steps.at(-1);
	if (last?.kind === "assistantText") {
		steps[steps.length - 1] = { kind: "assistantText", text: `${last.text}${text}` };
		return;
	}
	steps.push({ kind: "assistantText", text });
}

function decodeAgentServerMessage(message: AgentServerMessage): readonly CursorProtocolMessage[] {
	switch (message.message.case) {
		case "interactionUpdate": {
			const update = message.message.value;
			if (update.message.case === "textDelta") return update.message.value.text ? [{ type: "textDelta", text: update.message.value.text }] : [];
			if (update.message.case === "thinkingDelta") return update.message.value.text ? [{ type: "thinkingDelta", text: update.message.value.text }] : [];
			if (update.message.case === "tokenDelta") return [{ type: "usage", kind: "outputDelta", outputTokens: update.message.value.tokens }];
			return [];
		}
		case "conversationCheckpointUpdate": {
			const checkpointState = message.message.value;
			const checkpoint = toBinary(ConversationStateStructureSchema, checkpointState);
			const messages: CursorProtocolMessage[] = [{ type: "conversationCheckpoint", checkpoint }];
			if (checkpointState.tokenDetails) messages.push({ type: "usage", kind: "checkpoint", usedTokens: checkpointState.tokenDetails.usedTokens });
			return messages;
		}
		case "kvServerMessage":
			return decodeKvServerMessage(message.message.value);
		case "execServerMessage":
			return decodeExecServerMessage(message.message.value);
		case "interactionQuery":
			return [];
		default:
			return [];
	}
}

function decodeKvServerMessage(kvMessage: KvServerMessage): readonly CursorControlMessage[] {
	if (kvMessage.message.case === "getBlobArgs") return [{ type: "kvGetBlob", id: kvMessage.id, blobId: kvMessage.message.value.blobId }];
	if (kvMessage.message.case === "setBlobArgs") {
		return [{ type: "kvSetBlob", id: kvMessage.id, blobId: kvMessage.message.value.blobId, blobData: kvMessage.message.value.blobData }];
	}
	return [];
}

function decodeExecServerMessage(execMessage: ExecServerMessage): readonly CursorProtocolMessage[] {
	const execCase = execMessage.message.case;
	if (execCase === "requestContextArgs") {
		return [{ type: "requestContext", ...(execMessage.execId ? { execId: execMessage.execId } : {}), execNumericId: execMessage.id }];
	}
	if (execCase === "mcpArgs") {
		const mcpArgs = execMessage.message.value;
		return [{
			type: "toolCall",
			id: mcpArgs.toolCallId || randomUUID(),
			name: mcpArgs.toolName || mcpArgs.name || "cursor_tool",
			argumentsJson: JSON.stringify(decodeMcpArgsMap(mcpArgs.args ?? {})),
			...(execMessage.execId ? { execId: execMessage.execId } : {}),
			execNumericId: execMessage.id,
		}];
	}
	const fieldNumber = execCase ? EXEC_CASE_FIELD_NUMBERS.get(execCase) : undefined;
	return fieldNumber === undefined ? [] : [{ type: "nonMcpExec", fieldNumber, ...(execMessage.execId ? { execId: execMessage.execId } : {}), execNumericId: execMessage.id }];
}

function encodeKvClientMessage(id: number, messageCase: "getBlobResult" | "setBlobResult", value: unknown): Uint8Array {
	const response = create(KvClientMessageSchema, { id, message: { case: messageCase, value } as never });
	const clientMessage = create(AgentClientMessageSchema, { message: { case: "kvClientMessage", value: response } });
	return toBinary(AgentClientMessageSchema, clientMessage);
}

function encodeRequestContextResult(message: Extract<CursorControlMessage, { readonly type: "requestContext" }>, toolDefinitions: readonly McpToolDefinition[]): Uint8Array {
	const requestContext = create(RequestContextSchema, {
		rules: [],
		repositoryInfo: [],
		tools: [...toolDefinitions],
		gitRepos: [],
		projectLayouts: [],
		mcpInstructions: [],
		fileContents: {},
		customSubagents: [],
	});
	const result = create(RequestContextResultSchema, {
		result: { case: "success", value: create(RequestContextSuccessSchema, { requestContext }) },
	});
	return encodeExecClientMessage(message.execNumericId, message.execId, "requestContextResult", result);
}

function encodeNativeExecRejection(message: Extract<CursorServerMessage, { readonly type: "nonMcpExec" }>): Uint8Array | undefined {
	const result = createNativeExecResult(message.fieldNumber);
	return result ? encodeExecClientMessage(message.execNumericId, message.execId, result.caseName, result.value) : undefined;
}

function createNativeExecResult(fieldNumber: number): { readonly caseName: string; readonly value: unknown } | undefined {
	switch (fieldNumber) {
		case 2:
			return { caseName: "shellResult", value: create(ShellResultSchema, { result: { case: "rejected", value: createShellRejected() } }) };
		case 3:
			return { caseName: "writeResult", value: create(WriteResultSchema, { result: { case: "rejected", value: create(WriteRejectedSchema, { path: "", reason: NATIVE_EXEC_REJECT_REASON }) } }) };
		case 4:
			return { caseName: "deleteResult", value: create(DeleteResultSchema, { result: { case: "rejected", value: create(DeleteRejectedSchema, { path: "", reason: NATIVE_EXEC_REJECT_REASON }) } }) };
		case 5:
			return { caseName: "grepResult", value: create(GrepResultSchema, { result: { case: "error", value: create(GrepErrorSchema, { error: NATIVE_EXEC_REJECT_REASON }) } }) };
		case 7:
			return { caseName: "readResult", value: create(ReadResultSchema, { result: { case: "rejected", value: create(ReadRejectedSchema, { path: "", reason: NATIVE_EXEC_REJECT_REASON }) } }) };
		case 8:
			return { caseName: "lsResult", value: create(LsResultSchema, { result: { case: "rejected", value: create(LsRejectedSchema, { path: "", reason: NATIVE_EXEC_REJECT_REASON }) } }) };
		case 9:
			return { caseName: "diagnosticsResult", value: create(DiagnosticsResultSchema, {}) };
		case 14:
			return { caseName: "shellStream", value: create(ShellStreamSchema, { event: { case: "rejected", value: createShellRejected() } }) };
		case 16:
			return { caseName: "backgroundShellSpawnResult", value: create(BackgroundShellSpawnResultSchema, { result: { case: "rejected", value: createShellRejected() } }) };
		case 17:
			return { caseName: "listMcpResourcesExecResult", value: create(McpResultSchema, {}) };
		case 18:
			return { caseName: "readMcpResourceExecResult", value: create(McpResultSchema, {}) };
		case 20:
			return { caseName: "fetchResult", value: create(FetchResultSchema, { result: { case: "error", value: create(FetchErrorSchema, { url: "", error: NATIVE_EXEC_REJECT_REASON }) } }) };
		case 21:
			return { caseName: "recordScreenResult", value: create(McpResultSchema, {}) };
		case 22:
			return { caseName: "computerUseResult", value: create(McpResultSchema, {}) };
		case 23:
			return { caseName: "writeShellStdinResult", value: create(WriteShellStdinResultSchema, { result: { case: "error", value: create(WriteShellStdinErrorSchema, { error: NATIVE_EXEC_REJECT_REASON }) } }) };
		default:
			return undefined;
	}
}

function createShellRejected(): ReturnType<typeof create<typeof ShellRejectedSchema>> {
	return create(ShellRejectedSchema, {
		command: "",
		workingDirectory: "",
		reason: NATIVE_EXEC_REJECT_REASON,
		isReadonly: false,
	});
}

function encodeExecClientMessage(execNumericId: number | undefined, execId: string | undefined, messageCase: string, value: unknown): Uint8Array {
	const execClientMessage = create(ExecClientMessageSchema, {
		id: execNumericId ?? 0,
		execId: execId ?? "",
		message: { case: messageCase, value } as never,
	});
	const clientMessage = create(AgentClientMessageSchema, { message: { case: "execClientMessage", value: execClientMessage } });
	return toBinary(AgentClientMessageSchema, clientMessage);
}

function createMcpToolResult(text: string, isError: boolean): ReturnType<typeof create<typeof McpResultSchema>> {
	if (isError) {
		return create(McpResultSchema, { result: { case: "error", value: create(McpErrorSchema, { error: text }) } });
	}
	return create(McpResultSchema, {
		result: {
			case: "success",
			value: createMcpSuccess(text),
		},
	});
}

function createMcpToolCallResult(text: string, isError: boolean): ReturnType<typeof create<typeof McpToolResultSchema>> {
	if (isError) {
		return create(McpToolResultSchema, { result: { case: "error", value: create(McpToolErrorSchema, { error: text }) } });
	}
	return create(McpToolResultSchema, { result: { case: "success", value: createMcpSuccess(text) } });
}

function createMcpSuccess(text: string): ReturnType<typeof create<typeof McpSuccessSchema>> {
	return create(McpSuccessSchema, {
		content: [create(McpToolResultContentItemSchema, { content: { case: "text", value: create(McpTextContentSchema, { text }) } })],
		isError: false,
	});
}

function encodeProtobufValue(value: JsonValue): Uint8Array {
	return toBinary(ValueSchema, fromJson(ValueSchema, value as ProtobufJsonValue));
}

function encodeMcpArgValue(value: JsonValue): Uint8Array {
	try {
		return encodeProtobufValue(value);
	} catch {
		return textEncoder.encode(String(value));
	}
}

function encodeMcpArgsMap(args: JsonObject): Record<string, Uint8Array> {
	const encoded: Record<string, Uint8Array> = {};
	for (const [key, value] of Object.entries(args)) encoded[key] = encodeMcpArgValue(value);
	return encoded;
}

function decodeMcpArgValue(value: Uint8Array): JsonValue {
	try {
		const decoded = toJson(ValueSchema, fromBinary(ValueSchema, value)) as ProtobufJsonValue;
		return parseJsonValue(JSON.stringify(decoded)) ?? null;
	} catch {
		return textDecoder.decode(value);
	}
}

function decodeMcpArgsMap(args: Record<string, Uint8Array>): JsonObject {
	const decoded: JsonObject = {};
	for (const [key, value] of Object.entries(args)) decoded[key] = decodeMcpArgValue(value);
	return decoded;
}

function serializableJsonValue(value: object): JsonValue {
	return parseJsonValue(JSON.stringify(value)) ?? {};
}

function extractCurrentActionText(request: CursorRunRequest): string {
	const last = request.context.messages.at(-1);
	return last ? textFromMessage(last) : "";
}

function extractCurrentActionImages(request: CursorRunRequest): readonly ImageContent[] {
	const last = request.context.messages.at(-1);
	if (last?.role !== "user" || typeof last.content === "string") return [];
	return last.content.filter((part): part is ImageContent => part.type === "image");
}

function rawToolResultText(message: Extract<CursorRunRequest["context"]["messages"][number], { readonly role: "toolResult" }>): string {
	if (message.content.some((part) => part.type === "image")) throw new Error(CURSOR_TOOL_RESULT_IMAGE_SERIALIZATION_ERROR);
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
	return rawToolResultText(message);
}

function buildSelectedContextBlob(rootPromptBlobIds: readonly Uint8Array[], clientName: string): Uint8Array {
	const parts: Uint8Array[] = [];
	for (const blobId of rootPromptBlobIds) {
		parts.push(new Uint8Array([0x0a, blobId.length, ...blobId]));
	}
	const clientBytes = textEncoder.encode(clientName);
	parts.push(new Uint8Array([0xb2, 0x01, clientBytes.length, ...clientBytes]));
	return concatBytes(...parts);
}

function storeAsBlob(data: Uint8Array, blobStore: Map<string, Uint8Array>): Uint8Array {
	const blobId = new Uint8Array(createHash("sha256").update(data).digest());
	blobStore.set(blobKey(blobId), data);
	return blobId;
}

function blobKey(blobId: Uint8Array): string {
	return Buffer.from(blobId).toString("hex");
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
