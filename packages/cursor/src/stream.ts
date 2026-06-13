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
import { CursorConversationStateStore, type CursorConversationSnapshot } from "./conversation-state.js";
import { resolveCursorModelVariant } from "./model-mapper.js";
import type { CursorAgentTransport, CursorRunStream, CursorServerMessage, CursorToolCallMessage, CursorToolResultMessage } from "./transport.js";

export interface CursorStreamAdapterOptions {
	readonly transport: CursorAgentTransport;
	readonly conversationState?: CursorConversationStateStore;
	readonly uuid?: () => string;
	readonly pausedTurnIdleTimeoutMs?: number;
	readonly streamReadTimeoutMs?: number;
}

interface CursorStreamRuntime {
	readonly transport: CursorAgentTransport;
	readonly conversationState: CursorConversationStateStore;
	readonly uuid: () => string;
	readonly pausedTurnIdleTimeoutMs: number;
	readonly streamReadTimeoutMs: number;
}

const DEFAULT_PAUSED_TURN_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_STREAM_READ_TIMEOUT_MS = 10 * 60 * 1000;

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
			pausedTurnIdleTimeoutMs: options.pausedTurnIdleTimeoutMs ?? DEFAULT_PAUSED_TURN_IDLE_TIMEOUT_MS,
			streamReadTimeoutMs: options.streamReadTimeoutMs ?? DEFAULT_STREAM_READ_TIMEOUT_MS,
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

	getLifecycleSnapshot(): CursorConversationSnapshot {
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
		const pendingToolCalls: CursorToolCallMessage[] = [];
		const effectiveTimeoutMs = options?.timeoutMs ?? this.#runtime.streamReadTimeoutMs;

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
			const trailingToolResults = getTrailingToolResults(context);
			if (trailingToolResults.length > 0) {
				conversationId = requireCursorToolSessionId(options.sessionId, "resume a paused Cursor tool turn");
				runStream = await this.#runtime.conversationState.resumeTurnWithToolResults(conversationId, trailingToolResults, { signal: options.signal, timeoutMs: effectiveTimeoutMs });
			} else {
				runStream = await this.#runtime.transport.run({
					accessToken: options.apiKey,
					requestId,
					conversationId,
					model,
					resolvedModelId,
					thinkingLevel: options.reasoning,
					context,
					signal: options.signal,
					openTimeoutMs: effectiveTimeoutMs,
				});
				this.#runtime.conversationState.registerTurn(conversationId, runStream);
			}
			const iterator = runStream.messages[Symbol.asyncIterator]();
			while (true) {
				const next = await readNextCursorMessage(iterator, options.signal, effectiveTimeoutMs);
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
					conversationId = requireCursorToolSessionId(options.sessionId, "pause a Cursor tool turn");
					sawToolCall = true;
					pendingToolCalls.push(message);
					appendToolCall(stream, output, message.id, message.name, message.argumentsJson);
				} else if (message.type === "usage") {
					updateUsage(output, model, message);
				} else if (message.type === "nonMcpExec") {
					continue;
				} else {
					closeOpenContent(stream, output, textIndex, thinkingIndex);
					if (pendingToolCalls.length > 0) {
						const toolConversationId = requireCursorToolSessionId(options.sessionId, "pause a Cursor tool turn");
						this.#runtime.conversationState.pauseTurnForTools(toolConversationId, runStream, pendingToolCalls, { signal: options?.signal, idleTimeoutMs: this.#runtime.pausedTurnIdleTimeoutMs });
						conversationId = toolConversationId;
						output.stopReason = "toolUse";
						stream.push({ type: "done", reason: "toolUse", message: output });
						runStream = undefined;
					} else {
						output.stopReason = message.reason;
						stream.push({ type: "done", reason: message.reason, message: output });
					}
					terminalEventSent = true;
					break;
				}
			}

			if (!terminalEventSent) {
				closeOpenContent(stream, output, textIndex, thinkingIndex);
				if (pendingToolCalls.length > 0 && runStream) {
					const toolConversationId = requireCursorToolSessionId(options.sessionId, "pause a Cursor tool turn");
					this.#runtime.conversationState.pauseTurnForTools(toolConversationId, runStream, pendingToolCalls, { signal: options?.signal, idleTimeoutMs: this.#runtime.pausedTurnIdleTimeoutMs });
					conversationId = toolConversationId;
					output.stopReason = "toolUse";
					stream.push({ type: "done", reason: "toolUse", message: output });
					runStream = undefined;
				} else {
					output.stopReason = sawToolCall ? "toolUse" : "stop";
					stream.push({ type: "done", reason: output.stopReason, message: output });
				}
			}
		} catch (error) {
			const aborted = error instanceof CursorStreamAbortError || options?.signal?.aborted;
			const timedOut = error instanceof CursorStreamTimeoutError;
			if (timedOut && pendingToolCalls.length > 0 && runStream) {
				closeOpenContent(stream, output, textIndex, thinkingIndex);
				const toolConversationId = requireCursorToolSessionId(options?.sessionId, "pause a Cursor tool turn");
				this.#runtime.conversationState.pauseTurnForTools(toolConversationId, runStream, pendingToolCalls, { signal: options?.signal, idleTimeoutMs: this.#runtime.pausedTurnIdleTimeoutMs });
				conversationId = toolConversationId;
				output.stopReason = "toolUse";
				stream.push({ type: "done", reason: "toolUse", message: output });
				terminalEventSent = true;
				runStream = undefined;
				return;
			}
			output.stopReason = aborted ? "aborted" : "error";
			output.errorMessage = aborted
				? "Cursor stream aborted."
				: timedOut
					? "Cursor stream timed out while waiting for provider output."
					: sanitizeDiagnosticText(error instanceof Error ? error.message : "Cursor stream failed.", [options?.apiKey ?? ""]);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			if ((aborted || timedOut) && runStream && conversationId) {
				try {
					await this.#runtime.conversationState.cancelTurn(conversationId);
				} catch {
					// Terminal events must not be suppressed by best-effort cleanup failures.
				} finally {
					runStream = undefined;
				}
			}
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

class CursorStreamTimeoutError extends Error {
	constructor() {
		super("Cursor stream timed out while waiting for provider output.");
		this.name = "CursorStreamTimeoutError";
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

function getTrailingToolResults(context: Context): CursorToolResultMessage[] {
	const results: CursorToolResultMessage[] = [];
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index];
		if (!message || message.role !== "toolResult") break;
		results.unshift({ toolCallId: message.toolCallId, toolName: message.toolName, text: textFromToolResult(message), isError: message.isError });
	}
	return results;
}

function textFromToolResult(message: Extract<Context["messages"][number], { readonly role: "toolResult" }>): string {
	return message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
}

function requireCursorToolSessionId(sessionId: string | undefined, action: string): string {
	if (sessionId && sessionId.trim().length > 0) return sessionId;
	throw new Error(`Cursor tool calls require a stable sessionId from the host before Atomic can ${action}.`);
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
		// Cursor checkpoint `usedTokens` omits a dedicated input field on some
		// frames, so estimate input from already-seen output/cache counters.
		else if (message.usedTokens !== undefined) output.usage.input = Math.max(0, message.usedTokens - output.usage.output - output.usage.cacheRead - output.usage.cacheWrite);
		if (message.outputTokens !== undefined) output.usage.output = message.outputTokens;
		if (message.cacheReadTokens !== undefined) output.usage.cacheRead = message.cacheReadTokens;
		if (message.cacheWriteTokens !== undefined) output.usage.cacheWrite = message.cacheWriteTokens;
	}
	output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
	output.usage.cost = calculateCost(model, output.usage);
}

