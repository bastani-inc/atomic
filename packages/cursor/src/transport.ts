import type { Context, Model, Api, ThinkingLevel } from "@earendil-works/pi-ai";
import {
	buildCursorRpcHeaders,
	createCursorExperimentalProtocolError,
	CURSOR_API,
	CURSOR_API_BASE_URL,
	CURSOR_GET_USABLE_MODELS_PATH,
	CURSOR_RUN_PATH,
	parseJsonObject,
	readBooleanField,
	readNumberField,
	readStringField,
	redactHeaders,
	sanitizeDiagnosticText,
	type JsonObject,
} from "./config.js";
import type { CursorUsableModel } from "./model-mapper.js";

export interface CursorTransportLifecycleSnapshot {
	readonly openStreams: number;
	readonly cancelledStreams: number;
	readonly closedStreams: number;
}

export interface CursorRunRequest {
	readonly accessToken: string;
	readonly requestId: string;
	readonly model: Model<Api>;
	readonly resolvedModelId: string;
	readonly thinkingLevel?: ThinkingLevel;
	readonly context: Context;
	readonly signal?: AbortSignal;
}

export type CursorDoneReason = "stop" | "length" | "toolUse";

export type CursorServerMessage =
	| { readonly type: "textDelta"; readonly text: string }
	| { readonly type: "thinkingDelta"; readonly text: string }
	| { readonly type: "toolCall"; readonly id: string; readonly name: string; readonly argumentsJson: string }
	| { readonly type: "usage"; readonly inputTokens: number; readonly outputTokens: number; readonly cacheReadTokens?: number; readonly cacheWriteTokens?: number }
	| { readonly type: "done"; readonly reason: CursorDoneReason };

export interface CursorRunStream {
	readonly id: string;
	readonly messages: AsyncIterable<CursorServerMessage>;
	cancel(): Promise<void>;
	close(): Promise<void>;
}

export interface CursorAgentTransport {
	getUsableModels(accessToken: string, requestId: string, signal?: AbortSignal): Promise<readonly CursorUsableModel[]>;
	run(request: CursorRunRequest): Promise<CursorRunStream>;
	dispose(): Promise<void>;
	getLifecycleSnapshot(): CursorTransportLifecycleSnapshot;
}

export class Http2CursorAgentTransport implements CursorAgentTransport {
	#cancelledStreams = 0;
	#closedStreams = 0;

	constructor(readonly baseUrl = CURSOR_API_BASE_URL) {}

	async getUsableModels(accessToken: string, requestId: string, signal?: AbortSignal): Promise<readonly CursorUsableModel[]> {
		if (signal?.aborted) {
			throw createCursorExperimentalProtocolError("Cursor model discovery was aborted before the request started.");
		}
		const headers = buildCursorRpcHeaders(accessToken, requestId, "application/proto");
		void redactHeaders(headers);
		void new URL(CURSOR_GET_USABLE_MODELS_PATH, this.baseUrl);
		throw createCursorExperimentalProtocolError(
			"GetUsableModels requires Cursor protobuf descriptors and HTTP/2 Connect framing; using the estimated model catalog for now.",
		);
	}

	async run(request: CursorRunRequest): Promise<CursorRunStream> {
		if (request.signal?.aborted) {
			throw createCursorExperimentalProtocolError("Cursor stream was aborted before the request started.");
		}
		const headers = buildCursorRpcHeaders(request.accessToken, request.requestId, "application/connect+proto");
		void redactHeaders(headers);
		void new URL(CURSOR_RUN_PATH, this.baseUrl);
		throw createCursorExperimentalProtocolError(
			`${CURSOR_API} Run transport is isolated in transport.ts but deferred; no proxy or child-process bridge is used.`,
		);
	}

	async dispose(): Promise<void> {
		this.#closedStreams += 0;
	}

	getLifecycleSnapshot(): CursorTransportLifecycleSnapshot {
		return { openStreams: 0, cancelledStreams: this.#cancelledStreams, closedStreams: this.#closedStreams };
	}
}

export class CursorMockRunStream implements CursorRunStream {
	readonly id: string;
	readonly messages: AsyncIterable<CursorServerMessage>;
	#onCancel: () => void;
	#onClose: () => void;
	#cancelled = false;
	#closed = false;

