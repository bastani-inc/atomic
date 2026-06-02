/*
 * Type-only package authoring surface for standalone workflow packages.
 *
 * package.json points the root "types" condition here so authors can import
 * defineWorkflow and Type without pulling the Atomic runtime/extension graph into
 * their TypeScript program. Runtime loading still uses src/index.ts.
 */

import type {
  Static,
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
  TOptional,
  TPartial,
  TPick,
  TRecord,
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
  Record<Key extends TSchema, Value extends TSchema, const O extends TObjectOptions>(key: Key, value: Value, options: O): PreserveOptions<TRecord<string, Value>, O>;
  Record<Key extends TSchema, Value extends TSchema>(key: Key, value: Value): TRecord<string, Value>;
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

export type WorkflowSerializablePrimitive = string | number | boolean | null;
export type WorkflowSerializableValue =
  | WorkflowSerializablePrimitive
  | readonly WorkflowSerializableValue[]
  | { readonly [key: string]: WorkflowSerializableValue | undefined };
export type WorkflowSerializableObject = { readonly [key: string]: WorkflowSerializableValue | undefined };
export type WorkflowInputValues = WorkflowSerializableObject;
export type WorkflowOutputValues = WorkflowSerializableObject;
export type WorkflowRunOutput = WorkflowOutputValues;
export type WorkflowInputSchemaMap = Readonly<Record<string, TSchema>>;
export type WorkflowOutputSchemaMap = Readonly<Record<string, TSchema>>;
export type WorkflowInputSchema = TSchema;
export type WorkflowOutputSchema = TSchema;

export type WorkflowOutputMode = "inline" | "file-only";
export type WorkflowContextMode = "fresh" | "fork";

export interface WorkflowModelFallbackFields {
  readonly fallbackModels?: readonly string[];
  readonly retryModels?: readonly string[];
}

export type WorkflowModelValue = string;

export interface WorkflowModelUsage extends WorkflowSerializableObject {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly cost?: number;
  readonly turns?: number;
}

export interface WorkflowModelAttempt extends WorkflowSerializableObject {
  readonly model: string;
  readonly success: boolean;
  readonly error?: string;
  readonly usage?: WorkflowModelUsage;
}

export interface WorkflowModelInfo {
  readonly provider: string;
  readonly id: string;
  readonly fullId: string;
  readonly model?: WorkflowModelValue;
}

export interface WorkflowModelCatalogPort {
  listModels(): Promise<readonly WorkflowModelInfo[]>;
  readonly currentModel?: WorkflowModelValue;
  readonly preferredProvider?: string;
  recordWarning?: (warning: string) => void;
}

export interface WorkflowMaxOutput {
  readonly bytes?: number;
  readonly lines?: number;
}

export interface StageMcpOptions {
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
}

export interface WorkflowCustomToolDefinition extends WorkflowSerializableObject {
  readonly name: string;
  readonly description?: string;
}

export interface StageOptions extends WorkflowModelFallbackFields {
  readonly model?: string;
  readonly mcp?: StageMcpOptions;
  readonly tools?: readonly string[];
  readonly noTools?: "all" | "builtin";
  readonly excludedTools?: readonly string[];
  readonly customTools?: readonly WorkflowCustomToolDefinition[];
  readonly cwd?: string;
  readonly context?: WorkflowContextMode;
  readonly forkFromSessionFile?: string;
  readonly gitWorktreeDir?: string;
  readonly baseBranch?: string;
  readonly sessionDir?: string;
  readonly output?: string | false;
  readonly outputMode?: WorkflowOutputMode;
  readonly reads?: readonly string[] | false;
  readonly maxOutput?: WorkflowMaxOutput;
  readonly artifacts?: boolean;
  readonly thinkingLevel?: string;
}

export interface CompleteStageOpts extends WorkflowModelFallbackFields {
  readonly model?: string;
  readonly maxTokens?: number;
}

export interface StageOutputOptions {
  readonly output?: string | false;
  readonly outputMode?: WorkflowOutputMode;
  readonly context?: WorkflowContextMode;
  readonly cwd?: string;
  readonly maxOutput?: WorkflowMaxOutput;
  readonly artifacts?: boolean;
  readonly sessionDir?: string;
}

export interface PromptOptions extends WorkflowModelFallbackFields {
  readonly model?: string;
  readonly maxTokens?: number;
}

export type StagePromptOptions = PromptOptions & StageOutputOptions;

export interface WorkflowExecutionPolicy {
  readonly mode: WorkflowExecutionMode;
  readonly allowHumanInput: boolean;
  readonly awaitTerminalRun: boolean;
  readonly allowInputPicker: boolean;
}

export interface WorkflowMcpPort {
  setScope(stageId: string, allow: string[] | null, deny: string[] | null): void;
  clearScope(stageId: string): void;
}

export interface WorkflowPersistencePort {
  appendEntry(type: string, payload: Record<string, unknown>): string | undefined;
  setLabel?(entryId: string, label: string): void;
  appendCustomMessageEntry?(content: string, meta?: Record<string, unknown>): string | undefined;
}

export interface StageSessionRuntime {
  prompt(text: string, options?: PromptOptions): Promise<string | void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  subscribe(listener: (event: WorkflowSerializableValue) => void): () => void;
  readonly sessionFile: string | undefined;
  readonly sessionId: string;
  setModel(model: WorkflowSerializableValue): Promise<void>;
  setThinkingLevel(level: string): void;
  cycleModel(): WorkflowSerializableValue;
  cycleThinkingLevel(): WorkflowSerializableValue;
  readonly agent: WorkflowSerializableValue;
  readonly model: WorkflowSerializableValue;
  readonly thinkingLevel: string | undefined;
  readonly messages: readonly WorkflowSerializableValue[];
  readonly isStreaming: boolean;
  readonly pendingMessageCount?: number;
  readonly settingsManager?: WorkflowSerializableObject;
  navigateTree: WorkflowSerializableValue;
  compact: WorkflowSerializableValue;
  abortCompaction(): void;
  abort(): Promise<void>;
  dispose(): void | Promise<void>;
  getLastAssistantText?: () => string | undefined;
}

export type StageSessionCreateOptions = StageOptions & WorkflowSerializableObject;

export interface StageSessionCreateResult {
  readonly session: StageSessionRuntime;
  readonly settingsManager?: WorkflowSerializableObject;
}

export interface StageExecutionMeta {
  readonly runId: string;
  readonly stageId: string;
  readonly stageName: string;
  readonly stageOptions?: StageOptions;
  readonly signal?: AbortSignal;
  readonly executionMode?: WorkflowExecutionMode;
}

export interface AgentSessionAdapter {
  create(options: StageSessionCreateOptions, meta?: StageExecutionMeta): Promise<StageSessionRuntime | StageSessionCreateResult>;
}

export interface PromptAdapter {
  prompt(text: string, meta?: StageExecutionMeta): Promise<string>;
}

export interface CompleteAdapter {
  complete(text: string, opts?: CompleteStageOpts, meta?: StageExecutionMeta): Promise<string>;
}

export interface StageAdapters {
  readonly agentSession?: AgentSessionAdapter;
  readonly prompt?: PromptAdapter;
  readonly complete?: CompleteAdapter;
}

export interface StageContext {
  readonly name: string;
  prompt(text: string, options?: StagePromptOptions): Promise<string>;
  complete(text: string, options?: CompleteStageOpts): Promise<string>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  subscribe(listener: (event: WorkflowSerializableValue) => void): () => void;
  readonly sessionFile: string | undefined;
  readonly sessionId: string;
  setModel(model: string): Promise<void>;
  setThinkingLevel(level: string): void;
  cycleModel(): Promise<WorkflowSerializableValue | undefined>;
  cycleThinkingLevel(): WorkflowSerializableValue;
  readonly agent: WorkflowSerializableValue;
  readonly model: WorkflowSerializableValue;
  readonly thinkingLevel: WorkflowSerializableValue;
  readonly messages: WorkflowSerializableValue;
  readonly isStreaming: boolean;
  navigateTree(
    targetId: string,
    options?: { readonly summarize?: boolean; readonly customInstructions?: string; readonly replaceInstructions?: boolean; readonly label?: string },
  ): Promise<{ readonly editorText?: string; readonly cancelled: boolean }>;
  compact(customInstructions?: string): Promise<WorkflowSerializableValue>;
  abortCompaction(): void;
  abort(): Promise<void>;
}

export interface WorkflowArtifact extends WorkflowSerializableObject {
  readonly kind: "output" | "session" | "diff" | "patch";
  readonly path: string;
  readonly taskName?: string;
  readonly branch?: string;
  readonly diffStat?: string;
  readonly filesChanged?: number;
  readonly insertions?: number;
  readonly deletions?: number;
}

export interface WorkflowTaskContext extends WorkflowSerializableObject {
  readonly name?: string;
  readonly text: string;
}

export type WorkflowTaskContextInput = string | WorkflowTaskContext | WorkflowTaskResult;

export interface WorkflowTaskResult extends WorkflowTaskContext {
  readonly stageName: string;
  readonly sessionId?: string;
  readonly sessionFile?: string;
  readonly artifacts?: readonly WorkflowArtifact[];
  readonly model?: string;
  readonly fastMode?: boolean;
  readonly attemptedModels?: readonly string[];
  readonly modelAttempts?: readonly WorkflowModelAttempt[];
  readonly warnings?: readonly string[];
}

export interface WorkflowTaskSessionFields {
  readonly prompt?: string;
  readonly task?: string;
  readonly output?: string | false;
  readonly outputMode?: WorkflowOutputMode;
  readonly reads?: readonly string[] | false;
  readonly worktree?: boolean;
  readonly gitWorktreeDir?: string;
  readonly baseBranch?: string;
  readonly maxOutput?: WorkflowMaxOutput;
  readonly artifacts?: boolean;
}

export interface WorkflowTaskOptions extends StageOptions, WorkflowTaskSessionFields {
  readonly previous?: WorkflowTaskContextInput | readonly WorkflowTaskContextInput[];
}

export interface WorkflowTaskStep extends WorkflowTaskOptions {
  readonly name: string;
}

export interface WorkflowSharedTaskDefaults extends StageOptions {
  readonly output?: string | false;
  readonly outputMode?: WorkflowOutputMode;
  readonly reads?: readonly string[] | false;
  readonly worktree?: boolean;
  readonly gitWorktreeDir?: string;
  readonly baseBranch?: string;
  readonly maxOutput?: WorkflowMaxOutput;
  readonly artifacts?: boolean;
}

export interface WorkflowChainOptions extends WorkflowSharedTaskDefaults {
  readonly task?: string;
  readonly chainDir?: string;
}

export interface WorkflowParallelOptions extends WorkflowSharedTaskDefaults {
  readonly task?: string;
  readonly concurrency?: number;
  readonly failFast?: boolean;
}

export interface WorkflowDirectTaskItem extends WorkflowTaskOptions {
  /** Task/stage label passed to direct task execution. */
  readonly name: string;
  /** Repeat count for direct parallel expansion. */
  readonly count?: number;
}

export interface WorkflowParallelChainStep {
  readonly parallel: readonly WorkflowDirectTaskItem[];
  readonly concurrency?: number;
  readonly failFast?: boolean;
  readonly worktree?: boolean;
  readonly gitWorktreeDir?: string;
  readonly baseBranch?: string;
}

export type WorkflowChainStep = WorkflowDirectTaskItem | WorkflowParallelChainStep;

export type WorkflowTaskSessionOptions = StageOptions & WorkflowTaskSessionFields;

export interface WorkflowDirectOptions extends StageOptions {
  /** Shared/root task used for `{task}` in direct parallel or chain steps. */
  readonly task?: string;
  /** Optional named chain identifier for status/artifact grouping. */
  readonly chainName?: string;
  readonly concurrency?: number;
  readonly failFast?: boolean;
  /** Chain-only shared artifact directory for relative reads, outputs, and worktree diffs. */
  readonly chainDir?: string;
  readonly reads?: readonly string[] | false;
  readonly output?: string | false;
  readonly outputMode?: WorkflowOutputMode;
  readonly worktree?: boolean;
  readonly gitWorktreeDir?: string;
  readonly baseBranch?: string;
  readonly maxOutput?: WorkflowMaxOutput;
  readonly artifacts?: boolean;
}

export interface WorkflowRunChildOptions<TInputs extends WorkflowInputValues = WorkflowInputValues> {
  readonly inputs?: TInputs;
  readonly stageName?: string;
}

export interface WorkflowChildResult<TOutputs extends WorkflowOutputValues = WorkflowOutputValues> extends WorkflowSerializableObject {
  readonly workflow: string;
  readonly runId: string;
  readonly status: "completed";
  readonly outputs: TOutputs;
}

export interface WorkflowUIContext {
  input(prompt: string): Promise<string>;
  confirm(message: string): Promise<boolean>;
  select<T extends string>(message: string, options: readonly T[]): Promise<T>;
  editor(initial?: string): Promise<string>;
}

export type WorkflowUIAdapter = WorkflowUIContext;

export interface WorkflowRunContext<TInputs extends WorkflowInputValues = WorkflowInputValues> {
  readonly inputs: Readonly<TInputs>;
  readonly cwd?: string;
  stage(name: string, options?: StageOptions): StageContext;
  task(name: string, options: WorkflowTaskOptions): Promise<WorkflowTaskResult>;
  chain(steps: readonly WorkflowTaskStep[], options?: WorkflowChainOptions): Promise<WorkflowTaskResult[]>;
  parallel(steps: readonly WorkflowTaskStep[], options?: WorkflowParallelOptions): Promise<WorkflowTaskResult[]>;
  workflow<TChildInputs extends WorkflowInputValues, TChildOutputs extends WorkflowOutputValues>(
    definition: WorkflowDefinition<TChildInputs, TChildOutputs>,
    options?: WorkflowRunChildOptions<TChildInputs>,
  ): Promise<WorkflowChildResult<TChildOutputs>>;
  readonly ui: WorkflowUIContext;
}

export type WorkflowRunFn<
  TInputs extends WorkflowInputValues = WorkflowInputValues,
  TOutputs extends WorkflowOutputValues = WorkflowOutputValues,
> = (ctx: WorkflowRunContext<TInputs>) => Promise<TOutputs> | TOutputs;

export interface WorkflowRuntimeConfig {
  readonly maxDepth: number;
  readonly defaultConcurrency: number;
  readonly persistRuns: boolean;
  readonly statusFile: boolean;
  readonly statusFilePath?: string;
  readonly resumeInFlight: "ask" | "auto" | "never";
}

export interface WorkflowWorktreeInputBinding {
  readonly gitWorktreeDir: string;
  readonly baseBranch?: string;
}

export interface WorkflowInputBindings {
  readonly worktree?: WorkflowWorktreeInputBinding;
}

// Type-only nominal brand for standalone package typings. Runtime discovery uses
// the package-internal WeakSet in define-workflow.ts rather than a symbol field.
declare const workflowDefinitionBrand: unique symbol;

export interface WorkflowDefinition<
  TInputs extends WorkflowInputValues = WorkflowInputValues,
  TOutputs extends WorkflowOutputValues = WorkflowOutputValues,
  TRunInputs extends WorkflowInputValues = TInputs,
> {
  readonly __piWorkflow: true;
  readonly [workflowDefinitionBrand]: true;
  readonly __runInputs?: TRunInputs;
  readonly name: string;
  readonly normalizedName: string;
  readonly description: string;
  readonly inputs: WorkflowInputSchemaMap;
  readonly outputs?: WorkflowOutputSchemaMap;
  readonly inputBindings?: WorkflowInputBindings;
  run(ctx: WorkflowRunContext<TInputs>): Promise<TOutputs> | TOutputs;
}

type DeclaredResolvedEntry<K extends string, S extends TSchema> = S extends TOptional<TSchema>
  ? { readonly [P in K]?: Static<S> }
  : { readonly [P in K]: Static<S> };

type DeclaredProvidedEntry<K extends string, S extends TSchema> =
  S extends TOptional<TSchema> | { readonly default: WorkflowSerializableValue }
    ? { readonly [P in K]?: Static<S> }
    : { readonly [P in K]: Static<S> };

type Simplify<T> = { [K in keyof T]: T[K] } & {};
type NoExtraOutputs<TDeclared extends WorkflowOutputValues, TActual extends TDeclared> = TActual &
  Record<Exclude<keyof TActual, keyof TDeclared>, never>;

export interface WorkflowBuilder<
  TInputs extends WorkflowInputValues = {},
  TOutputs extends WorkflowOutputValues = {},
  TRunInputs extends WorkflowInputValues = TInputs,
> {
  description(text: string): WorkflowBuilder<TInputs, TOutputs, TRunInputs>;
  input<K extends string, S extends TSchema>(
    key: K,
    schema: S,
  ): WorkflowBuilder<Simplify<TInputs & DeclaredResolvedEntry<K, S>>, TOutputs, Simplify<TRunInputs & DeclaredProvidedEntry<K, S>>>;
  output<K extends string, S extends TSchema>(
    key: K,
    schema: S,
  ): WorkflowBuilder<TInputs, Simplify<TOutputs & DeclaredResolvedEntry<K, S>>, TRunInputs>;
  worktreeFromInputs(binding: WorkflowWorktreeInputBinding): WorkflowBuilder<TInputs, TOutputs, TRunInputs>;
  run<TActualOutputs extends TOutputs>(
    fn: (ctx: WorkflowRunContext<TInputs>) => Promise<NoExtraOutputs<TOutputs, TActualOutputs>> | NoExtraOutputs<TOutputs, TActualOutputs>,
  ): CompletedWorkflowBuilder<TInputs, TOutputs, TRunInputs>;
}

export interface CompletedWorkflowBuilder<
  TInputs extends WorkflowInputValues = {},
  TOutputs extends WorkflowOutputValues = {},
  TRunInputs extends WorkflowInputValues = TInputs,
> extends WorkflowBuilder<TInputs, TOutputs, TRunInputs> {
  description(text: string): CompletedWorkflowBuilder<TInputs, TOutputs, TRunInputs>;
  input<K extends string, S extends TSchema>(
    key: K,
    schema: S,
  ): CompletedWorkflowBuilder<Simplify<TInputs & DeclaredResolvedEntry<K, S>>, TOutputs, Simplify<TRunInputs & DeclaredProvidedEntry<K, S>>>;
  output<K extends string, S extends TSchema>(
    key: K,
    schema: S,
  ): CompletedWorkflowBuilder<TInputs, Simplify<TOutputs & DeclaredResolvedEntry<K, S>>, TRunInputs>;
  worktreeFromInputs(binding: WorkflowWorktreeInputBinding): CompletedWorkflowBuilder<TInputs, TOutputs, TRunInputs>;
  compile(): WorkflowDefinition<TInputs, TOutputs, TRunInputs>;
}

export type AnyWorkflowDefinition = WorkflowDefinition<WorkflowInputValues, WorkflowOutputValues, WorkflowInputValues>;

export type RunStatus = "pending" | "running" | "paused" | "completed" | "failed" | "killed";
export type WorkflowExecutionMode = "interactive" | "non_interactive";
export type WorkflowDetailsMode = "named" | "single" | "parallel" | "chain" | "inspection" | "control";
export type WorkflowDetailsStatus = "accepted" | "running" | "completed" | "failed" | "killed" | "noop";
export type WorkflowAction = "list" | "get" | "inputs" | "run" | "status" | "interrupt" | "resume";

export interface RunContinuationOpts {
  readonly source: RunSnapshot;
  readonly resumeFromStageId: string;
}

export interface WorkflowParentRunLink {
  readonly runId: string;
  readonly stageId: string;
  readonly rootRunId: string;
}

export interface RunOpts {
  readonly adapters?: StageAdapters;
  readonly cwd?: string;
  readonly ui?: WorkflowUIAdapter;
  readonly executionMode?: WorkflowExecutionMode;
  readonly usePromptNodesForUi?: boolean;
  readonly confirmStageReadiness?: (request: {
    readonly runId: string;
    readonly stageId: string;
    readonly stageName: string;
    readonly signal: AbortSignal;
  }) => Promise<boolean>;
  readonly store?: WorkflowSerializableObject;
  readonly persistence?: WorkflowPersistencePort;
  readonly mcp?: WorkflowMcpPort;
  readonly cancellation?: CancellationRegistry;
  readonly overlay?: WorkflowOverlayAdapter;
  readonly signal?: AbortSignal;
  readonly deferWorkflowStart?: boolean;
  readonly config?: WorkflowRuntimeConfig;
  readonly models?: WorkflowModelCatalogPort;
  readonly registry?: WorkflowRegistry;
  readonly depth?: number;
  readonly stageControlRegistry?: WorkflowSerializableObject;
  readonly runId?: string;
  readonly continuation?: RunContinuationOpts;
  readonly parentRun?: WorkflowParentRunLink;
  readonly onRunStart?: (snapshot: RunSnapshot) => void;
  readonly onStageStart?: (runId: string, snapshot: StageSnapshot) => void;
  readonly onStageEnd?: (runId: string, snapshot: StageSnapshot) => void;
  readonly onRunEnd?: (runId: string, status: RunStatus, result?: WorkflowOutputValues, error?: string) => void;
}

export interface StageSnapshot extends WorkflowSerializableObject {
  readonly id: string;
  readonly name: string;
  readonly status: RunStatus;
  readonly result?: WorkflowSerializableValue;
  readonly error?: string;
}

export interface RunResult<TOutputs extends WorkflowOutputValues = WorkflowOutputValues> extends WorkflowSerializableObject {
  readonly runId: string;
  readonly status: RunStatus;
  readonly result?: TOutputs;
  readonly error?: string;
  readonly stages: readonly StageSnapshot[];
}

export type ResolvedInputs<TInputs extends WorkflowInputValues = WorkflowInputValues> = Readonly<TInputs> & WorkflowSerializableObject;

export interface GitWorktreeSetupOptions extends WorkflowSerializableObject {
  readonly gitWorktreeDir: string;
  readonly baseBranch?: string;
  readonly cwd: string;
}

export interface GitWorktreeSetupResult extends WorkflowSerializableObject {
  readonly worktreeRoot: string;
  readonly cwd: string;
  readonly repositoryRoot: string;
  readonly created: boolean;
}

export interface WorkflowProgressSummary extends WorkflowSerializableObject {}
export interface WorkflowControlEvent extends WorkflowSerializableObject {}
export interface WorkflowIntercomSummary extends WorkflowSerializableObject {}

export interface WorkflowDetails extends WorkflowSerializableObject {
  readonly mode: WorkflowDetailsMode;
  readonly action?: WorkflowAction;
  readonly runId?: string;
  readonly status: WorkflowDetailsStatus;
  readonly context?: WorkflowContextMode;
  readonly results?: readonly WorkflowTaskResult[];
  readonly output?: WorkflowOutputValues;
  readonly progress?: WorkflowProgressSummary;
  readonly artifacts?: readonly WorkflowArtifact[];
  readonly controlEvents?: readonly WorkflowControlEvent[];
  readonly intercom?: WorkflowIntercomSummary;
  readonly warnings?: readonly string[];
  readonly error?: string;
}

export declare const INTERACTIVE_WORKFLOW_POLICY: WorkflowExecutionPolicy;
export declare const NON_INTERACTIVE_WORKFLOW_POLICY: WorkflowExecutionPolicy;
export declare function run<TInputs extends WorkflowInputValues, TOutputs extends WorkflowOutputValues, TRunInputs extends WorkflowInputValues = TInputs>(
  definition: WorkflowDefinition<TInputs, TOutputs, TRunInputs>,
  inputs: Readonly<TRunInputs>,
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
  constructor(nodes?: readonly StageNode[]);
}
export interface StageNode extends WorkflowSerializableObject {
  readonly id: string;
  readonly name: string;
  readonly deps?: readonly string[];
}
export interface StoreSnapshot extends WorkflowSerializableObject {}
export interface WorkflowNotice extends WorkflowSerializableObject {}
export type NoticeLevel = "info" | "warning" | "error";
export interface WorkflowOverlayAdapter extends WorkflowSerializableObject {}
export type PromptKind = string;
export interface PendingPrompt extends WorkflowSerializableObject {}
export interface ToolEvent extends WorkflowSerializableObject {}
export type StageStatus = RunStatus;
export interface RunSnapshot extends WorkflowSerializableObject {}
export declare function createStore(): WorkflowSerializableObject;
export declare const store: WorkflowSerializableObject;
export interface CancellationRegistry extends WorkflowSerializableObject {}
export interface ActiveRunEntry extends WorkflowSerializableObject {}
export declare function createCancellationRegistry(): CancellationRegistry;
export declare const cancellationRegistry: CancellationRegistry;
