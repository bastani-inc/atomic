import type { BoundWorkspace } from "@bastani/atomic";
import { type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { schemaFieldKind, schemaIsRequired } from "../../shared/schema-introspection.js";
import type {
	StageOptions,
	WorkflowDefinition,
	WorkflowInputSchema,
	WorkflowSerializableValue,
} from "../../shared/types.js";
import { type ValidationError, validateInputs } from "../shared/validate-inputs.js";
import type { ResolvedInputs } from "./executor-types.js";

export function resolveInputs(
	schema: Readonly<Record<string, WorkflowInputSchema>>,
	provided: Readonly<Record<string, unknown>>,
): ResolvedInputs {
	const resolved: Record<string, WorkflowSerializableValue> = {};
	for (const [key, value] of Object.entries(provided)) {
		if (value !== undefined) resolved[key] = value as WorkflowSerializableValue;
	}

	// `Value.Default` writes defaults straight into the value it is handed,
	// nested objects included, so it must never see caller-owned references —
	// a graph observer may have deep-frozen them. `Value.Clone` deep-copies
	// plain objects and arrays and returns anything else (Date, Map, class
	// instances, functions) by reference, so non-serializable inputs still
	// reach `validateInputs` unchanged and are still rejected there.
	const ownedInputs = Value.Clone(resolved);
	const withDefaults = Value.Default(
		Type.Object(schema as Record<string, TSchema>, { additionalProperties: true }),
		ownedInputs,
	) as Record<string, WorkflowSerializableValue>;
	for (const [key, value] of Object.entries(withDefaults)) {
		if (value !== undefined) resolved[key] = value;
	}

	for (const [key, schemaDef] of Object.entries(schema)) {
		if (schemaIsRequired(schemaDef) && resolved[key] === undefined) {
			throw new TypeError(`atomic-workflows: required input "${key}" not provided`);
		}
	}

	return resolved;
}

export function resolveInputConcurrency(
	schema: Readonly<Record<string, WorkflowInputSchema>>,
	resolvedInputs: ResolvedInputs,
): number | undefined {
	const concurrencySchema = schema.max_concurrency;
	if (concurrencySchema === undefined || schemaFieldKind(concurrencySchema) !== "number") {
		return undefined;
	}

	const value = resolvedInputs.max_concurrency;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return undefined;

	return Math.floor(value);
}

/**
 * Stage defaults a run derives from its inputs. A run bound to a workspace hands that binding to every stage instead
 * of setting up a worktree from its inputs.
 */
export function resolveInputRuntimeDefaults(
	def: Pick<WorkflowDefinition, "inputBindings">,
	resolvedInputs: ResolvedInputs,
	workspace?: BoundWorkspace,
): Partial<StageOptions> {
	if (workspace !== undefined) return { workspace };
	const defaults: Partial<StageOptions> = {};
	const worktree = def.inputBindings?.worktree;
	if (worktree !== undefined) {
		const gitWorktreeDir = resolvedInputs[worktree.gitWorktreeDir];
		if (typeof gitWorktreeDir === "string" && gitWorktreeDir.trim().length > 0) {
			defaults.gitWorktreeDir = gitWorktreeDir;
			const baseBranch = worktree.baseBranch === undefined ? undefined : resolvedInputs[worktree.baseBranch];
			if (typeof baseBranch === "string") defaults.baseBranch = baseBranch;
		}
	}
	return defaults;
}

function formatValidationErrors(errors: readonly ValidationError[]): string {
	return errors.map((error) => `  - ${error.key}: ${error.reason}`).join("\n");
}

export function resolveAndValidateInputs(
	schema: Readonly<Record<string, WorkflowInputSchema>>,
	provided: Readonly<Record<string, unknown>>,
	scope: string,
): ResolvedInputs {
	const resolved = resolveInputs(schema, provided);
	const errors = validateInputs(schema, resolved);
	if (errors.length > 0) {
		throw new TypeError(`atomic-workflows: invalid inputs for ${scope}:\n${formatValidationErrors(errors)}`);
	}
	return resolved;
}
