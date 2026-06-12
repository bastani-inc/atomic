import { randomUUID as nodeRandomUUID } from "node:crypto";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	calculateCost,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { parseJsonObject, sanitizeDiagnosticText } from "./config.js";
import { CursorConversationStateStore } from "./conversation-state.js";
import { resolveCursorModelVariant } from "./model-mapper.js";
import type { CursorAgentTransport, CursorRunStream, CursorServerMessage } from "./transport.js";

export interface CursorStreamAdapterOptions {
	readonly transport: CursorAgentTransport;
	readonly conversationState?: CursorConversationStateStore;
	readonly uuid?: () => string;
}

interface CursorStreamRuntime {
	readonly transport: CursorAgentTransport;
	readonly conversationState: CursorConversationStateStore;
	readonly uuid: () => string;
}

type IteratorReadResult =
	| { readonly kind: "message"; readonly result: IteratorResult<CursorServerMessage> }
	| { readonly kind: "aborted" };

function defaultCursorUuid(): string {
	return nodeRandomUUID();
}

export class CursorStreamAdapter {
	readonly #runtime: CursorStreamRuntime;

	constructor(options: CursorStreamAdapterOptions) {
		this.#runtime = {
			transport: options.transport,
			conversationState: options.conversationState ?? new CursorConversationStateStore(),
			uuid: options.uuid ?? defaultCursorUuid,
		};
	}

	streamSimple = (model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream => {
		const stream = createAssistantMessageEventStream();
		void this.#runStream(stream, model, context, options);
		return stream;
	};

	async dispose(): Promise<void> {
		await this.#runtime.conversationState.dispose();
		await this.#runtime.transport.dispose();
	}

	getLifecycleSnapshot() {
		return this.#runtime.conversationState.snapshot(this.#runtime.transport.getLifecycleSnapshot());
	}

	async #runStream(
		stream: AssistantMessageEventStream,
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	): Promise<void> {
		const output = createOutputMessage(model);
		stream.push({ type: "start", partial: output });

		let runStream: CursorRunStream | undefined;
		let conversationId: string | undefined;
		let textIndex: number | undefined;
		let thinkingIndex: number | undefined;
		let terminalEventSent = false;
		let sawToolCall = false;

		try {
			if (!options?.apiKey) {
				throw new Error("Cursor OAuth credentials are required. Run /login and select Cursor (experimental).");
			}
			if (hasImageInput(context)) {
				throw new Error("Cursor provider currently supports text input only; vision/image content is unsupported.");
			}
			if (options.signal?.aborted) {
				throw new CursorStreamAbortError();
			}

			const requestId = this.#runtime.uuid();
			conversationId = options.sessionId ?? requestId;
			const resolvedModelId = resolveCursorModelVariant(model.id, model.thinkingLevelMap, options.reasoning);
			runStream = await this.#runtime.transport.run({
				accessToken: options.apiKey,
				requestId,
				model,
				resolvedModelId,
				thinkingLevel: options.reasoning,
				context,
				signal: options.signal,
			});
			this.#runtime.conversationState.registerTurn(conversationId, runStream);
			const iterator = runStream.messages[Symbol.asyncIterator]();
			while (true) {
				const next = await readNextCursorMessage(iterator, options.signal);
				if (next.kind === "aborted") {
					throw new CursorStreamAbortError();
				}
				if (next.result.done) {
					break;
				}
				const message = next.result.value;
				if (message.type === "textDelta") {
					textIndex = appendTextDelta(stream, output, textIndex, message.text);
				} else if (message.type === "thinkingDelta") {
					thinkingIndex = appendThinkingDelta(stream, output, thinkingIndex, message.text);
				} else if (message.type === "toolCall") {
					sawToolCall = true;
					appendToolCall(stream, output, message.id, message.name, message.argumentsJson);
				} else if (message.type === "usage") {
					updateUsage(output, model, message);
				} else {
					closeOpenContent(stream, output, textIndex, thinkingIndex);
					output.stopReason = message.reason;
					stream.push({ type: "done", reason: message.reason, message: output });
					terminalEventSent = true;
					break;
				}
			}

			if (!terminalEventSent) {
				closeOpenContent(stream, output, textIndex, thinkingIndex);
				output.stopReason = sawToolCall ? "toolUse" : "stop";
				stream.push({ type: "done", reason: output.stopReason, message: output });
				terminalEventSent = true;
			}
		} catch (error) {
			const aborted = error instanceof CursorStreamAbortError || options?.signal?.aborted;
			if (aborted && runStream && conversationId) {
				await this.#runtime.conversationState.cancelTurn(conversationId);
			}
			output.stopReason = aborted ? "aborted" : "error";
			output.errorMessage = aborted
				? "Cursor stream aborted."
				: sanitizeDiagnosticText(error instanceof Error ? error.message : "Cursor stream failed.", [options?.apiKey ?? ""]);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			terminalEventSent = true;
		} finally {
			try {
				if (runStream && !options?.signal?.aborted) {
					await runStream.close();
					if (conversationId) this.#runtime.conversationState.completeTurn(conversationId);
				}
			} finally {
				stream.end(output);
			}
		}
	}
}

