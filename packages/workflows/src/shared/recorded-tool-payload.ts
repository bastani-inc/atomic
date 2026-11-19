import { isBigIntObject, isBooleanObject, isNumberObject, isProxy, isStringObject } from "node:util/types";
import { sliceHead } from "@bastani/atomic";
import { flattenTruncatedString } from "./flat-string.js";
import {
	TOOL_PAYLOAD_VALUE_LIMIT as BYTES,
	TOOL_PAYLOAD_MAX_DEPTH,
	TOOL_PAYLOAD_MAX_KEYS,
	TOOL_PAYLOAD_TRUNCATION_KEY,
	TOOL_PAYLOAD_TRUNCATION_MARKER as TRUNCATED,
} from "./tool-payload-bounds.js";
import type { WorkflowSerializableValue } from "./types.js";

class StagePayloadBudgetExceeded extends Error {}

const rawJSON = JSON as typeof JSON & { isRawJSON?: (value: object) => value is { rawJSON: string } };

function guardProxy(value: unknown): void {
	// Arrays are visited by index, not by enumerating own keys. Keep the supported array-proxy length coercion.
	if (isProxy(value) && !Array.isArray(value)) throw new TypeError("Cannot checkpoint a proxied tool payload");
}

/** Inspect only bounded containers, while their replacer is running and before native JSON visits their members. */
function isTooWide(value: object, accessor: () => void): boolean {
	if (isProxy(value)) return false; // Only the indexed array-proxy exception reaches this point.
	const array = Array.isArray(value);
	// Arrays can serialize non-enumerable indices; the built-in length is not a member.
	const keys = array ? Object.getOwnPropertyNames(value) : Object.keys(value);
	if (keys.length > TOOL_PAYLOAD_MAX_KEYS + (array ? 1 : 0)) return true;
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor && "value" in descriptor) guardProxy(descriptor.value);
		else accessor();
	}
	return false;
}

const MARKER_BYTES = Buffer.byteLength(JSON.stringify(TRUNCATED));

function truncatedString(value: string, limit = BYTES): string {
	let units = Math.min(value.length, limit - MARKER_BYTES);
	for (;;) {
		const prefix = sliceHead(value, units);
		if (Buffer.byteLength(JSON.stringify(prefix + TRUNCATED)) <= limit)
			return flattenTruncatedString(prefix) + TRUNCATED;
		units = Math.floor(units / 2);
	}
}

/** Read only a bounded prefix of an already encoded root string, never its original object or conversion hook. */
function wireStringPrefix(encoded: string, field: string): string | undefined {
	const start = field.length + 4; // {"field": followed by the value
	if (encoded[start] !== '"') return undefined;
	const prefix = sliceHead(encoded, Math.min(encoded.length - 2, start + BYTES)).slice(start);
	// A cut through a JSON escape can leave up to five incomplete code units (\\u followed by three digits).
	for (let trim = 0; trim <= 5 && trim < prefix.length; trim++) {
		try {
			return JSON.parse(`${prefix.slice(0, prefix.length - trim)}"`) as string;
		} catch {}
	}
	return undefined;
}

interface PrefixMember {
	readonly depth: number;
	readonly key: string;
	readonly remaining: number;
	valueRoom?: number;
	value: unknown;
}

type PrefixObject = Record<string, WorkflowSerializableValue>;
type PrefixContainer = PrefixObject | WorkflowSerializableValue[];

// Even if the next key does not fit, a fresh marker key, comma and colon still must.
const MARKER_ROOM =
	Buffer.byteLength(`,${JSON.stringify(TOOL_PAYLOAD_TRUNCATION_KEY + TOOL_PAYLOAD_MAX_KEYS)}:`) + MARKER_BYTES;

