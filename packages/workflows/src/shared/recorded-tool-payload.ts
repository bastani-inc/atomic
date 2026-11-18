import { isBoxedPrimitive, isProxy, isSymbolObject } from "node:util/types";
import { sliceHead } from "@bastani/atomic";
import { flattenTruncatedString } from "./flat-string.js";
import {
	TOOL_PAYLOAD_VALUE_LIMIT as BYTES,
	TOOL_PAYLOAD_MAX_DEPTH,
	TOOL_PAYLOAD_MAX_KEYS,
	TOOL_PAYLOAD_TRUNCATION_MARKER as TRUNCATED,
} from "./tool-payload-bounds.js";
import type { WorkflowSerializableValue } from "./types.js";

class StagePayloadBudgetExceeded extends Error {}

const rawJSON = JSON as typeof JSON & { isRawJSON?: (value: object) => value is { rawJSON: string } };

function guardProxy(value: unknown): void {
	// Arrays are visited by index, not by enumerating own keys. Keep the supported array-proxy length coercion.
	if (isProxy(value) && !Array.isArray(value)) throw new TypeError("Cannot checkpoint a proxied tool payload");
}

function truncatedString(value: string): string {
	let units = Math.min(value.length, BYTES - Buffer.byteLength(JSON.stringify(TRUNCATED)));
	for (;;) {
		const prefix = sliceHead(value, units);
		if (Buffer.byteLength(JSON.stringify(prefix + TRUNCATED)) <= BYTES)
			return flattenTruncatedString(prefix) + TRUNCATED;
		units = Math.floor(units / 2);
	}
}

/**
 * Checkpoint the native JSON value of this field. Width/depth truncation replaces just that container; exhausting
 * the total budget stops the pass, without replaying getters or toJSON to reconstruct a prefix. JSON can enumerate
 * ordinary keys and invoke toJSON before the replacer sees a member: this bounds retained bytes, not native key
 * enumeration or arbitrary callback work. The inspection UI's tolerant payload walker is separate.
 */
export function boundedRecordedToolPayload(
	value: WorkflowSerializableValue,
	field: "details" | "structuredContent",
): WorkflowSerializableValue | undefined {
	guardProxy(value);
	const envelope = { [field]: value };
	const containers = new WeakMap<object, { depth: number; emitted: boolean }>([
		[envelope, { depth: -1, emitted: false }],
	]);
	let remaining = BYTES;
	let visits = 0;
	let rootText: string | undefined;
	const charge = (bytes: number) => {
		remaining -= bytes;
		if (remaining < 0) throw new StagePayloadBudgetExceeded();
	};
	const chargeText = (text: string, quoted: boolean) => {
		if (text.length > remaining) throw new StagePayloadBudgetExceeded();
		charge(Buffer.byteLength(quoted ? JSON.stringify(text) : text));
	};
	try {
		const encoded = JSON.stringify(envelope, function (this: object, key: string, incoming: unknown): unknown {
			const parent = containers.get(this);
			if (!parent) return incoming; // The initial call for the synthetic envelope.
			const root = this === envelope;
			if (!root && ++visits > TOOL_PAYLOAD_MAX_KEYS) throw new StagePayloadBudgetExceeded();
			// Native JSON already applied toJSON. Inspect a data descriptor, never reread a getter: if it returned a
			// proxy that converted to a scalar, only the scalar is observable here and the proxy is never enumerated.
			if (!isProxy(this)) {
				const own = Object.getOwnPropertyDescriptor(this, key);
				if (own && "value" in own) guardProxy(own.value);
			}
			guardProxy(incoming);
			let item = incoming;
			if (root && typeof item === "string") rootText = item;
			const omitted = item === undefined || typeof item === "function" || typeof item === "symbol";
			if (omitted && !Array.isArray(this)) return item;
			if (!root) {
				if (parent.emitted) charge(1); // comma
				parent.emitted = true;
				if (!Array.isArray(this)) {
					chargeText(key, true);
					charge(1); // colon
				}
			}
			if (item !== null && typeof item === "object") {
				if (rawJSON.isRawJSON?.(item)) {
					chargeText(item.rawJSON, false);
					return item;
				}
				// The engine unboxes these after the replacer; do not invoke its conversion a second time to weigh it.
				if (isBoxedPrimitive(item) && !isSymbolObject(item)) return item;
				const depth = parent.depth + 1;
				if (depth >= TOOL_PAYLOAD_MAX_DEPTH || (!isProxy(item) && Object.keys(item).length > TOOL_PAYLOAD_MAX_KEYS))
					item = TRUNCATED;
				else {
					containers.set(item, { depth, emitted: false });
					charge(2);
					return item;
				}
			}
			if (typeof item === "string") chargeText(item, true);
			else if (omitted || item === null)
				charge(4); // null, including array holes
			else if (typeof item === "number" || typeof item === "boolean") charge(JSON.stringify(item).length);
			return item;
		});
		// Include bytes produced by native conversions after the replacer (for example boxed strings), not the envelope.
		const wireLimit = BYTES + field.length + 5;
		if (encoded.length > wireLimit || Buffer.byteLength(encoded) > wireLimit) throw new StagePayloadBudgetExceeded();
		return (JSON.parse(encoded) as Partial<Record<typeof field, WorkflowSerializableValue>>)[field];
	} catch (error) {
		if (error instanceof StagePayloadBudgetExceeded)
			return rootText === undefined ? TRUNCATED : truncatedString(rootText);
		throw error;
	}
}
