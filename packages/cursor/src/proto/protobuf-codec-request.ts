import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import type { ImageContent } from "@earendil-works/pi-ai";
import { parseJsonObject, type JsonObject } from "../config.js";
import type { CursorRunRequest } from "../transport.js";
import {
	AgentClientMessageSchema,
	AgentConversationTurnStructureSchema,
	AgentRunRequestSchema,
	AssistantMessageSchema,
	ConversationActionSchema,
	ConversationStateStructureSchema,
	ConversationStepSchema,
	ConversationTurnStructureSchema,
	McpArgsSchema,
	McpToolCallSchema,
	McpToolDefinitionSchema,
	ModelDetailsSchema,
	SelectedContextSchema,
	SelectedImageSchema,
	ToolCallSchema,
	UserMessageActionSchema,
	UserMessageSchema,
	type ConversationStateStructure,
	type McpToolDefinition,
	type SelectedImage,
	type UserMessage,
} from "./agent_pb.js";
import { encodeMcpArgsMap, encodeProtobufValue, serializableJsonValue } from "./protobuf-codec-json.js";
import { createMcpToolCallResult } from "./protobuf-codec-wire.js";

export interface ParsedAssistantTextStep {
	readonly kind: "assistantText";
	readonly text: string;
}

export interface ParsedToolCallStep {
	readonly kind: "toolCall";
	readonly toolCallId: string;
	readonly toolName: string;
	readonly arguments: JsonObject;
	result?: { readonly content: string; readonly isError: boolean };
}

export type ParsedTurnStep = ParsedAssistantTextStep | ParsedToolCallStep;

export interface ParsedTurn {
	readonly userText: string;
	readonly steps: ParsedTurnStep[];
}

const CURSOR_PROTO_CLIENT_NAME = "pi";
const CURSOR_TOOL_RESULT_IMAGE_SERIALIZATION_ERROR = "Cursor experimental image input serialization does not support tool-result images.";
const CURSOR_IMAGE_DECODE_ERROR = "Cursor experimental image input could not decode an image content block because the image payload is not valid base64/data URL base64. Remove image content or switch to a vision-capable provider.";
const textEncoder = new TextEncoder();
export function buildMcpToolDefinitions(request: CursorRunRequest): readonly McpToolDefinition[] {
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

export function buildCursorRequest(
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
	const normalized = encoded.replace(/[ \t\r\n\f\v]/gu, "");
	if (normalized.length === 0 || /[^A-Za-z0-9+/=]/u.test(normalized)) throw new Error(CURSOR_IMAGE_DECODE_ERROR);
	const firstPaddingIndex = normalized.indexOf("=");
	const hasPadding = firstPaddingIndex !== -1;
	if (hasPadding) {
		const padding = normalized.slice(firstPaddingIndex);
		if (!/^={1,2}$/u.test(padding) || normalized.length % 4 !== 0) throw new Error(CURSOR_IMAGE_DECODE_ERROR);
	} else if (normalized.length % 4 === 1) {
		throw new Error(CURSOR_IMAGE_DECODE_ERROR);
	}
	const padded = hasPadding ? normalized : normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
	const bytes = Buffer.from(padded, "base64");
	const canonical = bytes.toString("base64");
	const actual = hasPadding ? canonical : canonical.replace(/=+$/u, "");
	if (actual !== normalized) throw new Error(CURSOR_IMAGE_DECODE_ERROR);
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

export function parseHistoricalTurns(messages: readonly CursorRunRequest["context"]["messages"][number][]): readonly ParsedTurn[] {
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

export function currentActionStartIndex(request: CursorRunRequest): number {
	let index = request.context.messages.length - 1;
	while (index >= 0 && request.context.messages[index]?.role === "user") index--;
	return index + 1;
}

function currentActionUserMessages(request: CursorRunRequest): readonly Extract<CursorRunRequest["context"]["messages"][number], { readonly role: "user" }>[] {
	return request.context.messages.slice(currentActionStartIndex(request)).filter((message) => message.role === "user");
}

export function extractCurrentActionText(request: CursorRunRequest): string {
	return currentActionUserMessages(request).map(textFromMessage).join("\n");
}

export function extractCurrentActionImages(request: CursorRunRequest): readonly ImageContent[] {
	return currentActionUserMessages(request).flatMap((message) => {
		if (typeof message.content === "string") return [];
		return message.content.filter((part): part is ImageContent => part.type === "image");
	});
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

export function blobKey(blobId: Uint8Array): string {
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
