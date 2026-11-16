import { type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import type { WorkflowInputEntry } from "../extension/render-result.js";
import type { WorkflowInputValues, WorkflowSerializableValue } from "../shared/types.js";
import type { GraphTheme } from "./graph-theme.js";

export interface InputsPickerState {
	focusedIdx: number;
	rawText: Record<string, string>;
	invalidIndices: readonly number[];
	caret: number;
}

export type InputsPickerAction = { kind: "noop" } | { kind: "cancel" } | { kind: "run"; values: WorkflowInputValues };

export interface InputsPickerRenderOpts {
	width: number;
	theme: GraphTheme;
	workflowName: string;
	fields: readonly WorkflowInputEntry[];
	state: InputsPickerState;
	cursorOn: boolean;
}

export function initialInputText(field: WorkflowInputEntry, prefilled: WorkflowInputValues): string {
	const value = prefilled[field.name] !== undefined ? prefilled[field.name] : field.default;
	if (value === undefined) return "";
	return typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
}

export function createInputsPickerState(
	fields: readonly WorkflowInputEntry[],
	prefilled: WorkflowInputValues = {},
): InputsPickerState {
	const rawText: Record<string, string> = {};
	for (const f of fields) rawText[f.name] = initialInputText(f, prefilled);
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
			default:
				out[f.name] = structuredValue(f, v);
				break;
		}
	}
	return out;
}

const INVALID_PATTERN = "invalid pattern in the workflow schema";

function firstSchemaError(def: TSchema, value: unknown, kind: string): string {
	const errors = [...Value.Errors(def, value)];
	const depth = (path: string): number => path.split("/").length;
	const first = errors.reduce<(typeof errors)[number] | undefined>(
		(best, error) => (best === undefined || depth(error.schemaPath) < depth(best.schemaPath) ? error : best),
		undefined,
	);
	if (first === undefined) return `does not match ${kind} schema`;
	const where = first.instancePath ? `${first.instancePath} ` : "";
	switch (first.keyword) {
		case "const":
			return `${where}must equal ${JSON.stringify(first.params.allowedValue)}`;
		case "minLength":
		case "maxLength":
			return `${where}${first.message} (${first.keyword} ${first.params.limit})`;
		default:
			return `${where}${first.message}`;
	}
}

function checkSchema(schema: TSchema, value: unknown, kind: string): string | null {
	try {
		return Value.Check(schema, value) ? null : firstSchemaError(schema, value, kind);
	} catch (error) {
		if (error instanceof SyntaxError) return INVALID_PATTERN;
		return error instanceof Error && error.message ? error.message : `does not match ${kind} schema`;
	}
}

function parseFiniteJson(text: string): WorkflowSerializableValue {
	return JSON.parse(text, (_key, value) => {
		if (typeof value === "number" && !Number.isFinite(value)) {
			throw new RangeError("non-finite number");
		}
		return value;
	}) as WorkflowSerializableValue;
}

function structuredValue(field: WorkflowInputEntry, text: string): WorkflowSerializableValue {
	const schema = field.schema as TSchema | undefined;
	const looksLikeJson = (text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"));
	if (schema === undefined && !looksLikeJson) return text;
	let parsed: WorkflowSerializableValue;
	try {
		parsed = parseFiniteJson(text);
	} catch {
		return text;
	}
	if (schema === undefined || checkSchema(schema, parsed, "value") === null) return parsed;
	return checkSchema(schema, text, "value") === null ? text : parsed;
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
		return checkSchema(schema, value, field.type);
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
	return checkSchema(schema, value, "text");
}

const reasons = new WeakMap<WorkflowInputEntry, { value: string; reason: string | null }>();

export function invalidForField(field: WorkflowInputEntry, value: string, _idx: number): string | null {
	const cached = reasons.get(field);
	if (cached?.value === value) return cached.reason;
	const reason = fieldReason(field, value);
	reasons.set(field, { value, reason });
	return reason;
}

function fieldReason(field: WorkflowInputEntry, value: string): string | null {
	const empty = value.trim() === "";
	if (field.required && empty) {
		if (field.type === "select") return "choose one";
		if (field.type === "boolean") return "choose on or off";
		return "required";
	}
	if (empty) return null;
	if (field.schema !== undefined || ["unknown", "object", "array"].includes(field.type)) {
		try {
			parseFiniteJson(value);
		} catch (error) {
			if (error instanceof RangeError) return "must be JSON-serializable";
		}
	}
	if (field.schema !== undefined) return checkSchema(field.schema as TSchema, structuredValue(field, value), "value");
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
