/*
 * Type-only package authoring surface for standalone workflow packages.
 *
 * package.json points the root "types" condition here so authors can import
 * defineWorkflow and Type without pulling the Atomic runtime/extension graph into
 * their TypeScript program. Runtime loading still uses src/index.ts.
 */

import type {
  TAny,
  TArray,
  TArrayOptions,
  TBigInt,
  TBoolean,
  TEnum,
  TEnumValue,
  TInteger,
  TIntersect,
  TIntersectOptions,
  TLiteral,
  TLiteralValue,
  TNever,
  TNull,
  TNumber,
  TNumberOptions,
  TOmit,
  TObject,
  TObjectOptions,
  TPartial,
  TPick,
  TRecordAction,
  TRequired,
  TSchema,
  TSchemaOptions,
  TString,
  TStringOptions,
  TTuple,
  TTupleOptions,
  TUndefined,
  TUnion,
  TUnknown,
  TVoid,
  Type as TypeboxType,
  TKeysToIndexer,
} from "typebox";

type PreserveOptions<T extends TSchema, O extends TSchemaOptions> = T & O;
type TypeScriptEnumLike = Record<string, string | number>;
type TypeScriptEnumValues<T extends TypeScriptEnumLike> = Extract<T[keyof T], TEnumValue>[];

export declare const Type: Omit<
  typeof TypeboxType,
  | "Any"
  | "Array"
  | "BigInt"
  | "Boolean"
  | "Enum"
  | "Integer"
  | "Intersect"
  | "Literal"
  | "Never"
  | "Null"
  | "Number"
  | "Omit"
  | "Partial"
  | "Pick"
  | "Object"
  | "Record"
  | "Required"
  | "String"
  | "Tuple"
  | "Undefined"
  | "Union"
  | "Unknown"
  | "Void"
> & {
  Any<const O extends TSchemaOptions>(options: O): PreserveOptions<TAny, O>;
  Any(): TAny;
  Array<Type extends TSchema, const O extends TArrayOptions>(items: Type, options: O): PreserveOptions<TArray<Type>, O>;
  Array<Type extends TSchema>(items: Type): TArray<Type>;
  BigInt<const O extends TSchemaOptions>(options: O): PreserveOptions<TBigInt, O>;
  BigInt(): TBigInt;
  Boolean<const O extends TSchemaOptions>(options: O): PreserveOptions<TBoolean, O>;
  Boolean(): TBoolean;
  Enum<Values extends TEnumValue[], const O extends TSchemaOptions>(values: readonly [...Values], options: O): PreserveOptions<TEnum<Values>, O>;
  Enum<Values extends TEnumValue[]>(values: readonly [...Values]): TEnum<Values>;
  Enum<Enum extends TypeScriptEnumLike, const O extends TSchemaOptions>(value: Enum, options: O): PreserveOptions<TEnum<TypeScriptEnumValues<Enum>>, O>;
  Enum<Enum extends TypeScriptEnumLike>(value: Enum): TEnum<TypeScriptEnumValues<Enum>>;
  Integer<const O extends TNumberOptions>(options: O): PreserveOptions<TInteger, O>;
  Integer(): TInteger;
  Intersect<Types extends TSchema[], const O extends TIntersectOptions>(types: [...Types], options: O): PreserveOptions<TIntersect<Types>, O>;
  Intersect<Types extends TSchema[]>(types: [...Types]): TIntersect<Types>;
  Literal<const Value extends TLiteralValue, const O extends TSchemaOptions>(value: Value, options: O): PreserveOptions<TLiteral<Value>, O>;
  Literal<const Value extends TLiteralValue>(value: Value): TLiteral<Value>;
  Never<const O extends TSchemaOptions>(options: O): PreserveOptions<TNever, O>;
  Never(): TNever;
  Null<const O extends TSchemaOptions>(options: O): PreserveOptions<TNull, O>;
  Null(): TNull;
  Number<const O extends TNumberOptions>(options: O): PreserveOptions<TNumber, O>;
  Number(): TNumber;
  Omit<Type extends TSchema, Indexer extends PropertyKey[], const O extends TSchemaOptions>(type: Type, indexer: readonly [...Indexer], options: O): PreserveOptions<TOmit<Type, TKeysToIndexer<Indexer>>, O>;
  Omit<Type extends TSchema, Indexer extends PropertyKey[]>(type: Type, indexer: readonly [...Indexer]): TOmit<Type, TKeysToIndexer<Indexer>>;
  Omit<Type extends TSchema, Indexer extends TSchema, const O extends TSchemaOptions>(type: Type, indexer: Indexer, options: O): PreserveOptions<TOmit<Type, Indexer>, O>;
  Omit<Type extends TSchema, Indexer extends TSchema>(type: Type, indexer: Indexer): TOmit<Type, Indexer>;
  Partial<Type extends TSchema, const O extends TSchemaOptions>(type: Type, options: O): PreserveOptions<TPartial<Type>, O>;
  Partial<Type extends TSchema>(type: Type): TPartial<Type>;
  Pick<Type extends TSchema, Indexer extends PropertyKey[], const O extends TSchemaOptions>(type: Type, indexer: readonly [...Indexer], options: O): PreserveOptions<TPick<Type, TKeysToIndexer<Indexer>>, O>;
  Pick<Type extends TSchema, Indexer extends PropertyKey[]>(type: Type, indexer: readonly [...Indexer]): TPick<Type, TKeysToIndexer<Indexer>>;
  Pick<Type extends TSchema, Indexer extends TSchema, const O extends TSchemaOptions>(type: Type, indexer: Indexer, options: O): PreserveOptions<TPick<Type, Indexer>, O>;
  Pick<Type extends TSchema, Indexer extends TSchema>(type: Type, indexer: Indexer): TPick<Type, Indexer>;
  Object<Properties extends Record<PropertyKey, TSchema>, const O extends TObjectOptions>(properties: Properties, options: O): PreserveOptions<TObject<Properties>, O>;
  Object<Properties extends Record<PropertyKey, TSchema>>(properties: Properties): TObject<Properties>;
  Record<Key extends TSchema, Value extends TSchema, const O extends TObjectOptions>(key: Key, value: Value, options: O): PreserveOptions<TRecordAction<Key, Value>, O>;
  Record<Key extends TSchema, Value extends TSchema>(key: Key, value: Value): TRecordAction<Key, Value>;
  Required<Type extends TSchema, const O extends TSchemaOptions>(type: Type, options: O): PreserveOptions<TRequired<Type>, O>;
  Required<Type extends TSchema>(type: Type): TRequired<Type>;
  String<const O extends TStringOptions>(options: O): PreserveOptions<TString, O>;
  String(): TString;
  Tuple<Types extends TSchema[], const O extends TTupleOptions>(types: [...Types], options: O): PreserveOptions<TTuple<Types>, O>;
  Tuple<Types extends TSchema[]>(types: [...Types]): TTuple<Types>;
  Undefined<const O extends TSchemaOptions>(options: O): PreserveOptions<TUndefined, O>;
  Undefined(): TUndefined;
  Union<Types extends TSchema[], const O extends TSchemaOptions>(anyOf: [...Types], options: O): PreserveOptions<TUnion<Types>, O>;
  Union<Types extends TSchema[]>(anyOf: [...Types]): TUnion<Types>;
  Unknown<const O extends TSchemaOptions>(options: O): PreserveOptions<TUnknown, O>;
  Unknown(): TUnknown;
  Void<const O extends TSchemaOptions>(options: O): PreserveOptions<TVoid, O>;
  Void(): TVoid;
};
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
  WorkflowRunChildOptions,
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
  WorkflowInputValues,
  WorkflowOutputValues,
  WorkflowSerializableObject,
  WorkflowChainStep,
} from "./shared/authoring-contract.js";

