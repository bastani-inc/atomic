import type { AgentSessionEvent } from "@bastani/atomic";

/**
 * What holds a stage handle's live session from outside: mounted chats (visible or hidden) and operations still
 * running on the handle. Each time a hold ends, or the session reports it may have gone quiet, listeners are told,
 * so a release that had to wait is tried again (#4642).
 */
export class StageSessionHolds {
	private subscribers = 0;
	private operations = 0;
	private taken = 0;
	private readonly listeners = new Set<() => void>();

	get held(): boolean {
		return this.subscribers > 0 || this.operations > 0;
	}

	get holdsTaken(): number {
		return this.taken;
	}

	subscription(unsubscribe: () => void): () => void {
		this.subscribers += 1;
		this.taken += 1;
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			this.subscribers -= 1;
			unsubscribe();
			this.lifted();
		};
	}

	async operation<T>(operation: () => Promise<T>): Promise<T> {
		this.operations += 1;
		this.taken += 1;
		try {
			return await operation();
		} finally {
			this.operations -= 1;
			this.lifted();
		}
	}

	/** Feed every session event: the end of a turn, of a queue, of a compaction or of a retry may leave it quiet. */
	observe(event: AgentSessionEvent): void {
		switch (event.type) {
			case "agent_end":
			case "agent_settled":
			case "queue_update":
			case "compaction_end":
			case "auto_retry_end":
				this.lifted();
		}
	}

	onLifted(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	clear(): void {
		this.listeners.clear();
	}

	private lifted(): void {
		for (const listener of [...this.listeners]) listener();
	}
}
