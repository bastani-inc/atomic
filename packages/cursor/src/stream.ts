import { createHash, randomUUID as nodeRandomUUID } from "node:crypto";
import { type Api, type AssistantMessage, type AssistantMessageEventStream, calculateCost, type Context, createAssistantMessageEventStream, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { parseJsonObject, sanitizeDiagnosticText } from "./config.js";
import { CursorConversationStateStore, type CursorConversationSnapshot } from "./conversation-state.js";
import { resolveCursorModelVariant } from "./model-mapper.js";
import type { CursorAgentTransport, CursorRunStream, CursorServerMessage, CursorToolCallMessage, CursorToolResultMessage } from "./transport.js";

export interface CursorStreamAdapterOptions {
	readonly transport: CursorAgentTransport; readonly conversationState?: CursorConversationStateStore; readonly uuid?: () => string;
	readonly pausedTurnIdleTimeoutMs?: number; readonly streamReadTimeoutMs?: number;
}
interface CursorStreamRuntime {
	readonly transport: CursorAgentTransport; readonly conversationState: CursorConversationStateStore; readonly uuid: () => string;
	readonly pausedTurnIdleTimeoutMs: number; readonly streamReadTimeoutMs: number;
}

const DEFAULT_PAUSED_TURN_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_STREAM_READ_TIMEOUT_MS = 10 * 60 * 1000;
const TOOL_CALL_BATCH_IDLE_TIMEOUT_MS = 100;

type IteratorReadResult = { readonly kind: "message"; readonly result: IteratorResult<CursorServerMessage> } | { readonly kind: "aborted" };
type CursorReadRaceResult =
	| { readonly kind: "message"; readonly result: IteratorResult<CursorServerMessage>; readonly read: CursorMessageReadHandle }
	| { readonly kind: "error"; readonly error: Error; readonly read: CursorMessageReadHandle }
	| { readonly kind: "aborted" };

function defaultCursorUuid(): string {
	return nodeRandomUUID();
}

export class CursorStreamAdapter {
	readonly #runtime: CursorStreamRuntime;
	readonly #messageReaders = new WeakMap<CursorRunStream, CursorMessageReader>();

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

	async cleanupSession(sessionId: string): Promise<void> {
		await this.#runtime.conversationState.cancelTurn(deriveCursorBridgeKeyFromSessionId(sessionId));
		this.#runtime.transport.discardConversation?.(deriveCursorWireConversationIdFromSessionId(sessionId));
	}

	getLifecycleSnapshot(): CursorConversationSnapshot {
		return this.#runtime.conversationState.snapshot(this.#runtime.transport.getLifecycleSnapshot());
	}
	#messageReaderFor(runStream: CursorRunStream): CursorMessageReader {
		const existing = this.#messageReaders.get(runStream);
		if (existing) return existing;
		const reader = new CursorMessageReader(runStream.messages);
		this.#messageReaders.set(runStream, reader);
		return reader;
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
		let activeConversationKey: string | undefined;
		let textIndex: number | undefined;
		let thinkingIndex: number | undefined;
		let terminalEventSent = false;
		let sawToolCall = false;
		const pendingToolCalls: CursorToolCallMessage[] = [];
		const effectiveTimeoutMs = options?.timeoutMs ?? this.#runtime.streamReadTimeoutMs;
		try {
			if (!options?.apiKey) {
				throw new Error("Cursor OAuth credentials are required. Run /login and select Cursor.");
			}
			if (hasImageInput(context)) {
				throw new Error("Cursor provider currently supports text input only; vision/image content is unsupported.");
			}
			if (options.signal?.aborted) {
				throw new CursorStreamAbortError();
			}
			const requestId = this.#runtime.uuid();
			const conversationIdentity = deriveCursorConversationIdentity(context, options.sessionId);
			activeConversationKey = conversationIdentity.activeKey;
			const resolvedModelId = resolveCursorModelVariant(model.id, model.thinkingLevelMap, options.reasoning);
			const trailingToolResults = getTrailingToolResults(context);
			if (trailingToolResults.length > 0) {
				runStream = await this.#runtime.conversationState.resumeTurnWithToolResults(activeConversationKey, trailingToolResults, { signal: options.signal, timeoutMs: effectiveTimeoutMs });
			} else {
				runStream = await this.#runtime.transport.run({
					accessToken: options.apiKey,
					requestId,
					conversationId: conversationIdentity.wireConversationId,
					model,
					resolvedModelId,
					thinkingLevel: options.reasoning,
					context,
					signal: options.signal,
					openTimeoutMs: effectiveTimeoutMs,
				});
				this.#runtime.conversationState.registerTurn(activeConversationKey, runStream);
			}
			const reader = this.#messageReaderFor(runStream);
			while (true) {
				const readTimeoutMs = pendingToolCalls.length > 0 ? Math.min(effectiveTimeoutMs, TOOL_CALL_BATCH_IDLE_TIMEOUT_MS) : effectiveTimeoutMs;
				const next = await readNextCursorMessage(reader, options.signal, readTimeoutMs);
				if (next.kind === "aborted") {
					throw new CursorStreamAbortError();
				}
				if (next.result.done) {
					break;
				}
				const message = next.result.value;
				if (pendingToolCalls.length > 0 && message.type !== "toolCall" && message.type !== "usage") {
					closeOpenContent(stream, output, textIndex, thinkingIndex);
					if (!(message.type === "done" && message.reason === "toolUse")) reader.unread(next.result);
					this.#runtime.conversationState.pauseTurnForTools(activeConversationKey, runStream, pendingToolCalls, { signal: options?.signal, idleTimeoutMs: this.#runtime.pausedTurnIdleTimeoutMs });
					output.stopReason = "toolUse";
					stream.push({ type: "done", reason: "toolUse", message: output });
					terminalEventSent = true;
					runStream = undefined;
					break;
				}
				if (message.type === "textDelta") {
					textIndex = appendTextDelta(stream, output, textIndex, message.text);
				} else if (message.type === "thinkingDelta") {
					thinkingIndex = appendThinkingDelta(stream, output, thinkingIndex, message.text);
				} else if (message.type === "toolCall") {
					sawToolCall = true;
					pendingToolCalls.push(message);
					appendToolCall(stream, output, message.id, message.name, message.argumentsJson);
					continue;
				} else if (message.type === "usage") {
					updateUsage(output, model, message);
				} else if (message.type === "nonMcpExec") {
					continue;
				} else {
					closeOpenContent(stream, output, textIndex, thinkingIndex);
					if (pendingToolCalls.length > 0) {
						this.#runtime.conversationState.pauseTurnForTools(activeConversationKey, runStream, pendingToolCalls, { signal: options?.signal, idleTimeoutMs: this.#runtime.pausedTurnIdleTimeoutMs });
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
					this.#runtime.conversationState.pauseTurnForTools(activeConversationKey, runStream, pendingToolCalls, { signal: options?.signal, idleTimeoutMs: this.#runtime.pausedTurnIdleTimeoutMs });
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
			if (timedOut && pendingToolCalls.length > 0 && runStream && activeConversationKey) {
				closeOpenContent(stream, output, textIndex, thinkingIndex);
				this.#runtime.conversationState.pauseTurnForTools(activeConversationKey, runStream, pendingToolCalls, { signal: options?.signal, idleTimeoutMs: this.#runtime.pausedTurnIdleTimeoutMs });
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
			if ((aborted || timedOut) && runStream && activeConversationKey) {
				try {
					await this.#runtime.conversationState.cancelTurn(activeConversationKey);
				} catch {
				} finally {
					runStream = undefined;
				}
			}
		} finally {
			try {
				if (runStream && !options?.signal?.aborted) {
					await runStream.close();
					if (activeConversationKey) this.#runtime.conversationState.completeTurn(activeConversationKey);
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
interface CursorPendingMessageRead {
	readonly promise: Promise<IteratorResult<CursorServerMessage>>;
	consumed: boolean;
}
interface CursorMessageReadHandle {
	readonly promise: Promise<IteratorResult<CursorServerMessage>>;
	consumeResult(result: IteratorResult<CursorServerMessage>): void;
	consumeError(error: Error): void;
}
type CursorBufferedMessageRead =
	| { readonly kind: "result"; readonly result: IteratorResult<CursorServerMessage> }
	| { readonly kind: "error"; readonly error: Error };
class CursorMessageReader {
	readonly #iterator: AsyncIterator<CursorServerMessage>;
	#pending: CursorPendingMessageRead | undefined;
	#buffered: CursorBufferedMessageRead | undefined;
	constructor(messages: AsyncIterable<CursorServerMessage>) {
		this.#iterator = messages[Symbol.asyncIterator]();
	}
	unread(result: IteratorResult<CursorServerMessage>): void {
		if (this.#buffered) return;
		this.#buffered = { kind: "result", result };
	}
	peek(): CursorMessageReadHandle {
		if (this.#buffered) return this.peekBuffered(this.#buffered);
		const pending = this.#pending ?? this.startRead();
		return {
			promise: pending.promise,
			consumeResult: (result) => {
				pending.consumed = true;
				if (this.#pending === pending) this.#pending = undefined;
				if (this.#buffered?.kind === "result" && this.#buffered.result === result) this.#buffered = undefined;
			},
			consumeError: (error) => {
				pending.consumed = true;
				if (this.#pending === pending) this.#pending = undefined;
				if (this.#buffered?.kind === "error" && this.#buffered.error === error) this.#buffered = undefined;
			},
		};
	}
	private peekBuffered(buffered: CursorBufferedMessageRead): CursorMessageReadHandle {
		return {
			promise: buffered.kind === "result" ? Promise.resolve(buffered.result) : Promise.reject(buffered.error),
			consumeResult: (result) => {
				if (this.#buffered === buffered && buffered.kind === "result" && buffered.result === result) this.#buffered = undefined;
			},
			consumeError: (error) => {
				if (this.#buffered === buffered && buffered.kind === "error" && buffered.error === error) this.#buffered = undefined;
			},
		};
	}
	private startRead(): CursorPendingMessageRead {
		const pending: CursorPendingMessageRead = {
			promise: this.#iterator.next().catch((error: Error) => {
				throw normalizeCursorReadError(error);
			}),
			consumed: false,
		};
		this.#pending = pending;
		pending.promise.then(
			(result) => {
				if (this.#pending !== pending) return;
				this.#pending = undefined;
				if (!pending.consumed) this.#buffered = { kind: "result", result };
			},
			(error: Error) => {
				if (this.#pending !== pending) return;
				this.#pending = undefined;
				if (!pending.consumed) this.#buffered = { kind: "error", error };
			},
		);
		void pending.promise.catch(() => undefined);
		return pending;
	}
}
function normalizeCursorReadError(error: Error): Error {
	return error instanceof Error ? error : new Error(String(error));
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
function textFromMessage(message: Context["messages"][number]): string {
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
	return textFromToolResult(message);
}
interface CursorConversationIdentity {
	readonly activeKey: string;
	readonly wireConversationId: string;
}
function deriveCursorConversationIdentity(context: Context, sessionId: string | undefined): CursorConversationIdentity {
	const bridgeKey = deriveCursorConversationKey("bridge", context, sessionId);
	const conversationKey = deriveCursorConversationKey("conv", context, sessionId);
	return { activeKey: bridgeKey, wireConversationId: deterministicCursorConversationId(conversationKey) };
}
function deriveCursorBridgeKeyFromSessionId(sessionId: string): string {
	return hashCursorKey("bridge", sessionId);
}
function deriveCursorWireConversationIdFromSessionId(sessionId: string): string {
	return deterministicCursorConversationId(hashCursorKey("conv", sessionId));
}
function deriveCursorConversationKey(prefix: "bridge" | "conv", context: Context, sessionId: string | undefined): string {
	const trimmedSessionId = sessionId?.trim();
	if (trimmedSessionId) return hashCursorKey(prefix, trimmedSessionId);
	const firstUserMessage = context.messages.find((message) => message.role === "user");
	const firstUserText = firstUserMessage ? textFromMessage(firstUserMessage).slice(0, 200) : "";
	return hashCursorKey(prefix, firstUserText);
}
function hashCursorKey(prefix: "bridge" | "conv", value: string): string {
	return createHash("sha256").update(`${prefix}:${value}`).digest("hex").slice(0, 16);
}
function deterministicCursorConversationId(conversationKey: string): string {
	const hex = createHash("sha256").update(`cursor-conv-id:${conversationKey}`).digest("hex").slice(0, 32);
	const variantNibble = (0x8 | (Number.parseInt(hex[16] ?? "0", 16) & 0x3)).toString(16);
	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		`4${hex.slice(13, 16)}`,
		`${variantNibble}${hex.slice(17, 20)}`,
		hex.slice(20, 32),
	].join("-");
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
		else if (message.usedTokens !== undefined) output.usage.input = Math.max(0, message.usedTokens - output.usage.output - output.usage.cacheRead - output.usage.cacheWrite);
		if (message.outputTokens !== undefined) output.usage.output = message.outputTokens;
		if (message.cacheReadTokens !== undefined) output.usage.cacheRead = message.cacheReadTokens;
		if (message.cacheWriteTokens !== undefined) output.usage.cacheWrite = message.cacheWriteTokens;
	}
	output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
	output.usage.cost = calculateCost(model, output.usage);
}
async function readNextCursorMessage(reader: CursorMessageReader, signal: AbortSignal | undefined, timeoutMs: number): Promise<IteratorReadResult> {
	if (signal?.aborted) return { kind: "aborted" };
	let abortListener: (() => void) | undefined;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const abortPromise = signal ? new Promise<CursorReadRaceResult>((resolve) => {
		abortListener = () => resolve({ kind: "aborted" });
		signal.addEventListener("abort", abortListener, { once: true });
	}) : undefined;
	const timeoutPromise = timeoutMs > 0 ? new Promise<CursorReadRaceResult>((_resolve, reject) => {
		timeout = setTimeout(() => reject(new CursorStreamTimeoutError()), timeoutMs);
		timeout.unref?.();
	}) : undefined;
	const read = reader.peek();
	const messagePromise = read.promise.then(
		(result): CursorReadRaceResult => ({ kind: "message", result, read }),
		(error: Error): CursorReadRaceResult => ({ kind: "error", error: normalizeCursorReadError(error), read }),
	);
	try {
		const next = await Promise.race([messagePromise, ...(abortPromise ? [abortPromise] : []), ...(timeoutPromise ? [timeoutPromise] : [])]);
		if (next.kind === "message") {
			next.read.consumeResult(next.result);
			return { kind: "message", result: next.result };
		}
		if (next.kind === "error") {
			next.read.consumeError(next.error);
			throw next.error;
		}
		return next;
	} finally {
		if (abortListener) signal?.removeEventListener("abort", abortListener);
		if (timeout) clearTimeout(timeout);
	}
}
export function createCursorStreamAdapter(options: CursorStreamAdapterOptions): CursorStreamAdapter {
	return new CursorStreamAdapter(options);
}
