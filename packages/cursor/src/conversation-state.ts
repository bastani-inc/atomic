import type { CursorAuthorizedRoute } from "./execution-authority.js";
import type { CursorRunStream, CursorToolCallMessage, CursorToolResultMessage, CursorTransportLifecycleSnapshot, CursorWriteOptions } from "./transport.js";

export interface CursorConversationSnapshot extends CursorTransportLifecycleSnapshot {
	readonly activeTurns: number;
}

export interface PendingCursorToolCall {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly execId?: string;
	readonly execNumericId?: number;
}

export interface CursorConversationTurnHandle {
	readonly identity: symbol;
}

interface ActiveTurn extends CursorConversationTurnHandle {
	readonly conversationId: string;
	readonly stream: CursorRunStream;
	readonly authority: CursorAuthorizedRoute;
	readonly pendingTools: ReadonlyMap<string, PendingCursorToolCall>;
	abortCleanup?: () => void;
	readonly finalizeMessages?: () => void;
	idleTimer?: ReturnType<typeof setTimeout>;
}

export interface CursorPauseTurnOptions {
	readonly authority: CursorAuthorizedRoute;
	readonly signal?: AbortSignal;
	readonly idleTimeoutMs?: number;
	readonly finalizeMessages?: () => void;
}

export interface CursorResumeTurnOptions extends CursorWriteOptions {
	readonly authority: CursorAuthorizedRoute;
}

export class CursorConversationStateStore {
	readonly #activeTurns = new Map<string, ActiveTurn>();
	readonly #cancellationTasks = new Map<ActiveTurn, Promise<void>>();
	registerTurn(conversationId: string, stream: CursorRunStream, authority: CursorAuthorizedRoute, finalizeMessages?: () => void): CursorConversationTurnHandle {
		const existing = this.#activeTurns.get(conversationId);
		if (existing) this.replaceExistingTurn(existing, stream);
		const turn: ActiveTurn = { identity: Symbol("cursor-conversation-turn"), conversationId, stream, authority, pendingTools: new Map(), ...(finalizeMessages ? { finalizeMessages } : {}) };
		this.#activeTurns.set(conversationId, turn);
		this.armAbort(turn, [authority.authoritySignal]);
		return turn;
	}

	pauseTurnForTools(conversationId: string, stream: CursorRunStream, toolCalls: readonly CursorToolCallMessage[], options: CursorPauseTurnOptions): void {
		const existing = this.#activeTurns.get(conversationId);
		const finalizeMessages = existing?.stream === stream ? existing.finalizeMessages : options.finalizeMessages;
		if (existing && existing.stream !== stream) this.replaceExistingTurn(existing, stream);
		else if (existing) this.cleanupTurn(existing, false);
		const pendingTools = new Map<string, PendingCursorToolCall>();
		for (const toolCall of toolCalls) {
			pendingTools.set(toolCall.id, {
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				...(toolCall.execId ? { execId: toolCall.execId } : {}),
				...(toolCall.execNumericId !== undefined ? { execNumericId: toolCall.execNumericId } : {}),
			});
		}
		const abortSignals = options.signal
			? [options.signal, options.authority.authoritySignal]
			: [options.authority.authoritySignal];
		const turn: ActiveTurn = {
			identity: Symbol("cursor-conversation-turn"),
			conversationId,
			stream,
			authority: options.authority,
			pendingTools,
			...(finalizeMessages ? { finalizeMessages } : {}),
		};
		if (options.idleTimeoutMs && options.idleTimeoutMs > 0) {
			turn.idleTimer = setTimeout(() => this.cancelSpecificTurnBestEffort(turn), options.idleTimeoutMs);
			turn.idleTimer.unref?.();
		}
		this.#activeTurns.set(conversationId, turn);
		this.armAbort(turn, abortSignals);
	}

	captureTurn(conversationId: string): CursorConversationTurnHandle | undefined {
		return this.#activeTurns.get(conversationId);
	}

