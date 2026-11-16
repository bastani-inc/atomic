import {
	IsAny,
	IsArray,
	IsBoolean,
	IsInteger,
	IsLiteralString,
	IsNumber,
	IsObject,
	IsOptional,
	IsRefine,
	IsString,
	IsUnion,
	type TSchema,
} from "typebox";
import type { WorkflowInputEntry } from "../extension/render-result.js";

export type SchemaFieldKind = "text" | "number" | "integer" | "boolean" | "select" | "object" | "array" | "unknown";

interface SchemaMeta {
	readonly default?: unknown;
	readonly description?: string;
	readonly anyOf?: readonly TSchema[];
	readonly const?: unknown;
	readonly minimum?: number;
	readonly maximum?: number;
	readonly exclusiveMinimum?: number;
	readonly exclusiveMaximum?: number;
	readonly multipleOf?: number;
	readonly minLength?: number;
	readonly maxLength?: number;
	readonly pattern?: string;
	readonly format?: string;
}

function meta(schema: TSchema): SchemaMeta {
	return schema as unknown as SchemaMeta;
}

function isStringLiteralUnion(schema: TSchema): boolean {
	if (!IsUnion(schema)) return false;
	const members = meta(schema).anyOf ?? [];
	return members.length > 0 && members.every((m) => IsLiteralString(m));
}

function hasRefine(value: unknown, seen = new Set<object>()): boolean {
	if (typeof value !== "object" || value === null) return false;
	if (seen.has(value)) return false;
	seen.add(value);
	if (IsRefine(value)) return true;
	if (Array.isArray(value)) return value.some((item) => hasRefine(item, seen));
	return Object.values(value).some((item) => hasRefine(item, seen));
}

export function schemaFieldKind(schema: TSchema): SchemaFieldKind {
	if (isStringLiteralUnion(schema)) return "select";
	if (IsLiteralString(schema)) return "text";
	if (IsString(schema)) return "text";
	if (IsInteger(schema)) return "integer";
	if (IsNumber(schema)) return "number";
	if (IsBoolean(schema)) return "boolean";
	if (IsObject(schema)) return "object";
	if (IsArray(schema)) return "array";
	if (IsAny(schema)) return "unknown";
	return "unknown";
}

export function schemaDefault(schema: TSchema): unknown {
	return meta(schema).default;
}

export function schemaDescription(schema: TSchema): string | undefined {
	return meta(schema).description;
}

export function schemaChoices(schema: TSchema): readonly string[] | undefined {
	if (!isStringLiteralUnion(schema)) return undefined;
	const members = meta(schema).anyOf ?? [];
	return members.map((m) => String(meta(m).const));
}

export function schemaIsRequired(schema: TSchema): boolean {
	return !IsOptional(schema) && schemaDefault(schema) === undefined;
}

export function deriveInputField(name: string, schema: TSchema): WorkflowInputEntry {
	const m = meta(schema);
	const choices = schemaChoices(schema);
	const def = schemaDefault(schema);
	const description = schemaDescription(schema);
	const entry: WorkflowInputEntry = {
		name,
		type: schemaFieldKind(schema),
		required: schemaIsRequired(schema),
	};
	if (description !== undefined) entry.description = description;
	if (def !== undefined) entry.default = def;
	if (choices !== undefined) entry.choices = choices;
	if (typeof m.const === "string" || typeof m.const === "number" || typeof m.const === "boolean") {
		entry.const = m.const;
	}
	if (typeof m.minimum === "number" && Number.isFinite(m.minimum)) entry.minimum = m.minimum;
	if (typeof m.maximum === "number" && Number.isFinite(m.maximum)) entry.maximum = m.maximum;
	if (typeof m.exclusiveMinimum === "number" && Number.isFinite(m.exclusiveMinimum)) {
		entry.exclusiveMinimum = m.exclusiveMinimum;
	}
	if (typeof m.exclusiveMaximum === "number" && Number.isFinite(m.exclusiveMaximum)) {
		entry.exclusiveMaximum = m.exclusiveMaximum;
	}
	if (typeof m.multipleOf === "number" && Number.isFinite(m.multipleOf)) entry.multipleOf = m.multipleOf;
	if (typeof m.minLength === "number" && Number.isFinite(m.minLength)) entry.minLength = m.minLength;
	if (typeof m.maxLength === "number" && Number.isFinite(m.maxLength)) entry.maxLength = m.maxLength;
	if (typeof m.pattern === "string") entry.pattern = m.pattern;
	if (typeof m.format === "string") entry.format = m.format;
	if (hasRefine(schema)) {
		entry.validationDeferred = true;
	} else if (entry.type === "unknown" || entry.type === "object" || entry.type === "array") {
		entry.schema = JSON.parse(JSON.stringify(schema)) as WorkflowInputEntry["schema"];
	}
	return entry;
}

export function deriveInputFields(schema: Readonly<Record<string, TSchema>>): WorkflowInputEntry[] {
	return Object.entries(schema).map(([name, s]) => deriveInputField(name, s));
}
