/** Workflow authoring UI, builder, run, and result contract types. */

import type { KeybindingsManager, Theme } from "@bastani/atomic";
import type { Component, OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import type {
  RunStatus,
  StageAdapters,
  StageContext,
  StageOptions,
  WorkflowAction,
  WorkflowArtifact,
  WorkflowChainOptions,
  WorkflowContextMode,
  WorkflowDetailsMode,
  WorkflowChildResult,
  WorkflowDetailsStatus,
  WorkflowExecutionMode,
  WorkflowExitOptions,
  WorkflowInputSchemaMap,
  WorkflowInputValues,
  WorkflowMcpPort,
  WorkflowModelCatalogPort,
  WorkflowOutputSchemaMap,
  WorkflowOutputValues,
  WorkflowParallelOptions,
  WorkflowPersistencePort,
  WorkflowRunChildArgs,
  WorkflowSerializableObject,
  WorkflowSerializableValue,
  WorkflowTaskOptions,
  WorkflowTaskResult,
  WorkflowTaskStep,
} from "./authoring-contract-stage.js";

export type WorkflowCustomUiComponent = Component & { dispose?(): void };
export type WorkflowCustomUiTui = TUI;
export type WorkflowCustomUiTheme = Theme;
export type WorkflowCustomUiKeybindings = KeybindingsManager;
export type WorkflowCustomUiOverlayOptions = OverlayOptions;
export type WorkflowCustomUiOverlayHandle = OverlayHandle;

export type WorkflowCustomUiFactory<T> = (
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (value: T) => void,
) => WorkflowCustomUiComponent | Promise<WorkflowCustomUiComponent>;

export interface WorkflowCustomUiOptions {
  /** Render as a nested overlay. Workflow graph hosts may reject this when unsupported. */
  readonly overlay?: boolean;
  /** AbortSignal to programmatically dismiss the custom UI. */
  readonly signal?: AbortSignal;
  /** Overlay positioning/sizing options. Can be static or a function for dynamic updates. */
  readonly overlayOptions?: OverlayOptions | (() => OverlayOptions);
  /** Called with the real overlay handle after an overlay is shown. */
  readonly onHandle?: (handle: OverlayHandle) => void;
  /**
   * Workflow-only replay identity. Recommended whenever widget state or
   * semantics can change without the callsite changing. Do not include secrets;
   * the runtime stores only a hash.
   */
  readonly replayIdentity?: string;
  /** Safe display-only label for graph/status surfaces. Defaults to "Custom TUI prompt". Not part of replay identity. */
  readonly label?: string;
}

export interface WorkflowUIContext {
  input(prompt: string): Promise<string>;
  confirm(message: string): Promise<boolean>;
  select<T extends string>(message: string, options: readonly T[]): Promise<T>;
  editor(initial?: string): Promise<string>;
  custom<T>(factory: WorkflowCustomUiFactory<T>, options?: WorkflowCustomUiOptions): Promise<T>;
}

export interface WorkflowUIAdapter {
  input(prompt: string): Promise<string>;
  confirm(message: string): Promise<boolean>;
  select<T extends string>(message: string, options: readonly T[]): Promise<T>;
  editor(initial?: string): Promise<string>;
  custom?<T>(factory: WorkflowCustomUiFactory<T>, options?: WorkflowCustomUiOptions): Promise<T>;
}

export interface WorkflowRunContext<
  TInputs extends WorkflowInputValues = WorkflowInputValues,
  TDefinitionBrand extends object = {},
  TOutputs extends WorkflowOutputValues = WorkflowOutputValues,
> {
  readonly inputs: Readonly<TInputs>;
  readonly cwd?: string;
  exit(options?: WorkflowExitOptions<TOutputs>): never;
  stage<TSchemaDef extends TSchema>(name: string, options: StageOptions<TSchemaDef> & { readonly schema: TSchemaDef }): StageContext<TSchemaDef>;
  stage(name: string, options?: StageOptions): StageContext;
  task(name: string, options: WorkflowTaskOptions): Promise<WorkflowTaskResult>;
  chain(steps: readonly WorkflowTaskStep[], options?: WorkflowChainOptions): Promise<WorkflowTaskResult[]>;
  parallel(steps: readonly WorkflowTaskStep[], options?: WorkflowParallelOptions): Promise<WorkflowTaskResult[]>;
  workflow<
    TChildInputs extends WorkflowInputValues,
    TChildOutputs extends WorkflowOutputValues,
    TChildRunInputs extends WorkflowInputValues = TChildInputs,
  >(
    definition: WorkflowDefinition<TChildInputs, TChildOutputs, TChildRunInputs> & TDefinitionBrand,
    ...args: WorkflowRunChildArgs<TChildRunInputs>
  ): Promise<WorkflowChildResult<TChildOutputs>>;
  readonly ui: WorkflowUIContext;
  /**
   * Durable cached tool execution. Runs arbitrary TypeScript code and caches
   * the result durably so completed side effects are not repeated on resume.
   * Only `ctx.*` blocks (tool, ui, stage, task, chain, parallel, workflow)
   * produce durable checkpoints.
   *
   * cross-ref: issue #1498 — DBOS-backed cross-session resumability.
   */
  tool: WorkflowToolPrimitive;
}

/**
 * `ctx.tool` primitive signature. Runs an async function and caches the result.
 */
export interface WorkflowToolPrimitive {
  <TValue extends WorkflowSerializableValue>(
    name: string,
    args: Readonly<Record<string, WorkflowSerializableValue>>,
    fn: () => Promise<TValue>,
    options?: WorkflowToolOptions,
  ): Promise<TValue>;
}

/** Options for `ctx.tool`. */
export interface WorkflowToolOptions {
  readonly retriesAllowed?: boolean;
  readonly maxAttempts?: number;
  readonly intervalMs?: number;
  readonly backoffRate?: number;
}

export type WorkflowRunFn<
  TInputs extends WorkflowInputValues = WorkflowInputValues,
  TOutputs extends WorkflowOutputValues = WorkflowOutputValues,
  TDefinitionBrand extends object = {},
> = (ctx: WorkflowRunContext<TInputs, TDefinitionBrand, TOutputs>) => Promise<TOutputs> | TOutputs;

export interface WorkflowRuntimeConfig {
  readonly maxDepth: number;
  readonly defaultConcurrency: number;
  readonly persistRuns: boolean;
  readonly statusFile: boolean;
  readonly statusFilePath?: string;
  readonly resumeInFlight: "ask" | "auto" | "never";
  readonly worktree?: {
    readonly symlinkDirectories: readonly string[];
  };
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
  run(ctx: WorkflowRunContext<TInputs, TDefinitionBrand, TOutputs>): Promise<TOutputs> | TOutputs;
}

export type NoExtraOutputs<TDeclared extends WorkflowOutputValues, TActual extends TDeclared> = TActual &
  Record<Exclude<keyof TActual, keyof TDeclared>, never>;

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
  readonly onStageEnd?: (runId: string, snapshot: StageSnapshot) => unknown;
  readonly onRunEnd?: (runId: string, status: RunStatus, result?: WorkflowOutputValues, error?: string, exitReason?: string) => void;
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
  /** Actionable user guidance for accepted background execution. */
  readonly message?: string;
  readonly error?: string;
  /** True when the run reached its terminal status through ctx.exit(). */
  readonly exited?: boolean;
  readonly exitReason?: string;
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
  readonly result?: Partial<TOutputs>;
  readonly error?: string;
  /** True when the run reached its terminal status through ctx.exit(). */
  readonly exited?: boolean;
  readonly exitReason?: string;
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
