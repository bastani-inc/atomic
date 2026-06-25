import type {} from "../authoring/typebox-defaults.js";
import type { Static, TOptional, TSchema } from "typebox";
import type {
  WorkflowInputSchemaMap,
  WorkflowInputValues,
  WorkflowOutputSchemaMap,
  WorkflowOutputValues,
  WorkflowSerializableValue,
  WorkflowWorktreeInputBinding,
} from "./authoring-contract.js";

type SchemaKeys<TSchemas> = keyof TSchemas & string;
type Simplify<T> = { [K in keyof T]: T[K] } & {};
type UnionToIntersection<T> = (
  T extends T ? (value: T) => void : never
) extends (value: infer TIntersection) => void
  ? TIntersection
  : never;
type WorkflowInputShape<T> = T extends WorkflowInputValues ? T : never;
type WorkflowOutputShape<T> = T extends WorkflowOutputValues ? T : never;

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
  WorkflowOutputShape<WorkflowDeclaredOutputsFromSchemas<TSchemas>>;

export type NoExtraWorkflowOutputs<TDeclared, TActual extends TDeclared> = TActual &
  Record<Exclude<keyof TActual, keyof TDeclared>, never>;

export type WorkflowRunOutputResult<
  TOutputs extends WorkflowOutputSchemaMap,
  TActualOutputs extends WorkflowOutputsFromSchemas<TOutputs>,
> = NoExtraWorkflowOutputs<WorkflowOutputsFromSchemas<TOutputs>, TActualOutputs>;

export interface AuthoredWorkflowSpec<
  TInputs extends WorkflowInputSchemaMap = {},
  TOutputs extends WorkflowOutputSchemaMap = WorkflowOutputSchemaMap,
  TActualOutputs extends WorkflowOutputsFromSchemas<TOutputs> = WorkflowOutputsFromSchemas<TOutputs>,
  TRunContext = unknown,
> {
  readonly name?: string;
  readonly description: string;
  readonly inputs?: TInputs;
  readonly outputs: TOutputs;
  readonly worktreeFromInputs?: WorkflowWorktreeInputBinding;
  readonly run: (
    ctx: TRunContext,
  ) => Promise<WorkflowRunOutputResult<TOutputs, TActualOutputs>> | WorkflowRunOutputResult<TOutputs, TActualOutputs>;
}
