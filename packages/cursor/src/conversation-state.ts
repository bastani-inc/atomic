import type { CursorRunStream, CursorToolCallMessage, CursorToolResultMessage, CursorTransportLifecycleSnapshot, CursorWriteOptions } from "./transport.js";
import type { CursorRequestLease } from "./preparation.js";

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
	readonly pendingTools: ReadonlyMap<string, readonly PendingCursorToolCall[]>;
	readonly lease?: CursorRequestLease;
	readonly signalCleanup?: () => void;
	readonly abortCleanup?: () => void;
	readonly idleTimer?: ReturnType<typeof setTimeout>;
}

export interface CursorPauseTurnOptions {
	readonly signal?: AbortSignal;
	readonly signalCleanup?: () => void;
	readonly idleTimeoutMs?: number;
	readonly lease?: CursorRequestLease;
}

export type CursorResumeTurnOptions = CursorWriteOptions;

export class CursorConversationStateStore {
	readonly #activeTurns = new Map<string, ActiveTurn>();

	registerTurn(conversationId: string, stream: CursorRunStream, lease?: CursorRequestLease): void {
		const existing = this.#activeTurns.get(conversationId);
		if (existing) this.replaceExistingTurn(existing, stream);
		this.#activeTurns.set(conversationId, { conversationId, stream, pendingTools: new Map(), lease });
	}

	hasPausedTurn(conversationId: string): boolean {
		return (this.#activeTurns.get(conversationId)?.pendingTools.size ?? 0) > 0;
	}
	pauseTurnForTools(conversationId: string, stream: CursorRunStream, toolCalls: readonly CursorToolCallMessage[], options: CursorPauseTurnOptions = {}): void {
		const existing = this.#activeTurns.get(conversationId);
		if (existing && existing.stream !== stream) this.replaceExistingTurn(existing, stream);
		else if (existing) this.cleanupTurn(existing);
		const pendingTools = new Map<string, PendingCursorToolCall[]>();
		for (const toolCall of toolCalls) {
			const pending = {
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				...(toolCall.execId ? { execId: toolCall.execId } : {}),
				...(toolCall.execNumericId !== undefined ? { execNumericId: toolCall.execNumericId } : {}),
			};
			pendingTools.set(toolCall.id, [...(pendingTools.get(toolCall.id) ?? []), pending]);
		}
		let abortCleanup: (() => void) | undefined;
		if (options.signal) {
			const onAbort = (): void => this.cancelTurnBestEffort(conversationId);
			options.signal.addEventListener("abort", onAbort, { once: true });
			abortCleanup = () => options.signal?.removeEventListener("abort", onAbort);
		}
		const signalCleanup = options.signalCleanup;
		const idleTimer = options.idleTimeoutMs && options.idleTimeoutMs > 0 ? setTimeout(() => this.cancelTurnBestEffort(conversationId), options.idleTimeoutMs) : undefined;
		idleTimer?.unref?.();
		this.#activeTurns.set(conversationId, { conversationId, stream, pendingTools, lease: options.lease ?? existing?.lease, signalCleanup, ...(abortCleanup ? { abortCleanup } : {}), ...(idleTimer ? { idleTimer } : {}) });
		if (options.signal?.aborted) this.cancelTurnBestEffort(conversationId);
	}

	async resumeTurnWithToolResults(conversationId: string, results: readonly CursorToolResultMessage[], options: CursorResumeTurnOptions = {}): Promise<CursorRunStream> {
		const turn = this.#activeTurns.get(conversationId);
		turn?.lease?.assertCurrent("request");
		if (!turn) throw new Error(`Cursor has no paused tool turn for conversation ${conversationId}.`);
		try {
			const queues = new Map([...turn.pendingTools].map(([id, calls]) => [id, [...calls]]));
			const matched = results.map((result) => {
				const pending = queues.get(result.toolCallId)?.shift();
				if (!pending) throw new Error(`Cursor tool result ${result.toolCallId} does not match a paused tool call.`);
				return { result, pending };
			});
			for (const { result, pending } of matched) {
				turn.lease?.assertCurrent("request");
				await turn.stream.writeToolResult({ ...result, execId: pending.execId, execNumericId: pending.execNumericId }, options);
				turn.lease?.assertCurrent("request");
			}
			if (this.#activeTurns.get(conversationId) !== turn) throw new Error(`Cursor paused tool turn for conversation ${conversationId} was cancelled before resume completed.`);
			this.cleanupTurn(turn);
			this.#activeTurns.set(conversationId, { conversationId, stream: turn.stream, pendingTools: new Map(), lease: turn.lease });
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
		turn.signalCleanup?.();
		if (turn.idleTimer) clearTimeout(turn.idleTimer);
	}

	get activeTurns(): number {
		return this.#activeTurns.size;
	}

	snapshot(transport: CursorTransportLifecycleSnapshot): CursorConversationSnapshot {
		return { ...transport, activeTurns: this.#activeTurns.size };
	}
}
