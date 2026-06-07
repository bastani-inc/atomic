/**
 * Dependency-light workflow authoring contract shared by the runtime type graph
 * and the standalone package typing surface.
 *
 * This module intentionally imports only TypeBox types. Do not import
 * @bastani/atomic, executor internals, stores, or runtime graph modules here.
 */

import type { Static, TOptional, TSchema } from "typebox";

export type { Static, TSchema };

export type WorkflowSerializablePrimitive = string | number | boolean | null;
export type WorkflowSerializableValue =
  | WorkflowSerializablePrimitive
  | readonly WorkflowSerializableValue[]
  | WorkflowSerializableObject;

export interface WorkflowSerializableObject {
  /**
   * Optional properties use `undefined` at the type level for ergonomic
   * intellisense, but workflow runtime validation rejects actual `undefined`
   * values in returned/input objects. Omit optional keys instead.
   */
  readonly [key: string]: WorkflowSerializableValue | undefined;
}

export type WorkflowInputValues = WorkflowSerializableObject;
export type WorkflowOutputValues = WorkflowSerializableObject;
export type WorkflowRunOutput = WorkflowOutputValues;
export type WorkflowInputSchemaMap = Readonly<Record<string, TSchema>>;
export type WorkflowOutputSchemaMap = Readonly<Record<string, TSchema>>;
export type WorkflowInputSchema = TSchema;
export type WorkflowOutputSchema = TSchema;

export type WorkflowOutputMode = "inline" | "file-only";
export type WorkflowContextMode = "fresh" | "fork";
export type WorkflowThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type WorkflowExecutionMode = "interactive" | "non_interactive";
export type RunStatus = "pending" | "running" | "paused" | "completed" | "failed" | "killed";
export type WorkflowDetailsMode = "named" | "single" | "parallel" | "chain" | "inspection" | "control";
export type WorkflowDetailsStatus = "accepted" | "running" | "completed" | "failed" | "killed" | "noop";
export type WorkflowAction = "list" | "get" | "inputs" | "run" | "status" | "interrupt" | "resume";

export interface WorkflowModelFallbackFields {
  /** Ordered model IDs to try after `model` fails; entries may use `:off|minimal|low|medium|high|xhigh` reasoning suffixes. */
  readonly fallbackModels?: readonly string[];
  /** Optional deprecated compatibility helper aligned to `fallbackModels`; ignored for entries with a reasoning suffix. */
  readonly fallbackThinkingLevels?: readonly string[];
}

export type WorkflowModelValue = string | object;

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
  readonly reasoningLevel?: WorkflowThinkingLevel;
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

export interface WorkflowAgentToolResult<TDetails = unknown> {
  readonly content: unknown;
  readonly details?: TDetails;
}

export interface WorkflowCustomToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown> {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
  readonly parameters: TParams;
  readonly renderShell?: "default" | "self";
  readonly prepareArguments?: (args: unknown) => Static<TParams>;
  readonly executionMode?: "sequential" | "parallel";
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: ((update: WorkflowAgentToolResult<TDetails>) => void) | undefined,
    ctx: object,
  ): Promise<WorkflowAgentToolResult<TDetails>>;
}

export interface WorkflowScopedModel {
  readonly model: WorkflowModelValue;
  /** @deprecated Prefer suffixing model/fallbackModels entries with `:level`; removal is deferred. */
  readonly thinkingLevel?: WorkflowThinkingLevel;
}

export interface WorkflowFastModeSettings extends WorkflowSerializableObject {
  readonly enabled?: boolean;
  readonly model?: string;
}

export interface WorkflowFastModeSettingsManager {
  getCodexFastModeSettings(): WorkflowFastModeSettings;
}

export interface StageOptions extends WorkflowModelFallbackFields {
  readonly model?: WorkflowModelValue;
  readonly mcp?: StageMcpOptions;
  readonly tools?: readonly string[];
  readonly noTools?: "all" | "builtin";
  readonly excludedTools?: readonly string[];
  readonly customTools?: readonly WorkflowCustomToolDefinition[];
  readonly cwd?: string;
  readonly agentDir?: string;
  readonly scopedModels?: readonly WorkflowScopedModel[];
  readonly sessionManager?: never;
  readonly settingsManager?: never;
  readonly context?: WorkflowContextMode;
  readonly forkFromSessionFile?: string;
  readonly gitWorktreeDir?: string;
  readonly baseBranch?: string;
  readonly sessionDir?: string;
  /** @deprecated Prefer suffixing model/fallbackModels entries with `:level`; removal is deferred. */
  readonly thinkingLevel?: WorkflowThinkingLevel;
}

