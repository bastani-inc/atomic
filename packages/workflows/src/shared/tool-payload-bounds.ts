/**
 * Bounded, cycle-safe, accessor-safe handling for durable `ctx.tool` payloads.
 *
 * Tool args and results are author-supplied values that reach two long-lived
 * surfaces: the memoized graph projection and the read-only detail view. A
 * payload that is cyclic, carries a throwing `toJSON`, or exposes a throwing
 * getter must not crash either surface, and neither surface may retain or walk
 * more than the inspection cap. `structuredClone` and `JSON.stringify` fail all
 * three requirements — they throw on hostile input and their cost is set by the
 * payload rather than by the cap — so both paths go through this module.
 *
 * Every bound here is explicit in the output: truncation appends
 * `TOOL_PAYLOAD_TRUNCATION_MARKER`, a back-reference becomes
 * `TOOL_PAYLOAD_CYCLE_PLACEHOLDER`, and a property that cannot be read becomes
 * `TOOL_PAYLOAD_UNREADABLE_PLACEHOLDER`. Nothing is silently dropped.
 */

import { flattenTruncatedString } from "./flat-string.js";
import type { WorkflowSerializableValue } from "./types.js";

/** Maximum serialized payload characters retained or displayed per field. */
export const TOOL_PAYLOAD_VALUE_LIMIT = 16_384;
export const TOOL_PAYLOAD_TRUNCATION_MARKER = "… [truncated]";
export const TOOL_PAYLOAD_CYCLE_PLACEHOLDER = "<cycle>";
export const TOOL_PAYLOAD_UNREADABLE_PLACEHOLDER = "<unreadable>";
export const TOOL_PAYLOAD_UNSERIALIZABLE_PLACEHOLDER = "<unserializable>";
/** Key carrying the marker when an object is cut short by the cap. */
export const TOOL_PAYLOAD_TRUNCATION_KEY = "…";
/**
 * Nesting bound. Both walkers recurse, so a pathological payload would
 * otherwise exhaust the stack before the character cap could stop it.
 */
export const TOOL_PAYLOAD_MAX_DEPTH = 256;

/** Values JSON omits from objects entirely. */
function isOmittedJsonValue(value: unknown): boolean {
	return value === undefined || typeof value === "function" || typeof value === "symbol";
}

/**
 * Apply `toJSON` the way `JSON.stringify` would, containing a throwing accessor
 * or a throwing conversion instead of letting it escape.
 */
function resolveJsonValue(value: unknown): unknown {
	if (value === null || typeof value !== "object") return value;
	let toJson: unknown;
	try {
		toJson = (value as { readonly toJSON?: unknown }).toJSON;
	} catch {
		return TOOL_PAYLOAD_UNREADABLE_PLACEHOLDER;
	}
	if (typeof toJson !== "function") return value;
	try {
		return (toJson as (this: unknown) => unknown).call(value);
	} catch {
		return TOOL_PAYLOAD_UNSERIALIZABLE_PLACEHOLDER;
	}
}

function safeOwnKeys(value: object): string[] {
	try {
		return Object.keys(value);
	} catch {
		return [];
	}
}

function safeArrayLength(value: readonly unknown[]): number {
	try {
		const length = value.length;
		return Number.isSafeInteger(length) && length > 0 ? length : 0;
	} catch {
		return 0;
	}
}

function safeProperty(value: object, key: string | number): unknown {
	try {
		return (value as Record<string | number, unknown>)[key];
	} catch {
		return TOOL_PAYLOAD_UNREADABLE_PLACEHOLDER;
	}
}

// ---------------------------------------------------------------------------
// Bounded retention
// ---------------------------------------------------------------------------

/**
 * Serialized cost charged per value kind.
 *
 * Every branch of the walker must charge something. A branch that returns
 * without charging makes the cap unreachable for payloads built out of that
 * kind alone — a million nulls, holes, or omitted entries are all ordinary
 * `ctx.tool` results, and they are retained in the memoized projection and
 * written into durable checkpoints.
 */
