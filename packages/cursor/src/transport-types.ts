import type { Context, Model, Api, ThinkingLevel } from "@earendil-works/pi-ai";
import type { CursorUsableModel } from "./model-mapper.js";

export interface CursorTransportLifecycleSnapshot {
	readonly openStreams: number;
	readonly cancelledStreams: number;
	readonly closedStreams: number;
}

export interface CursorRunRequest {
	readonly accessToken: string;
	readonly requestId: string;
	readonly conversationId?: string;
	readonly model: Model<Api>;
	readonly resolvedModelId: string;
	readonly thinkingLevel?: ThinkingLevel;
	readonly context: Context;
	readonly signal?: AbortSignal;
	readonly openTimeoutMs?: number;
}

export type CursorDoneReason = "stop" | "length" | "toolUse";

export interface CursorToolCallMessage {
	readonly type: "toolCall";
	readonly id: string;
	readonly name: string;
	readonly argumentsJson: string;
	readonly execId?: string;
	readonly execNumericId?: number;
}

export type CursorServerMessage =
	| { readonly type: "textDelta"; readonly text: string }
	| { readonly type: "thinkingDelta"; readonly text: string }
	| CursorToolCallMessage
	| { readonly type: "usage"; readonly kind?: "checkpoint"; readonly inputTokens?: number; readonly outputTokens?: number; readonly cacheReadTokens?: number; readonly cacheWriteTokens?: number; readonly usedTokens?: number }
	| { readonly type: "usage"; readonly kind: "outputDelta"; readonly outputTokens: number }
	| { readonly type: "nonMcpExec"; readonly fieldNumber: number; readonly execId?: string; readonly execNumericId?: number }
	| { readonly type: "done"; readonly reason: CursorDoneReason };

export type CursorControlMessage =
	| { readonly type: "kvGetBlob"; readonly id: number; readonly blobId: Uint8Array }
	| { readonly type: "kvSetBlob"; readonly id: number; readonly blobId: Uint8Array; readonly blobData: Uint8Array }
	| { readonly type: "conversationCheckpoint"; readonly checkpoint: Uint8Array }
	| { readonly type: "requestContext"; readonly execNumericId?: number; readonly execId?: string };

export type CursorProtocolMessage = CursorServerMessage | CursorControlMessage;

export interface CursorToolResultMessage {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly text: string;
	readonly isError: boolean;
	readonly execId?: string;
	readonly execNumericId?: number;
}

export interface CursorWriteOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

export interface CursorRunStream {
	readonly id: string;
	readonly messages: AsyncIterable<CursorServerMessage>;
	writeToolResult(result: CursorToolResultMessage, options?: CursorWriteOptions): Promise<void>;
	cancel(): Promise<void>;
	close(): Promise<void>;
}

export interface CursorAgentTransport {
	getUsableModels(accessToken: string, requestId: string, signal?: AbortSignal): Promise<readonly CursorUsableModel[]>;
	run(request: CursorRunRequest): Promise<CursorRunStream>;
	dispose(): Promise<void>;
	discardConversation?(conversationId: string): void;
	getLifecycleSnapshot(): CursorTransportLifecycleSnapshot;
}

export interface CursorConnectFrame {
	readonly flags: number;
	readonly data: Uint8Array;
	readonly endStream: boolean;
}

export interface CursorHttp2UnaryResponse {
	readonly statusCode?: number;
	readonly body: Uint8Array;
	readonly headers: Record<string, string>;
}

export interface CursorHttp2StreamHandle {
	readonly frames: AsyncIterable<Uint8Array>;
	write(data: Uint8Array, options?: CursorWriteOptions): Promise<void>;
	close(): Promise<void>;
	cancel(): Promise<void>;
}

export interface CursorHttp2Client {
	requestUnary(request: {
		readonly baseUrl: string;
		readonly path: string;
		readonly headers: Record<string, string>;
		readonly body: Uint8Array;
		readonly signal?: AbortSignal;
		readonly timeoutMs?: number;
	}): Promise<CursorHttp2UnaryResponse>;
	openStream(request: {
		readonly baseUrl: string;
		readonly path: string;
		readonly headers: Record<string, string>;
		readonly signal?: AbortSignal;
		readonly initialBody?: Uint8Array;
		readonly timeoutMs?: number;
	}): Promise<CursorHttp2StreamHandle>;
	dispose(): Promise<void>;
}

export interface CursorProtocolCodec {
	encodeGetUsableModelsRequest(): Uint8Array;
	decodeGetUsableModelsResponse(data: Uint8Array): readonly CursorUsableModel[];
	encodeRunRequest(request: CursorRunRequest): Uint8Array;
	decodeRunFrame(frame: CursorConnectFrame): readonly CursorProtocolMessage[];
	encodeToolResult(result: CursorToolResultMessage): Uint8Array;
	encodeCancelRequest(): Uint8Array;
	encodeHeartbeatRequest(): Uint8Array;
	encodeServerResponse?(message: CursorProtocolMessage, requestId: string): Uint8Array | undefined;
	disposeRun?(requestId: string): void;
	discardRun?(requestId: string): void;
	discardConversation?(conversationId: string): void;
}

export interface Http2CursorAgentTransportOptions {
	readonly baseUrl?: string;
	readonly client?: CursorHttp2Client;
	readonly codec?: CursorProtocolCodec;
	readonly requestTimeoutMs?: number;
	readonly streamOpenTimeoutMs?: number;
	readonly heartbeatIntervalMs?: number;
}
