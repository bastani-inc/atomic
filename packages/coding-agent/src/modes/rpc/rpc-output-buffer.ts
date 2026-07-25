import { writeRawStdout } from "../../core/output-guard.ts";
import { INTERACTIVE_ENGINE_MAX_FRAME_BYTES } from "../interactive-engine/protocol.ts";
import type { RpcOutput, RpcOutputRecord } from "./rpc-responses.ts";
import type { RpcTransportError } from "./rpc-types.ts";

interface BoundingLimits {
	maxStringBytes: number;
	maxArrayItems: number;
	maxDepth: number;
}

const BOUNDING_PROFILES: readonly BoundingLimits[] = [
	{ maxStringBytes: 65_536, maxArrayItems: 128, maxDepth: 8 },
	{ maxStringBytes: 32_768, maxArrayItems: 64, maxDepth: 8 },
	{ maxStringBytes: 16_384, maxArrayItems: 32, maxDepth: 8 },
	{ maxStringBytes: 8_192, maxArrayItems: 16, maxDepth: 8 },
	{ maxStringBytes: 4_096, maxArrayItems: 8, maxDepth: 8 },
	{ maxStringBytes: 2_048, maxArrayItems: 8, maxDepth: 8 },
	{ maxStringBytes: 1_024, maxArrayItems: 8, maxDepth: 8 },
];
const TRANSPORT_LIMIT_ERROR = "RPC record exceeded the 1 MiB transport limit";

function boundedValue(
	value: object | boolean | null | number | string,
	limits: BoundingLimits,
	depth = 0,
): object | boolean | null | number | string {
	if (typeof value === "string") {
		if (Buffer.byteLength(value, "utf8") <= limits.maxStringBytes) return value;
		return `${Buffer.from(value).subarray(0, limits.maxStringBytes).toString("utf8")}\n[RPC payload truncated]`;
	}
	if (value === null || typeof value !== "object") return value;
	if (depth >= limits.maxDepth) return "[RPC payload depth truncated]";
	if (Array.isArray(value)) {
		return value
			.slice(0, limits.maxArrayItems)
			.map((entry) => boundedValue(entry as object | boolean | null | number | string, limits, depth + 1));
	}
	const result: Record<string, object | boolean | null | number | string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (entry !== undefined) {
			result[key] = boundedValue(entry as object | boolean | null | number | string, limits, depth + 1);
		}
	}
	return result;
}

function serializeCandidate(record: object | boolean | null | number | string): string | undefined {
	const line = JSON.stringify(record);
	return Buffer.byteLength(line, "utf8") <= INTERACTIVE_ENGINE_MAX_FRAME_BYTES ? `${line}\n` : undefined;
}

export function serializeBounded(record: RpcOutputRecord): string {
	const unmodified = serializeCandidate(record);
	if (unmodified) return unmodified;

	const identity = record as { type?: string; id?: string; command?: string };
	for (let index = 0; index < BOUNDING_PROFILES.length; index += 1) {
		const profile = BOUNDING_PROFILES[index];
		const bounded = serializeCandidate(boundedValue(record, profile));
		if (bounded) return bounded;
		if (index === 0 && identity.type === "response") {
			return `${JSON.stringify({
				type: "response",
				id: identity.id,
				command: identity.command,
				success: false,
				error: TRANSPORT_LIMIT_ERROR,
			})}\n`;
		}
	}

	const transportError: RpcTransportError = {
		type: "transport_error",
		...(typeof identity.type === "string" ? { recordType: identity.type } : {}),
		error: TRANSPORT_LIMIT_ERROR,
	};
	return `${JSON.stringify(transportError)}\n`;
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
