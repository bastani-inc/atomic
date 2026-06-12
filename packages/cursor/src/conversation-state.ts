import type { CursorRunStream, CursorTransportLifecycleSnapshot } from "./transport.js";

export interface CursorConversationSnapshot extends CursorTransportLifecycleSnapshot {
	readonly activeTurns: number;
}

interface ActiveTurn {
	readonly conversationId: string;
	readonly stream: CursorRunStream;
}

export class CursorConversationStateStore {
	readonly #activeTurns = new Map<string, ActiveTurn>();

	registerTurn(conversationId: string, stream: CursorRunStream): void {
		this.#activeTurns.set(conversationId, { conversationId, stream });
	}

	completeTurn(conversationId: string): void {
		this.#activeTurns.delete(conversationId);
	}

	async cancelTurn(conversationId: string): Promise<void> {
		const turn = this.#activeTurns.get(conversationId);
		if (!turn) return;
		await turn.stream.cancel();
		await turn.stream.close();
		this.#activeTurns.delete(conversationId);
	}

	async dispose(): Promise<void> {
		const turns = [...this.#activeTurns.values()];
		this.#activeTurns.clear();
		await Promise.all(turns.map(async (turn) => {
			await turn.stream.close();
		}));
	}

	get activeTurns(): number {
		return this.#activeTurns.size;
	}

	snapshot(transport: CursorTransportLifecycleSnapshot): CursorConversationSnapshot {
		return { ...transport, activeTurns: this.#activeTurns.size };
	}
}
