import type { RpcEvent } from "./rpc-types.ts";

export class RpcEventBuffer {
	private readonly updates = new Map<string, RpcEvent>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private readonly emit: (event: RpcEvent) => void;
	constructor(emit: (event: RpcEvent) => void) {
		this.emit = emit;
	}

	/**
	 * Coalescing keeps only the last event per key, so a type is coalescible
	 * only when each event supersedes the previous one. `tool_execution_update`
	 * qualifies: each carries the full `partialResult` so far, keyed per call.
	 *
	 * `message_update` does not. It carries an `assistantMessageEvent` delta,
	 * and dropping a delta drops that text permanently, so it takes the
	 * pass-through path below.
	 */
	enqueue(event: RpcEvent): void {
		const key = event.type === "tool_execution_update" ? `tool:${event.toolCallId}` : undefined;
		if (!key) {
			this.flush();
			this.emit(event);
			return;
		}
		this.updates.set(key, event);
		this.timer ??= setTimeout(() => this.flush(), 16);
	}

	/**
	 * Each update leaves the buffer before it is emitted. An emit that throws therefore keeps only the updates not yet
	 * delivered, and an emit that drains the buffer (a listener stopping the client) takes only those: no update is
	 * delivered twice.
	 */
	flush(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		for (const [key, event] of this.updates) {
			this.updates.delete(key);
			this.emit(event);
		}
	}

	/** Remove the updates still held and return them, without emitting them. */
	drain(): RpcEvent[] {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		const events = [...this.updates.values()];
		this.updates.clear();
		return events;
	}

	dispose(): void {
		this.flush();
	}
}
