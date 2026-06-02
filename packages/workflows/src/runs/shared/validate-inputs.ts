/**
 * validateInputs — check a parsed input bag against a workflow's declared
 * TypeBox input schema. Used by slash-command and programmatic SDK dispatch
 * paths to reject malformed input payloads before dispatch.
 *
 * Reports:
 *   - unknown input keys (catches typos like "propmt")
 *   - wrong-typed values (number/boolean/string/select-union/integer)
 *   - select values not in the declared literal union
 *   - missing required inputs
 *   - non-JSON-serializable values
 *
 * Does NOT coerce: "true" is not a boolean, "3" is not a number. JSON parsing
 * upstream already preserves types — string-typed values reaching this point
 * are user mistakes worth surfacing.
 *
 * The legacy `{ type }` descriptor is gone; the field kind, choices, and
 * required-ness are derived from the TypeBox schema via schema-introspection,
 * keeping the historical error wording byte-for-byte stable.
 */

import { Value } from "typebox/value";
import {
  workflowSerializableValidationError,
  workflowSerializableTypeName,
} from "../../shared/serializable.js";
import {
  schemaChoices,
  schemaFieldKind,
  schemaIsRequired,
} from "../../shared/schema-introspection.js";
import type { TSchema, WorkflowInputValues } from "../../shared/types.js";

export interface ValidationError {
  key: string;
  reason: string;
}

export function validateInputs(
  schema: Readonly<Record<string, TSchema>>,
  inputs: WorkflowInputValues,
): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const key of Object.keys(inputs)) {
    if (!(key in schema)) {
      errors.push({ key, reason: "unknown input key (not declared by this workflow)" });
    }
  }

  for (const [key, def] of Object.entries(schema)) {
    const value = inputs[key];
    let hasTypeError = false;

    if (value === undefined) {
      if (schemaIsRequired(def)) {
        errors.push({ key, reason: "required input is missing" });
      }
      continue;
    }

    const kind = schemaFieldKind(def);
    switch (kind) {
      case "text":
        if (typeof value !== "string") {
          errors.push({ key, reason: `expected string, got ${workflowSerializableTypeName(value)}` });
          hasTypeError = true;
        }
        break;
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)) {
          errors.push({ key, reason: `expected finite number, got ${workflowSerializableTypeName(value)}` });
          hasTypeError = true;
        }
        break;
      case "integer":
        if (typeof value !== "number" || !Number.isInteger(value)) {
          errors.push({ key, reason: `expected integer, got ${workflowSerializableTypeName(value)}` });
          hasTypeError = true;
        }
        break;
      case "boolean":
        if (typeof value !== "boolean") {
          errors.push({ key, reason: `expected boolean, got ${workflowSerializableTypeName(value)}` });
          hasTypeError = true;
        }
        break;
      case "select": {
        const choices = schemaChoices(def) ?? [];
        const allowed = choices.join(", ");
        if (typeof value !== "string") {
          errors.push({ key, reason: `expected one of [${allowed}], got ${workflowSerializableTypeName(value)}` });
          hasTypeError = true;
        } else if (!choices.includes(value)) {
          errors.push({ key, reason: `must be one of [${allowed}]` });
        }
        break;
      }
      default:
        // object / array / unknown: defer to the schema's own checker so a
        // precise declared shape (Type.Object({ ... }), Type.Array(...)) is
        // still enforced, while loose schemas accept any serializable value.
        if (!Value.Check(def, value)) {
          const first = [...Value.Errors(def, value)][0];
          errors.push({ key, reason: first === undefined ? `does not match ${kind} schema` : first.message });
          hasTypeError = true;
        }
        break;
    }

    const serializableError = hasTypeError
      ? undefined
      : workflowSerializableValidationError(value, `input "${key}"`);
    if (serializableError !== undefined) {
      errors.push({ key, reason: serializableError.replace(/^input "[^"]+" /, "") });
    }
  }

  return errors;
}
