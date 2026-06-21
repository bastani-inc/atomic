import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { Static, TOptional, TSchema } from "typebox";
import type {
  WorkflowDefinition,
  WorkflowInputBindings,
  WorkflowInputSchemaMap,
  WorkflowInputValues,
  WorkflowOutputSchemaMap,
  WorkflowOutputValues,
  WorkflowRunContext,
  WorkflowRunFn,
  WorkflowSerializableValue,
  WorkflowWorktreeInputBinding,
} from "../shared/types.js";
import { normalizeWorkflowName } from "../workflows/identity.js";

const BRANDED_WORKFLOW_DEFINITIONS = new WeakSet<object>();

type SchemaKeys<TSchemas> = keyof TSchemas & string;
type Simplify<T> = { [K in keyof T]: T[K] } & {};
type UnionToIntersection<T> = (
  T extends T ? (value: T) => void : never
) extends (value: infer TIntersection) => void
  ? TIntersection
  : never;
type WorkflowInputShape<T> = T extends WorkflowInputValues ? T : never;

type DeclaredResolvedEntry<K extends string, S extends TSchema> = S extends TOptional<TSchema>
  ? { readonly [P in K]?: Static<S> & WorkflowSerializableValue }
  : { readonly [P in K]: Static<S> & WorkflowSerializableValue };

type DeclaredProvidedEntry<K extends string, S extends TSchema> =
  S extends TOptional<TSchema> | { readonly default: WorkflowSerializableValue }
    ? { readonly [P in K]?: Static<S> & WorkflowSerializableValue }
    : { readonly [P in K]: Static<S> & WorkflowSerializableValue };

type DeclaredOutputEntry<K extends string, S extends TSchema> = S extends TOptional<TSchema>
  ? { readonly [P in K]?: Static<S> & WorkflowSerializableValue }
  : { readonly [P in K]: Static<S> & WorkflowSerializableValue };

type WorkflowResolvedInputShapeFromSchemas<TSchemas extends WorkflowInputSchemaMap> = [SchemaKeys<TSchemas>] extends [never]
  ? {}
  : Simplify<UnionToIntersection<{
    readonly [K in SchemaKeys<TSchemas>]: DeclaredResolvedEntry<K, TSchemas[K]>;
  }[SchemaKeys<TSchemas>]>>;

type WorkflowProvidedInputShapeFromSchemas<TSchemas extends WorkflowInputSchemaMap> = [SchemaKeys<TSchemas>] extends [never]
  ? {}
  : Simplify<UnionToIntersection<{
    readonly [K in SchemaKeys<TSchemas>]: DeclaredProvidedEntry<K, TSchemas[K]>;
  }[SchemaKeys<TSchemas>]>>;

export type WorkflowInputsFromSchemas<TSchemas extends WorkflowInputSchemaMap> =
  WorkflowInputShape<WorkflowResolvedInputShapeFromSchemas<TSchemas>>;

export type WorkflowProvidedInputsFromSchemas<TSchemas extends WorkflowInputSchemaMap> =
  WorkflowInputShape<WorkflowProvidedInputShapeFromSchemas<TSchemas>>;

type WorkflowDeclaredOutputsFromSchemas<TSchemas extends WorkflowOutputSchemaMap> = [SchemaKeys<TSchemas>] extends [never]
  ? {}
  : Simplify<UnionToIntersection<{
    readonly [K in SchemaKeys<TSchemas>]: DeclaredOutputEntry<K, TSchemas[K]>;
  }[SchemaKeys<TSchemas>]>>;

export type WorkflowOutputsFromSchemas<TSchemas extends WorkflowOutputSchemaMap> =
  WorkflowDeclaredOutputsFromSchemas<TSchemas> & WorkflowOutputValues;

type NoExtraWorkflowOutputs<TDeclared, TActual extends TDeclared> = TActual &
  Record<Exclude<keyof TActual, keyof TDeclared>, never>;

type WorkflowRunOutputResult<
  TOutputs extends WorkflowOutputSchemaMap,
  TActualOutputs extends WorkflowDeclaredOutputsFromSchemas<TOutputs>,
> = NoExtraWorkflowOutputs<WorkflowDeclaredOutputsFromSchemas<TOutputs>, TActualOutputs>;

export interface AuthoredWorkflowSpec<
  TInputs extends WorkflowInputSchemaMap = {},
  TOutputs extends WorkflowOutputSchemaMap = WorkflowOutputSchemaMap,
  TActualOutputs extends WorkflowDeclaredOutputsFromSchemas<TOutputs> = WorkflowDeclaredOutputsFromSchemas<TOutputs>,
> {
  readonly name?: string;
  readonly description: string;
  readonly inputs?: TInputs;
  readonly outputs: TOutputs;
  readonly worktreeFromInputs?: WorkflowWorktreeInputBinding;
  readonly run: (
    ctx: WorkflowRunContext<WorkflowInputsFromSchemas<TInputs>, WorkflowOutputsFromSchemas<TOutputs>>,
  ) => Promise<WorkflowRunOutputResult<TOutputs, TActualOutputs>> | WorkflowRunOutputResult<TOutputs, TActualOutputs>;
}

export type AuthoredWorkflowDefinition<
  TInputs extends WorkflowInputSchemaMap,
  TOutputs extends WorkflowOutputSchemaMap,
> = WorkflowDefinition<WorkflowInputsFromSchemas<TInputs>, WorkflowOutputsFromSchemas<TOutputs>>;

// Package-internal runtime brand. It deliberately is not exported through the
// public SDK surface; workflow({...}) and executor-created direct workflows are
// the only package code paths that can mint accepted runtime definitions.
export function stampWorkflowDefinition<
  TInputs extends WorkflowInputValues,
  TOutputs extends WorkflowOutputValues,
>(
  definition: object,
): WorkflowDefinition<TInputs, TOutputs> {
  BRANDED_WORKFLOW_DEFINITIONS.add(definition);
  return definition as never as WorkflowDefinition<TInputs, TOutputs>;
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
  const match = line.match(/\(?((?:file:\/\/)?(?:\/|[A-Za-z]:[\\/])[^():]+?\.[cm]?[jt]sx?):\d+:\d+\)?/);
  const rawPath = match?.[1];
  if (rawPath === undefined) return undefined;
  return rawPath.startsWith("file://") ? fileURLToPath(rawPath) : rawPath;
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
    const base = basename(filePath).replace(/\.[cm]?[jt]sx?$/, "");
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
  TActualOutputs extends WorkflowDeclaredOutputsFromSchemas<TOutputs> = WorkflowDeclaredOutputsFromSchemas<TOutputs>,
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

  const branded = stampWorkflowDefinition<WorkflowInputsFromSchemas<TInputs>, WorkflowOutputsFromSchemas<TOutputs>>(definition);
  return Object.freeze(branded) as AuthoredWorkflowDefinition<TInputs, TOutputs>;
}
