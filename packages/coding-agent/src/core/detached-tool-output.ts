import { isProxy } from "node:util/types";
import type { AgentToolResult } from "@bastani/atomic-agent-core";

/** Snapshot dynamic fields once. Plain data, including symbol-keyed protocol markers, retains its identity. */
function readFields<T extends object>(source: T, keys: readonly string[]): T {
	const proxy = isProxy(source);
	let descriptors: PropertyDescriptorMap | undefined;
	for (const key of keys) {
		const own = Object.getOwnPropertyDescriptor(source, key);
		if (!proxy && (own ? "value" in own : !(key in source))) continue;
		const value: unknown = Reflect.get(source, key);
		if (!own && value === undefined && !(key in source)) continue;
		descriptors ??= Object.getOwnPropertyDescriptors(source);
		descriptors[key] = { value, enumerable: own?.enumerable ?? true, configurable: true, writable: true };
	}
	return descriptors ? (Object.defineProperties({}, descriptors) as T) : source;
}

const resultFields = ["content", "details", "structuredContent", "usage", "isError", "terminate"];
const partFields = ["type", "text", "textSignature", "data", "mimeType"];

/** Host-facing reads belong inside the caller's error boundary, never on an abandoned operation. */
export function readableDetachedOutput(value: AgentToolResult): AgentToolResult {
	const result = readFields(value, resultFields);
	const content = result.content;
	if (content == null) return result;
	if (!Array.isArray(content)) throw new TypeError("Invalid tool result content");
	let parts: AgentToolResult["content"] | undefined =
		isProxy(content) || Object.getPrototypeOf(content) !== Array.prototype ? [] : undefined;
	for (let i = 0, length = content.length; i < length; i++) {
		const part = content[i]!;
		const stable = readFields(part, partFields);
		if (
			stable.type === "text"
				? typeof stable.text !== "string" ||
					(stable.textSignature !== undefined && typeof stable.textSignature !== "string")
				: stable.type !== "image" || typeof stable.data !== "string" || typeof stable.mimeType !== "string"
		)
			throw new TypeError("Invalid tool result part");
		const descriptor = Object.getOwnPropertyDescriptor(content, i);
		if (!parts && (stable !== part || !descriptor || !("value" in descriptor))) parts = content.slice(0, i);
		parts?.push(stable);
	}
	if (!parts) return result;
	const descriptors = Object.getOwnPropertyDescriptors(result);
	descriptors.content = { value: parts, enumerable: true, configurable: true, writable: true };
	return Object.defineProperties({}, descriptors) as AgentToolResult;
}