export interface CompleteStageOpts extends WorkflowModelFallbackFields {
  readonly model?: WorkflowModelValue;
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

export type WorkflowInputSource = "interactive" | "rpc" | "extension";
export type WorkflowStreamingBehavior = "steer" | "followUp";

export type WorkflowImageContent = object;

export interface PromptOptions {
  readonly expandPromptTemplates?: boolean;
  readonly images?: readonly WorkflowImageContent[];
  readonly streamingBehavior?: WorkflowStreamingBehavior;
  readonly source?: WorkflowInputSource;
  readonly preflightResult?: (success: boolean) => void;
}

export type StagePromptOptions = PromptOptions & StageOutputOptions;

export interface WorkflowExecutionPolicy {
  readonly mode: WorkflowExecutionMode;
  readonly allowHumanInput: boolean;
  readonly awaitTerminalRun: boolean;
  readonly allowInputPicker: boolean;
}

export interface WorkflowMcpPort {
  setScope(stageId: string, allow: readonly string[] | null, deny: readonly string[] | null): void;
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
  subscribe(listener: (event: never) => void): () => void;
  readonly sessionFile: string | undefined;
  readonly sessionId: string;
  setModel(model: WorkflowSerializableValue): Promise<void>;
  setThinkingLevel(level: WorkflowThinkingLevel): void;
  cycleModel(): WorkflowSerializableValue;
  cycleThinkingLevel(): WorkflowThinkingLevel | undefined;
  readonly agent: WorkflowSerializableValue;
  readonly model: WorkflowSerializableValue;
  readonly thinkingLevel: WorkflowThinkingLevel | undefined;
  readonly messages: readonly WorkflowSerializableValue[];
  readonly isStreaming: boolean;
  readonly pendingMessageCount?: number;
  readonly settingsManager?: WorkflowFastModeSettingsManager;
  navigateTree(
    targetId: string,
    options?: { readonly summarize?: boolean; readonly customInstructions?: string; readonly replaceInstructions?: boolean; readonly label?: string },
  ): Promise<{ readonly editorText?: string; readonly cancelled: boolean }>;
  compact(): Promise<object>;
  abortCompaction(): void;
  abort(): Promise<void>;
  dispose(): void | Promise<void>;
  getLastAssistantText?: () => string | undefined;
}

export type StageSessionCreateOptions = StageOptions;

export interface StageSessionCreateResult {
  readonly session: StageSessionRuntime;
  readonly settingsManager?: WorkflowFastModeSettingsManager;
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
  subscribe(listener: (event: never) => void): () => void;
  readonly sessionFile: string | undefined;
  readonly sessionId: string;
  setModel(model: WorkflowModelValue): Promise<void>;
  setThinkingLevel(level: WorkflowThinkingLevel): void;
  cycleModel(): Promise<object | undefined>;
  cycleThinkingLevel(): WorkflowThinkingLevel | undefined;
  readonly agent: object;
  readonly model: WorkflowModelValue | undefined;
  readonly thinkingLevel: WorkflowThinkingLevel | undefined;
  readonly messages: readonly object[];
  readonly isStreaming: boolean;
  navigateTree(
    targetId: string,
    options?: { readonly summarize?: boolean; readonly customInstructions?: string; readonly replaceInstructions?: boolean; readonly label?: string },
  ): Promise<{ readonly editorText?: string; readonly cancelled: boolean }>;
  compact(): Promise<object>;
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

export interface WorkflowSharedTaskDefaults extends StageOptions, WorkflowTaskSessionFields {}

export interface WorkflowChainOptions extends WorkflowSharedTaskDefaults {
  readonly chainDir?: string;
}

export interface WorkflowParallelOptions extends WorkflowSharedTaskDefaults {
  readonly concurrency?: number;
  readonly failFast?: boolean;
}

export interface WorkflowDirectTaskItem extends WorkflowTaskOptions {
  readonly name: string;
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

export interface WorkflowDirectOptions extends StageOptions, WorkflowTaskSessionFields {
  readonly chainName?: string;
  readonly concurrency?: number;
  readonly failFast?: boolean;
  readonly chainDir?: string;
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

export interface WorkflowRunContext<
  TInputs extends WorkflowInputValues = WorkflowInputValues,
  TDefinitionBrand extends object = {},
> {
  readonly inputs: Readonly<TInputs>;
  readonly cwd?: string;
  stage(name: string, options?: StageOptions): StageContext;
  task(name: string, options: WorkflowTaskOptions): Promise<WorkflowTaskResult>;
  chain(steps: readonly WorkflowTaskStep[], options?: WorkflowChainOptions): Promise<WorkflowTaskResult[]>;
  parallel(steps: readonly WorkflowTaskStep[], options?: WorkflowParallelOptions): Promise<WorkflowTaskResult[]>;
  workflow<TChildInputs extends WorkflowInputValues, TChildOutputs extends WorkflowOutputValues>(
    definition: WorkflowDefinition<TChildInputs, TChildOutputs> & TDefinitionBrand,
    options?: WorkflowRunChildOptions<TChildInputs>,
  ): Promise<WorkflowChildResult<TChildOutputs>>;
  readonly ui: WorkflowUIContext;
}

export type WorkflowRunFn<
  TInputs extends WorkflowInputValues = WorkflowInputValues,
  TOutputs extends WorkflowOutputValues = WorkflowOutputValues,
  TDefinitionBrand extends object = {},
> = (ctx: WorkflowRunContext<TInputs, TDefinitionBrand>) => Promise<TOutputs> | TOutputs;

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

export interface WorkflowDefinition<
  TInputs extends WorkflowInputValues = WorkflowInputValues,
  TOutputs extends WorkflowOutputValues = WorkflowOutputValues,
  TRunInputs extends WorkflowInputValues = TInputs,
  TDefinitionBrand extends object = {},
> {
  readonly __piWorkflow: true;
  readonly __runInputs?: TRunInputs;
  readonly name: string;
  readonly normalizedName: string;
  readonly description: string;
  readonly inputs: WorkflowInputSchemaMap;
  readonly outputs?: WorkflowOutputSchemaMap;
  readonly inputBindings?: WorkflowInputBindings;
  run(ctx: WorkflowRunContext<TInputs, TDefinitionBrand>): Promise<TOutputs> | TOutputs;
}

type DeclaredResolvedEntry<K extends string, S extends TSchema> = S extends TOptional<TSchema>
  ? { readonly [P in K]?: Static<S> }
  : { readonly [P in K]: Static<S> };

type DeclaredProvidedEntry<K extends string, S extends TSchema> =
  S extends TOptional<TSchema> | { readonly default: WorkflowSerializableValue }
    ? { readonly [P in K]?: Static<S> }
    : { readonly [P in K]: Static<S> };

type Simplify<T> = { [K in keyof T]: T[K] } & {};
export type NoExtraOutputs<TDeclared extends WorkflowOutputValues, TActual extends TDeclared> = TActual &
  Record<Exclude<keyof TActual, keyof TDeclared>, never>;

export interface WorkflowBuilder<
  TInputs extends WorkflowInputValues = {},
  TOutputs extends WorkflowOutputValues = {},
  TRunInputs extends WorkflowInputValues = TInputs,
  TDefinitionBrand extends object = {},
  TCompiledDefinition extends WorkflowDefinition<TInputs, TOutputs, TRunInputs, TDefinitionBrand> = WorkflowDefinition<TInputs, TOutputs, TRunInputs, TDefinitionBrand>,
> {
  description(text: string): WorkflowBuilder<TInputs, TOutputs, TRunInputs, TDefinitionBrand, TCompiledDefinition>;
  input<K extends string, S extends TSchema>(
    key: K,
    schema: S,
  ): WorkflowBuilder<
    Simplify<TInputs & DeclaredResolvedEntry<K, S>>,
    TOutputs,
    Simplify<TRunInputs & DeclaredProvidedEntry<K, S>>,
    TDefinitionBrand,
    WorkflowDefinition<Simplify<TInputs & DeclaredResolvedEntry<K, S>>, TOutputs, Simplify<TRunInputs & DeclaredProvidedEntry<K, S>>, TDefinitionBrand> & TDefinitionBrand
  >;
  output<K extends string, S extends TSchema>(
    key: K,
    schema: S,
  ): WorkflowBuilder<
    TInputs,
    Simplify<TOutputs & (DeclaredResolvedEntry<K, S> & WorkflowOutputValues)>,
    TRunInputs,
    TDefinitionBrand,
    WorkflowDefinition<TInputs, Simplify<TOutputs & (DeclaredResolvedEntry<K, S> & WorkflowOutputValues)>, TRunInputs, TDefinitionBrand> & TDefinitionBrand
  >;
  worktreeFromInputs(binding: WorkflowWorktreeInputBinding): WorkflowBuilder<TInputs, TOutputs, TRunInputs, TDefinitionBrand, TCompiledDefinition>;
  run<TActualOutputs extends TOutputs>(
    fn: (ctx: WorkflowRunContext<TInputs, TDefinitionBrand>) => Promise<NoExtraOutputs<TOutputs, TActualOutputs>> | NoExtraOutputs<TOutputs, TActualOutputs>,
  ): CompletedWorkflowBuilder<TInputs, TOutputs, TRunInputs, TDefinitionBrand, TCompiledDefinition>;
}

export interface CompletedWorkflowBuilder<
  TInputs extends WorkflowInputValues = {},
  TOutputs extends WorkflowOutputValues = {},
  TRunInputs extends WorkflowInputValues = TInputs,
  TDefinitionBrand extends object = {},
  TCompiledDefinition extends WorkflowDefinition<TInputs, TOutputs, TRunInputs, TDefinitionBrand> = WorkflowDefinition<TInputs, TOutputs, TRunInputs, TDefinitionBrand>,
> extends WorkflowBuilder<TInputs, TOutputs, TRunInputs, TDefinitionBrand, TCompiledDefinition> {
  description(text: string): CompletedWorkflowBuilder<TInputs, TOutputs, TRunInputs, TDefinitionBrand, TCompiledDefinition>;
  input<K extends string, S extends TSchema>(
    key: K,
    schema: S,
  ): CompletedWorkflowBuilder<
    Simplify<TInputs & DeclaredResolvedEntry<K, S>>,
    TOutputs,
    Simplify<TRunInputs & DeclaredProvidedEntry<K, S>>,
    TDefinitionBrand,
    WorkflowDefinition<Simplify<TInputs & DeclaredResolvedEntry<K, S>>, TOutputs, Simplify<TRunInputs & DeclaredProvidedEntry<K, S>>, TDefinitionBrand> & TDefinitionBrand
  >;
  output<K extends string, S extends TSchema>(
    key: K,
    schema: S,
  ): CompletedWorkflowBuilder<
    TInputs,
    Simplify<TOutputs & (DeclaredResolvedEntry<K, S> & WorkflowOutputValues)>,
    TRunInputs,
    TDefinitionBrand,
    WorkflowDefinition<TInputs, Simplify<TOutputs & (DeclaredResolvedEntry<K, S> & WorkflowOutputValues)>, TRunInputs, TDefinitionBrand> & TDefinitionBrand
  >;
  worktreeFromInputs(binding: WorkflowWorktreeInputBinding): CompletedWorkflowBuilder<TInputs, TOutputs, TRunInputs, TDefinitionBrand, TCompiledDefinition>;
  compile(): TCompiledDefinition;
}

export interface WorkflowOverlayAdapter extends WorkflowSerializableObject {}
export interface RunSnapshot extends WorkflowSerializableObject {}
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
  readonly store?: object;
  readonly persistence?: WorkflowPersistencePort;
  readonly mcp?: WorkflowMcpPort;
  readonly cancellation?: CancellationRegistry;
  readonly overlay?: WorkflowOverlayAdapter;
  readonly signal?: AbortSignal;
  readonly deferWorkflowStart?: boolean;
  readonly config?: WorkflowRuntimeConfig;
  readonly models?: WorkflowModelCatalogPort;
  readonly registry?: object;
  readonly depth?: number;
  readonly stageControlRegistry?: object;
  readonly runId?: string;
  readonly continuation?: RunContinuationOpts;
  readonly parentRun?: WorkflowParentRunLink;
  readonly onRunStart?: (snapshot: RunSnapshot) => void;
  readonly onStageStart?: (runId: string, snapshot: StageSnapshot) => void;
  readonly onStageEnd?: (runId: string, snapshot: StageSnapshot) => void;
  readonly onRunEnd?: (runId: string, status: RunStatus, result?: WorkflowOutputValues, error?: string) => void;
}

export interface WorkflowProgressSummary extends WorkflowSerializableObject {
  readonly completed?: number;
  readonly total?: number;
}

export interface WorkflowControlEvent extends WorkflowSerializableObject {
  readonly type?: "notify" | "needs_attention" | "interrupted" | "resumed";
  readonly message?: string;
}

export interface WorkflowIntercomSummary extends WorkflowSerializableObject {
  readonly enabled?: boolean;
  readonly delivery?: "off" | "notify" | "result" | "control-and-result";
  readonly parentSession?: string;
}

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

export type StageStatus = RunStatus | "skipped" | "awaiting_input" | "blocked";

export interface StageSnapshot extends WorkflowSerializableObject {
  readonly id: string;
  readonly name: string;
  readonly status: StageStatus;
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
