/*
 * Type-only package authoring surface for standalone workflow packages.
 *
 * package.json points the root "types" condition here so authors can import
 * workflow without pulling the Atomic runtime/extension graph into their
 * TypeScript program. Runtime loading still uses src/index.ts. Import Type from
 * typebox directly.
 */

import type {} from "./authoring/typebox-defaults.js";
import type { Static, TOptional, TSchema } from "typebox";
export type { Static, TSchema } from "typebox";

export type {
  AgentSessionAdapter,
  CompleteAdapter,
  CompleteStageOpts,
  GitWorktreeSetupOptions,
  GitWorktreeSetupResult,
  PromptAdapter,
  PromptOptions,
  ResolvedInputs,
  RunResult,
  RunStatus,
  StageAdapters,
  StageStatus,
  StageOptions,
  StageContext,
  StageSnapshot,
  StageExecutionMeta,
  StageMcpOptions,
  StageOutputOptions,
  StagePromptOptions,
  StageSessionCreateOptions,
  StageSessionCreateResult,
  StageSessionRuntime,
  WorkflowAction,
  WorkflowArtifact,
  WorkflowChainOptions,
  WorkflowChainStep,
  WorkflowChildResult,
  WorkflowContextMode,
  WorkflowControlEvent,
  WorkflowCustomToolDefinition,
  WorkflowCustomUiComponent,
  WorkflowCustomUiFactory,
  WorkflowCustomUiKeybindings,
  WorkflowCustomUiOptions,
  WorkflowCustomUiOverlayHandle,
  WorkflowCustomUiOverlayOptions,
  WorkflowCustomUiTheme,
  WorkflowCustomUiTui,
  WorkflowDetails,
  WorkflowDetailsMode,
  WorkflowDetailsStatus,
  WorkflowDirectOptions,
  WorkflowDirectTaskItem,
  WorkflowExecutionMode,
  WorkflowExecutionPolicy,
  WorkflowExitOptions,
  WorkflowExitStatus,
  WorkflowInputBindings,
  WorkflowInputSchema,
  WorkflowInputSchemaMap,
  WorkflowInputValues,
  WorkflowIntercomSummary,
  WorkflowMaxOutput,
  WorkflowMcpPort,
  WorkflowModelAttempt,
  WorkflowModelCatalogPort,
  WorkflowModelFallbackFields,
  WorkflowModelInfo,
  WorkflowModelUsage,
  WorkflowModelValue,
  WorkflowOutputMode,
  WorkflowOutputSchema,
  WorkflowOutputSchemaMap,
  WorkflowOutputValues,
  WorkflowParallelChainStep,
  WorkflowParallelOptions,
  WorkflowPersistencePort,
  WorkflowProgressSummary,
  WorkflowRunChildArgs,
  WorkflowRunChildOptions,
  WorkflowRunChildOptionsArgument,
  WorkflowRunOutput,
  WorkflowRuntimeConfig,
  WorkflowSerializableObject,
  WorkflowSerializablePrimitive,
  WorkflowSerializableValue,
  WorkflowSharedTaskDefaults,
  WorkflowTaskContext,
  WorkflowTaskContextInput,
  WorkflowTaskOptions,
  WorkflowTaskResult,
  WorkflowTaskSessionFields,
  WorkflowTaskSessionOptions,
  WorkflowTaskStep,
  WorkflowThinkingLevel,
  WorkflowUIAdapter,
  WorkflowUIContext,
  WorkflowWorktreeInputBinding,
} from "./shared/authoring-contract.js";

import type * as AuthoringContract from "./shared/authoring-contract.js";

import type {
  GitWorktreeSetupOptions,
  GitWorktreeSetupResult,
  ResolvedInputs,
  RunResult,
  RunStatus,
  StageSnapshot,
  WorkflowDefinition as WorkflowContractDefinition,
  WorkflowDetails,
  WorkflowDirectOptions,
  WorkflowDirectTaskItem,
  WorkflowExecutionPolicy,
  WorkflowInputSchemaMap,
  WorkflowInputValues,
  WorkflowOutputSchemaMap,
  WorkflowOutputValues,
  WorkflowSerializableObject,
  WorkflowSerializableValue,
  WorkflowWorktreeInputBinding,
  WorkflowChainStep,
} from "./shared/authoring-contract.js";

