import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AuthoredWorkflowSpec as SharedAuthoredWorkflowSpec,
  WorkflowInputsFromSchemas,
  WorkflowOutputsFromSchemas,
  WorkflowProvidedInputsFromSchemas,
} from "../shared/workflow-authoring-types.js";
import type {
  WorkflowDefinition,
  WorkflowInputBindings,
  WorkflowInputSchemaMap,
  WorkflowInputValues,
  WorkflowOutputSchemaMap,
  WorkflowOutputValues,
  WorkflowRunContext,
  WorkflowRunFn,
  WorkflowWorktreeInputBinding,
} from "../shared/types.js";
import { normalizeWorkflowName } from "../workflows/identity.js";

export type {
  WorkflowInputsFromSchemas,
  WorkflowOutputsFromSchemas,
  WorkflowProvidedInputsFromSchemas,
} from "../shared/workflow-authoring-types.js";

const BRANDED_WORKFLOW_DEFINITIONS = new WeakSet<object>();

export type AuthoredWorkflowSpec<
  TInputs extends WorkflowInputSchemaMap = {},
  TOutputs extends WorkflowOutputSchemaMap = WorkflowOutputSchemaMap,
  TActualOutputs extends WorkflowOutputsFromSchemas<TOutputs> = WorkflowOutputsFromSchemas<TOutputs>,
> = SharedAuthoredWorkflowSpec<
  TInputs,
  TOutputs,
  TActualOutputs,
  WorkflowRunContext<WorkflowInputsFromSchemas<TInputs>, WorkflowOutputsFromSchemas<TOutputs>>
>;

export type AuthoredWorkflowDefinition<
  TInputs extends WorkflowInputSchemaMap,
  TOutputs extends WorkflowOutputSchemaMap,
> = WorkflowDefinition<
  WorkflowInputsFromSchemas<TInputs>,
  WorkflowOutputsFromSchemas<TOutputs>,
  WorkflowProvidedInputsFromSchemas<TInputs>
> & {
  readonly outputs: Readonly<TOutputs>;
};

// Package-internal runtime brand. It deliberately is not exported through the
// public SDK surface; workflow({...}) and executor-created direct workflows are
// the only package code paths that can mint accepted runtime definitions.
export function stampWorkflowDefinition<
  TInputs extends WorkflowInputValues,
  TOutputs extends WorkflowOutputValues,
  TRunInputs extends WorkflowInputValues = TInputs,
>(
  definition: object,
): WorkflowDefinition<TInputs, TOutputs, TRunInputs> {
  BRANDED_WORKFLOW_DEFINITIONS.add(definition);
  return definition as never as WorkflowDefinition<TInputs, TOutputs, TRunInputs>;
}

export function isBrandedWorkflowDefinition(value: object): value is WorkflowDefinition {
  return BRANDED_WORKFLOW_DEFINITIONS.has(value);
}

function requireNonEmptyString(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`workflow: ${label} must be a non-empty string`);
  }
}

function freezeSchemaMap<TSchemas extends WorkflowInputSchemaMap | WorkflowOutputSchemaMap>(
  schemas: TSchemas,
): Readonly<TSchemas> {
  return Object.freeze({ ...schemas }) as Readonly<TSchemas>;
}

function stackFilePath(line: string): string | undefined {
  const fileUrlMatch = line.match(/\(?((?:file:\/\/)[^\s)]+?\.[cm]?[jt]sx?):\d+:\d+\)?/);
  const rawPath = fileUrlMatch?.[1]
    ?? line.match(/\(?((?:\/|[A-Za-z]:[\\/])[^():]+?\.[cm]?[jt]sx?):\d+:\d+\)?/)?.[1];
  if (rawPath === undefined) return undefined;
  if (!rawPath.startsWith("file://")) return rawPath;
  try {
    return fileURLToPath(rawPath);
  } catch {
    return undefined;
  }
}