class CursorStreamAbortError extends Error {
	constructor() {
		super("Cursor stream aborted.");
		this.name = "CursorStreamAbortError";
	}
}

function createOutputMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function hasImageInput(context: Context): boolean {
	for (const message of context.messages) {
		if (message.role === "user") {
			if (typeof message.content !== "string" && message.content.some((content) => content.type === "image")) return true;
		} else if (message.role === "toolResult") {
			if (message.content.some((content) => content.type === "image")) return true;
		}
	}
	return false;
}

function appendTextDelta(stream: AssistantMessageEventStream, output: AssistantMessage, existingIndex: number | undefined, delta: string): number {
	const contentIndex = existingIndex ?? output.content.length;
	if (existingIndex === undefined) {
		output.content.push({ type: "text", text: "" });
		stream.push({ type: "text_start", contentIndex, partial: output });
	}
	const block = output.content[contentIndex];
	if (block?.type === "text") {
		block.text += delta;
	}
	stream.push({ type: "text_delta", contentIndex, delta, partial: output });
	return contentIndex;
}

function appendThinkingDelta(stream: AssistantMessageEventStream, output: AssistantMessage, existingIndex: number | undefined, delta: string): number {
	const contentIndex = existingIndex ?? output.content.length;
	if (existingIndex === undefined) {
		output.content.push({ type: "thinking", thinking: "" });
		stream.push({ type: "thinking_start", contentIndex, partial: output });
	}
	const block = output.content[contentIndex];
	if (block?.type === "thinking") {
		block.thinking += delta;
	}
	stream.push({ type: "thinking_delta", contentIndex, delta, partial: output });
	return contentIndex;
}

function appendToolCall(stream: AssistantMessageEventStream, output: AssistantMessage, id: string, name: string, argumentsJson: string): void {
	const contentIndex = output.content.length;
	const parsedArguments = parseJsonObject(argumentsJson) ?? {};
	output.content.push({ type: "toolCall", id, name, arguments: parsedArguments });
	stream.push({ type: "toolcall_start", contentIndex, partial: output });
	stream.push({ type: "toolcall_delta", contentIndex, delta: argumentsJson, partial: output });
	stream.push({
		type: "toolcall_end",
		contentIndex,
		toolCall: { type: "toolCall", id, name, arguments: parsedArguments },
		partial: output,
	});
}

function closeOpenContent(stream: AssistantMessageEventStream, output: AssistantMessage, textIndex: number | undefined, thinkingIndex: number | undefined): void {
	if (textIndex !== undefined) {
		const block = output.content[textIndex];
		if (block?.type === "text") {
			stream.push({ type: "text_end", contentIndex: textIndex, content: block.text, partial: output });
		}
	}
	if (thinkingIndex !== undefined) {
		const block = output.content[thinkingIndex];
		if (block?.type === "thinking") {
			stream.push({ type: "thinking_end", contentIndex: thinkingIndex, content: block.thinking, partial: output });
		}
	}
}

function updateUsage(output: AssistantMessage, model: Model<Api>, message: Extract<CursorServerMessage, { readonly type: "usage" }>): void {
	if (message.kind === "outputDelta") {
		output.usage.output += message.outputTokens;
	} else {
		if (message.inputTokens !== undefined) output.usage.input = message.inputTokens;
		if (message.outputTokens !== undefined) output.usage.output = message.outputTokens;
		if (message.cacheReadTokens !== undefined) output.usage.cacheRead = message.cacheReadTokens;
		if (message.cacheWriteTokens !== undefined) output.usage.cacheWrite = message.cacheWriteTokens;
	}
	output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
	output.usage.cost = calculateCost(model, output.usage);
}

async function readNextCursorMessage(iterator: AsyncIterator<CursorServerMessage>, signal?: AbortSignal): Promise<IteratorReadResult> {
	if (!signal) {
		return { kind: "message", result: await iterator.next() };
	}
	if (signal.aborted) {
		return { kind: "aborted" };
	}
	let abortListener: (() => void) | undefined;
	const abortPromise = new Promise<IteratorReadResult>((resolve) => {
		abortListener = () => resolve({ kind: "aborted" });
		signal.addEventListener("abort", abortListener, { once: true });
	});
	const messagePromise = iterator.next().then((result): IteratorReadResult => ({ kind: "message", result }));
	const result = await Promise.race([messagePromise, abortPromise]);
	if (abortListener) signal.removeEventListener("abort", abortListener);
	return result;
}

export function createCursorStreamAdapter(options: CursorStreamAdapterOptions): CursorStreamAdapter {
	return new CursorStreamAdapter(options);
}
