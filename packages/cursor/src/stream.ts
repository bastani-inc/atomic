import { createHash, randomUUID as nodeRandomUUID } from "node:crypto";
import { type Api, type AssistantMessage, type AssistantMessageEventStream, calculateCost, type Context, createAssistantMessageEventStream, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { parseJsonObject, sanitizeDiagnosticText } from "./config.js";
import { CursorConversationStateStore, type CursorConversationSnapshot } from "./conversation-state.js";
import type { CursorAgentTransport, CursorRunStream, CursorServerMessage, CursorToolCallMessage, CursorToolResultMessage } from "./transport.js";
import type { CursorAuthorizedRoute, CursorExecutionRouteAuthorizer } from "./execution-authority.js";
import { CursorMessageReader, CursorStreamAbortError, CursorStreamTimeoutError, readNextCursorMessage } from "./stream-reader.js";
export interface CursorStreamAdapterOptions {
	readonly transport: CursorAgentTransport; readonly conversationState?: CursorConversationStateStore; readonly uuid?: () => string;
	readonly pausedTurnIdleTimeoutMs?: number; readonly streamReadTimeoutMs?: number; readonly disposeGraceMs?: number;
	readonly executionAuthorizer?: CursorExecutionRouteAuthorizer;
}
interface CursorStreamRuntime {
	readonly transport: CursorAgentTransport; readonly conversationState: CursorConversationStateStore; readonly uuid: () => string;
	readonly pausedTurnIdleTimeoutMs: number; readonly streamReadTimeoutMs: number; readonly disposeGraceMs: number;
}
const DEFAULT_PAUSED_TURN_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_STREAM_READ_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_DISPOSE_GRACE_MS = 1_000;
const TOOL_CALL_BATCH_IDLE_TIMEOUT_MS = 100;


function defaultCursorUuid(): string {
	return nodeRandomUUID();
}

export class CursorStreamAdapter {
	readonly #runtime: CursorStreamRuntime;
	readonly #messageReaders = new WeakMap<CursorRunStream, CursorMessageReader>();
	#executionAuthorizer: CursorExecutionRouteAuthorizer | undefined;
	readonly #disposeController = new AbortController();
	#disposePromise: Promise<void> | undefined;
	readonly #cleanupTasks = new Set<Promise<void>>();
	#cleanupTrackingClosed = false;

	constructor(options: CursorStreamAdapterOptions) {
		this.#runtime = {
			transport: options.transport,
			conversationState: options.conversationState ?? new CursorConversationStateStore(),
			uuid: options.uuid ?? defaultCursorUuid,
			pausedTurnIdleTimeoutMs: options.pausedTurnIdleTimeoutMs ?? DEFAULT_PAUSED_TURN_IDLE_TIMEOUT_MS,
			streamReadTimeoutMs: options.streamReadTimeoutMs ?? DEFAULT_STREAM_READ_TIMEOUT_MS,
			disposeGraceMs: options.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS,
		};
		this.#executionAuthorizer = options.executionAuthorizer;
	}

	bindExecutionAuthority(authorizer: CursorExecutionRouteAuthorizer): void {
		if (this.#executionAuthorizer) throw new Error("Cursor execution authority is already bound and cannot be replaced.");
		this.#executionAuthorizer = authorizer;
	}

	streamSimple = (model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream => {
		const stream = createAssistantMessageEventStream();
		void this.#runStream(stream, model, context, options);
		return stream;
	};

	dispose(): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise;
		this.#cleanupTrackingClosed = true;
		this.#disposeController.abort(new Error("Cursor stream adapter disposed."));
		this.#disposePromise = (async () => {
			const initial = [
				this.#runtime.conversationState.dispose(),
				this.#runtime.transport.dispose(),
			];
			await waitForCursorCleanup(this.#drainCleanup(initial), this.#runtime.disposeGraceMs);
			this.#cleanupTasks.clear();
			this.#runtime.conversationState.detachPendingCleanupTasks();
		})();
		return this.#disposePromise;
	}

	async cleanupSession(sessionId: string): Promise<void> {
		const cleanup = this.#trackCleanup(this.#runtime.conversationState.cancelTurn(deriveCursorBridgeKeyFromSessionId(sessionId)));
		await waitForCursorCleanup(cleanup, this.#runtime.disposeGraceMs);
		this.#runtime.transport.discardConversation?.(deriveCursorWireConversationIdFromSessionId(sessionId));
	}

	getLifecycleSnapshot(): CursorConversationSnapshot {
		return this.#runtime.conversationState.snapshot(this.#runtime.transport.getLifecycleSnapshot());
	}

	getPendingCleanupCount(): number {
		return this.#cleanupTasks.size + this.#runtime.conversationState.pendingCleanupTasks;
	}

	#trackCleanup(cleanup: Promise<void>): Promise<void> {
		let observed: Promise<void>;
		observed = cleanup.catch(() => undefined).finally(() => this.#cleanupTasks.delete(observed));
		if (!this.#cleanupTrackingClosed) this.#cleanupTasks.add(observed);
		return observed;
	}
	async #drainCleanup(initial: readonly Promise<unknown>[]): Promise<void> {
		await Promise.allSettled(initial);
		while (this.#cleanupTasks.size > 0) {
			await Promise.allSettled([...this.#cleanupTasks]);
		}
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
		let messageReader: CursorMessageReader | undefined;
		const conversationIdentity = deriveCursorConversationIdentity(context, options?.sessionId);
		const activeConversationKey = conversationIdentity.activeKey;
		const trailingToolResults = getTrailingToolResults(context);
		const resumeAttempt = trailingToolResults.length > 0;
		let activeTurn = resumeAttempt ? this.#runtime.conversationState.captureTurn(activeConversationKey) : undefined;
		let textIndex: number | undefined;
		let thinkingIndex: number | undefined;
		let terminalEventSent = false;
		let sawToolCall = false;
		const pendingToolCalls: CursorToolCallMessage[] = [];
		let cursorRouting: CursorAuthorizedRoute | undefined;
		const effectiveTimeoutMs = options?.timeoutMs ?? this.#runtime.streamReadTimeoutMs;
		let executionSignal = options?.signal;
		try {
			if (!options?.apiKey) {
				throw new Error("Cursor OAuth credentials are required. Run /login and select Cursor.");
			}
			if (options.signal?.aborted) {
				throw new CursorStreamAbortError();
			}
			const executionAuthorizer = this.#executionAuthorizer;
			if (!executionAuthorizer) throw new Error("Cursor execution requires a current authenticated catalog authority. Refresh the catalog and reselect a model.");
			cursorRouting = await executionAuthorizer(model, options.apiKey, options.signal);
			executionSignal = options.signal
				? AbortSignal.any([options.signal, cursorRouting.authoritySignal, this.#disposeController.signal])
				: AbortSignal.any([cursorRouting.authoritySignal, this.#disposeController.signal]);
			if (cursorRouting.modelId !== model.id) throw new Error(`Cursor model ${model.id} is not an exact route in the authenticated catalog. Refresh the catalog and reselect a model.`);
			if (hasImageInput(context) && !cursorRouting.supportsImages) throw new Error(`Cursor model ${model.id} does not support image input.`);
			const requestId = this.#runtime.uuid();
			if (resumeAttempt) {
				runStream = await this.#runtime.conversationState.resumeTurnWithToolResults(activeConversationKey, trailingToolResults, {
					authority: cursorRouting,
					signal: executionSignal,
					timeoutMs: effectiveTimeoutMs,
				});
				activeTurn = this.#runtime.conversationState.captureTurn(activeConversationKey);
				messageReader = this.#messageReaderFor(runStream);
			} else {
				cursorRouting.assertCurrent();
				const opening = this.#runtime.transport.run({
					accessToken: options.apiKey,
					requestId,
					conversationId: conversationIdentity.wireConversationId,
					model,
					resolvedModelId: model.id,
					maxMode: cursorRouting.maxMode,
					context,
					signal: executionSignal,
					openTimeoutMs: effectiveTimeoutMs,
				});
				runStream = await opening;
				const openedReader = this.#messageReaderFor(runStream);
				messageReader = openedReader;
				activeTurn = this.#runtime.conversationState.registerTurn(activeConversationKey, runStream, cursorRouting, () => { void openedReader.finalize(); });
			}
			const reader = messageReader;
			while (true) {
				const readTimeoutMs = pendingToolCalls.length > 0 ? Math.min(effectiveTimeoutMs, TOOL_CALL_BATCH_IDLE_TIMEOUT_MS) : effectiveTimeoutMs;
				const next = await readNextCursorMessage(reader, executionSignal, readTimeoutMs);
				if (next.kind === "aborted") {
					throw new CursorStreamAbortError();
				}
				cursorRouting.assertCurrent();
				if (executionSignal?.aborted) throw new CursorStreamAbortError();
				if (next.result.done) {
					break;
				}
				const message = next.result.value;
				if (pendingToolCalls.length > 0 && message.type !== "toolCall" && message.type !== "usage") {
					closeOpenContent(stream, output, textIndex, thinkingIndex);
					if (!(message.type === "done" && message.reason === "toolUse")) reader.unread(next.result);
					this.#runtime.conversationState.pauseTurnForTools(activeConversationKey, runStream, pendingToolCalls, { authority: cursorRouting, signal: options?.signal, idleTimeoutMs: this.#runtime.pausedTurnIdleTimeoutMs });
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
						this.#runtime.conversationState.pauseTurnForTools(activeConversationKey, runStream, pendingToolCalls, { authority: cursorRouting, signal: options?.signal, idleTimeoutMs: this.#runtime.pausedTurnIdleTimeoutMs });
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
					this.#runtime.conversationState.pauseTurnForTools(activeConversationKey, runStream, pendingToolCalls, { authority: cursorRouting, signal: options?.signal, idleTimeoutMs: this.#runtime.pausedTurnIdleTimeoutMs });
					output.stopReason = "toolUse";
					stream.push({ type: "done", reason: "toolUse", message: output });
					runStream = undefined;
				} else {
					output.stopReason = sawToolCall ? "toolUse" : "stop";
					stream.push({ type: "done", reason: output.stopReason, message: output });
				}
			}
		} catch (error) {
			const initiallyAborted = error instanceof CursorStreamAbortError || executionSignal?.aborted;
			const timedOut = error instanceof CursorStreamTimeoutError;
			let canPauseTimedOutTools = !initiallyAborted && timedOut && pendingToolCalls.length > 0 && !!runStream && !!cursorRouting;
			if (canPauseTimedOutTools && cursorRouting) {
				try {
					cursorRouting.assertCurrent();
					canPauseTimedOutTools = !executionSignal?.aborted;
				} catch {
					canPauseTimedOutTools = false;
				}
			}
			if (canPauseTimedOutTools && runStream && cursorRouting) {
				closeOpenContent(stream, output, textIndex, thinkingIndex);
				this.#runtime.conversationState.pauseTurnForTools(activeConversationKey, runStream, pendingToolCalls, { authority: cursorRouting, signal: options?.signal, idleTimeoutMs: this.#runtime.pausedTurnIdleTimeoutMs });
				output.stopReason = "toolUse";
				stream.push({ type: "done", reason: "toolUse", message: output });
				terminalEventSent = true;
				runStream = undefined;
				return;
			}
			const aborted = initiallyAborted || executionSignal?.aborted;
			output.stopReason = aborted ? "aborted" : "error";
			output.errorMessage = aborted
				? "Cursor stream aborted."
				: timedOut
					? "Cursor stream timed out while waiting for provider output."
					: sanitizeDiagnosticText(error instanceof Error ? error.message : "Cursor stream failed.", [options?.apiKey ?? ""]);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			if ((aborted || timedOut) && activeTurn) {
				this.#trackCleanup(this.#runtime.conversationState.cancelTurn(activeConversationKey, activeTurn));
				runStream = undefined;
				activeTurn = undefined;
			} else if (resumeAttempt && activeTurn) {
				this.#trackCleanup(this.#runtime.conversationState.cancelTurn(activeConversationKey, activeTurn));
				activeTurn = undefined;
			}
		} finally {
			try {
				if (runStream) {
					messageReader?.finalize();
					if (executionSignal?.aborted) {
						if (activeTurn) this.#trackCleanup(this.#runtime.conversationState.cancelTurn(activeConversationKey, activeTurn));
					} else if (activeTurn) {
						this.#runtime.conversationState.completeTurn(activeConversationKey, activeTurn);
						this.#trackCleanup(runStream.close());
					}
					activeTurn = undefined;
					runStream = undefined;
				}
			} finally {
				stream.end(output);
			}
		}
	}
}


async function waitForCursorCleanup(cleanup: Promise<unknown>, graceMs: number): Promise<void> {
	const settled = cleanup.then(() => undefined, () => undefined);
	if (graceMs <= 0) return;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			settled,
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, graceMs);
				timer.unref?.();
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
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
	const last = context.messages.at(-1);
	if (!last) return false;
	if (last.role === "user") {
		return typeof last.content !== "string" && last.content.some((content) => content.type === "image");
	}
	if (last.role !== "toolResult") return false;
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index];
		if (!message || message.role !== "toolResult") break;
		if (message.content.some((content) => content.type === "image")) return true;
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
export function createCursorStreamAdapter(options: CursorStreamAdapterOptions): CursorStreamAdapter {
	return new CursorStreamAdapter(options);
}
