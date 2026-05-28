import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { create, fromBinary, fromJson, toBinary, toJson, type JsonValue } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import type { CursorModelsBridge } from "./models.ts";
import type { CursorProxyBridge, CursorProxyBridgeChunk } from "./proxy.ts";
import {
	AgentClientMessageSchema,
	AgentConversationTurnStructureSchema,
	AgentRunRequestSchema,
	AgentServerMessageSchema,
	AssistantMessageSchema,
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
	McpToolErrorSchema,
	McpSuccessSchema,
	McpTextContentSchema,
	McpToolCallSchema,
	McpToolDefinitionSchema,
	McpToolResultContentItemSchema,
	McpToolResultSchema,
	ModelDetailsSchema,
	ReadRejectedSchema,
	ReadResultSchema,
	RequestContextResultSchema,
	RequestContextSchema,
	RequestContextSuccessSchema,
	ResumeActionSchema,
	SelectedContextSchema,
	SetBlobResultSchema,
	ShellRejectedSchema,
	ShellResultSchema,
	ShellStreamSchema,
	ToolCallSchema,
	UserMessageActionSchema,
	UserMessageSchema,
	WriteRejectedSchema,
	WriteResultSchema,
	type AgentServerMessage,
	type ConversationStateStructure,
	type ExecServerMessage,
	type KvServerMessage,
	type McpToolDefinition,
	type UserMessage,
} from "./proto/agent_pb.ts";

export interface CursorBridge extends CursorModelsBridge, CursorProxyBridge {
	clearSession(sessionId: string): void;
	close(): Promise<void> | void;
}

export interface CursorBridgeOptions {
	bridgePath?: string;
	nodeExecutable?: string;
	requestTimeoutMs?: number;
	toolCallCollectionWindowMs?: number;
	debug?: (event: string, details?: unknown) => void;
}

interface BridgeHandle {
	proc: Pick<ChildProcess, "kill">;
	readonly alive: boolean;
	write(data: Uint8Array): void;
	end(): void;
	onData(cb: (chunk: Buffer) => void): void;
	onClose(cb: (code: number, error?: Error) => void): void;
}

interface OpenAIToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

interface OpenAIMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string | null | { type: string; text?: string }[];
	tool_call_id?: string;
	tool_calls?: OpenAIToolCall[];
}

interface OpenAIToolDef {
	type: "function";
	function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

interface ParsedToolResult {
	content: string;
	isError: boolean;
}

interface ToolCallIndexState {
	nextIndex: number;
	byToolCallId: Map<string, number>;
}

interface ParsedAssistantTextStep {
	kind: "assistantText";
	text: string;
}

interface ParsedToolCallStep {
	kind: "toolCall";
	toolCallId: string;
	toolName: string;
	arguments: Record<string, unknown>;
	result?: ParsedToolResult;
}

type ParsedTurnStep = ParsedAssistantTextStep | ParsedToolCallStep;

interface ParsedTurn {
	userText: string;
	steps: ParsedTurnStep[];
}

interface ParsedMessages {
	systemPrompt: string;
	userText: string;
	turns: ParsedTurn[];
	toolResultContinuation: boolean;
}

interface StoredSession {
	conversationId: string;
	checkpoint?: Uint8Array;
	blobStore: Map<string, Uint8Array>;
	lastAccessMs: number;
}

const CURSOR_API_URL = "https://api2.cursor.sh";
const CONNECT_COMPRESSED_FLAG = 0b0000_0001;
const CONNECT_END_STREAM_FLAG = 0b0000_0010;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_TOOL_CALL_COLLECTION_WINDOW_MS = 150;
const DEFAULT_BRIDGE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "h2-bridge.mjs");
const SESSION_TTL_MS = 30 * 60_000;
const BRIDGE_STDERR_LIMIT = 8 * 1024;

function lpEncode(data: Uint8Array): Buffer {
	const buf = Buffer.alloc(4 + data.length);
	buf.writeUInt32BE(data.length, 0);
	buf.set(data, 4);
	return buf;
}

function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
	const frame = Buffer.alloc(5 + data.length);
	frame[0] = flags;
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, 5);
	return frame;
}

function bridgeStartError(message: string): Error {
	return new Error(`Cursor bridge failed to start: ${message}`);
}

function sanitizeBridgeStderr(stderr: Buffer, accessToken: string): string {
	let message = stderr.toString("utf8").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ").trim();
	if (!message) return "";
	message = message.replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]");
	if (accessToken) message = message.split(accessToken).join("[REDACTED]");
	return message;
}

function killQuietly(proc: Pick<ChildProcess, "kill">): void {
	try {
		proc.kill();
	} catch {}
}

