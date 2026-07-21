import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { createCursorExperimentalProtocolError } from "../config.js";
import type { CursorUsableModel } from "../model-mapper.js";
import { CursorError } from "../errors.js";
import type { CursorConnectFrame, CursorProtocolCodec, CursorProtocolMessage, CursorRunRequest, CursorToolResultMessage } from "../transport.js";
import {
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	CancelActionSchema,
	ClientHeartbeatSchema,
	ConversationActionSchema,
	GetBlobResultSchema,
	GetUsableModelsRequestSchema,
	GetUsableModelsResponseSchema,
	SetBlobResultSchema,
	type McpToolDefinition,
	type ModelDetails,
} from "./cursor-protocol.js";
import { blobKey, buildCursorRequest, buildMcpToolDefinitions, extractCurrentActionText, parseHistoricalTurns } from "./protobuf-codec-request.js";
import { createMcpToolResult, decodeAgentServerMessage, encodeExecClientMessage, encodeKvClientMessage, encodeNativeExecRejection, encodeRequestContextResult } from "./protobuf-codec-wire.js";

// Cursor protocol codec intentionally follows the MIT-licensed
// ndraiman/pi-cursor-provider implementation. The request/control bytes are
// built through Cursor's generated protobuf descriptors instead of inferred
// hand-written field concatenation so the private API sees the same semantic
// messages as the reference provider.



export class CursorProtobufProtocolCodec implements CursorProtocolCodec {
	readonly #blobStores = new Map<string, Map<string, Uint8Array>>();
	readonly #toolDefinitions = new Map<string, readonly McpToolDefinition[]>();

	encodeGetUsableModelsRequest(): Uint8Array {
		return toBinary(GetUsableModelsRequestSchema, create(GetUsableModelsRequestSchema, {}));
	}

	decodeGetUsableModelsResponse(data: Uint8Array): readonly CursorUsableModel[] {
		try {
			const body = unwrapConnectUnaryBody(data) ?? data;
			return decodeGetUsableModelsBody(body);
		} catch (error) {
			if (error instanceof CursorError) throw error;
			throw new CursorError("ProtocolMalformed", "Cursor GetUsableModels protobuf response is malformed.", {
				operation: "discovery",
				cause: error instanceof Error ? error : undefined,
			});
		}
	}

	encodeRunRequest(request: CursorRunRequest): Uint8Array {
		const conversationIdValue = request.conversationId ?? request.requestId;
		const last = request.context.messages.at(-1);
		const historicalMessages = last?.role === "user" ? request.context.messages.slice(0, -1) : request.context.messages;
		const payload = buildCursorRequest(
			request.routeReference,
			request.context.systemPrompt ?? "",
			extractCurrentActionText(request),
			parseHistoricalTurns(historicalMessages),
			conversationIdValue,
		);
		this.#blobStores.set(request.requestId, payload.blobStore);
		this.#toolDefinitions.set(request.requestId, buildMcpToolDefinitions(request));
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
			return encodeKvClientMessage(message.id, "setBlobResult", create(SetBlobResultSchema, {}));
		}
		if (message.type === "conversationCheckpoint") return undefined;
		if (message.type === "requestContext") {
			return encodeRequestContextResult(message, this.#toolDefinitions.get(requestId) ?? []);
		}
		if (message.type === "nonMcpExec") {
			return encodeNativeExecRejection(message);
		}
		return undefined;
	}

	disposeRun(requestId: string): void { this.cleanupRun(requestId); }

	discardRun(requestId: string): void { this.cleanupRun(requestId); }

	discardConversation(_conversationId: string): void {}

	private cleanupRun(requestId: string): void {
		this.#blobStores.delete(requestId);
		this.#toolDefinitions.delete(requestId);
	}

	encodeToolResult(result: CursorToolResultMessage): Uint8Array {
		if (result.content?.some((part) => part.type === "image")) {
			throw new CursorError("ProtocolError", "Cursor accepts text-only live tool results; image content is unsupported.", { operation: "request" });
		}
		const mcpResult = createMcpToolResult(result.text, result.isError);
		return encodeExecClientMessage(result.execNumericId, result.execId, "mcpResult", mcpResult);
	}

	encodeCancelRequest(): Uint8Array {
		const cancelAction = create(ConversationActionSchema, {
			action: { case: "cancelAction", value: create(CancelActionSchema, {}) },
		});
		const clientMessage = create(AgentClientMessageSchema, { message: { case: "conversationAction", value: cancelAction } });
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
	return decoded.models.map(modelDetailsToCursorUsableModel);
}

function modelDetailsToCursorUsableModel(model: ModelDetails): CursorUsableModel {
	if (model.modelId.length === 0) {
		throw new CursorError("ProtocolMalformed", "Cursor GetUsableModels contains an empty route ID.", {
			operation: "discovery",
		});
	}
	const displayName = model.displayName || model.displayNameShort || model.displayModelId || undefined;
	return {
		modelId: model.modelId,
		maxMode: model.maxMode,
		...(displayName === undefined ? {} : { displayName }),
	};
}

function unwrapConnectUnaryBody(data: Uint8Array): Uint8Array | undefined {
	let offset = 0;
	let body: Uint8Array | undefined;
	let sawFrame = false;
	while (offset < data.byteLength) {
		if (offset + 5 > data.byteLength) {
			if (sawFrame) throw malformedCatalogFraming();
			return undefined;
		}
		const flags = data[offset] ?? 0;
		const view = new DataView(data.buffer, data.byteOffset + offset, data.byteLength - offset);
		const length = view.getUint32(1, false);
		const frameEnd = offset + 5 + length;
		if (frameEnd > data.byteLength) {
			if (sawFrame) throw malformedCatalogFraming();
			return undefined;
		}
		if ((flags & 0b0000_0001) !== 0) {
			if (sawFrame) throw malformedCatalogFraming();
			return undefined;
		}
		if ((flags & 0b0000_0010) === 0) {
			if (body !== undefined) throw malformedCatalogFraming();
			body = data.slice(offset + 5, frameEnd);
		}
		sawFrame = true;
		offset = frameEnd;
	}
	return body;
}

function malformedCatalogFraming(): CursorError {
	return new CursorError("ProtocolMalformed", "Cursor GetUsableModels response framing is malformed.", { operation: "discovery" });
}

