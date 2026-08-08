import { writeRawStdout } from "../../core/output-guard.ts";
import type { RpcOutput, RpcOutputRecord } from "./rpc-responses.ts";

export function serializeRpcOutputRecord(record: RpcOutputRecord): string {
	return `${JSON.stringify(record)}\n`;
}
export class RpcOutputBuffer {
	private readonly updates = new Map<string, RpcOutputRecord>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	readonly output: RpcOutput = (record) => this.enqueue(record);

	dispose(): void {
		this.flush();
	}

	/**
	 * Coalescing keeps only the last record per key, so a type is coalescible
	 * only when each record supersedes the previous one. `tool_execution_update`
	 * qualifies: each carries the full `partialResult` so far, keyed per call.
	 *
	 * `message_update` does not. It carries an `assistantMessageEvent` delta,
	 * and dropping a delta drops that text permanently, so it takes the
	 * pass-through path below.
	 */
	private enqueue(record: RpcOutputRecord): void {
		const event = record as { type?: string; toolCallId?: string };
		const key = event.type === "tool_execution_update" && event.toolCallId ? `tool:${event.toolCallId}` : undefined;
		if (key) {
			this.updates.set(key, record);
			this.timer ??= setTimeout(() => this.flush(), 16);
			return;
		}
		this.flush();
		writeRawStdout(serializeRpcOutputRecord(record));
	}

	private flush(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		for (const record of this.updates.values()) writeRawStdout(serializeRpcOutputRecord(record));
		this.updates.clear();
	}
}