// Type-only nominal brand for standalone package typings. Runtime discovery uses
// the package-internal WeakSet in define-workflow.ts rather than a symbol field.
declare const workflowDefinitionBrand: unique symbol;
type WorkflowDefinitionBrand = { readonly [workflowDefinitionBrand]: true };

export interface WorkflowDefinition<
  TInputs extends WorkflowInputValues = WorkflowInputValues,
  TOutputs extends WorkflowOutputValues = WorkflowOutputValues,
  TRunInputs extends WorkflowInputValues = TInputs,
  TDefinitionBrand extends object = WorkflowDefinitionBrand,
> extends WorkflowContractDefinition<TInputs, TOutputs, TRunInputs, TDefinitionBrand>, WorkflowDefinitionBrand {}

export type WorkflowRunContext<
  TInputs extends WorkflowInputValues = WorkflowInputValues,
  TOutputs extends WorkflowOutputValues = WorkflowOutputValues,
> = AuthoringContract.WorkflowRunContext<TInputs, WorkflowDefinitionBrand, TOutputs>;
export type WorkflowRunFn<
  TInputs extends WorkflowInputValues = WorkflowInputValues,
  TOutputs extends WorkflowOutputValues = WorkflowOutputValues,
> = AuthoringContract.WorkflowRunFn<TInputs, TOutputs, WorkflowDefinitionBrand>;

export type AnyWorkflowDefinition = WorkflowDefinition<WorkflowInputValues, WorkflowOutputValues, WorkflowInputValues>;

export type WorkflowBuilder<
  TInputs extends WorkflowInputValues = {},
  TOutputs extends WorkflowOutputValues = {},
  TRunInputs extends WorkflowInputValues = TInputs,
> = AuthoringContract.WorkflowBuilder<TInputs, TOutputs, TRunInputs, WorkflowDefinitionBrand, WorkflowDefinition<TInputs, TOutputs, TRunInputs>>;

export type CompletedWorkflowBuilder<
  TInputs extends WorkflowInputValues = {},
  TOutputs extends WorkflowOutputValues = {},
  TRunInputs extends WorkflowInputValues = TInputs,
> = AuthoringContract.CompletedWorkflowBuilder<TInputs, TOutputs, TRunInputs, WorkflowDefinitionBrand, WorkflowDefinition<TInputs, TOutputs, TRunInputs>>;

export type RunContinuationOpts = AuthoringContract.RunContinuationOpts;
export type WorkflowParentRunLink = AuthoringContract.WorkflowParentRunLink;
export type RunOpts = Omit<AuthoringContract.RunOpts, "registry"> & { readonly registry?: WorkflowRegistry };

export declare const INTERACTIVE_WORKFLOW_POLICY: WorkflowExecutionPolicy;
export declare const NON_INTERACTIVE_WORKFLOW_POLICY: WorkflowExecutionPolicy;
export declare function run<TInputs extends WorkflowInputValues, TOutputs extends WorkflowOutputValues, TRunInputs extends WorkflowInputValues = TInputs>(
  definition: WorkflowDefinition<TInputs, TOutputs, TRunInputs>,
  inputs: Readonly<NoInfer<TRunInputs>>,
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
  register<TInputs extends WorkflowInputValues, TOutputs extends WorkflowOutputValues>(
    definition: WorkflowDefinition<TInputs, TOutputs>,
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
 * a migration error; author workflows with defineWorkflow(...).compile().
 */
export declare const runWorkflow: never;
export declare function defineWorkflow(name: string): WorkflowBuilder;
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