// Type-only nominal brand for standalone package typings. Runtime discovery uses
// the package-internal WeakSet in authoring/workflow.ts rather than a symbol field.
declare const workflowDefinitionBrand: unique symbol;
type WorkflowDefinitionBrand = { readonly [workflowDefinitionBrand]: true };

export interface WorkflowDefinition<
  TInputs extends WorkflowInputValues = WorkflowInputValues,
  TOutputs extends WorkflowOutputValues = WorkflowOutputValues,
  TRunInputs extends WorkflowInputValues = TInputs,
  TDefinitionBrand extends object = WorkflowDefinitionBrand,
> extends WorkflowContractDefinition<TInputs, TOutputs, TRunInputs, TDefinitionBrand>, WorkflowDefinitionBrand {}

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

export type WorkflowRunContext<
  TInputs extends WorkflowInputValues = WorkflowInputValues,
  TOutputs extends WorkflowOutputValues = WorkflowOutputValues,
> = AuthoringContract.WorkflowRunContext<TInputs, WorkflowDefinitionBrand, TOutputs>;
export type WorkflowRunFn<
  TInputs extends WorkflowInputValues = WorkflowInputValues,
  TOutputs extends WorkflowOutputValues = WorkflowOutputValues,
> = AuthoringContract.WorkflowRunFn<TInputs, TOutputs, WorkflowDefinitionBrand>;

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

type WorkflowRunInputArgument<TInputs extends WorkflowInputValues> = [keyof TInputs] extends [never]
  ? Readonly<Record<string, never>>
  : TInputs;

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

export type AnyWorkflowDefinition = WorkflowDefinition<WorkflowInputValues, WorkflowOutputValues, WorkflowInputValues>;

export type RunContinuationOpts = AuthoringContract.RunContinuationOpts;
export type WorkflowParentRunLink = AuthoringContract.WorkflowParentRunLink;
export type RunOpts = Omit<AuthoringContract.RunOpts, "registry"> & { readonly registry?: WorkflowRegistry };

export declare const INTERACTIVE_WORKFLOW_POLICY: WorkflowExecutionPolicy;
export declare const NON_INTERACTIVE_WORKFLOW_POLICY: WorkflowExecutionPolicy;
export declare function run<TInputs extends WorkflowInputValues, TOutputs extends WorkflowOutputValues, TRunInputs extends WorkflowInputValues = TInputs>(
  definition: WorkflowDefinition<TInputs, TOutputs, TRunInputs>,
  inputs: Readonly<NoInfer<WorkflowRunInputArgument<TRunInputs>>>,
  opts?: RunOpts,
): Promise<RunResult<TOutputs>>;
export declare function runTask(task: WorkflowDirectTaskItem, runOptions?: RunOpts): Promise<WorkflowDetails>;
export declare function runTask(task: WorkflowDirectTaskItem, options?: WorkflowDirectOptions, runOptions?: RunOpts): Promise<WorkflowDetails>;
export declare function runParallel(tasks: readonly WorkflowDirectTaskItem[], options?: WorkflowDirectOptions, runOptions?: RunOpts): Promise<WorkflowDetails>;
export declare function runChain(steps: readonly WorkflowChainStep[], options?: WorkflowDirectOptions, runOptions?: RunOpts): Promise<WorkflowDetails>;
export declare function resolveInputs<TInputs extends WorkflowInputValues>(
  schema: Readonly<Record<keyof TInputs & string, TSchema>>,
  provided: Partial<TInputs>,
): ResolvedInputs<TInputs>;
export declare function setupGitWorktree(options: GitWorktreeSetupOptions): GitWorktreeSetupResult;

export interface WorkflowRegistry {
  register<
    TInputs extends WorkflowInputValues,
    TOutputs extends WorkflowOutputValues,
    TRunInputs extends WorkflowInputValues = TInputs,
  >(
    definition: WorkflowDefinition<TInputs, TOutputs, TRunInputs>,
  ): WorkflowRegistry;
  merge(other: WorkflowRegistry): WorkflowRegistry;
  get(name: string): AnyWorkflowDefinition | undefined;
  has(name: string): boolean;
  remove(name: string): WorkflowRegistry;
  names(): string[];
  all(): AnyWorkflowDefinition[];
}

/**
 * @deprecated Removed imperative workflow API. This runtime value only throws
 * a migration error; author workflows with workflow({...}).
 */