function spawnH2Bridge(options: Required<Pick<CursorBridgeOptions, "bridgePath" | "nodeExecutable">> & {
	accessToken: string;
	rpcPath: string;
	unary?: boolean;
	debug?: (event: string, details?: unknown) => void;
}): BridgeHandle {
	options.debug?.("bridge.spawn", { rpcPath: options.rpcPath, unary: options.unary ?? false, bridgePath: options.bridgePath, nodeExecutable: options.nodeExecutable });
	let exited = false;
	let exitCode = 1;
	let closeError: Error | undefined;
	let pending = Buffer.alloc(0);
	let stderr = Buffer.alloc(0);
	const callbacks: { data?: (chunk: Buffer) => void; close?: (code: number, error?: Error) => void } = {};
	const closeOnce = (code: number, error?: Error) => {
		if (exited) return;
		exited = true;
		exitCode = code;
		closeError = error;
		options.debug?.("bridge.exit", { rpcPath: options.rpcPath, exitCode, error: error?.message });
		callbacks.close?.(exitCode, closeError);
	};
	const closedHandle = (): BridgeHandle => ({
		proc: { kill: () => false },
		get alive() {
			return false;
		},
		write() {},
		end() {},
		onData(cb) {
			callbacks.data = cb;
		},
		onClose(cb) {
			callbacks.close = cb;
			queueMicrotask(() => cb(exitCode, closeError));
		},
	});

	if (!existsSync(options.bridgePath)) {
		closeOnce(1, bridgeStartError(`h2-bridge.mjs not found at ${options.bridgePath}`));
		return closedHandle();
	}

	let proc: ChildProcess;
	try {
		proc = spawn(options.nodeExecutable, [options.bridgePath], { stdio: ["pipe", "pipe", "pipe"] });
	} catch (error) {
		closeOnce(1, bridgeStartError(`Node executable "${options.nodeExecutable}" could not be spawned: ${error instanceof Error ? error.message : String(error)}`));
		return closedHandle();
	}

	proc.on("error", (error) => closeOnce(1, bridgeStartError(`Node executable "${options.nodeExecutable}" failed: ${error.message}`)));

	if (!proc.stdin || !proc.stdout) {
		closeOnce(1, bridgeStartError("child stdio pipes are unavailable"));
	}

	try {
		proc.stdin?.write(
			lpEncode(
				new TextEncoder().encode(
					JSON.stringify({ accessToken: options.accessToken, url: CURSOR_API_URL, path: options.rpcPath, unary: options.unary ?? false }),
				),
			),
		);
	} catch (error) {
		closeOnce(1, bridgeStartError(`initial bridge write failed: ${error instanceof Error ? error.message : String(error)}`));
	}

	proc.stdout?.on("data", (chunk: Buffer) => {
		pending = Buffer.concat([pending, chunk]);
		while (pending.length >= 4) {
			const len = pending.readUInt32BE(0);
			if (pending.length < 4 + len) break;
			const payload = pending.subarray(4, 4 + len);
			pending = pending.subarray(4 + len);
			callbacks.data?.(Buffer.from(payload));
		}
	});

	proc.stderr?.on("data", (chunk: Buffer) => {
		if (stderr.length >= BRIDGE_STDERR_LIMIT) return;
		const remaining = BRIDGE_STDERR_LIMIT - stderr.length;
		stderr = Buffer.concat([stderr, chunk.subarray(0, remaining)]);
	});

	proc.on("close", (code) => {
		const resolvedCode = code ?? 1;
		if (resolvedCode === 0) {
			closeOnce(resolvedCode);
			return;
		}
		const stderrMessage = sanitizeBridgeStderr(stderr, options.accessToken);
		closeOnce(resolvedCode, new Error(stderrMessage || `Cursor bridge exited with code ${resolvedCode}`));
	});

	return {
		proc,
		get alive() {
			return !exited;
		},
		write(data: Uint8Array) {
			try {
				if (!proc.stdin || exited) return;
				proc.stdin.write(lpEncode(data));
			} catch (error) {
				closeOnce(1, bridgeStartError(`bridge write failed: ${error instanceof Error ? error.message : String(error)}`));
			}
		},
		end() {
			try {
				if (!proc.stdin || exited) return;
				proc.stdin.write(lpEncode(new Uint8Array(0)));
				proc.stdin.end();
			} catch (error) {
				closeOnce(1, bridgeStartError(`bridge end failed: ${error instanceof Error ? error.message : String(error)}`));
			}
		},
		onData(cb) {
			callbacks.data = cb;
		},
		onClose(cb) {
			if (exited) queueMicrotask(() => cb(exitCode, closeError));
			else callbacks.close = cb;
		},
	};
}

function decodeConnectUnaryBody(payload: Uint8Array): Uint8Array | undefined {
	if (payload.length < 5) return undefined;
	let offset = 0;
	while (offset + 5 <= payload.length) {
		const flags = payload[offset]!;
		const messageLength = new DataView(payload.buffer, payload.byteOffset + offset, payload.byteLength - offset).getUint32(1, false);
		const frameEnd = offset + 5 + messageLength;
		if (frameEnd > payload.length) return undefined;
		if ((flags & CONNECT_COMPRESSED_FLAG) !== 0) return undefined;
		if ((flags & CONNECT_END_STREAM_FLAG) === 0) return payload.subarray(offset + 5, frameEnd);
		offset = frameEnd;
	}
	return undefined;
}

