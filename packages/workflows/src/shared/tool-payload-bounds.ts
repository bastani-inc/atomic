/**
 * Bounded, cycle-safe, accessor-safe handling for durable `ctx.tool` payloads.
 *
 * Tool args and results are author-supplied values that reach two long-lived
 * surfaces: the memoized graph projection and the read-only detail view. A
 * payload that is cyclic, carries a throwing `toJSON`, or exposes a throwing
 * getter must not crash either surface, and neither surface may retain or walk
 * more than the inspection cap. `structuredClone` and `JSON.stringify` fail
 * all three requirements — they throw on hostile input and their cost is set
 * by the payload rather than by the cap — so both paths go through this module.
 *
 * Key discovery has one runtime limitation that callers cannot remove:
 * `Reflect.ownKeys` invokes the proxy's `[[OwnPropertyKeys]]` trap and the
 * engine may materialize that trap's complete key list before this module can
 * inspect it. We call that trap once, then bound all controlled per-key work:
 * at most `TOOL_PAYLOAD_MAX_KEYS` candidate keys have descriptors read, and
 * only those candidates that pass the enumerable-string check have values
 * read. This preserves own enumerable string-key order while making descriptor
 * and value work independent of the remaining payload width.
 *
 * Every bound here is explicit in the output: truncation appends
 * `TOOL_PAYLOAD_TRUNCATION_MARKER`, a back-reference becomes
 * `TOOL_PAYLOAD_CYCLE_PLACEHOLDER`, and a property that cannot be read becomes
 * `TOOL_PAYLOAD_UNREADABLE_PLACEHOLDER`. Nothing is silently dropped.
 */

import { flattenTruncatedString } from "./flat-string.js";
import type { WorkflowSerializableValue } from "./types.js";

/** A callable value supplied by an untrusted payload boundary. */
export type ToolPayloadCallable = (this: ToolPayloadValue, ...args: never[]) => ToolPayloadValue;

/** An index-signature object supplied by an untrusted payload boundary. */
export interface ToolPayloadObject {
	readonly [key: string]: ToolPayloadValue | undefined;
}

/** An array whose elements may be hostile values. */
export type ToolPayloadArray = readonly ToolPayloadValue[];

/**
 * Runtime values that can cross an inspection boundary before validation.
 *
 * WorkflowSerializableValue is the normal authoring contract. The additional
 * members describe values that hostile callbacks and JavaScript callers can
 * still hand to an inspection surface: omitted values, symbols, bigint,
 * functions, arrays, and index-signature objects.
 */
export type ToolPayloadValue =
	| string
	| number
	| boolean
	| null
	| undefined
	| bigint
	| symbol
	| ToolPayloadCallable
	| ToolPayloadArray
	| ToolPayloadObject;

/**
 * Values produced by bounded retention after omitted members are removed.
 *
 * BigInt is preserved here because the inspection copy mirrors structuredClone
 * for unusual JavaScript values; ordinary typed workflow callers select the
 * narrower WorkflowSerializableValue overload below.
 */
export type ToolPayloadRetainedValue =
	| string
	| number
	| boolean
	| null
	| bigint
	| readonly ToolPayloadRetainedValue[]
	| { readonly [key: string]: ToolPayloadRetainedValue | undefined };
/** An object with a callable JSON conversion hook. */
export interface ToolPayloadObjectWithToJSON extends ToolPayloadObject {
	readonly toJSON: ToolPayloadCallable;
}

/** Maximum candidate keys whose descriptors may be inspected per payload walk. */
export const TOOL_PAYLOAD_MAX_KEYS = 2_048;

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
function isOmittedJsonValue(value: ToolPayloadValue | undefined): boolean {
	return value === undefined || typeof value === "function" || typeof value === "symbol";
}

/** Narrow an untrusted value to an object with ordinary own properties. */
export function isToolPayloadObject(value: ToolPayloadValue): value is ToolPayloadObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Narrow an untrusted value to an array-like object. */
export function isToolPayloadArray(value: ToolPayloadValue): value is ToolPayloadArray {
	return Array.isArray(value);
}

/** Narrow an untrusted value to any object-like payload, including arrays. */
export function isToolPayloadObjectLike(value: ToolPayloadValue): value is ToolPayloadObject | ToolPayloadArray {
	return value !== null && typeof value === "object";
}

/** Narrow a payload member to a callable value without invoking it. */
export function isToolPayloadCallable(value: ToolPayloadValue | undefined): value is ToolPayloadCallable {
	return typeof value === "function";
}

/** Test a payload object's `toJSON` member while containing a throwing getter. */
export function hasCallableToolPayloadToJSON(value: ToolPayloadObject): value is ToolPayloadObjectWithToJSON {
	try {
		return isToolPayloadCallable(value.toJSON);
	} catch {
		return false;
	}
}

interface PropertyRead {
	readonly ok: true;
	readonly value: ToolPayloadValue;
}

