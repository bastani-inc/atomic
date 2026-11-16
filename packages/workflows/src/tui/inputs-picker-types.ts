import { type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
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

export function coerceValues(fields: readonly WorkflowInputEntry[], raw: Record<string, string>): WorkflowInputValues {
	const out: Record<string, WorkflowSerializableValue> = {};
	for (const f of fields) {
		const v = raw[f.name] ?? "";
		if (!f.required && v.trim() === "") continue;
		switch (f.type) {
			case "number": {
				const n = Number(v);
				if (Number.isFinite(n)) out[f.name] = n;
				break;
			}
			case "integer": {
				const n = Number(v);
				if (Number.isInteger(n)) out[f.name] = n;
				break;
			}
			case "boolean": {
				const parsed = parseBooleanInput(v);
				if (parsed !== undefined) out[f.name] = parsed;
				break;
			}
			case "select":
			case "text":
			case "string":
				out[f.name] = v;
				break;
			default: {
				if ((v.startsWith("{") && v.endsWith("}")) || (v.startsWith("[") && v.endsWith("]"))) {
					try {
						out[f.name] = JSON.parse(v) as WorkflowSerializableValue;
						break;
					} catch {
						break;
					}
				}
				out[f.name] = v;
				break;
			}
		}
	}
	return out;
}

function firstSchemaError(def: TSchema, value: number | string, kind: string): string {
	const first = [...Value.Errors(def, value)][0];
	if (first === undefined) return `does not match ${kind} schema`;
	switch (first.keyword) {
		case "const":
			return `must equal ${JSON.stringify(first.params.allowedValue)}`;
		case "minLength":
		case "maxLength":
			return `${first.message} (${first.keyword} ${first.params.limit})`;
		default:
			return first.message;
	}
}

function schemaConstraintReason(field: WorkflowInputEntry, value: number | string): string | null {
	if (field.const !== undefined && value !== field.const) {
		return `must equal ${JSON.stringify(field.const)}`;
	}
	if (field.type === "integer" || field.type === "number") {
		if (typeof value !== "number") return null;
		if (
			field.minimum === undefined &&
			field.maximum === undefined &&
			field.exclusiveMinimum === undefined &&
			field.exclusiveMaximum === undefined &&
			field.multipleOf === undefined
		) {
			return null;
		}
		const opts = {
			...(field.minimum !== undefined ? { minimum: field.minimum } : {}),
			...(field.maximum !== undefined ? { maximum: field.maximum } : {}),
			...(field.exclusiveMinimum !== undefined ? { exclusiveMinimum: field.exclusiveMinimum } : {}),
			...(field.exclusiveMaximum !== undefined ? { exclusiveMaximum: field.exclusiveMaximum } : {}),
			...(field.multipleOf !== undefined ? { multipleOf: field.multipleOf } : {}),
		};
		const schema = field.type === "integer" ? Type.Integer(opts) : Type.Number(opts);
		return Value.Check(schema, value) ? null : firstSchemaError(schema, value, field.type);
	}
	if (typeof value !== "string") return null;
	if (
		field.minLength === undefined &&
		field.maxLength === undefined &&
		field.pattern === undefined &&
		field.format === undefined
	) {
		return null;
	}
	const schema = Type.String({
		...(field.minLength !== undefined ? { minLength: field.minLength } : {}),
		...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {}),
		...(field.pattern !== undefined ? { pattern: field.pattern } : {}),
		...(field.format !== undefined ? { format: field.format } : {}),
	});
	return Value.Check(schema, value) ? null : firstSchemaError(schema, value, "text");
}

export function invalidForField(field: WorkflowInputEntry, value: string, _idx: number): string | null {
	const empty = value.trim() === "";
	if (field.required && empty) {
		if (field.type === "select") return "choose one";
		if (field.type === "boolean") return "choose on or off";
		return "required";
	}
	if (empty) return null;
	if (field.type === "select") {
		return (field.choices ?? []).includes(value) ? null : "not in choices";
	}
	if (field.type === "boolean") {
		const parsed = parseBooleanInput(value);
		if (parsed === undefined) return "must be on or off";
		if (field.const !== undefined && parsed !== field.const) return `must equal ${JSON.stringify(field.const)}`;
		return null;
	}
	if (field.type === "integer") {
		const n = Number(value);
		if (!Number.isInteger(n)) return "must be a whole number";
		return schemaConstraintReason(field, n);
	}
	if (field.type === "number") {
		const n = Number(value);
		if (!Number.isFinite(n)) return "must be a number";
		return schemaConstraintReason(field, n);
	}
	return schemaConstraintReason(field, value);
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