function parseConnectFrames(
	onMessage: (bytes: Uint8Array) => void,
	onEndStream: (bytes: Uint8Array) => void,
): (incoming: Buffer) => void {
	let pending = Buffer.alloc(0);
	return (incoming) => {
		pending = Buffer.concat([pending, incoming]);
		while (pending.length >= 5) {
			const flags = pending[0]!;
			const msgLen = pending.readUInt32BE(1);
			if (pending.length < 5 + msgLen) break;
			const messageBytes = pending.subarray(5, 5 + msgLen);
			pending = pending.subarray(5 + msgLen);
			if (flags & CONNECT_END_STREAM_FLAG) onEndStream(messageBytes);
			else onMessage(messageBytes);
		}
	};
}

function parseConnectEndStream(data: Uint8Array): Error | undefined {
	try {
		const payload = JSON.parse(new TextDecoder().decode(data)) as { error?: { code?: string; message?: string } };
		return payload.error ? new Error(`Connect error ${payload.error.code ?? "unknown"}: ${payload.error.message ?? "Unknown error"}`) : undefined;
	} catch {
		return undefined;
	}
}

function textContent(content: OpenAIMessage["content"]): string {
	if (content == null) return "";
	if (typeof content === "string") return content;
	return content.filter((part) => part.type === "text" && part.text).map((part) => part.text!).join("\n");
}

function parseToolCallArguments(raw: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(raw) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { value: parsed };
	} catch {
		return raw ? { __raw: raw } : {};
	}
}

function parseMessages(messages: OpenAIMessage[]): ParsedMessages {
	const systemPrompt = messages.filter((message) => message.role === "system").map((message) => textContent(message.content)).join("\n") || "You are a helpful assistant.";
	const turns: ParsedTurn[] = [];
	let current: ParsedTurn | undefined;
	for (const message of messages.filter((entry) => entry.role !== "system")) {
		if (message.role === "user") {
			if (current) turns.push(current);
			current = { userText: textContent(message.content), steps: [] };
			continue;
		}
		if (!current) continue;
		if (message.role === "assistant") {
			const text = textContent(message.content);
			if (text) current.steps.push({ kind: "assistantText", text });
			for (const toolCall of message.tool_calls ?? []) {
				current.steps.push({
					kind: "toolCall",
					toolCallId: toolCall.id,
					toolName: toolCall.function.name,
					arguments: parseToolCallArguments(toolCall.function.arguments),
				});
			}
			continue;
		}
		if (message.role === "tool") {
			const content = textContent(message.content);
			const matching = current.steps.find(
				(step): step is ParsedToolCallStep => step.kind === "toolCall" && step.toolCallId === message.tool_call_id,
			);
			if (matching) matching.result = { content, isError: false };
			else current.steps.push({ kind: "toolCall", toolCallId: message.tool_call_id ?? "", toolName: "", arguments: {}, result: { content, isError: false } });
		}
	}
	const userText = current?.userText ?? "";
	if (current && current.steps.length > 0) turns.push(current);
	let lastNonSystemRole: OpenAIMessage["role"] | undefined;
	for (const message of messages) {
		if (message.role !== "system") lastNonSystemRole = message.role;
	}
	return { systemPrompt, userText, turns, toolResultContinuation: lastNonSystemRole === "tool" };
}

function encodeMcpArgValue(value: unknown): Uint8Array {
	try {
		return toBinary(ValueSchema, fromJson(ValueSchema, value as JsonValue));
	} catch {
		return new TextEncoder().encode(String(value));
	}
}

function decodeMcpArgValue(value: Uint8Array): unknown {
	try {
		return toJson(ValueSchema, fromBinary(ValueSchema, value));
	} catch {
		return new TextDecoder().decode(value);
	}
}

function encodeMcpArgsMap(args: Record<string, unknown>): Record<string, Uint8Array> {
	const encoded: Record<string, Uint8Array> = {};
	for (const [key, value] of Object.entries(args)) encoded[key] = encodeMcpArgValue(value);
	return encoded;
}

function decodeMcpArgsMap(args: Record<string, Uint8Array>): Record<string, unknown> {
	const decoded: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) decoded[key] = decodeMcpArgValue(value);
	return decoded;
}

function buildMcpToolDefinitions(tools: OpenAIToolDef[]): McpToolDefinition[] {
	return tools.map((tool) => {
		const fn = tool.function;
		const jsonSchema: JsonValue = fn.parameters && typeof fn.parameters === "object" ? (fn.parameters as JsonValue) : { type: "object", properties: {}, required: [] };
		return create(McpToolDefinitionSchema, {
			name: fn.name,
			description: fn.description ?? "",
			providerIdentifier: "atomic",
			toolName: fn.name,
			inputSchema: toBinary(ValueSchema, fromJson(ValueSchema, jsonSchema)),
		});
	});
}

function buildSelectedContextBlob(rootPromptBlobIds: Uint8Array[], clientName: string): Uint8Array {
	const parts: Uint8Array[] = [];
	for (const blobId of rootPromptBlobIds) parts.push(new Uint8Array([0x0a, blobId.length, ...blobId]));
	const clientBytes = new TextEncoder().encode(clientName);
	parts.push(new Uint8Array([0xb2, 0x01, clientBytes.length, ...clientBytes]));
	const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}
	return result;
}

function blobKey(blobId: Uint8Array): string {
	return Buffer.from(blobId).toString("hex");
}