/** Rebuild only from the native pass's bounded sequence of already visited members. Never read a member again. */
function recordedPrefix(members: PrefixMember[]): WorkflowSerializableValue {
	if (members.length < 2) return TRUNCATED;
	// No inherited conversion hooks, even when the source array inherited a toJSON that returned itself.
	const container = (value: unknown): PrefixContainer =>
		Array.isArray(value) ? Object.setPrototypeOf([], null) : Object.create(null);
	const root = container(members[0]!.value);
	const parents = [root];
	for (let i = 1; i < members.length; i++) {
		const { depth, key, valueRoom = 0, value } = members[i]!;
		const parent = parents[depth - 1]!;
		let item: WorkflowSerializableValue;
		let name = key;
		const cut = (members[i + 1]?.remaining ?? -1) < MARKER_ROOM;
		if (cut) {
			if (valueRoom < MARKER_BYTES && !Array.isArray(parent)) {
				name = TOOL_PAYLOAD_TRUNCATION_KEY;
				for (let n = 1; Object.hasOwn(parent, name); n++) name = TOOL_PAYLOAD_TRUNCATION_KEY + n;
			}
			item = typeof value === "string" && valueRoom >= MARKER_BYTES ? truncatedString(value, valueRoom) : TRUNCATED;
		} else if (value !== null && typeof value === "object") {
			item = parents[depth] = container(value);
		} else {
			item = value as string | number | boolean | null;
		}
		if (Array.isArray(parent)) parent[parent.length] = item;
		else parent[name] = item;
		if (cut) break;
	}
	// As on the successful path, detach even short strings sliced from a large source, and return ordinary JSON.
	return JSON.parse(JSON.stringify(root)) as WorkflowSerializableValue;
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
	let members: PrefixMember[] | undefined = [];
	const nonJson = () => {
		members = undefined;
	};
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
			if (!root && ++visits > TOOL_PAYLOAD_MAX_KEYS) {
				nonJson(); // This is the traversal guard, not a byte cutoff.
				throw new StagePayloadBudgetExceeded();
			}
			// Native JSON already applied toJSON. Inspect a data descriptor, never reread a getter: if it returned a
			// proxy that converted to a scalar, only the scalar is observable here and the proxy is never enumerated.
			if (!isProxy(this)) {
				const own = Object.getOwnPropertyDescriptor(this, key);
				if (own && "value" in own) guardProxy(own.value);
				if (!own || !("value" in own) || !Object.is(own.value, incoming)) nonJson();
			}
			guardProxy(incoming);
			if (isProxy(incoming)) nonJson();
			let item = incoming;
			if (root && typeof item === "string") rootText = item;
			const omitted = item === undefined || typeof item === "function" || typeof item === "symbol";
			if (omitted) nonJson();
			if (omitted && !Array.isArray(this)) return item;
			const member: PrefixMember | undefined = members && { depth: parent.depth + 1, key, remaining, value: item };
			if (member) members?.push(member);
			if (!root) {
				if (parent.emitted) charge(1); // comma
				parent.emitted = true;
				if (!Array.isArray(this)) {
					chargeText(key, true);
					charge(1); // colon
				}
			}
			if (member) member.valueRoom = remaining; // Comma, key, colon and all closing brackets are already paid for.
			if (item !== null && typeof item === "object") {
				if (rawJSON.isRawJSON?.(item)) {
					nonJson();
					chargeText(item.rawJSON, false);
					return item;
				}
				// Charge the intrinsic primitive before visiting a sibling, without invoking user coercion hooks.
				// Return the original box so native JSON still applies any custom conversion exactly once.
				if (isStringObject(item)) {
					nonJson();
					const text = String.prototype.valueOf.call(item);
					if (root) rootText = text;
					chargeText(text, true);
					return item;
				}
				if (isNumberObject(item)) {
					nonJson();
					charge(JSON.stringify(Number.prototype.valueOf.call(item)).length);
					return item;
				}
				if (isBooleanObject(item)) {
					nonJson();
					charge(Boolean.prototype.valueOf.call(item) ? 4 : 5);
					return item;
				}
				if (isBigIntObject(item)) return BigInt.prototype.valueOf.call(item); // No JSON representation.
				const depth = parent.depth + 1;
				if (depth >= TOOL_PAYLOAD_MAX_DEPTH || isTooWide(item, nonJson)) {
					item = TRUNCATED;
					if (member) member.value = item;
				} else {
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
		if (encoded.length > wireLimit || Buffer.byteLength(encoded) > wireLimit) {
			rootText = wireStringPrefix(encoded, field);
			throw new StagePayloadBudgetExceeded();
		}
		return (JSON.parse(encoded) as Partial<Record<typeof field, WorkflowSerializableValue>>)[field];
	} catch (error) {
		if (error instanceof StagePayloadBudgetExceeded)
			return rootText !== undefined ? truncatedString(rootText) : members ? recordedPrefix(members) : TRUNCATED;
		throw error;
	}
}
