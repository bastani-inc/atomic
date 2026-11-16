import type { WorkflowInputEntry } from "../extension/render-result.js";
import type { WorkflowInputValues, WorkflowSerializableValue } from "../shared/types.js";
import type { GraphTheme } from "./graph-theme.js";

export interface InputsPickerState {
	/** Index of the currently-focused field. */
	focusedIdx: number;
	/**
	 * Raw string the user has typed/selected for each field, keyed by name.
	 * Booleans store `"true"` / `"false"`; numbers store their text form;
	 * selects store the chosen choice; text/string store the literal value.
	 * `coerceValues()` converts these into typed objects at submit time.
	 */
	rawText: Record<string, string>;
	/**
	 * Set of field indices that failed validation on the most recent submit
	 * attempt. Used to dim the run hint and to highlight a field if the user
	 * retries with required fields still empty.
	 */
	invalidIndices: readonly number[];
	/** Cursor offset within the focused single-line text field. */
	caret: number;
}

/** Discriminated action returned by the key handler. */
export type InputsPickerAction = { kind: "noop" } | { kind: "cancel" } | { kind: "run"; values: WorkflowInputValues };

export interface InputsPickerRenderOpts {
	width: number;
	theme: GraphTheme;
	workflowName: string;
	fields: readonly WorkflowInputEntry[];
	state: InputsPickerState;
	/** True when the blinking cursor is in its visible half-period. */
	cursorOn: boolean;
}

// ---------------------------------------------------------------------------
// State construction + value coercion
// ---------------------------------------------------------------------------

/**
 * Seed `rawText` from declared defaults plus any values the user already
 * passed as key=value tokens. Nothing else is chosen for the user: a select
 * or boolean without a default starts unset, as text and numbers do, so a
 * required one must be answered and an optional one is omitted (#5224).
 */
/**
 * A field's starting text in every inputs form: the value passed on the command line, else the declared default,
 * else nothing. A select or boolean is never preset to its first choice or to off (#5224).
 */
export function initialInputText(field: WorkflowInputEntry, prefilled: WorkflowInputValues): string {
	if (prefilled[field.name] !== undefined) return String(prefilled[field.name]);
	if (field.default !== undefined) return String(field.default);
	return "";
}

export function createInputsPickerState(
	fields: readonly WorkflowInputEntry[],
	prefilled: WorkflowInputValues = {},
): InputsPickerState {
	const rawText: Record<string, string> = {};
	for (const f of fields) rawText[f.name] = initialInputText(f, prefilled);
	// Focus the first invalid field if any; otherwise field 0. This keeps the
	// cursor on the first thing the user actually needs to fill in.
	const firstInvalid = fields.findIndex((f, i) => invalidForField(f, rawText[f.name] ?? "", i) !== null);
	const focusedIdx = firstInvalid >= 0 ? firstInvalid : 0;
	return {
		focusedIdx,
		rawText,
		invalidIndices: [],
		caret: (rawText[fields[focusedIdx]?.name ?? ""] ?? "").length,
	};
}

/**
 * Coerce the rawText map into typed values matching the declared schema.
 * Mirrors the `parseWorkflowArgs` JSON-tolerant logic for text/string
 * fields (so users can paste `["a","b"]` into a text box and have it land
 * as an array), and enforces numeric / boolean parsing for typed fields.
 *
 * Throws on hard parse failure for required fields; lenient on optional.
 * The picker only calls `coerceValues` after `validate` succeeds, so the
 * thrown branch is a defensive guard, not an expected path.
 */
export function coerceValues(fields: readonly WorkflowInputEntry[], raw: Record<string, string>): WorkflowInputValues {
	const out: Record<string, WorkflowSerializableValue> = {};
	for (const f of fields) {
		const v = raw[f.name] ?? "";
		if (v === "" && !f.required) continue; // skip empty optionals
		switch (f.type) {
			case "number":
			case "integer": {
				if (!f.required && v.trim() === "") break;
				const n = Number(v);
				if (Number.isFinite(n)) out[f.name] = n;
				break;
			}
			case "boolean": {
				const parsed = parseBooleanInput(v);
				if (parsed !== undefined) out[f.name] = parsed;
				break;
			}
			case "select":
				if (!f.required && v.trim() === "") break;
				out[f.name] = v;
				break;
			default: {
				// Try JSON for power users pasting structured data; otherwise treat
				// as a literal string. Mirrors parseWorkflowArgs.
				if ((v.startsWith("{") && v.endsWith("}")) || (v.startsWith("[") && v.endsWith("]"))) {
					try {
						out[f.name] = JSON.parse(v) as WorkflowSerializableValue;
						break;
					} catch {
						// fall through
					}
				}
				out[f.name] = v;
			}
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Return the reason why `field` is invalid for `value`, or `null` if valid.
 * Used both to flag fields on submit and to drive the dim state of the run
 * key hint.
 */
export function invalidForField(field: WorkflowInputEntry, value: string, _idx: number): string | null {
	const empty = value.trim() === "";
	if (field.required && empty) {
		if (field.type === "select") return "choose one";
		if (field.type === "boolean") return "choose on or off";
		return "required";
	}
	if (empty) return null;
	if (field.type === "select" && field.choices && !field.choices.includes(value)) return "not in choices";
	if (field.type === "boolean" && parseBooleanInput(value) === undefined) return "must be on or off";
	if (field.type === "integer" && !Number.isInteger(Number(value))) return "must be a whole number";
	if (field.type === "number" && !Number.isFinite(Number(value))) return "must be a number";
	return null;
}

export function parseBooleanInput(value: string): boolean | undefined {
	const text = value.trim().toLowerCase();
	if (text === "true" || text === "1" || text === "on") return true;
	if (text === "false" || text === "0" || text === "off") return false;
	return undefined;
}

export function computeInvalid(fields: readonly WorkflowInputEntry[], raw: Record<string, string>): number[] {
	const out: number[] = [];
	for (let i = 0; i < fields.length; i++) {
		const f = fields[i]!;
		if (invalidForField(f, raw[f.name] ?? "", i) !== null) out.push(i);
	}
	return out;
}
