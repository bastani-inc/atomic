import { randomUUID } from "node:crypto";
import { create, toBinary } from "@bufbuild/protobuf";
import type { CursorControlMessage, CursorProtocolMessage, CursorServerMessage } from "../transport.js";
import {
	AgentClientMessageSchema,
	BackgroundShellSpawnResultSchema,
	ConversationStateStructureSchema,
	DeleteRejectedSchema,
	DeleteResultSchema,
	ExecClientMessageSchema,
	FetchErrorSchema,
	FetchResultSchema,
	GrepErrorSchema,
	GrepResultSchema,
	KvClientMessageSchema,
	LsRejectedSchema,
	LsResultSchema,
	McpErrorSchema,
	McpResultSchema,
	McpSuccessSchema,
	McpTextContentSchema,
	McpToolErrorSchema,
	McpToolResultContentItemSchema,
	McpToolResultSchema,
	ReadRejectedSchema,
	ReadResultSchema,
	RequestContextResultSchema,
	RequestContextSchema,
	RequestContextSuccessSchema,
	ShellRejectedSchema,
	ShellResultSchema,
	ShellStreamSchema,
	WriteRejectedSchema,
	WriteResultSchema,
	WriteShellStdinErrorSchema,
	WriteShellStdinResultSchema,
	type AgentServerMessage,
	type ExecServerMessage,
	type KvServerMessage,
	type McpToolDefinition,
} from "./cursor-protocol.js";
import { decodeMcpArgsMap } from "./protobuf-codec-json.js";

const NATIVE_EXEC_REJECT_REASON = "Tool not available in this environment. Use the MCP tools provided instead.";

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

export function decodeAgentServerMessage(message: AgentServerMessage): readonly CursorProtocolMessage[] {
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

export function encodeKvClientMessage(id: number, messageCase: "getBlobResult" | "setBlobResult", value: unknown): Uint8Array {
	const response = create(KvClientMessageSchema, { id, message: { case: messageCase, value } as never });
	const clientMessage = create(AgentClientMessageSchema, { message: { case: "kvClientMessage", value: response } });
	return toBinary(AgentClientMessageSchema, clientMessage);
}

export function encodeRequestContextResult(message: Extract<CursorControlMessage, { readonly type: "requestContext" }>, toolDefinitions: readonly McpToolDefinition[]): Uint8Array {
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

export function encodeNativeExecRejection(message: Extract<CursorServerMessage, { readonly type: "nonMcpExec" }>): Uint8Array | undefined {
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
			return { caseName: "mcpResult", value: createMcpToolResult(NATIVE_EXEC_REJECT_REASON, true) };
		case 14:
			return { caseName: "shellStream", value: create(ShellStreamSchema, { event: { case: "rejected", value: createShellRejected() } }) };
		case 16:
			return { caseName: "backgroundShellSpawnResult", value: create(BackgroundShellSpawnResultSchema, { result: { case: "rejected", value: createShellRejected() } }) };
		case 17:
			return { caseName: "listMcpResourcesExecResult", value: createMcpToolResult(NATIVE_EXEC_REJECT_REASON, true) };
		case 18:
			return { caseName: "readMcpResourceExecResult", value: createMcpToolResult(NATIVE_EXEC_REJECT_REASON, true) };
		case 20:
			return { caseName: "fetchResult", value: create(FetchResultSchema, { result: { case: "error", value: create(FetchErrorSchema, { url: "", error: NATIVE_EXEC_REJECT_REASON }) } }) };
		case 21:
			return { caseName: "recordScreenResult", value: createMcpToolResult(NATIVE_EXEC_REJECT_REASON, true) };
		case 22:
			return { caseName: "computerUseResult", value: createMcpToolResult(NATIVE_EXEC_REJECT_REASON, true) };
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

export function encodeExecClientMessage(execNumericId: number | undefined, execId: string | undefined, messageCase: string, value: unknown): Uint8Array {
	const execClientMessage = create(ExecClientMessageSchema, {
		id: execNumericId ?? 0,
		execId: execId ?? "",
		message: { case: messageCase, value } as never,
	});
	const clientMessage = create(AgentClientMessageSchema, { message: { case: "execClientMessage", value: execClientMessage } });
	return toBinary(AgentClientMessageSchema, clientMessage);
}

export function createMcpToolResult(content: string, isError: boolean): ReturnType<typeof create<typeof McpResultSchema>> {
	if (isError) return create(McpResultSchema, { result: { case: "error", value: create(McpErrorSchema, { error: content }) } });
	return create(McpResultSchema, { result: { case: "success", value: createMcpSuccess(content) } });
}

export function createMcpToolCallResult(content: string, isError: boolean): ReturnType<typeof create<typeof McpToolResultSchema>> {
	if (isError) return create(McpToolResultSchema, { result: { case: "error", value: create(McpToolErrorSchema, { error: content }) } });
	return create(McpToolResultSchema, { result: { case: "success", value: createMcpSuccess(content) } });
}

function createMcpSuccess(content: string): ReturnType<typeof create<typeof McpSuccessSchema>> {
	return create(McpSuccessSchema, { content: [createTextContentItem(content)], isError: false });
}

function createTextContentItem(text: string): ReturnType<typeof create<typeof McpToolResultContentItemSchema>> {
	return create(McpToolResultContentItemSchema, { content: { case: "text", value: create(McpTextContentSchema, { text }) } });
}