function isWorkflowAuthoringImplementationFrame(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  if (!/\/authoring\/workflow\.[cm]?[jt]sx?$/.test(normalized)) return false;
  return normalized.includes("/packages/workflows/")
    || normalized.includes("/node_modules/@bastani/workflows/")
    || normalized.includes("/dist/builtin/workflows/")
    || normalized.includes("/.atomic/agent/extensions/workflows/")
    || normalized.includes("/.pi/agent/extensions/workflows/");
}

function workflowNameFromCaller(): string | undefined {
  const stack = new Error().stack;
  if (stack === undefined) return undefined;

  for (const line of stack.split("\n")) {
    const filePath = stackFilePath(line);
    if (filePath === undefined) continue;
    if (isWorkflowAuthoringImplementationFrame(filePath)) continue;
    const base = basename(filePath.replace(/\\/g, "/")).replace(/\.[cm]?[jt]sx?$/, "");
    if (base.length > 0) return base;
  }

  return undefined;
}

function resolveWorkflowName(name: string | undefined): string {
  const resolved = name ?? workflowNameFromCaller();
  if (resolved === undefined) {
    throw new TypeError("workflow: name must be provided when caller filename cannot be inferred");
  }
  requireNonEmptyString(resolved, "name");
  return resolved;
}

function freezeInputBindings(
  binding: WorkflowWorktreeInputBinding | undefined,
): WorkflowInputBindings | undefined {
  if (binding === undefined) return undefined;
  return Object.freeze({
    worktree: Object.freeze({ ...binding }),
  });
}

export function workflow<
  const TInputs extends WorkflowInputSchemaMap = {},
  const TOutputs extends WorkflowOutputSchemaMap = WorkflowOutputSchemaMap,
  TActualOutputs extends WorkflowOutputsFromSchemas<TOutputs> = WorkflowOutputsFromSchemas<TOutputs>,
>(
  spec: AuthoredWorkflowSpec<TInputs, TOutputs, TActualOutputs>,
): AuthoredWorkflowDefinition<TInputs, TOutputs> {
  const specRun = spec.run;
  if (typeof spec.description !== "string") {
    throw new TypeError("workflow: description must be a string");
  }
  if (typeof specRun !== "function") {
    throw new TypeError("workflow: run must be a function");
  }
  if (spec.outputs === undefined || spec.outputs === null || typeof spec.outputs !== "object" || Array.isArray(spec.outputs)) {
    throw new TypeError("workflow: outputs must be a schema map");
  }
  if (spec.inputs !== undefined && (spec.inputs === null || typeof spec.inputs !== "object" || Array.isArray(spec.inputs))) {
    throw new TypeError("workflow: inputs must be a schema map");
  }

  const name = resolveWorkflowName(spec.name);
  const normalizedName = normalizeWorkflowName(name);
  requireNonEmptyString(normalizedName, "normalized name");
  const frozenInputs = freezeSchemaMap(spec.inputs ?? {} as TInputs);
  const frozenOutputs = freezeSchemaMap(spec.outputs);
  const inputBindings = freezeInputBindings(spec.worktreeFromInputs);
  const run: WorkflowRunFn<WorkflowInputsFromSchemas<TInputs>, WorkflowOutputsFromSchemas<TOutputs>> = async (ctx) => specRun(ctx);

  const definition = {
    __piWorkflow: true,
    name,
    normalizedName,
    description: spec.description,
    inputs: frozenInputs,
    outputs: frozenOutputs,
    ...(inputBindings !== undefined ? { inputBindings } : {}),
    run,
  };

  const branded = stampWorkflowDefinition<
    WorkflowInputsFromSchemas<TInputs>,
    WorkflowOutputsFromSchemas<TOutputs>,
    WorkflowProvidedInputsFromSchemas<TInputs>
  >(definition);
  return Object.freeze(branded) as AuthoredWorkflowDefinition<TInputs, TOutputs>;
}
