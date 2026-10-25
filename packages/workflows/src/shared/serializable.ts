import { Refine, type TSchema, Type } from "typebox";

/**
 * A JSON-serializable object must be a *plain* object (or array, handled
 * separately) — class instances such as `Date`, `Map`, or `RegExp` structurally
 * look like empty records to the schema checker but are not JSON round-trippable,
 * so they are rejected here.
 */
function isPlainObjectValue(value: unknown): boolean {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return true;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

import { Value } from "typebox/value";
import type { WorkflowOutputValues, WorkflowSerializableValue } from "./types.js";

export const WORKFLOW_SERIALIZABLE_DESCRIPTION =
	"JSON-serializable (string, finite number, boolean, null, array, or object)";

/**
 * Recursive TypeBox schema describing a JSON-serializable value: string, finite
 * number, boolean, null, array of serializable values, or an object whose
 * values are serializable. `Type.Number` already rejects NaN/Infinity in
 * TypeBox's value checker, matching the previous `z.number().finite()`.
 */
export const workflowSerializableValueSchema: TSchema = Type.Cyclic(
	{
		Serializable: Type.Union([
			Type.String(),
			Type.Number(),
			Type.Boolean(),
			Type.Null(),
			Type.Array(Type.Ref("Serializable")),
			Refine(
				Type.Record(Type.String(), Type.Ref("Serializable")),
				isPlainObjectValue,
				() => "must be a plain JSON object",
			),
		]),
	},
	"Serializable",
);

export const workflowSerializableObjectSchema: TSchema = Type.Record(Type.String(), workflowSerializableValueSchema);

export function workflowSerializableTypeName(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (typeof value === "number" && Number.isNaN(value)) return "NaN";
	if (typeof value === "number" && !Number.isFinite(value)) return String(value);
	return typeof value;
}

/** Format a TypeBox `instancePath` ("/a/0/b") as "a[0].b" for error messages. */
function formatInstancePath(instancePath: string): string {
	if (!instancePath) return "";
	const segments = instancePath.split("/").filter((s) => s.length > 0);
	return segments
		.map((segment) =>
			/^\d+$/.test(segment)
				? `[${segment}]`
				: /^[A-Za-z_$][\w$]*$/.test(segment)
					? `.${segment}`
					: `[${JSON.stringify(segment)}]`,
		)
		.join("")
		.replace(/^\./, "");
}

/** Resolve the value located at a TypeBox instance path within `root`. */
function valueAtInstancePath(root: unknown, instancePath: string): unknown {
	if (!instancePath) return root;
	let current: unknown = root;
	for (const segment of instancePath.split("/").filter((s) => s.length > 0)) {
		if (current === null || typeof current !== "object") return current;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function firstError(schema: TSchema, value: unknown): { instancePath: string } | undefined {
	for (const error of Value.Errors(schema, value)) {
		return { instancePath: error.instancePath };
	}
	return undefined;
}

/**
 * Fast, sound pre-check: true only for values the schema certainly accepts (strings, finite numbers, booleans,
 * null, dense arrays and plain objects whose own properties are all enumerable string keys, nested without
 * cycles). Anything else falls back to the schema, so edge cases keep their exact behavior. The schema's
 * recursive `$ref` evaluation dominated large workflow payloads (session transcripts) in the pool coordinator.
 */
function certainlySerializable(root: unknown, rootMustBeObject: boolean): boolean {
	if (rootMustBeObject && (root === null || typeof root !== "object" || Array.isArray(root))) return false;
	const pending: unknown[] = [root];
	const ancestors = new Set<object>();
	const exits: (object | undefined)[] = [undefined];
	while (pending.length > 0) {
		const exit = exits.pop();
		const value = pending.pop();
		if (exit !== undefined) {
			ancestors.delete(exit);
			continue;
		}
		if (value === null || typeof value === "string" || typeof value === "boolean") continue;
		if (typeof value === "number") {
			if (!Number.isFinite(value)) return false;
			continue;
		}
		if (typeof value !== "object" || ancestors.has(value)) return false;
		if (Object.getOwnPropertySymbols(value).length > 0) return false;
		const names = Object.getOwnPropertyNames(value);
		let children: unknown[];
		if (Array.isArray(value)) {
			if (names.length !== value.length + 1) return false;
			children = value;
		} else {
			const proto = Object.getPrototypeOf(value);
			if (proto !== Object.prototype && proto !== null) return false;
			const keys = Object.keys(value);
			if (keys.length !== names.length) return false;
			children = keys.map((key) => (value as Record<string, unknown>)[key]);
		}
		ancestors.add(value);
		pending.push(value);
		exits.push(value);
		for (const child of children) {
			pending.push(child);
			exits.push(undefined);
		}
	}
	return true;
}

export function workflowSerializableValidationError(value: unknown, label: string): string | undefined {
	if (certainlySerializable(value, false) || Value.Check(workflowSerializableValueSchema, value)) return undefined;
	const issue = firstError(workflowSerializableValueSchema, value);
	const issuePath = issue === undefined ? "" : formatInstancePath(issue.instancePath);
	const location = issuePath.length > 0 ? ` at ${issuePath}` : "";
	const offending = issue === undefined ? value : valueAtInstancePath(value, issue.instancePath);
	return `${label}${location} must be ${WORKFLOW_SERIALIZABLE_DESCRIPTION}, got ${workflowSerializableTypeName(offending)}`;
}

export function workflowSerializableObjectValidationError(value: unknown, label: string): string | undefined {
	if (certainlySerializable(value, true) || Value.Check(workflowSerializableObjectSchema, value)) return undefined;
	const issue = firstError(workflowSerializableObjectSchema, value);
	const issuePath = issue === undefined ? "" : formatInstancePath(issue.instancePath);
	const location = issuePath.length > 0 ? ` at ${issuePath}` : "";
	const offending = issue === undefined ? value : valueAtInstancePath(value, issue.instancePath);
	return `${label}${location} must be a ${WORKFLOW_SERIALIZABLE_DESCRIPTION} object, got ${workflowSerializableTypeName(offending)}`;
}

export function assertWorkflowSerializableValue(
	value: unknown,
	label: string,
): asserts value is WorkflowSerializableValue {
	const error = workflowSerializableValidationError(value, label);
	if (error !== undefined) throw new Error(`atomic-workflows: ${error}`);
}

export function assertWorkflowSerializableObject(value: unknown, label: string): asserts value is WorkflowOutputValues {
	const error = workflowSerializableObjectValidationError(value, label);
	if (error !== undefined) throw new Error(`atomic-workflows: ${error}`);
}
