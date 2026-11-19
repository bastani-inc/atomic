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
	private disposeWhenFree?: () => void | Promise<void>;
	private displaced = false;
	private resume?: AbortSignal;

	get operating(): boolean {
		return this.operations > 0;
	}

	/** The old chat cannot start a second writer while a resume opens this stage, or after it took over. */
	reserveForResume(until: AbortSignal): void {
		this.resume = until;
	}

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
		if (this.displaced) throw new Error("This stage chat has been replaced; send the message to the resumed stage.");
		if (this.resume !== undefined && !this.resume.aborted)
			throw new Error("This stage is resuming; send the message when its chat reconnects.");
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

	/** A displaced session no longer has a registry owner. Its last view or operation closes it instead. */
	afterLastHold(dispose: () => void | Promise<void>): void | Promise<void> {
		this.displaced = true;
		if (!this.held) return dispose();
		this.disposeWhenFree ??= dispose;
	}

	clear(): void {
		this.disposeWhenFree = undefined;
		this.listeners.clear();
	}

	private lifted(): void {
		for (const listener of [...this.listeners]) listener();
		if (!this.held && this.disposeWhenFree !== undefined) {
			const dispose = this.disposeWhenFree;
			this.disposeWhenFree = undefined;
			void Promise.resolve(dispose()).catch((error: unknown) =>
				console.warn("atomic-workflows: displaced stage session release failed", error),
			);
		}
	}
}