async function readNextCursorMessage(iterator: AsyncIterator<CursorServerMessage>, signal: AbortSignal | undefined, timeoutMs: number): Promise<IteratorReadResult> {
	if (signal?.aborted) return { kind: "aborted" };
	let abortListener: (() => void) | undefined;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const abortPromise = signal ? new Promise<IteratorReadResult>((resolve) => {
		abortListener = () => resolve({ kind: "aborted" });
		signal.addEventListener("abort", abortListener, { once: true });
	}) : undefined;
	const timeoutPromise = timeoutMs > 0 ? new Promise<IteratorReadResult>((_resolve, reject) => {
		timeout = setTimeout(() => reject(new CursorStreamTimeoutError()), timeoutMs);
		timeout.unref?.();
	}) : undefined;
	const messagePromise = iterator.next().then((result): IteratorReadResult => ({ kind: "message", result }));
	void messagePromise.catch(() => undefined);
	try {
		return await Promise.race([messagePromise, ...(abortPromise ? [abortPromise] : []), ...(timeoutPromise ? [timeoutPromise] : [])]);
	} finally {
		if (abortListener) signal?.removeEventListener("abort", abortListener);
		if (timeout) clearTimeout(timeout);
	}
}

export function createCursorStreamAdapter(options: CursorStreamAdapterOptions): CursorStreamAdapter {
	return new CursorStreamAdapter(options);
}
