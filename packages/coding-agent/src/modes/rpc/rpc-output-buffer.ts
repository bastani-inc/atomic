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

	private enqueue(record: RpcOutputRecord): void {
		const event = record as { type?: string; toolCallId?: string };
		const key =
			event.type === "message_update"
				? "message"
				: event.type === "tool_execution_update" && event.toolCallId
					? `tool:${event.toolCallId}`
					: undefined;
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
