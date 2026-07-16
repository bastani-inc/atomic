import { writeRawStdout } from "../../core/output-guard.ts";
import { INTERACTIVE_ENGINE_MAX_FRAME_BYTES } from "../interactive-engine/protocol.ts";
import type { RpcOutput, RpcOutputRecord } from "./rpc-responses.ts";

const MAX_STRING_BYTES = 64 * 1024;
const MAX_ARRAY_ITEMS = 128;

function boundedValue(value: object | boolean | null | number | string, depth = 0): object | boolean | null | number | string {
	if (typeof value === "string") {
		if (Buffer.byteLength(value, "utf8") <= MAX_STRING_BYTES) return value;
		return `${Buffer.from(value).subarray(0, MAX_STRING_BYTES).toString("utf8")}\n[RPC payload truncated]`;
	}
	if (value === null || typeof value !== "object") return value;
	if (depth >= 8) return "[RPC payload depth truncated]";
	if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_ITEMS).map((entry) =>
		boundedValue(entry as object | boolean | null | number | string, depth + 1));
	const result: Record<string, object | boolean | null | number | string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (entry !== undefined) result[key] = boundedValue(entry as object | boolean | null | number | string, depth + 1);
	}
	return result;
}

function serializeBounded(record: RpcOutputRecord): string {
	let line = JSON.stringify(record);
	if (Buffer.byteLength(line, "utf8") <= INTERACTIVE_ENGINE_MAX_FRAME_BYTES) return `${line}\n`;
	line = JSON.stringify(boundedValue(record));
	if (Buffer.byteLength(line, "utf8") <= INTERACTIVE_ENGINE_MAX_FRAME_BYTES) return `${line}\n`;
	const identity = record as { type?: string; id?: string; command?: string };
	return `${JSON.stringify({
		type: identity.type ?? "transport_error",
		...(identity.id ? { id: identity.id } : {}),
		...(identity.command ? { command: identity.command } : {}),
		success: false,
		error: "RPC record exceeded the 1 MiB transport limit",
	})}\n`;
}

export class RpcOutputBuffer {
	private readonly updates = new Map<string, RpcOutputRecord>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	readonly output: RpcOutput = (record) => this.enqueue(record);

	dispose(): void { this.flush(); }

	private enqueue(record: RpcOutputRecord): void {
		const event = record as { type?: string; toolCallId?: string };
		const key = event.type === "message_update"
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
		writeRawStdout(serializeBounded(record));
	}

	private flush(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		for (const record of this.updates.values()) writeRawStdout(serializeBounded(record));
		this.updates.clear();
	}
}