interface PropertyReadFailure {
	readonly ok: false;
}

function readToolPayloadProperty(
	value: ToolPayloadObject | ToolPayloadArray,
	key: PropertyKey,
): PropertyRead | PropertyReadFailure {
	try {
		const property: ToolPayloadValue = Reflect.get(value, key);
		return { ok: true, value: property };
	} catch {
		return { ok: false };
	}
}

function safeProperty(value: ToolPayloadObject | ToolPayloadArray, key: PropertyKey): ToolPayloadValue {
	const result = readToolPayloadProperty(value, key);
	return result.ok ? result.value : TOOL_PAYLOAD_UNREADABLE_PLACEHOLDER;
}

/**
 * Lazily expose own enumerable string keys without paying Object.keys' eager
 * descriptor pass. The engine may still materialize the complete ownKeys list;
 * `consumeKey` bounds every descriptor/value operation under our control.
 */
interface SafeOwnKeyScan {
	readonly keys: Iterable<string>;
	readonly stoppedByLimit: () => boolean;
}

function safeOwnKeys(value: ToolPayloadObject | ToolPayloadArray, consumeKey: () => boolean): SafeOwnKeyScan {
	let stopped = false;
	function* enumerate(): Generator<string> {
		let keys: readonly PropertyKey[];
		try {
			keys = Reflect.ownKeys(value);
		} catch {
			return;
		}
		for (const key of keys) {
			if (!consumeKey()) {
				stopped = true;
				return;
			}
			if (typeof key !== "string") continue;
			let descriptor: PropertyDescriptor | undefined;
			try {
				descriptor = Object.getOwnPropertyDescriptor(value, key);
			} catch {
				continue;
			}
			if (descriptor?.enumerable === true) yield key;
		}
	}
	return { keys: enumerate(), stoppedByLimit: () => stopped };
}

function safeArrayLength(value: ToolPayloadArray): number {
	const result = readToolPayloadProperty(value, "length");
	if (!result.ok || typeof result.value !== "number") return 0;
	return Number.isSafeInteger(result.value) && result.value > 0 ? result.value : 0;
}

/**
 * Apply `toJSON` the way `JSON.stringify` would, containing a throwing accessor
 * or a throwing conversion instead of letting it escape.
 */
