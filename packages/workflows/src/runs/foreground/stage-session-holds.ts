import type { AgentSessionEvent } from "@bastani/atomic";

const SESSION_QUIETING_EVENTS: ReadonlySet<string> = new Set([
	"agent_end",
	"agent_settled",
	"queue_update",
	"compaction_end",
	"auto_retry_end",
]);

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

	observe(event: AgentSessionEvent): void {
		if (SESSION_QUIETING_EVENTS.has(event.type)) this.lifted();
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
