import type { RpcEvent } from "./rpc-types.ts";

export class RpcEventBuffer {
	private readonly updates = new Map<string, RpcEvent>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	constructor(private readonly emit: (event: RpcEvent) => void) {}

	enqueue(event: RpcEvent): void {
		const key = event.type === "message_update"
			? "message"
			: event.type === "tool_execution_update"
				? `tool:${event.toolCallId}`
				: undefined;
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

	dispose(): void { this.flush(); }
}