const NULL_COST = 4; // "null"
const NUMBER_COST = 8;
const BOOLEAN_COST = 5; // "false"
const CONTAINER_COST = 2; // "{}" or "[]"
const SEPARATOR_COST = 1; // "," between elements

interface CloneState {
	remaining: number;
	depth: number;
	readonly seen: Set<object>;
}

function cloneString(state: CloneState, value: string): string {
	if (state.remaining <= 0) return TOOL_PAYLOAD_TRUNCATION_MARKER;
	if (value.length <= state.remaining) {
		state.remaining -= value.length;
		return value;
	}
	const keep = state.remaining;
	state.remaining = 0;
	// Flattened: this projection is memoized, so a SlicedString here would keep
	// the whole original payload alive behind a bounded-looking value.
	return `${flattenTruncatedString(value.slice(0, keep))}${TOOL_PAYLOAD_TRUNCATION_MARKER}`;
}

function cloneObjectLike(state: CloneState, value: object): WorkflowSerializableValue {
	if (state.seen.has(value)) return TOOL_PAYLOAD_CYCLE_PLACEHOLDER;
	if (state.depth >= TOOL_PAYLOAD_MAX_DEPTH) return TOOL_PAYLOAD_TRUNCATION_MARKER;
	state.seen.add(value);
	state.depth += 1;
	// Charge the container itself so deep, empty nesting still reaches the cap.
	state.remaining -= CONTAINER_COST;
	try {
		if (Array.isArray(value)) {
			const items: WorkflowSerializableValue[] = [];
			const length = safeArrayLength(value);
			for (let index = 0; index < length; index++) {
				if (state.remaining <= 0) {
					items.push(TOOL_PAYLOAD_TRUNCATION_MARKER);
					break;
				}
				state.remaining -= SEPARATOR_COST;
				const item = safeProperty(value, index);
				// A hole, `undefined`, a function, or a symbol serializes as `null`
				// and is charged as one: an array of them is not free to retain.
				if (isOmittedJsonValue(item)) {
					state.remaining -= NULL_COST;
					items.push(null);
					continue;
				}
				items.push(cloneValue(state, item));
			}
			return items;
		}
		const cloned: { [key: string]: WorkflowSerializableValue } = {};
		for (const key of safeOwnKeys(value)) {
			if (state.remaining <= 0) {
				cloned[TOOL_PAYLOAD_TRUNCATION_KEY] = TOOL_PAYLOAD_TRUNCATION_MARKER;
				break;
			}
			// Charged before the omission check for the same reason: inspecting a
			// key costs work whether or not JSON would emit it.
			state.remaining -= key.length + SEPARATOR_COST;
			const child = safeProperty(value, key);
			if (isOmittedJsonValue(child)) continue;
			cloned[key] = cloneValue(state, child);
		}
		return cloned;
	} finally {
		state.depth -= 1;
		state.seen.delete(value);
	}
}

function cloneValue(state: CloneState, value: unknown): WorkflowSerializableValue {
	const resolved = resolveJsonValue(value);
	if (resolved === null) {
		state.remaining -= NULL_COST;
		return null;
	}
	switch (typeof resolved) {
		case "string":
			return cloneString(state, resolved);
		case "number":
			state.remaining -= NUMBER_COST;
			return Number.isFinite(resolved) ? resolved : null;
		case "boolean":
			state.remaining -= BOOLEAN_COST;
			return resolved;
		case "object":
			return cloneObjectLike(state, resolved);
		case "bigint":
			// Retained verbatim, as `structuredClone` did: the display path
			// renders its digits and nothing here normalizes author values.
			state.remaining -= NUMBER_COST;
			return resolved as unknown as WorkflowSerializableValue;
		default:
			state.remaining -= TOOL_PAYLOAD_UNSERIALIZABLE_PLACEHOLDER.length;
			return TOOL_PAYLOAD_UNSERIALIZABLE_PLACEHOLDER;
	}
}

/**
 * Detach a tool payload for the memoized graph projection.
 *
 * Cycles, throwing accessors, and throwing `toJSON` implementations are
 * contained; retention is bounded by `limit` serialized characters.
 */
