import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { createCursorExperimentalProtocolError } from "../config.js";
import type { CursorUsableModel } from "../model-mapper.js";
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
} from "./agent_pb.js";
import { blobKey, buildCursorRequest, buildMcpToolDefinitions, extractCurrentActionImages, extractCurrentActionText, parseHistoricalTurns } from "./protobuf-codec-request.js";
import { createMcpToolResult, decodeAgentServerMessage, encodeExecClientMessage, encodeKvClientMessage, encodeNativeExecRejection, encodeRequestContextResult } from "./protobuf-codec-wire.js";
import { decodeAvailableModelsResponse, encodeAvailableModelsRequest, type CursorAvailableModel } from "./cursor-available-models-codec.js";

// Cursor protocol codec intentionally follows the MIT-licensed
// ndraiman/pi-cursor-provider implementation. The request/control bytes are
// built through Cursor's generated protobuf descriptors instead of inferred
// hand-written field concatenation so the private API sees the same semantic
// messages as the reference provider.

interface StoredCursorConversationState {
	checkpoint?: Uint8Array;
	blobStore: Map<string, Uint8Array>;
}


export class CursorProtobufProtocolCodec implements CursorProtocolCodec {
	readonly #blobStores = new Map<string, Map<string, Uint8Array>>();
	readonly #toolDefinitions = new Map<string, readonly McpToolDefinition[]>();
	readonly #runConversationIds = new Map<string, string>();
	readonly #conversationStates = new Map<string, StoredCursorConversationState>();

	encodeAvailableModelsRequest(): Uint8Array {
		return encodeAvailableModelsRequest();
	}

	decodeAvailableModelsResponse(data: Uint8Array): readonly CursorAvailableModel[] {
		try {
			const unwrapped = unwrapConnectUnaryBody(data);
			return decodeAvailableModelsResponse(unwrapped ?? data);
		} catch (error) {
			throw createCursorExperimentalProtocolError(`Cursor protobuf AvailableModels decoding failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

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
		const conversationIdValue = request.conversationId ?? request.requestId;
		const storedState = this.#conversationStates.get(conversationIdValue);
		const payload = buildCursorRequest(
			request.resolvedModelId,
			request.context.systemPrompt ?? "",
			extractCurrentActionText(request),
			parseHistoricalTurns(request.context.messages.slice(0, -1)),
			conversationIdValue,
			storedState?.checkpoint ?? null,
			storedState?.blobStore,
			extractCurrentActionImages(request),
			{
				modelId: request.requestedModelId,
				maxMode: request.requestedMaxMode,
				parameters: request.modelParameters,
			},
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
		const mcpResult = createMcpToolResult(result.content ?? result.text, result.isError, result.text);
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
		supportsReasoning: Boolean(model.thinkingDetails),
		metadataProvenance: "get-usable-models",
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