function storeAsBlob(data: Uint8Array, blobStore: Map<string, Uint8Array>): Uint8Array {
	const id = new Uint8Array(createHash("sha256").update(data).digest());
	blobStore.set(blobKey(id), data);
	return id;
}

function createUserMessage(text: string, selectedContextBlob: Uint8Array): UserMessage {
	const messageId = crypto.randomUUID();
	return create(UserMessageSchema, {
		text,
		messageId,
		selectedContext: create(SelectedContextSchema, {}),
		mode: 1,
		selectedContextBlob,
		correlationId: messageId,
	});
}

function buildTurnStepBytes(step: ParsedTurnStep): Uint8Array {
	if (step.kind === "assistantText") {
		return toBinary(ConversationStepSchema, create(ConversationStepSchema, { message: { case: "assistantMessage", value: create(AssistantMessageSchema, { text: step.text }) } }));
	}
	const toolName = step.toolName || "tool";
	const mcpToolCall = create(McpToolCallSchema, {
		args: create(McpArgsSchema, { name: toolName, args: encodeMcpArgsMap(step.arguments), toolCallId: step.toolCallId, providerIdentifier: "atomic", toolName }),
		...(step.result && {
			result: create(McpToolResultSchema, {
				result: step.result.isError
					? { case: "error", value: create(McpToolErrorSchema, { error: step.result.content }) }
					: {
							case: "success",
							value: create(McpSuccessSchema, {
								content: [create(McpToolResultContentItemSchema, { content: { case: "text", value: create(McpTextContentSchema, { text: step.result.content }) } })],
								isError: false,
							}),
						},
			}),
		}),
	});
	return toBinary(
		ConversationStepSchema,
		create(ConversationStepSchema, { message: { case: "toolCall", value: create(ToolCallSchema, { tool: { case: "mcpToolCall", value: mcpToolCall } }) } }),
	);
}

function buildTurnBlob(turn: ParsedTurn, blobStore: Map<string, Uint8Array>, selectedContextBlob: Uint8Array): Uint8Array {
	const userMsg = createUserMessage(turn.userText, selectedContextBlob);
	const userMsgBlobId = storeAsBlob(toBinary(UserMessageSchema, userMsg), blobStore);
	const stepBlobIds = turn.steps.map((step) => storeAsBlob(buildTurnStepBytes(step), blobStore));
	const agentTurn = create(AgentConversationTurnStructureSchema, { userMessage: userMsgBlobId, steps: stepBlobIds, requestId: crypto.randomUUID() });
	const turnStructure = create(ConversationTurnStructureSchema, { turn: { case: "agentConversationTurn", value: agentTurn } });
	return storeAsBlob(toBinary(ConversationTurnStructureSchema, turnStructure), blobStore);
}

function buildConversationStateFromParsedTurns(parsed: ParsedMessages, blobStore: Map<string, Uint8Array>, systemBlobId: Uint8Array, selectedContextBlob: Uint8Array): ConversationStateStructure {
	const turnBlobIds = parsed.turns.map((turn) => buildTurnBlob(turn, blobStore, selectedContextBlob));
	return create(ConversationStateStructureSchema, {
		rootPromptMessagesJson: [systemBlobId],
		turns: turnBlobIds,
		todos: [],
		pendingToolCalls: [],
		previousWorkspaceUris: [`file://${process.cwd()}`],
		mode: 1,
		fileStates: {},
		fileStatesV2: {},
		summaryArchives: [],
		turnTimings: [],
		subagentStates: {},
		selfSummaryCount: 0,
		readPaths: [],
		clientName: "atomic",
	});
}

function completedToolCallSteps(parsed: ParsedMessages): Map<string, ParsedToolCallStep> {
	const completed = new Map<string, ParsedToolCallStep>();
	for (const turn of parsed.turns) {
		for (const step of turn.steps) {
			if (step.kind === "toolCall" && step.result && step.toolCallId) completed.set(step.toolCallId, step);
		}
	}
	return completed;
}

function decodeMcpToolCallId(stepBytes: Uint8Array): string | undefined {
	try {
		const step = fromBinary(ConversationStepSchema, stepBytes);
		if (step.message.case !== "toolCall") return undefined;
		const tool = step.message.value.tool;
		if (tool.case !== "mcpToolCall") return undefined;
		return tool.value.args?.toolCallId || undefined;
	} catch {
		return undefined;
	}
}

function collectPendingToolCallIds(value: JsonValue, ids: Set<string>): void {
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const item of value) collectPendingToolCallIds(item, ids);
		return;
	}
	for (const [key, item] of Object.entries(value)) {
		if ((key === "toolCallId" || key === "tool_call_id") && typeof item === "string" && item) ids.add(item);
		else collectPendingToolCallIds(item as JsonValue, ids);
	}
}

function isCompletedPendingToolCall(entry: string, completedIds: Set<string>): boolean {
	const trimmed = entry.trim();
	if (completedIds.has(trimmed)) return true;
	try {
		const parsed = JSON.parse(trimmed) as JsonValue;
		const ids = new Set<string>();
		collectPendingToolCallIds(parsed, ids);
		if (ids.size !== 1) return false;
		const [id] = ids;
		return id !== undefined && completedIds.has(id);
	} catch {
		return false;
	}
}