	constructor(id: string, messages: AsyncIterable<CursorServerMessage>, onCancel: () => void, onClose: () => void) {
		this.id = id;
		this.messages = messages;
		this.#onCancel = onCancel;
		this.#onClose = onClose;
	}

	get cancelled(): boolean {
		return this.#cancelled;
	}

	get closed(): boolean {
		return this.#closed;
	}

	async cancel(): Promise<void> {
		if (this.#cancelled) return;
		this.#cancelled = true;
		this.#onCancel();
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#onClose();
	}
}

export interface CursorMockTransportRun {
	readonly request: CursorRunRequest;
	readonly stream: CursorMockRunStream;
}

export class CursorMockTransport implements CursorAgentTransport {
	readonly runs: CursorMockTransportRun[] = [];
	readonly modelRequests: string[] = [];
	#models: readonly CursorUsableModel[];
	#messages: readonly CursorServerMessage[];
	#openStreams = 0;
	#cancelledStreams = 0;
	#closedStreams = 0;

	constructor(options: { readonly models?: readonly CursorUsableModel[]; readonly messages?: readonly CursorServerMessage[] } = {}) {
		this.#models = options.models ?? [];
		this.#messages = options.messages ?? [];
	}

	setMessages(messages: readonly CursorServerMessage[]): void {
		this.#messages = messages;
	}

	async getUsableModels(accessToken: string, requestId: string, signal?: AbortSignal): Promise<readonly CursorUsableModel[]> {
		if (signal?.aborted) {
			throw new Error("Cursor mock model discovery aborted");
		}
		this.modelRequests.push(`${requestId}:${accessToken.length}`);
		return this.#models;
	}

	async run(request: CursorRunRequest): Promise<CursorRunStream> {
		if (request.signal?.aborted) {
			throw new Error("Cursor mock stream aborted");
		}
		this.#openStreams += 1;
		const stream = new CursorMockRunStream(
			request.requestId,
			this.createMessageIterable(),
			() => {
				this.#cancelledStreams += 1;
			},
			() => {
				this.#closedStreams += 1;
				this.#openStreams = Math.max(0, this.#openStreams - 1);
			},
		);
		this.runs.push({ request, stream });
		return stream;
	}

	async dispose(): Promise<void> {
		for (const run of this.runs) {
			await run.stream.close();
		}
	}

	getLifecycleSnapshot(): CursorTransportLifecycleSnapshot {
		return { openStreams: this.#openStreams, cancelledStreams: this.#cancelledStreams, closedStreams: this.#closedStreams };
	}

	private async *createMessageIterable(): AsyncIterable<CursorServerMessage> {
		for (const message of this.#messages) {
			yield message;
		}
	}
}

export function parseCursorModelFromJson(value: JsonObject): CursorUsableModel | undefined {
	const id = readStringField(value, "id") ?? readStringField(value, "modelId") ?? readStringField(value, "name");
	if (!id) return undefined;
	return {
		id,
		name: readStringField(value, "name"),
		displayName: readStringField(value, "displayName") ?? readStringField(value, "display_name"),
		contextWindow: readNumberField(value, "contextWindow") ?? readNumberField(value, "context_window"),
		maxTokens: readNumberField(value, "maxTokens") ?? readNumberField(value, "max_tokens"),
		supportsReasoning: readBooleanField(value, "supportsReasoning") ?? readBooleanField(value, "supports_reasoning"),
		supportsThinking: readBooleanField(value, "supportsThinking") ?? readBooleanField(value, "supports_thinking"),
	};
}

export function sanitizeCursorTransportError(error: Error, secrets: readonly string[] = []): Error {
	return new Error(sanitizeDiagnosticText(error.message, secrets));
}

export function parseCursorModelListFromJsonText(text: string): readonly CursorUsableModel[] {
	const parsed = parseJsonObject(text);
	const models = parsed?.models;
	if (!Array.isArray(models)) return [];
	return models.flatMap((item) => {
		if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
		const model = parseCursorModelFromJson(item as JsonObject);
		return model ? [model] : [];
	});
}