function resolveJsonValue(value: ToolPayloadValue): ToolPayloadValue {
	if (!isToolPayloadObjectLike(value)) return value;
	const toJson = readToolPayloadProperty(value, "toJSON");
	if (!toJson.ok) return TOOL_PAYLOAD_UNREADABLE_PLACEHOLDER;
	if (!isToolPayloadCallable(toJson.value)) return value;
	try {
		return toJson.value.call(value);
	} catch {
		return TOOL_PAYLOAD_UNSERIALIZABLE_PLACEHOLDER;
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
	keysRemaining: number;
	readonly seen: Set<object>;
}

function consumeKeyBudget(state: { keysRemaining: number }): boolean {
	if (state.keysRemaining <= 0) return false;
	state.keysRemaining -= 1;
	return true;
}

function addTruncationMarker(record: { [key: string]: ToolPayloadRetainedValue }): void {
	let key = TOOL_PAYLOAD_TRUNCATION_KEY;
	let suffix = 1;
	while (Object.hasOwn(record, key)) key = `${TOOL_PAYLOAD_TRUNCATION_KEY}${suffix++}`;
	record[key] = TOOL_PAYLOAD_TRUNCATION_MARKER;
}
function cloneObjectLike(state: CloneState, value: ToolPayloadObject | ToolPayloadArray): ToolPayloadRetainedValue {
	if (state.seen.has(value)) return TOOL_PAYLOAD_CYCLE_PLACEHOLDER;
	if (state.depth >= TOOL_PAYLOAD_MAX_DEPTH) return TOOL_PAYLOAD_TRUNCATION_MARKER;
	state.seen.add(value);
	state.depth += 1;
	// Charge the container itself so deep, empty nesting still reaches the cap.
	state.remaining -= CONTAINER_COST;
	try {
		if (isToolPayloadArray(value)) {
			const items: ToolPayloadRetainedValue[] = [];
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
		const cloned: { [key: string]: ToolPayloadRetainedValue } = {};
		const scan = safeOwnKeys(value, () => state.remaining > 0 && consumeKeyBudget(state));
		for (const key of scan.keys) {
			// Charged before the omission check for the same reason: inspecting a
			// key costs work whether or not JSON would emit it.
			state.remaining -= key.length + SEPARATOR_COST;
			const child = safeProperty(value, key);
			if (isOmittedJsonValue(child)) continue;
			cloned[key] = cloneValue(state, child);
		}
		if (scan.stoppedByLimit()) addTruncationMarker(cloned);
		return cloned;
	} finally {
		state.depth -= 1;
		state.seen.delete(value);
	}
}

function cloneValue(state: CloneState, value: ToolPayloadValue): ToolPayloadRetainedValue {
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
			// BigInt is retained in the inspection copy like structuredClone.
			state.remaining -= NUMBER_COST;
			return resolved;
		default:
			state.remaining -= TOOL_PAYLOAD_UNSERIALIZABLE_PLACEHOLDER.length;
			return TOOL_PAYLOAD_UNSERIALIZABLE_PLACEHOLDER;
	}
}

/**
 * Detach a tool payload for the memoized graph projection.
 *
 * Cycles, throwing accessors, and throwing `toJSON` implementations are
 * contained; retention is bounded by `limit` and the controlled key budget.
 */
export function boundedToolPayload(value: WorkflowSerializableValue, limit?: number): WorkflowSerializableValue;
export function boundedToolPayload(value: ToolPayloadValue, limit?: number): ToolPayloadRetainedValue;
export function boundedToolPayload(
	value: ToolPayloadValue,
	limit = TOOL_PAYLOAD_VALUE_LIMIT,
): ToolPayloadRetainedValue {
	return cloneValue(
		{ remaining: Math.max(1, limit), depth: 0, keysRemaining: TOOL_PAYLOAD_MAX_KEYS, seen: new Set<object>() },
		value,
	);
}

/**
 * Detach a tool argument record, always returning a plain object.
 *
 * The record boundary stays object-shaped even when a hostile top-level value
 * is supplied. One character budget and one controlled key budget are shared
 * across all emitted keys.
 */
export function boundedToolPayloadRecord(
	value: Readonly<Record<string, WorkflowSerializableValue>>,
	limit?: number,
): Readonly<Record<string, WorkflowSerializableValue>>;
export function boundedToolPayloadRecord(
	value: ToolPayloadValue,
	limit?: number,
): Readonly<Record<string, ToolPayloadRetainedValue>>;
export function boundedToolPayloadRecord(
	value: ToolPayloadValue,
	limit = TOOL_PAYLOAD_VALUE_LIMIT,
): Readonly<Record<string, ToolPayloadRetainedValue>> {
	const record: { [key: string]: ToolPayloadRetainedValue } = {};
	if (!isToolPayloadObjectLike(value)) return record;
	const state: CloneState = {
		remaining: Math.max(1, limit),
		depth: 0,
		keysRemaining: TOOL_PAYLOAD_MAX_KEYS,
		seen: new Set<object>([value]),
	};
	const scan = safeOwnKeys(value, () => state.remaining > 0 && consumeKeyBudget(state));
	for (const key of scan.keys) {
		state.remaining -= key.length + SEPARATOR_COST;
		const child = safeProperty(value, key);
		if (isOmittedJsonValue(child)) continue;
		record[key] = cloneValue(state, child);
	}
	if (scan.stoppedByLimit()) addTruncationMarker(record);
	return record;
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

// ---------------------------------------------------------------------------
// Bounded serialization
// ---------------------------------------------------------------------------

interface SerializeState {
	readonly limit: number;
	readonly parts: string[];
	length: number;
	depth: number;
	keysRemaining: number;
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
function writeObjectLike(state: SerializeState, value: ToolPayloadObject | ToolPayloadArray): boolean {
	if (state.seen.has(value)) return writeChunk(state, JSON.stringify(TOOL_PAYLOAD_CYCLE_PLACEHOLDER));
	if (state.depth >= TOOL_PAYLOAD_MAX_DEPTH) {
		state.truncated = true;
		return writeChunk(state, JSON.stringify(TOOL_PAYLOAD_TRUNCATION_MARKER));
	}
	state.seen.add(value);
	state.depth += 1;
	try {
		if (isToolPayloadArray(value)) {
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
		const scan = safeOwnKeys(value, () => state.length < state.limit && consumeKeyBudget(state));
		for (const key of scan.keys) {
			const child = safeProperty(value, key);
			if (isOmittedJsonValue(child)) continue;
			if (!first && !writeChunk(state, ",")) return false;
			first = false;
			if (!writeChunk(state, `${JSON.stringify(key)}:`)) return false;
			if (!writeValue(state, child)) return false;
		}
		if (scan.stoppedByLimit()) {
			state.truncated = true;
			return false;
		}
		return writeChunk(state, "}");
	} finally {
		state.depth -= 1;
		state.seen.delete(value);
	}
}

function writeValue(state: SerializeState, value: ToolPayloadValue): boolean {
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
export function boundedToolPayloadText(value: ToolPayloadValue, limit = TOOL_PAYLOAD_VALUE_LIMIT): string {
	const cap = Math.max(TOOL_PAYLOAD_TRUNCATION_MARKER.length + 1, limit);
	const state: SerializeState = {
		limit: cap,
		parts: [],
		length: 0,
		depth: 0,
		keysRemaining: TOOL_PAYLOAD_MAX_KEYS,
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