function mergeToolResultContinuationIntoCheckpoint(
	checkpoint: ConversationStateStructure,
	parsed: ParsedMessages,
	blobStore: Map<string, Uint8Array>,
	selectedContextBlob: Uint8Array,
): ConversationStateStructure {
	const completedSteps = completedToolCallSteps(parsed);
	if (completedSteps.size === 0) return checkpoint;
	const matchedToolCallIds = new Set<string>();

	for (let turnIndex = checkpoint.turns.length - 1; turnIndex >= 0; turnIndex--) {
		const turnBlobId = checkpoint.turns[turnIndex]!;
		const turnBytes = blobStore.get(blobKey(turnBlobId));
		if (!turnBytes) continue;
		let changed = false;
		try {
			const turnStructure = fromBinary(ConversationTurnStructureSchema, turnBytes);
			if (turnStructure.turn.case !== "agentConversationTurn") continue;
			const agentTurn = turnStructure.turn.value;
			const updatedStepBlobIds = agentTurn.steps.map((stepBlobId) => {
				const stepBytes = blobStore.get(blobKey(stepBlobId));
				if (!stepBytes) return stepBlobId;
				const toolCallId = decodeMcpToolCallId(stepBytes);
				if (!toolCallId) return stepBlobId;
				const completedStep = completedSteps.get(toolCallId);
				if (!completedStep) return stepBlobId;
				changed = true;
				matchedToolCallIds.add(toolCallId);
				return storeAsBlob(buildTurnStepBytes(completedStep), blobStore);
			});
			if (changed) {
				agentTurn.steps = updatedStepBlobIds;
				checkpoint.turns[turnIndex] = storeAsBlob(toBinary(ConversationTurnStructureSchema, turnStructure), blobStore);
			}
		} catch {
			continue;
		}
	}

	const fallbackSteps: ParsedToolCallStep[] = [];
	for (const [toolCallId, step] of completedSteps) {
		if (!matchedToolCallIds.has(toolCallId)) fallbackSteps.push(step);
	}
	const latestTurn = parsed.turns[parsed.turns.length - 1];
	if (fallbackSteps.length > 0 && latestTurn) checkpoint.turns.push(buildTurnBlob({ userText: latestTurn.userText, steps: fallbackSteps }, blobStore, selectedContextBlob));

	const matchedIds = new Set([...matchedToolCallIds, ...fallbackSteps.map((step) => step.toolCallId)]);
	checkpoint.pendingToolCalls = checkpoint.pendingToolCalls.filter((entry) => !isCompletedPendingToolCall(entry, matchedIds));
	return checkpoint;
}

function buildCursorRequest(modelId: string, parsed: ParsedMessages, session: StoredSession, tools: OpenAIToolDef[]): { requestBytes: Uint8Array; mcpTools: McpToolDefinition[] } {
	const blobStore = session.blobStore;
	const systemBytes = new TextEncoder().encode(JSON.stringify({ role: "system", content: parsed.systemPrompt }));
	const systemBlobId = storeAsBlob(systemBytes, blobStore);
	const selectedCtxBlob = storeAsBlob(buildSelectedContextBlob([systemBlobId], "atomic"), blobStore);
	const conversationState = session.checkpoint
		? parsed.toolResultContinuation
			? mergeToolResultContinuationIntoCheckpoint(fromBinary(ConversationStateStructureSchema, session.checkpoint), parsed, blobStore, selectedCtxBlob)
			: fromBinary(ConversationStateStructureSchema, session.checkpoint)
		: buildConversationStateFromParsedTurns(parsed, blobStore, systemBlobId, selectedCtxBlob);
	const action = parsed.toolResultContinuation
		? create(ConversationActionSchema, { action: { case: "resumeAction", value: create(ResumeActionSchema, {}) } })
		: create(ConversationActionSchema, { action: { case: "userMessageAction", value: create(UserMessageActionSchema, { userMessage: createUserMessage(parsed.userText, selectedCtxBlob) }) } });
	const modelDetails = create(ModelDetailsSchema, { modelId, displayModelId: modelId, displayName: modelId });
	const runRequest = create(AgentRunRequestSchema, { conversationState, action, modelDetails, conversationId: session.conversationId });
	const clientMessage = create(AgentClientMessageSchema, { message: { case: "runRequest", value: runRequest } });
	return { requestBytes: toBinary(AgentClientMessageSchema, clientMessage), mcpTools: buildMcpToolDefinitions(tools) };
}

function makeHeartbeatBytes(): Uint8Array {
	return frameConnectMessage(toBinary(AgentClientMessageSchema, create(AgentClientMessageSchema, { message: { case: "clientHeartbeat", value: create(ClientHeartbeatSchema, {}) } })));
}

function sendKvResponse(kvMsg: KvServerMessage, messageCase: string, value: unknown, sendFrame: (data: Uint8Array) => void): void {
	const response = create(KvClientMessageSchema, { id: (kvMsg as { id?: number }).id, message: { case: messageCase as never, value: value as never } });
	sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, create(AgentClientMessageSchema, { message: { case: "kvClientMessage", value: response } }))));
}