	async resumeTurnWithToolResults(conversationId: string, results: readonly CursorToolResultMessage[], options: CursorResumeTurnOptions): Promise<CursorRunStream> {
		const turn = this.#activeTurns.get(conversationId);
		if (!turn) throw new Error(`Cursor has no paused tool turn for conversation ${conversationId}.`);
		try {
			assertCurrentAuthority(turn.authority, options.authority);
			for (const result of results) {
				if (!turn.pendingTools.has(result.toolCallId)) throw new Error(`Cursor tool result ${result.toolCallId} does not match a paused tool call.`);
			}
			for (const result of results) {
				const pending = turn.pendingTools.get(result.toolCallId);
				if (!pending) throw new Error(`Cursor tool result ${result.toolCallId} does not match a paused tool call.`);
				assertResumeActive(turn, options.authority, options.signal);
				const write = turn.stream.writeToolResult({ ...result, execId: pending.execId, execNumericId: pending.execNumericId }, options);
				await write;
			}
			assertResumeActive(turn, options.authority, options.signal);
			if (this.#activeTurns.get(conversationId) !== turn) throw new Error(`Cursor paused tool turn for conversation ${conversationId} was cancelled before resume completed.`);
			this.cleanupTurn(turn, false);
			this.#activeTurns.delete(conversationId);
			this.registerTurn(conversationId, turn.stream, turn.authority, turn.finalizeMessages);
			return turn.stream;
		} catch (error) {
			if (this.#activeTurns.get(conversationId) === turn) this.cancelSpecificTurnBestEffort(turn);
			else this.cleanupTurn(turn);
			throw error;
		}
	}

	completeTurn(conversationId: string, expected: CursorConversationTurnHandle): void {
		const turn = this.#activeTurns.get(conversationId);
		if (!turn || turn.identity !== expected.identity) return;
		this.detachTurn(turn);
	}

	async cancelTurn(conversationId: string, expected?: CursorConversationTurnHandle): Promise<void> {
		const turn = this.#activeTurns.get(conversationId);
		if (!turn || (expected && turn.identity !== expected.identity)) return;
		return this.cancelSpecificTurnTracked(turn);
	}

	async cancelAllTurns(): Promise<void> {
		const turns = [...this.#activeTurns.values()];
		const cancellations = turns.map((turn) => this.cancelSpecificTurnTracked(turn));
		await Promise.allSettled([
			...this.#cancellationTasks.values(),
			...cancellations,
		]);
	}

	async dispose(): Promise<void> {
		await this.cancelAllTurns();
	}

	detachPendingCleanupTasks(): void {
		this.#cancellationTasks.clear();
	}

	get pendingCleanupTasks(): number {
		return this.#cancellationTasks.size;
	}

	private replaceExistingTurn(existing: ActiveTurn, replacementStream: CursorRunStream): void {
		this.detachTurn(existing);
		if (existing.stream !== replacementStream) this.cancelSpecificTurnBestEffort(existing);
	}

	private cancelSpecificTurnBestEffort(turn: ActiveTurn): void {
		this.cancelSpecificTurnTracked(turn).catch(() => undefined);
	}

	private cancelSpecificTurnTracked(turn: ActiveTurn): Promise<void> {
		const pending = this.#cancellationTasks.get(turn);
		if (pending) return pending;
		this.detachTurn(turn);
		const task = turn.stream.cancel().finally(() => {
			if (this.#cancellationTasks.get(turn) === task) this.#cancellationTasks.delete(turn);
		});
		this.#cancellationTasks.set(turn, task);
		return task;
	}

	private detachTurn(turn: ActiveTurn): void {
		this.cleanupTurn(turn);
		if (this.#activeTurns.get(turn.conversationId) === turn) this.#activeTurns.delete(turn.conversationId);
	}

	private armAbort(turn: ActiveTurn, signals: readonly AbortSignal[]): void {
		const distinctSignals = [...new Set(signals)];
		const onAbort = (): void => this.cancelSpecificTurnBestEffort(turn);
		for (const signal of distinctSignals) signal.addEventListener("abort", onAbort, { once: true });
		turn.abortCleanup = () => {
			for (const signal of distinctSignals) signal.removeEventListener("abort", onAbort);
		};
		if (distinctSignals.some((signal) => signal.aborted)) this.cancelSpecificTurnBestEffort(turn);
	}
	private cleanupTurn(turn: ActiveTurn, finalizeMessages = true): void {
		turn.abortCleanup?.();
		delete turn.abortCleanup;
		if (turn.idleTimer) clearTimeout(turn.idleTimer);
		delete turn.idleTimer;
		if (finalizeMessages) turn.finalizeMessages?.();
	}

	get activeTurns(): number {
		return this.#activeTurns.size;
	}

	snapshot(transport: CursorTransportLifecycleSnapshot): CursorConversationSnapshot {
		return { ...transport, activeTurns: this.#activeTurns.size };
	}
}

function assertCurrentAuthority(left: CursorAuthorizedRoute, right: CursorAuthorizedRoute): void {
	left.assertCurrent();
	right.assertCurrent();
	if (left.authorityLease !== right.authorityLease
		|| left.credentialScope !== right.credentialScope
		|| left.catalogGeneration !== right.catalogGeneration
		|| left.modelId !== right.modelId
		|| left.maxMode !== right.maxMode
		|| left.supportsImages !== right.supportsImages) {
		throw new Error("Cursor paused tool turn belongs to a different authenticated catalog. Refresh and retry the turn.");
	}
}

function assertResumeActive(turn: ActiveTurn, authority: CursorAuthorizedRoute, signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Cursor tool-result resume was cancelled.");
	assertCurrentAuthority(turn.authority, authority);
}
