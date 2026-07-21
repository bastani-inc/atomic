import { createHash, randomUUID as nodeRandomUUID } from "node:crypto";
import { type Api, type AssistantMessage, type AssistantMessageEventStream, calculateCost, type Context, createAssistantMessageEventStream, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { parseJsonObject, sanitizeDiagnosticText } from "./config.js";
import { CursorConversationStateStore, type CursorConversationSnapshot } from "./conversation-state.js";
import { CursorError } from "./errors.js";
import { getCursorRouteReference } from "./model-mapper.js";
import { assertCurrentCursorInputIsTextOnly } from "./input-validation.js";
import type { CursorPreparationController, CursorRequestLease } from "./preparation.js";
import { CursorMessageReader, CursorStreamAbortError, CursorStreamTimeoutError, readNextCursorMessage } from "./stream-read.js";
import type { CursorAgentTransport, CursorRunStream, CursorServerMessage, CursorToolCallMessage, CursorToolResultMessage } from "./transport.js";

export interface CursorStreamAdapterOptions {
	readonly transport: CursorAgentTransport; readonly conversationState?: CursorConversationStateStore; readonly uuid?: () => string;
	readonly routeAuthority: Pick<CursorPreparationController, "acquireRequestLease">;
	readonly pausedTurnIdleTimeoutMs?: number; readonly streamReadTimeoutMs?: number;
	readonly toolCallBatchIdleWait?: (idleMs: number) => Promise<void>;
}
interface CursorStreamRuntime {
	readonly transport: CursorAgentTransport; readonly conversationState: CursorConversationStateStore; readonly uuid: () => string;
	readonly routeAuthority: Pick<CursorPreparationController, "acquireRequestLease">;
	readonly pausedTurnIdleTimeoutMs: number; readonly streamReadTimeoutMs: number;
	readonly toolCallBatchIdleWait: (idleMs: number) => Promise<void>;
}
const DEFAULT_PAUSED_TURN_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_STREAM_READ_TIMEOUT_MS = 10 * 60 * 1000;
const TOOL_CALL_BATCH_IDLE_TIMEOUT_MS = 100;

function defaultCursorUuid(): string {
	return nodeRandomUUID();
}
class CursorToolBatchIdleError extends Error {
	constructor() { super("Cursor tool-call batch reached its idle handoff boundary."); this.name = "CursorToolBatchIdleError"; }
}

function waitForToolCallBatchIdle(idleMs: number): Promise<void> {
	return new Promise((resolve) => {
		const timeout = setTimeout(resolve, idleMs);
		timeout.unref?.();
	});
}

export class CursorStreamAdapter {
	readonly #runtime: CursorStreamRuntime;
	readonly #messageReaders = new WeakMap<CursorRunStream, CursorMessageReader>();

	constructor(options: CursorStreamAdapterOptions) {
		if (!options.routeAuthority) {
			throw new CursorError("UnsupportedSelection", "Cursor route authority is required before streaming.", { operation: "request" });
		}
		this.#runtime = {
			transport: options.transport,
			conversationState: options.conversationState ?? new CursorConversationStateStore(),
			uuid: options.uuid ?? defaultCursorUuid,
			routeAuthority: options.routeAuthority,
			pausedTurnIdleTimeoutMs: options.pausedTurnIdleTimeoutMs ?? DEFAULT_PAUSED_TURN_IDLE_TIMEOUT_MS,
			streamReadTimeoutMs: options.streamReadTimeoutMs ?? DEFAULT_STREAM_READ_TIMEOUT_MS,
			toolCallBatchIdleWait: options.toolCallBatchIdleWait ?? waitForToolCallBatchIdle,
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
		let runStreamRegistered = false;
		stream.push({ type: "start", partial: output });
		let runStream: CursorRunStream | undefined;
		let activeConversationKey: string | undefined;
		let textIndex: number | undefined;
		let thinkingIndex: number | undefined;
		let terminalEventSent = false;
		let sawToolCall = false;
		const pendingToolCalls: CursorToolCallMessage[] = [];
		const effectiveTimeoutMs = options?.timeoutMs ?? this.#runtime.streamReadTimeoutMs;
		let requestLease: CursorRequestLease | undefined;
		let requestSignalCleanup = (): void => undefined;
		let requestSignalOwnedByPausedTurn = false;
		let requestSignal = options?.signal;
		try {
			if (!options?.apiKey) {
				throw new Error("Cursor OAuth credentials are required. Run /login and select Cursor.");
			}
			const routeReference = getCursorRouteReference(model);
			requestLease = this.#runtime.routeAuthority.acquireRequestLease(routeReference);
			const combined = combineAbortSignals(options?.signal, requestLease.signal);
			requestSignal = combined.signal;
			requestSignalCleanup = combined.cleanup;
			requestLease.assertCurrent("request");
			assertCurrentCursorInputIsTextOnly(context, model.id);
			if (requestSignal?.aborted) throw new CursorStreamAbortError();
			const requestId = this.#runtime.uuid();
			const conversationIdentity = deriveCursorConversationIdentity(context, options.sessionId);
			activeConversationKey = conversationIdentity.activeKey;
			const trailingToolResults = getTrailingToolResults(context);
			if (trailingToolResults.length > 0 && this.#runtime.conversationState.hasPausedTurn(activeConversationKey)) {
				requestLease.assertCurrent("request");
				runStream = await this.#runtime.conversationState.resumeTurnWithToolResults(activeConversationKey, trailingToolResults, { signal: requestSignal, timeoutMs: effectiveTimeoutMs });
				requestLease.assertCurrent("request");
				runStreamRegistered = true;
			} else {
				runStream = await this.#runtime.transport.run({
					accessToken: options.apiKey,
					requestId,
					conversationId: conversationIdentity.wireConversationId,
					model,
					routeReference,
					context,
					signal: requestSignal,
					openTimeoutMs: effectiveTimeoutMs,
				});
				requestLease.assertCurrent("request");
				this.#runtime.conversationState.registerTurn(activeConversationKey, runStream, requestLease);
				runStreamRegistered = true;
			}
			const reader = this.#messageReaderFor(runStream);
			while (true) {
				const validatingToolBoundary = pendingToolCalls.length > 0;
				const next = await readNextCursorMessage(
					reader,
					requestSignal,
					effectiveTimeoutMs,
					validatingToolBoundary
						? () => this.#runtime.toolCallBatchIdleWait(TOOL_CALL_BATCH_IDLE_TIMEOUT_MS)
						: undefined,
					validatingToolBoundary ? runStream.failure : undefined,
				);
				if (next.kind === "aborted") throw new CursorStreamAbortError();
				if (next.kind === "idle") throw new CursorToolBatchIdleError();
				if (next.kind === "failure") {
					try { await readNextCursorMessage(reader, undefined, 0); }
					catch (error) { throw error; }
					throw next.error;
				}
				requestLease.assertCurrent("stream");
				if (next.result.done) {
					break;
				}
				const message = next.result.value;
				if (pendingToolCalls.length > 0 && message.type !== "toolCall" && message.type !== "usage") {
					closeOpenContent(stream, output, textIndex, thinkingIndex);
					if (!(message.type === "done" && message.reason === "toolUse")) reader.unread(next.result);
					requestSignalOwnedByPausedTurn = true;
					this.#runtime.conversationState.pauseTurnForTools(activeConversationKey, runStream, pendingToolCalls, { signal: requestSignal, signalCleanup: requestSignalCleanup, idleTimeoutMs: this.#runtime.pausedTurnIdleTimeoutMs, lease: requestLease });
					output.stopReason = "toolUse";
					stream.push({ type: "done", reason: "toolUse", message: output });
					terminalEventSent = true;
					runStream = undefined;
					break;
				}
				if (message.type === "textDelta") {
					if (thinkingIndex !== undefined) { closeThinkingContent(stream, output, thinkingIndex); thinkingIndex = undefined; }
					textIndex = appendTextDelta(stream, output, textIndex, message.text);
				} else if (message.type === "thinkingDelta") {
					if (textIndex !== undefined) { closeTextContent(stream, output, textIndex); textIndex = undefined; }
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
						requestSignalOwnedByPausedTurn = true;
						this.#runtime.conversationState.pauseTurnForTools(activeConversationKey, runStream, pendingToolCalls, { signal: requestSignal, signalCleanup: requestSignalCleanup, idleTimeoutMs: this.#runtime.pausedTurnIdleTimeoutMs, lease: requestLease });
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
					requestSignalOwnedByPausedTurn = true;
					this.#runtime.conversationState.pauseTurnForTools(activeConversationKey, runStream, pendingToolCalls, { signal: requestSignal, signalCleanup: requestSignalCleanup, idleTimeoutMs: this.#runtime.pausedTurnIdleTimeoutMs, lease: requestLease });
					output.stopReason = "toolUse";
					stream.push({ type: "done", reason: "toolUse", message: output });
					runStream = undefined;
				} else {
					output.stopReason = sawToolCall ? "toolUse" : "stop";
					stream.push({ type: "done", reason: output.stopReason, message: output });
				}
			}
		} catch (error) {
			const timedOut = error instanceof CursorStreamTimeoutError;
			const toolBatchIdle = error instanceof CursorToolBatchIdleError;
			let generationStale = (error instanceof CursorError && error.code === "StaleGeneration") ||
				(requestLease?.signal.aborted === true && options?.signal?.aborted !== true);
			if (!generationStale && options?.signal?.aborted !== true && (timedOut || toolBatchIdle) && pendingToolCalls.length > 0) {
				try { requestLease?.assertCurrent("stream"); }
				catch { generationStale = true; }
			}
			const aborted = !generationStale && (error instanceof CursorStreamAbortError || requestSignal?.aborted);
			if (!aborted && !generationStale && (timedOut || toolBatchIdle) && pendingToolCalls.length > 0 && runStream && activeConversationKey) {
				closeOpenContent(stream, output, textIndex, thinkingIndex);
				requestSignalOwnedByPausedTurn = true;
				this.#runtime.conversationState.pauseTurnForTools(activeConversationKey, runStream, pendingToolCalls, { signal: requestSignal, signalCleanup: requestSignalCleanup, idleTimeoutMs: this.#runtime.pausedTurnIdleTimeoutMs, lease: requestLease });
				output.stopReason = "toolUse";
				stream.push({ type: "done", reason: "toolUse", message: output });
				terminalEventSent = true;
				runStream = undefined;
				return;
			}
			output.stopReason = aborted ? "aborted" : "error";
			output.errorMessage = generationStale
				? "Cursor request generation became stale."
				: aborted
					? "Cursor stream aborted."
					: timedOut
						? "Cursor stream timed out while waiting for provider output."
						: sanitizeDiagnosticText(error instanceof Error ? error.message : "Cursor stream failed.", [options?.apiKey ?? ""]);
			if ((aborted || timedOut || generationStale) && runStream) {
				try {
					if (runStreamRegistered && activeConversationKey) await this.#runtime.conversationState.cancelTurn(activeConversationKey);
					else await runStream.cancel();
				} catch {
					try { await runStream.close(); } catch {}
				} finally {
					runStream = undefined;
				}
			}
			stream.push({ type: "error", reason: output.stopReason, error: output });
		} finally {
			try {
				if (runStream && !options?.signal?.aborted) {
					await runStream.close();
					if (activeConversationKey) this.#runtime.conversationState.completeTurn(activeConversationKey);
				}
			} finally {
				if (!requestSignalOwnedByPausedTurn) requestSignalCleanup();
				stream.end(output);
			}
		}
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
		results.unshift({ toolCallId: message.toolCallId, toolName: message.toolName, text: textFromToolResult(message), content: message.content, isError: message.isError });
	}
	return results;
}
function textFromToolResult(message: Extract<Context["messages"][number], { readonly role: "toolResult" }>): string {
	return message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
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
function closeTextContent(stream: AssistantMessageEventStream, output: AssistantMessage, index: number): void {
	const block = output.content[index];
	if (block?.type === "text") stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
}

function closeThinkingContent(stream: AssistantMessageEventStream, output: AssistantMessage, index: number): void {
	const block = output.content[index];
	if (block?.type === "thinking") stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
}
function closeOpenContent(stream: AssistantMessageEventStream, output: AssistantMessage, textIndex: number | undefined, thinkingIndex: number | undefined): void {
	if (textIndex !== undefined) closeTextContent(stream, output, textIndex);
	if (thinkingIndex !== undefined) closeThinkingContent(stream, output, thinkingIndex);
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

function combineAbortSignals(first: AbortSignal | undefined, second: AbortSignal): { signal: AbortSignal; cleanup(): void } {
	const controller = new AbortController();
	const abort = (): void => controller.abort();
	for (const signal of [first, second]) {
		if (signal?.aborted) controller.abort(signal.reason);
		else signal?.addEventListener("abort", abort, { once: true });
	}
	return {
		signal: controller.signal,
		cleanup: () => {
			first?.removeEventListener("abort", abort);
			second.removeEventListener("abort", abort);
		},
	};
}
export function createCursorStreamAdapter(options: CursorStreamAdapterOptions): CursorStreamAdapter {
	return new CursorStreamAdapter(options);
}