function handleKvMessage(kvMsg: KvServerMessage, blobStore: Map<string, Uint8Array>, sendFrame: (data: Uint8Array) => void): void {
	const message = (kvMsg as { message?: { case?: string; value?: { blobId?: Uint8Array; blobData?: Uint8Array } } }).message;
	if (message?.case === "getBlobArgs") {
		const blobId = message.value?.blobId;
		const blobData = blobId ? blobStore.get(blobKey(blobId)) : undefined;
		sendKvResponse(kvMsg, "getBlobResult", create(GetBlobResultSchema, blobData ? { blobData } : {}), sendFrame);
	} else if (message?.case === "setBlobArgs") {
		const { blobId, blobData } = message.value ?? {};
		if (blobId && blobData) blobStore.set(blobKey(blobId), blobData);
		sendKvResponse(kvMsg, "setBlobResult", create(SetBlobResultSchema, {}), sendFrame);
	}
}

function sendExecResult(execMsg: ExecServerMessage, messageCase: string, value: unknown, sendFrame: (data: Uint8Array) => void): void {
	const source = execMsg as { id?: number; execId?: string };
	const execClientMessage = create(ExecClientMessageSchema, { id: source.id, execId: source.execId, message: { case: messageCase as never, value: value as never } });
	sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, create(AgentClientMessageSchema, { message: { case: "execClientMessage", value: execClientMessage } }))));
}

function rejectNativeExec(execMsg: ExecServerMessage, sendFrame: (data: Uint8Array) => void): void {
	const execCase = (execMsg as { message?: { case?: string; value?: { path?: string; command?: string } } }).message?.case;
	const args = (execMsg as { message?: { value?: { path?: string; command?: string } } }).message?.value ?? {};
	const reason = "Tool not available in this environment. Use Atomic MCP tools instead.";
	if (execCase === "readArgs") sendExecResult(execMsg, "readResult", create(ReadResultSchema, { result: { case: "rejected", value: create(ReadRejectedSchema, { path: args.path, reason }) } }), sendFrame);
	else if (execCase === "lsArgs") sendExecResult(execMsg, "lsResult", create(LsResultSchema, { result: { case: "rejected", value: create(LsRejectedSchema, { path: args.path, reason }) } }), sendFrame);
	else if (execCase === "writeArgs") sendExecResult(execMsg, "writeResult", create(WriteResultSchema, { result: { case: "rejected", value: create(WriteRejectedSchema, { path: args.path, reason }) } }), sendFrame);
	else if (execCase === "deleteArgs") sendExecResult(execMsg, "deleteResult", create(DeleteResultSchema, { result: { case: "rejected", value: create(DeleteRejectedSchema, { path: args.path, reason }) } }), sendFrame);
	else if (execCase === "shellArgs") sendExecResult(execMsg, "shellResult", create(ShellResultSchema, { result: { case: "rejected", value: create(ShellRejectedSchema, { command: args.command, reason }) } }), sendFrame);
	else if (execCase === "shellStreamArgs") sendExecResult(execMsg, "shellStream", create(ShellStreamSchema, { event: { case: "rejected", value: create(ShellRejectedSchema, { command: args.command, reason }) } }), sendFrame);
	else if (execCase === "grepArgs") sendExecResult(execMsg, "grepResult", create(GrepResultSchema, { result: { case: "error", value: create(GrepErrorSchema, { error: reason }) } }), sendFrame);
	else if (execCase === "fetchArgs") sendExecResult(execMsg, "fetchResult", create(FetchResultSchema, { result: { case: "error", value: create(FetchErrorSchema, { error: reason }) } }), sendFrame);
	else if (execCase === "diagnosticsArgs") sendExecResult(execMsg, "diagnosticsResult", create(DiagnosticsResultSchema, {}), sendFrame);
	else if (execCase === "cancelArgs") sendExecResult(execMsg, "cancelResult", create(CancelActionSchema, {}), sendFrame);
}

function allocateToolCallIndex(state: ToolCallIndexState, toolCallId: string): number {
	const existing = state.byToolCallId.get(toolCallId);
	if (existing !== undefined) return existing;
	const index = state.nextIndex++;
	state.byToolCallId.set(toolCallId, index);
	return index;
}

function handleExecMessage(
	execMsg: ExecServerMessage,
	mcpTools: McpToolDefinition[],
	sendFrame: (data: Uint8Array) => void,
	onToolCall: (chunk: Extract<CursorProxyBridgeChunk, { type: "tool_call" }>) => void,
	toolCallIndexes: ToolCallIndexState,
): void {
	const exec = execMsg as { id?: number; execId?: string; message?: { case?: string; value?: { args?: Record<string, Uint8Array>; toolCallId?: string; toolName?: string; name?: string } } };
	const execCase = exec.message?.case;
	if (execCase === "requestContextArgs") {
		const requestContext = create(RequestContextSchema, { rules: [], repositoryInfo: [], tools: mcpTools, gitRepos: [], projectLayouts: [], mcpInstructions: [], fileContents: {}, customSubagents: [] });
		const result = create(RequestContextResultSchema, { result: { case: "success", value: create(RequestContextSuccessSchema, { requestContext }) } });
		sendExecResult(execMsg, "requestContextResult", result, sendFrame);
		return;
	}
	if (execCase === "mcpArgs") {
		const value = exec.message?.value;
		const toolCallId = value?.toolCallId || crypto.randomUUID();
		onToolCall({
			type: "tool_call",
			id: toolCallId,
			index: allocateToolCallIndex(toolCallIndexes, toolCallId),
			name: value?.toolName || value?.name || "tool",
			arguments: JSON.stringify(decodeMcpArgsMap(value?.args ?? {})),
		});
		return;
	}
	rejectNativeExec(execMsg, sendFrame);
}