export function boundedToolPayload(
	value: WorkflowSerializableValue,
	limit = TOOL_PAYLOAD_VALUE_LIMIT,
): WorkflowSerializableValue {
	return cloneValue({ remaining: Math.max(1, limit), depth: 0, seen: new Set<object>() }, value);
}

/**
 * Detach a tool argument record, always returning a plain object.
 *
 * `boundedToolPayload` applies `toJSON` at the top level, so a hostile or
 * merely unusual args object could otherwise collapse to a string or array.
 * Durable checkpoints carry this value, and a decoder that met a non-object
 * there once discarded the whole workflow, so the record shape is guaranteed
 * here rather than assumed downstream. One budget is shared across all keys.
 */
export function boundedToolPayloadRecord(
	value: Readonly<Record<string, WorkflowSerializableValue>>,
	limit = TOOL_PAYLOAD_VALUE_LIMIT,
): Readonly<Record<string, WorkflowSerializableValue>> {
	const record: { [key: string]: WorkflowSerializableValue } = {};
	if (value === null || typeof value !== "object") return record;
	const state: CloneState = { remaining: Math.max(1, limit), depth: 0, seen: new Set<object>([value]) };
	for (const key of safeOwnKeys(value)) {
		if (state.remaining <= 0) {
			record[TOOL_PAYLOAD_TRUNCATION_KEY] = TOOL_PAYLOAD_TRUNCATION_MARKER;
			break;
		}
		state.remaining -= key.length + SEPARATOR_COST;
		const child = safeProperty(value, key);
		if (isOmittedJsonValue(child)) continue;
		record[key] = cloneValue(state, child);
	}
	return record;
}

// ---------------------------------------------------------------------------
// Bounded serialization
// ---------------------------------------------------------------------------

interface SerializeState {
	readonly limit: number;
	readonly parts: string[];
	length: number;
	depth: number;
	truncated: boolean;
	readonly seen: Set<object>;
}

/** Append `chunk`; returns false once the cap is reached so callers stop early. */
function writeChunk(state: SerializeState, chunk: string): boolean {
	const remaining = state.limit - state.length;
	if (remaining <= 0) {
		state.truncated = true;
		return false;
	}
	if (chunk.length > remaining) {
		state.parts.push(chunk.slice(0, remaining));
		state.length = state.limit;
		state.truncated = true;
		return false;
	}
	state.parts.push(chunk);
	state.length += chunk.length;
	return true;
}

function writeString(state: SerializeState, value: string): boolean {
	const remaining = state.limit - state.length;
	if (remaining <= 0) {
		state.truncated = true;
		return false;
	}
	// Quote only what can still fit, so a multi-megabyte string costs the cap
	// rather than its own length.
	if (value.length > remaining) {
		state.truncated = true;
		writeChunk(state, JSON.stringify(value.slice(0, remaining)));
		return false;
	}
	return writeChunk(state, JSON.stringify(value));
}

function writeObjectLike(state: SerializeState, value: object): boolean {
	if (state.seen.has(value)) return writeChunk(state, JSON.stringify(TOOL_PAYLOAD_CYCLE_PLACEHOLDER));
	if (state.depth >= TOOL_PAYLOAD_MAX_DEPTH) {
		state.truncated = true;
		return writeChunk(state, JSON.stringify(TOOL_PAYLOAD_TRUNCATION_MARKER));
	}
	state.seen.add(value);
	state.depth += 1;
	try {
		if (Array.isArray(value)) {
			if (!writeChunk(state, "[")) return false;
			const length = safeArrayLength(value);
			for (let index = 0; index < length; index++) {
				if (index > 0 && !writeChunk(state, ",")) return false;
				const item = safeProperty(value, index);
				if (!writeValue(state, isOmittedJsonValue(item) ? null : item)) return false;
			}
			return writeChunk(state, "]");
		}
		if (!writeChunk(state, "{")) return false;
		let first = true;
		for (const key of safeOwnKeys(value)) {
			const child = safeProperty(value, key);
			if (isOmittedJsonValue(child)) continue;
			if (!first && !writeChunk(state, ",")) return false;
			first = false;
			if (!writeChunk(state, `${JSON.stringify(key)}:`)) return false;
			if (!writeValue(state, child)) return false;
		}
		return writeChunk(state, "}");
	} finally {
		state.depth -= 1;
		state.seen.delete(value);
	}
}

