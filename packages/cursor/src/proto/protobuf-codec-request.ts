import { createHash, randomUUID } from "node:crypto";
import { create, toBinary } from "@bufbuild/protobuf";
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
	RequestedModelSchema,
	SelectedContextSchema,
	ThinkingMessageSchema,
	ToolCallSchema,
	UserMessageActionSchema,
	UserMessageSchema,
	type ConversationStateStructure,
	type McpToolDefinition,
	type UserMessage,
} from "./cursor-protocol.js";
import { encodeMcpArgsMap, encodeProtobufValue, serializableJsonValue } from "./protobuf-codec-json.js";
import { createMcpToolCallResult } from "./protobuf-codec-wire.js";

export interface ParsedAssistantTextStep { readonly kind: "assistantText"; readonly text: string; }
export interface ParsedAssistantThinkingStep { readonly kind: "assistantThinking"; readonly text: string; }
export interface ParsedToolCallStep {
	readonly kind: "toolCall";
	readonly toolCallId: string;
	readonly toolName: string;
	readonly arguments: JsonObject;
	result?: { readonly content: string; readonly isError: boolean };
}
export type ParsedTurnStep = ParsedAssistantTextStep | ParsedAssistantThinkingStep | ParsedToolCallStep;

export interface ParsedTurn {
	readonly userText: string;
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
	reference: import("../route-reference.js").CursorRouteReference,
	systemPrompt: string,
	userText: string,
	turns: readonly ParsedTurn[],
	conversationId: string,
): { readonly requestBytes: Uint8Array; readonly blobStore: Map<string, Uint8Array> } {
	const blobStore = new Map<string, Uint8Array>();
	const systemBlobId = storeAsBlob(textEncoder.encode(JSON.stringify({ role: "system", content: systemPrompt })), blobStore);
	const selectedContextBlob = storeAsBlob(buildSelectedContextBlob([systemBlobId], CURSOR_PROTO_CLIENT_NAME), blobStore);
	const conversationState = buildConversationState(turns, blobStore, systemBlobId, selectedContextBlob);
	const userMessage = createUserMessage(userText, selectedContextBlob);
	const action = create(ConversationActionSchema, {
		action: { case: "userMessageAction", value: create(UserMessageActionSchema, { userMessage }) },
	});
	const modelDetails = create(ModelDetailsSchema, {
		modelId: reference.routeId,
		maxMode: reference.maxMode,
	});
	if (reference.maxMode === undefined) modelDetails.maxMode = undefined;
	const requestedModel = create(RequestedModelSchema, {
		modelId: reference.routeId,
		maxMode: reference.maxMode === true,
		parameters: [],
	});
	const runRequest = create(AgentRunRequestSchema, { conversationState, action, modelDetails, requestedModel, conversationId });
	const clientMessage = create(AgentClientMessageSchema, { message: { case: "runRequest", value: runRequest } });
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
		mode: 1,
		clientName: CURSOR_PROTO_CLIENT_NAME,
	});
}

function createUserMessage(text: string, selectedContextBlob: Uint8Array): UserMessage {
	const messageId = randomUUID();
	return create(UserMessageSchema, {
		text,
		messageId,
		selectedContext: create(SelectedContextSchema, { selectedImages: [] }),
		mode: 1,
		selectedContextBlob,
		correlationId: messageId,
	});
}

function buildTurnStepBytes(step: ParsedTurnStep): Uint8Array {
	if (step.kind === "assistantText") {
		return toBinary(ConversationStepSchema, create(ConversationStepSchema, {
			message: { case: "assistantMessage", value: create(AssistantMessageSchema, { text: step.text }) },
		}));
	}
	if (step.kind === "assistantThinking") {
		return toBinary(ConversationStepSchema, create(ConversationStepSchema, {
			message: { case: "thinkingMessage", value: create(ThinkingMessageSchema, { text: step.text, durationMs: 0 }) },
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
		message: { case: "toolCall", value: create(ToolCallSchema, { tool: { case: "mcpToolCall", value: mcpToolCall } }) },
	}));
}

export function parseHistoricalTurns(messages: readonly CursorRunRequest["context"]["messages"][number][]): readonly ParsedTurn[] {
	const turns: ParsedTurn[] = [];
	let current: { userText: string; hasUser: boolean; steps: ParsedTurnStep[]; unmatchedCalls: Map<string, ParsedToolCallStep[]> } | undefined;
	const flush = (): void => {
		if (current && (current.hasUser || current.steps.length > 0)) turns.push({ userText: current.userText, steps: current.steps });
		current = undefined;
	};
	for (const message of messages) {
		if (message.role === "user") {
			flush();
			current = { userText: textFromMessage(message), hasUser: true, steps: [], unmatchedCalls: new Map() };
			continue;
		}
		if (message.role === "assistant") {
			current ??= { userText: "", hasUser: false, steps: [], unmatchedCalls: new Map() };
			for (const part of message.content) {
				if (part.type === "text") current.steps.push({ kind: "assistantText", text: part.text });
				else if (part.type === "thinking") current.steps.push({ kind: "assistantThinking", text: part.thinking });
				else if (part.type === "toolCall") {
					const step: ParsedToolCallStep = { kind: "toolCall", toolCallId: part.id, toolName: part.name, arguments: parseJsonObject(JSON.stringify(part.arguments)) ?? {} };
					current.steps.push(step);
					const queue = current.unmatchedCalls.get(part.id) ?? [];
					queue.push(step);
					current.unmatchedCalls.set(part.id, queue);
				}
			}
			continue;
		}
		current ??= { userText: "", hasUser: false, steps: [], unmatchedCalls: new Map() };
		const queue = current.unmatchedCalls.get(message.toolCallId);
		const step = queue?.shift();
		const result = { content: rawToolResultText(message), isError: message.isError };
		if (step) step.result = result;
		else current.steps.push({ kind: "assistantText", text: result.content });
	}
	flush();
	return turns;
}
export function extractCurrentActionText(request: CursorRunRequest): string {
	const last = request.context.messages.at(-1);
	return last?.role === "user" ? textFromMessage(last) : "";
}


function rawToolResultText(message: Extract<CursorRunRequest["context"]["messages"][number], { readonly role: "toolResult" }>): string {
	return message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
}

function textFromMessage(message: CursorRunRequest["context"]["messages"][number]): string {
	if (message.role === "user") {
		if (typeof message.content === "string") return message.content;
		return message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
	}
	if (message.role === "assistant") {
		return message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
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
