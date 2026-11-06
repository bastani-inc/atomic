import type { WatchEndReason, WatchId } from "./stage-watch-types.js";

/** Why each stage watch ended, for the root's later calls on it. Past `capacity`, the oldest is forgotten. */
export class EndedWatches extends Map<WatchId, WatchEndReason> {
	private readonly capacity: number;

	constructor(capacity: number) {
		super();
		this.capacity = capacity;
	}

	/** Records why the watch `id` ended. */
	remember(id: WatchId, reason: WatchEndReason): void {
		this.set(id, reason);
		if (this.size > this.capacity) this.delete(this.keys().next().value!);
	}
}
