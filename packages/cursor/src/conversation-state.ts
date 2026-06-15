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

interface ActiveTurn {
	readonly conversationId: string;
	readonly stream: CursorRunStream;
	readonly pendingTools: ReadonlyMap<string, PendingCursorToolCall>;
	readonly abortCleanup?: () => void;
	readonly idleTimer?: ReturnType<typeof setTimeout>;
}

export interface CursorPauseTurnOptions {
	readonly signal?: AbortSignal;
	readonly idleTimeoutMs?: number;
}

export type CursorResumeTurnOptions = CursorWriteOptions;

export class CursorConversationStateStore {
	readonly #activeTurns = new Map<string, ActiveTurn>();

	registerTurn(conversationId: string, stream: CursorRunStream): void {
		const existing = this.#activeTurns.get(conversationId);
		if (existing) this.replaceExistingTurn(existing, stream);
		this.#activeTurns.set(conversationId, { conversationId, stream, pendingTools: new Map() });
	}

	pauseTurnForTools(conversationId: string, stream: CursorRunStream, toolCalls: readonly CursorToolCallMessage[], options: CursorPauseTurnOptions = {}): void {
		const existing = this.#activeTurns.get(conversationId);
		if (existing && existing.stream !== stream) this.replaceExistingTurn(existing, stream);
		else if (existing) this.cleanupTurn(existing);
		const pendingTools = new Map<string, PendingCursorToolCall>();
		for (const toolCall of toolCalls) {
			pendingTools.set(toolCall.id, {
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				...(toolCall.execId ? { execId: toolCall.execId } : {}),
				...(toolCall.execNumericId !== undefined ? { execNumericId: toolCall.execNumericId } : {}),
			});
		}
		let abortCleanup: (() => void) | undefined;
		if (options.signal) {
			const onAbort = (): void => this.cancelTurnBestEffort(conversationId);
			options.signal.addEventListener("abort", onAbort, { once: true });
			abortCleanup = () => options.signal?.removeEventListener("abort", onAbort);
		}
		const idleTimer = options.idleTimeoutMs && options.idleTimeoutMs > 0 ? setTimeout(() => this.cancelTurnBestEffort(conversationId), options.idleTimeoutMs) : undefined;
		idleTimer?.unref?.();
		this.#activeTurns.set(conversationId, { conversationId, stream, pendingTools, ...(abortCleanup ? { abortCleanup } : {}), ...(idleTimer ? { idleTimer } : {}) });
		if (options.signal?.aborted) this.cancelTurnBestEffort(conversationId);
	}

	async resumeTurnWithToolResults(conversationId: string, results: readonly CursorToolResultMessage[], options: CursorResumeTurnOptions = {}): Promise<CursorRunStream> {
		const turn = this.#activeTurns.get(conversationId);
		if (!turn) throw new Error(`Cursor has no paused tool turn for conversation ${conversationId}.`);
		try {
			for (const result of results) {
				if (!turn.pendingTools.has(result.toolCallId)) throw new Error(`Cursor tool result ${result.toolCallId} does not match a paused tool call.`);
			}
			for (const result of results) {
				const pending = turn.pendingTools.get(result.toolCallId);
				if (!pending) throw new Error(`Cursor tool result ${result.toolCallId} does not match a paused tool call.`);
				await turn.stream.writeToolResult({ ...result, execId: pending.execId, execNumericId: pending.execNumericId }, options);
			}
			if (this.#activeTurns.get(conversationId) !== turn) throw new Error(`Cursor paused tool turn for conversation ${conversationId} was cancelled before resume completed.`);
			this.cleanupTurn(turn);
			this.#activeTurns.set(conversationId, { conversationId, stream: turn.stream, pendingTools: new Map() });
			return turn.stream;
		} catch (error) {
			if (this.#activeTurns.get(conversationId) === turn) await this.cancelSpecificTurn(turn).catch(() => undefined);
			else this.cleanupTurn(turn);
			throw error;
		}
	}

	completeTurn(conversationId: string): void {
		const turn = this.#activeTurns.get(conversationId);
		if (turn) this.cleanupTurn(turn);
		this.#activeTurns.delete(conversationId);
	}

	async cancelTurn(conversationId: string): Promise<void> {
		const turn = this.#activeTurns.get(conversationId);
		if (!turn) return;
		await this.cancelSpecificTurn(turn);
	}

	async dispose(): Promise<void> {
		const turns = [...this.#activeTurns.values()];
		this.#activeTurns.clear();
		await Promise.allSettled(turns.map(async (turn) => {
			this.cleanupTurn(turn);
			await turn.stream.cancel();
		}));
	}

	private replaceExistingTurn(existing: ActiveTurn, replacementStream: CursorRunStream): void {
		this.cleanupTurn(existing);
		this.#activeTurns.delete(existing.conversationId);
		if (existing.stream !== replacementStream) existing.stream.cancel().catch(() => undefined);
	}

	private cancelTurnBestEffort(conversationId: string): void {
		this.cancelTurn(conversationId).catch(() => undefined);
	}

	private async cancelSpecificTurn(turn: ActiveTurn): Promise<void> {
		this.cleanupTurn(turn);
		if (this.#activeTurns.get(turn.conversationId) === turn) this.#activeTurns.delete(turn.conversationId);
		await turn.stream.cancel();
	}

	private cleanupTurn(turn: ActiveTurn): void {
		turn.abortCleanup?.();
		if (turn.idleTimer) clearTimeout(turn.idleTimer);
	}

	get activeTurns(): number {
		return this.#activeTurns.size;
	}

	snapshot(transport: CursorTransportLifecycleSnapshot): CursorConversationSnapshot {
		return { ...transport, activeTurns: this.#activeTurns.size };
	}
}
