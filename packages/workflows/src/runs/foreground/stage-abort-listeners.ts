/**
 * A stage's listeners on its run's abort signal. While the stage waits with its session released they are detached
 * as a group, so an idle stage holds none; the run's wake dispatcher observes the abort for it meanwhile.
 */
export class StageAbortListeners {
	private readonly listeners = new Set<() => void>();
	private attached = true;
	private readonly signal: AbortSignal;

	constructor(signal: AbortSignal) {
		this.signal = signal;
	}

	add(listener: () => void): () => void {
		this.listeners.add(listener);
		if (this.attached) this.signal.addEventListener("abort", listener, { once: true });
		return () => {
			this.listeners.delete(listener);
			this.signal.removeEventListener("abort", listener);
		};
	}

	/** Settle with `operation`, or reject with the run's abort reason as soon as the run aborts. */
	race<T>(operation: Promise<T>): Promise<T> {
		const reason = (): Error | DOMException | string =>
			this.signal.reason ?? new DOMException("workflow killed", "AbortError");
		// The abort goes first: an already aborted run rejects even when the operation has settled, and the race still
		// observes the operation's own later rejection.
		if (this.signal.aborted) return Promise.race([Promise.reject(reason()), operation]);
		const abort = Promise.withResolvers<never>();
		const remove = this.add(() => abort.reject(reason()));
		return Promise.race([operation, abort.promise]).finally(remove);
	}

	detach(): void {
		if (!this.attached) return;
		this.attached = false;
		for (const listener of this.listeners) this.signal.removeEventListener("abort", listener);
	}

	attach(): void {
		if (this.attached) return;
		this.attached = true;
		for (const listener of [...this.listeners]) {
			if (this.signal.aborted) listener();
			else this.signal.addEventListener("abort", listener, { once: true });
		}
	}

	get size(): number {
		return this.attached ? this.listeners.size : 0;
	}
}