function writeValue(state: SerializeState, value: unknown): boolean {
	const resolved = resolveJsonValue(value);
	if (resolved === null) return writeChunk(state, "null");
	switch (typeof resolved) {
		case "string":
			return writeString(state, resolved);
		case "number":
			return writeChunk(state, Number.isFinite(resolved) ? String(resolved) : "null");
		case "boolean":
			return writeChunk(state, resolved ? "true" : "false");
		case "object":
			return writeObjectLike(state, resolved);
		case "bigint":
			return writeChunk(state, String(resolved));
		default:
			return writeChunk(state, "null");
	}
}

/**
 * Serialize a tool payload for display with work bounded by `limit` rather than
 * by the payload. Truncated output always carries the marker.
 */
export function boundedToolPayloadText(value: unknown, limit = TOOL_PAYLOAD_VALUE_LIMIT): string {
	const cap = Math.max(TOOL_PAYLOAD_TRUNCATION_MARKER.length + 1, limit);
	const state: SerializeState = {
		limit: cap,
		parts: [],
		length: 0,
		depth: 0,
		truncated: false,
		seen: new Set<object>(),
	};
	writeValue(state, value);
	const text = state.parts.join("");
	if (!state.truncated) return text;
	const keep = Math.max(0, cap - TOOL_PAYLOAD_TRUNCATION_MARKER.length);
	return `${text.slice(0, keep)}${TOOL_PAYLOAD_TRUNCATION_MARKER}`;
}

/**
 * Bound already-textual inspection metadata, such as a captured callback
 * source, with the same cap and marker.
 */
export function boundedToolText(value: string, limit = TOOL_PAYLOAD_VALUE_LIMIT): string {
	const cap = Math.max(TOOL_PAYLOAD_TRUNCATION_MARKER.length + 1, limit);
	if (value.length <= cap) return value;
	const keep = Math.max(0, cap - TOOL_PAYLOAD_TRUNCATION_MARKER.length);
	return `${flattenTruncatedString(value.slice(0, keep))}${TOOL_PAYLOAD_TRUNCATION_MARKER}`;
}

// ---------------------------------------------------------------------------
// Display-safe text
// ---------------------------------------------------------------------------

/** Columns one source tab expands to. Spaces are emitted, so this is exact. */
export const TOOL_TEXT_TAB_WIDTH = 4;

/**
 * Make author-supplied text safe to paint inside a bordered box.
 *
 * Serialized fields are JSON-quoted, which escapes control bytes for free.
 * Source text is deliberately *not* quoted — it stays readable as source — so
 * it needs the same protection applied directly: tabs become spaces, because
 * the width model counts a tab as one grapheme while a terminal advances to
 * its own tab stop, and every other control byte becomes a printable `\xNN`
 * so an embedded ESC cannot emit a live escape sequence into the frame.
 */
export function sanitizeToolDisplayText(value: string, tabWidth = TOOL_TEXT_TAB_WIDTH): string {
	const stops = Math.max(1, Math.floor(tabWidth));
	let out = "";
	let column = 0;
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		if (char === "\n") {
			out += char;
			column = 0;
			continue;
		}
		if (char === "\t") {
			const pad = stops - (column % stops);
			out += " ".repeat(pad);
			column += pad;
			continue;
		}
		if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
			const escaped = `\\x${code.toString(16).padStart(2, "0")}`;
			out += escaped;
			column += escaped.length;
			continue;
		}
		out += char;
		column += 1;
	}
	return out;
}

/** Single-line variant for chrome such as a box title. */
export function sanitizeToolTitleText(value: string): string {
	return sanitizeToolDisplayText(value).replace(/\n/g, " ");
}
