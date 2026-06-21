import { Value } from "typebox/value";
import type {
  WorkflowDefinition,
  WorkflowOutputSchema,
  WorkflowOutputValues,
  WorkflowSerializableValue,
} from "../../shared/types.js";
import { schemaChoices, schemaFieldKind, schemaIsRequired } from "../../shared/schema-introspection.js";
import {
  assertWorkflowSerializableObject,
  WORKFLOW_SERIALIZABLE_DESCRIPTION,
  workflowSerializableTypeName,
  workflowSerializableValidationError,
} from "../../shared/serializable.js";
import type { WorkflowExitOutputSnapshot } from "./executor-abort.js";
import {
  isWorkflowExitSnapshotInvalidValue,
  workflowExitSnapshotInvalidValueMessage,
} from "./executor-abort.js";

function hasOwnWorkflowOutput(record: WorkflowOutputValues | Readonly<Record<string, WorkflowOutputSchema>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function assertWorkflowOutputsExplicit(
  scope: string,
  sourceOutput: WorkflowOutputValues,
  declarations: Readonly<Record<string, WorkflowOutputSchema>>,
  missingOutputSuffix = "",
): void {
  for (const key of Object.keys(sourceOutput)) {
    if (!hasOwnWorkflowOutput(declarations, key)) {
      throw new Error(
        `atomic-workflows: ${scope} returned undeclared output "${key}"; declare it in outputs: { "${key}": Type.... } or remove it from the .run() return`,
      );
    }
  }
  for (const [key, schema] of Object.entries(declarations)) {
    if (!(key in sourceOutput)) {
      if (schemaIsRequired(schema)) {
        throw new Error(`atomic-workflows: ${scope} missing output "${key}"${missingOutputSuffix}`);
      }
      continue;
    }
    const value = sourceOutput[key];
    const kind = schemaFieldKind(schema);
    if (!Value.Check(schema, value)) {
      const choices = schemaChoices(schema);
      if (kind === "select" && choices !== undefined && typeof value === "string") {
        throw new Error(
          `atomic-workflows: ${scope} output "${key}" must be one of [${choices.join(", ")}], got ${JSON.stringify(value)}`,
        );
      }
      throw new Error(
        `atomic-workflows: ${scope} output "${key}" expected ${kind}, got ${workflowSerializableTypeName(value)}`,
      );
    }
    const serializableError = workflowSerializableValidationError(value, `${scope} output "${key}"`);
    if (serializableError !== undefined) throw new Error(`atomic-workflows: ${serializableError}`);
  }
}

function normalizeWorkflowOutputObject(
  workflowName: string,
  rawOutput: unknown,
  label: string,
): WorkflowOutputValues | undefined {
  if (rawOutput === undefined) return undefined;
  const normalized = rawOutput !== null && typeof rawOutput === "object" && !Array.isArray(rawOutput)
    ? Object.fromEntries(Object.entries(rawOutput as Record<string, unknown>).filter(([, v]) => v !== undefined))
    : rawOutput;
  assertWorkflowSerializableObject(normalized, `workflow "${workflowName}" ${label}`);
  return normalized;
}

export function normalizeWorkflowRunOutput(
  workflowName: string,
  rawOutput: unknown,
): WorkflowOutputValues | undefined {
  return normalizeWorkflowOutputObject(workflowName, rawOutput, ".run() return");
}

export function normalizeWorkflowExitOutput(
  workflowName: string,
  snapshot: WorkflowExitOutputSnapshot | undefined,
): WorkflowOutputValues | undefined {
  if (snapshot === undefined) return undefined;
  if (!snapshot.ok) throw snapshot.error;
  if (isWorkflowExitSnapshotInvalidValue(snapshot.value)) {
    const invalidMessage = workflowExitSnapshotInvalidValueMessage(
      `workflow "${workflowName}" ctx.exit() outputs`,
      snapshot.value,
    );
    throw new Error(`atomic-workflows: ${invalidMessage ?? `workflow "${workflowName}" ctx.exit() outputs must be ${WORKFLOW_SERIALIZABLE_DESCRIPTION}, got object`}`);
  }
  return normalizeWorkflowOutputObject(workflowName, snapshot.value, "ctx.exit() outputs");
}

export function assertWorkflowRunOutputs(
  workflowName: string,
  result: WorkflowOutputValues | undefined,
  declaredOutputs: Readonly<Record<string, WorkflowOutputSchema>> | undefined,
): void {
  assertWorkflowOutputsExplicit(
    `workflow "${workflowName}"`,
    result ?? {},
    declaredOutputs ?? {},
  );
}

export function assertWorkflowExitOutputs(
  workflowName: string,
  result: WorkflowOutputValues | undefined,
  declaredOutputs: Readonly<Record<string, WorkflowOutputSchema>> | undefined,
): void {
  const declarations = declaredOutputs ?? {};
  const sourceOutput = result ?? {};
  const scope = `workflow "${workflowName}" ctx.exit()`;
  for (const key of Object.keys(sourceOutput)) {
    if (!hasOwnWorkflowOutput(declarations, key)) {
      throw new Error(
        `atomic-workflows: ${scope} provided undeclared output "${key}"; declare it in outputs: { "${key}": Type.... } or remove it from ctx.exit({ outputs })`,
      );
    }
  }
  for (const [key, schema] of Object.entries(declarations)) {
    if (!(key in sourceOutput)) continue;
    const value = sourceOutput[key];
    const invalidSnapshotValue = workflowExitSnapshotInvalidValueMessage(`${scope} output "${key}"`, value);
    if (invalidSnapshotValue !== undefined) throw new Error(`atomic-workflows: ${invalidSnapshotValue}`);
    const kind = schemaFieldKind(schema);
    if (!Value.Check(schema, value)) {
      const choices = schemaChoices(schema);
      if (kind === "select" && choices !== undefined && typeof value === "string") {
        throw new Error(
          `atomic-workflows: ${scope} output "${key}" must be one of [${choices.join(", ")}], got ${JSON.stringify(value)}`,
        );
      }
      throw new Error(
        `atomic-workflows: ${scope} output "${key}" expected ${kind}, got ${workflowSerializableTypeName(value)}`,
      );
    }
    const serializableError = workflowSerializableValidationError(value, `${scope} output "${key}"`);
    if (serializableError !== undefined) throw new Error(`atomic-workflows: ${serializableError}`);
  }
}

export function selectWorkflowOutputs(
  child: WorkflowDefinition,
  rawOutput: WorkflowOutputValues | undefined,
): WorkflowOutputValues {
  const declarations = child.outputs ?? {};
  const sourceOutput = rawOutput ?? {};
  const selected: Record<string, WorkflowSerializableValue> = {};
  for (const key of Object.keys(declarations)) {
    const value = sourceOutput[key];
    if (value !== undefined) selected[key] = value;
  }
  return selected;
}
