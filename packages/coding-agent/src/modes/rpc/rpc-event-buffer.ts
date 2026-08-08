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

	flush(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		for (const event of this.updates.values()) this.emit(event);
		this.updates.clear();
	}

	dispose(): void {
		this.flush();
	}
}
