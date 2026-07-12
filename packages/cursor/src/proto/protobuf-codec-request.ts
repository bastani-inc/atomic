import { createHash, randomUUID } from "node:crypto";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import type { ImageContent } from "@earendil-works/pi-ai/compat";
import { parseJsonObject, type JsonObject } from "../config.js";
import type { CursorRunRequest, CursorToolResultContent } from "../transport.js";
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
	RequestedModelSchema,
	RequestedModel_ModelParameterbytesSchema,
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
import { decodeStrictBase64ImageData } from "./protobuf-codec-base64.js";
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
	result?: { readonly content: string | readonly CursorToolResultContent[]; readonly isError: boolean; readonly fallbackText?: string };
}

export type ParsedTurnStep = ParsedAssistantTextStep | ParsedToolCallStep;

export interface ParsedTurn {
	readonly userText: string;
	readonly userImages: readonly ImageContent[];
	readonly steps: ParsedTurnStep[];
}

const CURSOR_PROTO_CLIENT_NAME = "pi";
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
	turns: readonly ParsedTurn[],
	conversationId: string,
	checkpoint: Uint8Array | null,
	existingBlobStore?: Map<string, Uint8Array>,
	userImages: readonly ImageContent[] = [],
	routing?: { readonly modelId?: string; readonly maxMode?: boolean; readonly parameters?: readonly { readonly id: string; readonly value: string }[] },
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
	const requestedModel = routing?.modelId ? create(RequestedModelSchema, {
		modelId: routing.modelId,
		maxMode: routing.maxMode ?? false,
		parameters: (routing.parameters ?? []).map((parameter) => create(RequestedModel_ModelParameterbytesSchema, parameter)),
	}) : undefined;
	const runRequest = create(AgentRunRequestSchema, { conversationState, action, modelDetails, requestedModel, conversationId });
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
		const userMessage = createUserMessage(turn.userText, selectedContextBlob, turn.userImages);
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
	const selectedImages = images.map((image, index) => createSelectedImage(image, index));
	return create(UserMessageSchema, {
		text,
		messageId,
		selectedContext: create(SelectedContextSchema, { selectedImages }),
		mode: 1,
		selectedContextBlob,
		correlationId: messageId,
	});
}

function createSelectedImage(image: ImageContent, index: number): SelectedImage {
	const data = decodeStrictBase64ImageData(image.data, { kind: "selected image", mimeType: image.mimeType, index });
	const hash = createHash("sha256").update(data).digest("hex").slice(0, 16);
	return create(SelectedImageSchema, {
		uuid: randomUUID(),
		path: `/atomic/inline-images/${hash}-${index}.${extensionForMimeType(image.mimeType)}`,
		mimeType: image.mimeType,
		dataOrBlobId: { case: "data", value: data },
	});
}

function extensionForMimeType(mimeType: string): string {
	const normalized = mimeType.toLowerCase();
	if (normalized === "image/jpeg" || normalized === "image/jpg") return "jpg";
	if (normalized === "image/png") return "png";
	if (normalized === "image/gif") return "gif";
	if (normalized === "image/webp") return "webp";
	return "img";
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
		...(step.result ? { result: createMcpToolCallResult(step.result.content, step.result.isError, step.result.fallbackText ?? "") } : {}),
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
	let currentTurn: { userText: string; userImages: readonly ImageContent[]; steps: ParsedTurnStep[]; toolCallById: Map<string, ParsedToolCallStep> } | undefined;
	const ensureTurn = (): { userText: string; userImages: readonly ImageContent[]; steps: ParsedTurnStep[]; toolCallById: Map<string, ParsedToolCallStep> } => {
		currentTurn ??= { userText: "", userImages: [], steps: [], toolCallById: new Map() };
		return currentTurn;
	};
	const flushTurn = (): void => {
		if (!currentTurn) return;
		if (currentTurn.userText || currentTurn.userImages.length > 0 || currentTurn.steps.length > 0) {
			turns.push({ userText: currentTurn.userText, userImages: currentTurn.userImages, steps: currentTurn.steps });
		}
		currentTurn = undefined;
	};
	for (const message of messages) {
		if (message.role === "user") {
			flushTurn();
			currentTurn = { userText: textFromMessage(message), userImages: imagesFromUserMessage(message), steps: [], toolCallById: new Map() };
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
			step.result = { content: message.content, isError: message.isError, fallbackText: rawToolResultText(message) };
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

export function extractCurrentActionText(request: CursorRunRequest): string {
	const last = request.context.messages.at(-1);
	return last ? textFromMessage(last) : "";
}

export function extractCurrentActionImages(request: CursorRunRequest): readonly ImageContent[] {
	const last = request.context.messages.at(-1);
	if (!last || last.role !== "user") return [];
	return imagesFromUserMessage(last);
}

function imagesFromUserMessage(message: Extract<CursorRunRequest["context"]["messages"][number], { readonly role: "user" }>): readonly ImageContent[] {
	if (typeof message.content === "string") return [];
	return message.content.filter((part): part is ImageContent => part.type === "image");
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
