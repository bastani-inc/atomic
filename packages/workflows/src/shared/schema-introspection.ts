/**
 * schema-introspection — single adapter between TypeBox input/output schemas
 * and the legacy normalized field descriptor (`WorkflowInputEntry`) consumed by
 * the inputs picker UI, validation, dispatch, and render paths.
 *
 * Authors declare inputs/outputs with TypeBox schemas (`Type.String`,
 * `Type.Number`, `Type.Union([...literals])`, …). The many UI/render/dispatch
 * surfaces still want a flat `{ type, choices?, default?, required?,
 * description? }` view; rather than rewrite all of them, they derive that view
 * from a TypeBox schema through this module.
 */

import {
  IsAny,
  IsArray,
  IsBoolean,
  IsInteger,
  IsLiteralString,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUnion,
  type TSchema,
} from "typebox";
import type { WorkflowInputEntry } from "../extension/render-result.js";

/** Field-kind label expected by the legacy descriptor consumers. */
export type SchemaFieldKind =
  | "text"
  | "number"
  | "integer"
  | "boolean"
  | "select"
  | "object"
  | "array"
  | "unknown";

interface SchemaMeta {
  readonly default?: unknown;
  readonly description?: string;
  readonly anyOf?: readonly TSchema[];
  readonly const?: unknown;
}

function meta(schema: TSchema): SchemaMeta {
  return schema as unknown as SchemaMeta;
}

/** True when every member of a union is a string literal. */
function isStringLiteralUnion(schema: TSchema): boolean {
  if (!IsUnion(schema)) return false;
  const members = meta(schema).anyOf ?? [];
  return members.length > 0 && members.every((m) => IsLiteralString(m));
}

/** Map a TypeBox schema to the legacy field-kind label. */
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

/** Declared default value (`schema.default`), or undefined when none. */
export function schemaDefault(schema: TSchema): unknown {
  return meta(schema).default;
}

/** Declared description, or undefined. */
export function schemaDescription(schema: TSchema): string | undefined {
  return meta(schema).description;
}

/** Allowed string values for a string-literal union, else undefined. */
export function schemaChoices(schema: TSchema): readonly string[] | undefined {
  if (!isStringLiteralUnion(schema)) return undefined;
  const members = meta(schema).anyOf ?? [];
  return members.map((m) => String(meta(m).const));
}

/**
 * A field is "required" in the picker/validation sense — i.e. the caller MUST
 * supply it — when it is neither wrapped in `Type.Optional(...)` nor carries a
 * `default`. A defaulted input is a required KEY at the type level (it is always
 * present after defaults are applied) but the user need not provide it, so it is
 * reported as not-required here, matching the legacy descriptor semantics where
 * `{ default }` implied `required: false`.
 */
export function schemaIsRequired(schema: TSchema): boolean {
  return !IsOptional(schema) && schemaDefault(schema) === undefined;
}

/** Derive the legacy normalized input descriptor for a single named field. */
export function deriveInputField(name: string, schema: TSchema): WorkflowInputEntry {
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
  return entry;
}

/** Derive descriptors for an entire declared input map (preserving order). */
export function deriveInputFields(
  schema: Readonly<Record<string, TSchema>>,
): WorkflowInputEntry[] {
  return Object.entries(schema).map(([name, s]) => deriveInputField(name, s));
}