export declare const runWorkflow: never;
export declare function workflow<
  const TInputs extends WorkflowInputSchemaMap = {},
  const TOutputs extends WorkflowOutputSchemaMap = WorkflowOutputSchemaMap,
  TActualOutputs extends WorkflowDeclaredOutputsFromSchemas<TOutputs> = WorkflowDeclaredOutputsFromSchemas<TOutputs>,
>(
  spec: AuthoredWorkflowSpec<TInputs, TOutputs, TActualOutputs>,
): AuthoredWorkflowDefinition<TInputs, TOutputs>;
export declare function createRegistry<TDefinitions extends readonly AnyWorkflowDefinition[] = readonly AnyWorkflowDefinition[]>(
  initial?: TDefinitions,
): WorkflowRegistry;
export declare function normalizeWorkflowName(name: string): string;
export declare function workflowNamesEqual(a: string, b: string): boolean;

export declare class GraphFrontierTracker {
  onSpawn(stageId: string, stageName: string): string[];
  currentParents(): string[];
  replaceParents(stageId: string, parentIds: readonly string[]): void;
  onSettle(stageId: string): void;
  getNodes(): StageNode[];
  getParents(stageId: string): string[];
  reset(): void;
}
export interface StageNode extends WorkflowSerializableObject {
  readonly id: string;
  readonly name: string;
  readonly parentIds: readonly string[];
}
export type NoticeLevel = "info" | "warning" | "error";
export type PromptKind = "input" | "confirm" | "select" | "editor" | "custom";
export type CustomPromptIdentitySource = "caller" | "factory" | "callsite";

export interface PendingPrompt extends WorkflowSerializableObject {
  readonly id: string;
  readonly kind: PromptKind;
  readonly message: string;
  readonly choices?: readonly string[];
  readonly initial?: string;
  readonly customIdentityHash?: string;
  readonly customIdentitySource?: CustomPromptIdentitySource;
  readonly createdAt: number;
}

export interface ToolEvent {
  readonly name: string;
  readonly input?: Record<string, unknown>;
  readonly output?: string;
  readonly startedAt?: number;
  readonly endedAt?: number;
}

export interface WorkflowNotice extends WorkflowSerializableObject {
  readonly id: string;
  readonly runId?: string;
  readonly stageId?: string;
  readonly level: NoticeLevel;
  readonly message: string;
  readonly createdAt: number;
  readonly requiresAck?: boolean;
  readonly ackedAt?: number;
}

export interface WorkflowOverlayAdapter {
  show(notice: WorkflowNotice): void;
  hide(): void;
}

export interface RunSnapshot {
  readonly id: string;
  readonly name: string;
  readonly status: RunStatus;
  readonly stages: readonly StageSnapshot[];
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly durationMs?: number;
  readonly result?: WorkflowOutputValues;
  readonly error?: string;
  /** True when the run reached its terminal status through ctx.exit(). */
  readonly exited?: boolean;
  readonly exitReason?: string;
  readonly pendingPrompt?: PendingPrompt;
}

export interface StoreSnapshot {
  readonly runs: readonly RunSnapshot[];
  readonly notices: readonly WorkflowNotice[];
  readonly version: number;
}

export interface Store {
  runs(): readonly RunSnapshot[];
  notices(): readonly WorkflowNotice[];
  activeRunId(): string | null;
  recordRunStart(run: RunSnapshot): void;
  recordStageStart(runId: string, stage: StageSnapshot): void;
  recordToolStart(runId: string, stageId: string, evt: ToolEvent): void;
  recordToolEnd(runId: string, stageId: string, evt: ToolEvent): void;
  recordStageEnd(runId: string, stage: StageSnapshot): void;
  recordRunEnd(runId: string, status: RunStatus, result?: WorkflowOutputValues, error?: string): boolean;
  removeRun(runId: string): boolean;
  recordNotice(notice: WorkflowNotice): void;
  ackNotice(id: string): boolean;
}

export declare function createStore(): Store;
export declare const store: Store;

export interface ActiveRunEntry {
  readonly controller: AbortController;
  readonly children: readonly AbortController[];
}

export interface CancellationRegistry {
  register(runId: string, controller: AbortController): void;
  registerChild(runId: string, controller: AbortController): void;
  abort(runId: string, reason?: unknown): boolean;
  abortAll(reason?: unknown): number;
  unregister(runId: string): void;
  isAborted(runId: string): boolean;
}

export declare function createCancellationRegistry(): CancellationRegistry;
export declare const cancellationRegistry: CancellationRegistry;