function processServerMessage(
	msg: AgentServerMessage,
	session: StoredSession,
	mcpTools: McpToolDefinition[],
	sendFrame: (data: Uint8Array) => void,
	onChunk: (chunk: CursorProxyBridgeChunk) => void,
	toolCallIndexes: ToolCallIndexState,
): void {
	const message = (msg as { message: { case: string; value: unknown } }).message;
	switch (message.case) {
		case "interactionUpdate": {
			const update = message.value as { message?: { case?: string; value?: { text?: string } } };
			const text = update.message?.value?.text ?? "";
			if (!text) break;

			switch (update.message?.case) {
				case "textDelta":
					onChunk({ type: "text", text });
					break;
				case "thinkingDelta":
					onChunk({ type: "thinking", text });
					break;
			}
			break;
		}
		case "kvServerMessage":
			handleKvMessage(message.value as KvServerMessage, session.blobStore, sendFrame);
			break;
		case "execServerMessage":
			handleExecMessage(message.value as ExecServerMessage, mcpTools, sendFrame, onChunk, toolCallIndexes);
			break;
		case "conversationCheckpointUpdate":
			session.checkpoint = toBinary(ConversationStateStructureSchema, message.value as ConversationStateStructure);
			break;
	}
}

function deterministicConversationId(sessionId: string): string {
	const hex = createHash("sha256").update(`cursor-conv-id:${sessionId}`).digest("hex").slice(0, 32);
	return [hex.slice(0, 8), hex.slice(8, 12), `4${hex.slice(13, 16)}`, `${(0x8 | (parseInt(hex[16]!, 16) & 0x3)).toString(16)}${hex.slice(17, 20)}`, hex.slice(20, 32)].join("-");
}

export function createCursorBridge(options: CursorBridgeOptions = {}): CursorBridge {
	return new NodeH2CursorBridge(options);
}

class NodeH2CursorBridge implements CursorBridge {
	private readonly options: CursorBridgeOptions;
	private readonly bridgePath: string;
	private readonly nodeExecutable: string;
	private readonly requestTimeoutMs: number;
	private readonly toolCallCollectionWindowMs: number;
	private readonly sessions = new Map<string, StoredSession>();
	private readonly active = new Set<BridgeHandle>();
	private readonly activeToolCallTimers = new Set<ReturnType<typeof setTimeout>>();

	constructor(options: CursorBridgeOptions) {
		this.options = options;
		this.bridgePath = options.bridgePath ?? DEFAULT_BRIDGE_PATH;
		this.nodeExecutable = options.nodeExecutable ?? "node";
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.toolCallCollectionWindowMs = options.toolCallCollectionWindowMs ?? DEFAULT_TOOL_CALL_COLLECTION_WINDOW_MS;
	}

	async getUsableModels(accessToken: string): Promise<unknown> {
		const requestBody = toBinary(GetUsableModelsRequestSchema, create(GetUsableModelsRequestSchema, {}));
		const responseBody = await this.callUnary(accessToken, "/agent.v1.AgentService/GetUsableModels", requestBody);
		let decoded: unknown;
		try {
			decoded = fromBinary(GetUsableModelsResponseSchema, responseBody);
		} catch {
			const body = decodeConnectUnaryBody(responseBody);
			if (!body) throw new Error("Cursor model discovery returned undecodable protobuf");
			decoded = fromBinary(GetUsableModelsResponseSchema, body);
		}
		return decoded;
	}

	async *chatCompletions(request: Record<string, unknown>, context: { accessToken: string; signal?: AbortSignal }): AsyncIterable<CursorProxyBridgeChunk> {
		const messages = Array.isArray(request.messages) ? (request.messages as OpenAIMessage[]) : [];
		const tools = Array.isArray(request.tools) ? (request.tools as OpenAIToolDef[]) : [];
		const modelId = typeof request.model === "string" ? request.model : "cursor";
		const sessionId = typeof request.pi_session_id === "string" && request.pi_session_id.trim() ? request.pi_session_id.trim() : "default";
		const session = this.getSession(sessionId);
		const parsed = parseMessages(messages);
		const payload = buildCursorRequest(modelId, parsed, session, tools);
		const bridge = spawnH2Bridge({ bridgePath: this.bridgePath, nodeExecutable: this.nodeExecutable, accessToken: context.accessToken, rpcPath: "/agent.v1.AgentService/Run", debug: this.options.debug });
		this.active.add(bridge);
		const queue: CursorProxyBridgeChunk[] = [];
		let notify: (() => void) | undefined;
		let done = false;
		let error: Error | undefined;
		let sawToolCall = false;
		const toolCallIndexes: ToolCallIndexState = { nextIndex: 0, byToolCallId: new Map() };
		let toolCallCollectionTimer: ReturnType<typeof setTimeout> | undefined;
		const wake = () => {
			notify?.();
			notify = undefined;
		};
		const clearToolCallCollectionTimer = () => {
			if (!toolCallCollectionTimer) return;
			clearTimeout(toolCallCollectionTimer);
			this.activeToolCallTimers.delete(toolCallCollectionTimer);
			toolCallCollectionTimer = undefined;
		};
		const finishToolCallCollection = () => {
			clearToolCallCollectionTimer();
			done = true;
			killQuietly(bridge.proc);
			wake();
		};
		const resetToolCallCollectionTimer = () => {
			clearToolCallCollectionTimer();
			toolCallCollectionTimer = setTimeout(finishToolCallCollection, this.toolCallCollectionWindowMs);
			this.activeToolCallTimers.add(toolCallCollectionTimer);
		};
		const sendFrame = (data: Uint8Array) => bridge.write(data);
		const heartbeat = setInterval(() => bridge.write(makeHeartbeatBytes()), 5_000);
		const abort = () => {
			clearToolCallCollectionTimer();
			killQuietly(bridge.proc);
		};
		context.signal?.addEventListener("abort", abort, { once: true });
		bridge.onData(
			parseConnectFrames(
				(bytes) => {
					try {
						const msg = fromBinary(AgentServerMessageSchema, bytes);
						processServerMessage(msg, session, payload.mcpTools, sendFrame, (chunk) => {
							if (chunk.type === "tool_call") {
								sawToolCall = true;
								resetToolCallCollectionTimer();
							}
							queue.push(chunk);
							wake();
						}, toolCallIndexes);
					} catch (err) {
						clearToolCallCollectionTimer();
						error = err instanceof Error ? err : new Error(String(err));
						wake();
					}
				},
				(endStreamBytes) => {
					const endStreamError = parseConnectEndStream(endStreamBytes);
					if (!endStreamError) return;
					clearToolCallCollectionTimer();
					error = endStreamError;
					wake();
				},
			),
		);
		bridge.onClose((code, closeError) => {
			done = true;
			clearToolCallCollectionTimer();
			clearInterval(heartbeat);
			context.signal?.removeEventListener("abort", abort);
			this.active.delete(bridge);
			if (closeError && !error && !sawToolCall) error = closeError;
			else if (code !== 0 && !error && !sawToolCall) error = new Error(`Cursor bridge exited with code ${code}`);
			wake();
		});
		bridge.write(frameConnectMessage(payload.requestBytes));

		try {
			while (!done || queue.length > 0) {
				while (queue.length > 0) yield queue.shift()!;
				if (error) throw error;
				if (done) break;
				await new Promise<void>((resolve) => {
					notify = resolve;
				});
			}
			if (error) throw error;
			yield { type: "done", finishReason: sawToolCall ? "tool_calls" : "stop" };
		} finally {
			clearToolCallCollectionTimer();
			clearInterval(heartbeat);
			if (bridge.alive) bridge.end();
		}
	}

	clearSession(sessionId: string): void {
		this.sessions.delete(sessionId);
	}

	close(): void {
		for (const timer of this.activeToolCallTimers) clearTimeout(timer);
		this.activeToolCallTimers.clear();
		for (const bridge of this.active) killQuietly(bridge.proc);
		this.active.clear();
		this.sessions.clear();
	}

	private callUnary(accessToken: string, rpcPath: string, requestBody: Uint8Array): Promise<Uint8Array> {
		const bridge = spawnH2Bridge({ bridgePath: this.bridgePath, nodeExecutable: this.nodeExecutable, accessToken, rpcPath, unary: true, debug: this.options.debug });
		this.active.add(bridge);
		const chunks: Buffer[] = [];
		return new Promise((resolvePromise, reject) => {
			const timeout = setTimeout(() => {
				killQuietly(bridge.proc);
				reject(new Error(`Cursor bridge timed out calling ${rpcPath}`));
			}, this.requestTimeoutMs);
			bridge.onData((chunk) => chunks.push(Buffer.from(chunk)));
			bridge.onClose((code, closeError) => {
				clearTimeout(timeout);
				this.active.delete(bridge);
				if (closeError) reject(closeError);
				else if (code !== 0) reject(new Error(`Cursor bridge exited with code ${code}`));
				else resolvePromise(Buffer.concat(chunks));
			});
			bridge.write(requestBody);
			bridge.end();
		});
	}

	private getSession(sessionId: string): StoredSession {
		const now = Date.now();
		for (const [key, session] of this.sessions) {
			if (now - session.lastAccessMs > SESSION_TTL_MS) this.sessions.delete(key);
		}
		const existing = this.sessions.get(sessionId);
		if (existing) {
			existing.lastAccessMs = now;
			return existing;
		}
		const created = { conversationId: deterministicConversationId(sessionId), blobStore: new Map<string, Uint8Array>(), lastAccessMs: now };
		this.sessions.set(sessionId, created);
		return created;
	}
}
