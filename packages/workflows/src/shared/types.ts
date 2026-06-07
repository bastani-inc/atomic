/**
 * Cross-cutting shared types for atomic workflows.
 * cross-ref: pi docs/sdk.md AgentSession
 */

import type {
  AgentSession,
  AgentSessionEvent,
  ContextCompactionResult,
  CreateAgentSessionOptions,
  ModelCycleResult,
  PromptOptions,
  SessionManager,
  SettingsManager,
  ToolDefinition,
} from "@bastani/atomic";
import type { TSchema } from "typebox";
import type * as AuthoringContract from "./authoring-contract.js";

export type { TSchema };

export type { AgentSessionEvent, ContextCompactionResult, ModelCycleResult, PromptOptions };

export type WorkflowModelValue = NonNullable<CreateAgentSessionOptions["model"]> | string;
export type WorkflowModelUsage = AuthoringContract.WorkflowModelUsage;
export type WorkflowModelAttempt = AuthoringContract.WorkflowModelAttempt;
export type WorkflowModelFallbackFields = AuthoringContract.WorkflowModelFallbackFields;
export type WorkflowThinkingLevel = AuthoringContract.WorkflowThinkingLevel;

export interface WorkflowModelInfo extends Omit<AuthoringContract.WorkflowModelInfo, "model"> {
  readonly model?: NonNullable<CreateAgentSessionOptions["model"]>;
}

export interface WorkflowModelCatalogPort extends Omit<AuthoringContract.WorkflowModelCatalogPort, "listModels" | "currentModel"> {
  listModels(): Promise<readonly WorkflowModelInfo[]>;
  /** Current user-selected model used as the implicit final fallback. */
  readonly currentModel?: WorkflowModelValue;
}

// ---------------------------------------------------------------------------
// Workflow serializable values
// ---------------------------------------------------------------------------

export type WorkflowSerializablePrimitive = AuthoringContract.WorkflowSerializablePrimitive;
export type WorkflowSerializableObject = AuthoringContract.WorkflowSerializableObject;
export type WorkflowSerializableValue = AuthoringContract.WorkflowSerializableValue;
export type WorkflowInputValues = AuthoringContract.WorkflowInputValues;
export type WorkflowOutputValues = AuthoringContract.WorkflowOutputValues;
export type WorkflowRunOutput = AuthoringContract.WorkflowRunOutput;

// ---------------------------------------------------------------------------
// Workflow input / output schemas
// ---------------------------------------------------------------------------

/**
 * Inputs and outputs are declared with TypeBox schemas. Authors use
 * `.input(key, Type.String({ ... }))` / `.output(key, Type.Object({ ... }))`;
 * the builder threads the precise `Static<>` types and the runtime validates
 * via TypeBox `Value`.
 */
export type WorkflowInputSchemaMap = AuthoringContract.WorkflowInputSchemaMap;
export type WorkflowOutputSchemaMap = AuthoringContract.WorkflowOutputSchemaMap;

/** A single declared input schema is just a TypeBox schema. */
export type WorkflowInputSchema = AuthoringContract.WorkflowInputSchema;
/** A single declared output schema is just a TypeBox schema. */
export type WorkflowOutputSchema = AuthoringContract.WorkflowOutputSchema;

// ---------------------------------------------------------------------------
// Workflow execution policy
// ---------------------------------------------------------------------------

export type WorkflowExecutionMode = AuthoringContract.WorkflowExecutionMode;
export type WorkflowExecutionPolicy = AuthoringContract.WorkflowExecutionPolicy;

export const INTERACTIVE_WORKFLOW_POLICY: WorkflowExecutionPolicy = Object.freeze({
  mode: "interactive",
  allowHumanInput: true,
  awaitTerminalRun: false,
  allowInputPicker: true,
});

export const NON_INTERACTIVE_WORKFLOW_POLICY: WorkflowExecutionPolicy = Object.freeze({
  mode: "non_interactive",
  allowHumanInput: false,
  awaitTerminalRun: true,
  allowInputPicker: false,
});

// ---------------------------------------------------------------------------
// Workflow child composition and outputs
// ---------------------------------------------------------------------------

export interface WorkflowRunChildOptions<TInputs extends WorkflowInputValues = WorkflowInputValues> {
  /** Inputs forwarded to the child workflow, typed against its input contract. */
  readonly inputs?: TInputs;
  /** Parent boundary stage display name. Defaults to workflow:<workflow-name>. */
  readonly stageName?: string;
}

export interface WorkflowChildResult<TOutputs extends WorkflowOutputValues = WorkflowOutputValues>
  extends WorkflowSerializableObject {
  readonly workflow: string;
  readonly runId: string;
  readonly status: "completed";
  /** Child outputs, typed from the child workflow's declared `.output(...)` contract. */
  readonly outputs: TOutputs;
}

// ---------------------------------------------------------------------------
// HIL (human-in-the-loop) primitives available inside run functions
// ---------------------------------------------------------------------------

/**
 * HIL surface available on WorkflowRunContext.ui.
 * Each primitive suspends the current stage until the user responds.
 * Mirrors pi ctx.ui.input / confirm / select / editor methods.
 */
export type WorkflowUIContext = AuthoringContract.WorkflowUIContext;

/**
 * Adapter supplied by the pi runtime (or test harness) to back the HIL
 * primitives.  Must implement the same surface as WorkflowUIContext so that
 * the executor can delegate directly.
 */
export type WorkflowUIAdapter = AuthoringContract.WorkflowUIAdapter;

// ---------------------------------------------------------------------------
// StageOptions — per-stage configuration + pi SDK session options
// ---------------------------------------------------------------------------

/**
 * MCP server gating options for a single stage.
 * When provided, the executor forwards these to the WorkflowMcpPort
 * before the stage starts and clears them after it settles.
 */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export interface StageMcpOptions extends AuthoringContract.StageMcpOptions {
  allow?: string[];
  deny?: string[];
}

/**
 * Options accepted by WorkflowRunContext.stage(name, options?).
 * All pi SDK createAgentSession options are forwarded to the stage session;
 * workflow-owned options such as `mcp` and `gitWorktreeDir` are stripped before SDK session creation.
 */
export interface StageOptions
  extends Omit<CreateAgentSessionOptions, "model" | keyof AuthoringContract.StageOptions>,
    Omit<Mutable<AuthoringContract.StageOptions>, "sessionManager" | "settingsManager"> {
  /** Model id or pi SDK model object used as the primary stage model. */
  model?: WorkflowModelValue;
  /** Per-stage MCP server gating. No-op when no WorkflowMcpPort is configured. */
  mcp?: StageMcpOptions;
  customTools?: ToolDefinition[];
  scopedModels?: CreateAgentSessionOptions["scopedModels"];
  sessionManager?: SessionManager;
  settingsManager?: SettingsManager;
}

// ---------------------------------------------------------------------------
// Stage execution metadata — threaded from executor into adapter calls
// ---------------------------------------------------------------------------

/**
 * Execution metadata injected by the executor into stage adapter calls.
 * Not exposed to workflow authors — StageContext public API is unchanged.
 */
export interface StageExecutionMeta {
  /** Run ID of the containing workflow execution. */
  runId: string;
  /** Stage ID of the current stage. */
  stageId: string;
  /** Human-readable stage name. */
  stageName: string;
  /** Stage options after workflow-owned direct-mode rewriting. */
  stageOptions?: StageOptions;
  /** AbortSignal propagated from the executor's own AbortController. */
  signal?: AbortSignal;
  /** Runtime execution mode for policy-aware child sessions. */
  executionMode?: WorkflowExecutionMode;
}

export interface CompleteStageOpts extends WorkflowModelFallbackFields {
  model?: WorkflowModelValue;
  maxTokens?: number;
}

// ---------------------------------------------------------------------------
// Runtime ports — abstract adapters used by the executor
// ---------------------------------------------------------------------------

/**
 * Abstract MCP scope-gating port.
 * Implemented by the pi runtime or a test stub; no hard dep on integrations/mcp.
 */
export interface WorkflowMcpPort {
  /** Restrict MCP server access for the given stage. Null = unrestricted. */
  setScope(stageId: string, allow: string[] | null, deny: string[] | null): void;
  /** Restore unrestricted MCP access after the stage settles. */
  clearScope(stageId: string): void;
}

/**
 * Abstract persistence port.
 * Mirrors PersistenceAPI from shared/persistence-session-entries — no hard import.
 */
export interface WorkflowPersistencePort {
  appendEntry(type: string, payload: Record<string, unknown>): string | undefined;
  setLabel?(entryId: string, label: string): void;
  appendCustomMessageEntry?(content: string, meta?: Record<string, unknown>): string | undefined;
}

// ---------------------------------------------------------------------------
// Task context primitives
// ---------------------------------------------------------------------------

/**
 * Reusable context passed between high-level workflow tasks. This keeps
 * `{previous}` handoffs as a typed SDK primitive instead of requiring authors
 * to manually concatenate prior output into every prompt.
 */
export type WorkflowTaskContext = AuthoringContract.WorkflowTaskContext;
export type WorkflowTaskContextInput = AuthoringContract.WorkflowTaskContextInput;
export type WorkflowTaskResult = AuthoringContract.WorkflowTaskResult;

/**
 * Higher-level task API: create a tracked stage, optionally inject prior task
 * output, prompt the agent, and return a reusable task result.
 *
 * `{previous}` means prior step output.
 */
export interface WorkflowTaskOptions extends StageOptions, Omit<Mutable<AuthoringContract.WorkflowTaskOptions>, keyof AuthoringContract.StageOptions> {}
export interface WorkflowTaskStep extends WorkflowTaskOptions, Omit<Mutable<AuthoringContract.WorkflowTaskStep>, keyof AuthoringContract.WorkflowTaskOptions> {}
export interface WorkflowSharedTaskDefaults extends StageOptions, Omit<Mutable<AuthoringContract.WorkflowSharedTaskDefaults>, keyof AuthoringContract.StageOptions> {}
export interface WorkflowChainOptions extends WorkflowSharedTaskDefaults, Omit<Mutable<AuthoringContract.WorkflowChainOptions>, keyof AuthoringContract.WorkflowSharedTaskDefaults> {}
export interface WorkflowParallelOptions extends WorkflowSharedTaskDefaults, Omit<Mutable<AuthoringContract.WorkflowParallelOptions>, keyof AuthoringContract.WorkflowSharedTaskDefaults> {}

export type WorkflowOutputMode = AuthoringContract.WorkflowOutputMode;
export type WorkflowMaxOutput = AuthoringContract.WorkflowMaxOutput;
export type StageOutputOptions = Mutable<AuthoringContract.StageOutputOptions>;
export type StagePromptOptions = PromptOptions & StageOutputOptions;

export type WorkflowArtifact = AuthoringContract.WorkflowArtifact;
export type WorkflowProgressSummary = AuthoringContract.WorkflowProgressSummary;
export type WorkflowControlEvent = AuthoringContract.WorkflowControlEvent;
export type WorkflowIntercomSummary = AuthoringContract.WorkflowIntercomSummary;
export type WorkflowDetailsMode = AuthoringContract.WorkflowDetailsMode;
export type WorkflowDetailsStatus = AuthoringContract.WorkflowDetailsStatus;
export type WorkflowAction = AuthoringContract.WorkflowAction;
export type WorkflowDetails = Mutable<AuthoringContract.WorkflowDetails>;
export type WorkflowTaskSessionFields = Mutable<AuthoringContract.WorkflowTaskSessionFields>;
export type WorkflowTaskSessionOptions = StageOptions & WorkflowTaskSessionFields;
export interface WorkflowDirectTaskItem extends WorkflowTaskOptions, Omit<Mutable<AuthoringContract.WorkflowDirectTaskItem>, keyof AuthoringContract.WorkflowTaskOptions> {}
export interface WorkflowParallelChainStep extends Omit<AuthoringContract.WorkflowParallelChainStep, "parallel"> {
  readonly parallel: readonly WorkflowDirectTaskItem[];
}
export type WorkflowChainStep = WorkflowDirectTaskItem | WorkflowParallelChainStep;
export interface WorkflowDirectOptions extends StageOptions, Omit<Mutable<AuthoringContract.WorkflowDirectOptions>, keyof AuthoringContract.StageOptions> {}

// ---------------------------------------------------------------------------
// Stage context (provided to ctx.stage() calls)
// ---------------------------------------------------------------------------

/**
 * Stage context returned by WorkflowRunContext.stage().
 *
 * This exposes the supported subset of pi's SDK AgentSession. The workflow
 * executor owns disposal and wraps prompt() with stage lifecycle tracking.
 */
export interface StageContext {
  /** Human-readable name for this stage (used in TUI + persistence). */
  readonly name: string;

  /** Send a prompt and wait for completion. */
  prompt(text: string, options?: StagePromptOptions): Promise<string>;
  complete(text: string, options?: CompleteStageOpts): Promise<string>;

  /** Queue messages during streaming. */
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;

  /** Subscribe to events (returns unsubscribe function). */
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;

  /** Session info. */
  readonly sessionFile: string | undefined;
  readonly sessionId: string;

  /** Model control. */
  setModel(model: Parameters<AgentSession["setModel"]>[0]): Promise<void>;
  setThinkingLevel(level: Parameters<AgentSession["setThinkingLevel"]>[0]): void;
  cycleModel(): Promise<ModelCycleResult | undefined>;
  cycleThinkingLevel(): ReturnType<AgentSession["cycleThinkingLevel"]>;

  /** State access. */
  readonly agent: AgentSession["agent"];
  readonly model: AgentSession["model"];
  readonly thinkingLevel: AgentSession["thinkingLevel"];
  readonly messages: AgentSession["messages"];
  readonly isStreaming: AgentSession["isStreaming"];

  /** In-place tree navigation within the current session file. */
  navigateTree(
    targetId: string,
    options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
  ): Promise<{ editorText?: string; cancelled: boolean }>;

  /** Compaction. */
  compact(): Promise<ContextCompactionResult>;
  abortCompaction(): void;

  /** Abort current operation. */
  abort(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Workflow run context (top-level ctx passed to the run function)
// ---------------------------------------------------------------------------

export interface WorkflowRunContext<TInputs extends WorkflowInputValues = WorkflowInputValues> {
  /** Typed inputs provided by the caller, validated against the input schema. */
  readonly inputs: TInputs;
  /** Invocation working directory for workflow-owned artifacts. Defaults to the host process cwd when omitted. */
  readonly cwd?: string;
  /**
   * Create and register a named stage synchronously. Stage work starts when
   * a stage method such as prompt() or complete() is awaited; the executor
   * infers the DAG automatically from those method calls.
   *
   * @param name   Human-readable stage name (used in TUI + persistence).
   * @param options Optional per-stage configuration (mcp allow/deny, etc.).
   */
  stage(name: string, options?: StageOptions): StageContext;
  /**
   * Safe high-level task primitive. Equivalent to creating a named stage and
   * calling prompt(), with built-in context handoff support.
   */
  task(name: string, options: WorkflowTaskOptions): Promise<WorkflowTaskResult>;
  /** Run tasks in sequence. Missing step tasks: first gets `{task}`, later steps get `{previous}`. */
  chain(steps: readonly WorkflowTaskStep[], options?: WorkflowChainOptions): Promise<WorkflowTaskResult[]>;
  /** Run tasks in parallel. Missing step tasks use the first available task as a fallback. */
  parallel(steps: readonly WorkflowTaskStep[], options?: WorkflowParallelOptions): Promise<WorkflowTaskResult[]>;
  /** Execute a reusable child workflow by compiled workflow definition. */
  workflow<TChildInputs extends WorkflowInputValues, TChildOutputs extends WorkflowOutputValues>(
    definition: WorkflowDefinition<TChildInputs, TChildOutputs>,
    options?: WorkflowRunChildOptions<TChildInputs>,
  ): Promise<WorkflowChildResult<TChildOutputs>>;
  /** HIL primitives for user interaction during a run. */
  readonly ui: WorkflowUIContext;
}

// ---------------------------------------------------------------------------
// WorkflowRuntimeConfig — resolved runtime tunables injected at composition root
// ---------------------------------------------------------------------------

/**
 * Resolved runtime configuration for workflow execution.
 * Built from WorkflowEffectiveConfig (all optionals filled with defaults) and
 * injected into createExtensionRuntime, dispatch, run, and runDetached option seams.
 *
 * Downstream tasks own: maxDepth enforcement, defaultConcurrency pool,
 * statusFile writer. This type is the port — values flow through but are not
 * acted on until those tasks land.
 */
export type WorkflowRuntimeConfig = AuthoringContract.WorkflowRuntimeConfig;

// ---------------------------------------------------------------------------
// Workflow run function
// ---------------------------------------------------------------------------

export type WorkflowRunFn<
  TInputs extends WorkflowInputValues = WorkflowInputValues,
  TOutputs extends WorkflowOutputValues = WorkflowOutputValues,
> = (ctx: WorkflowRunContext<TInputs>) => ReturnType<AuthoringContract.WorkflowRunFn<TInputs, TOutputs>>;

// ---------------------------------------------------------------------------
// Compiled workflow definition
// ---------------------------------------------------------------------------

export type WorkflowWorktreeInputBinding = AuthoringContract.WorkflowWorktreeInputBinding;
export type WorkflowInputBindings = AuthoringContract.WorkflowInputBindings;
declare const workflowDefinitionBrand: unique symbol;
export type WorkflowDefinitionBrand = { readonly [workflowDefinitionBrand]: true };

export interface WorkflowDefinition<
  TInputs extends WorkflowInputValues = WorkflowInputValues,
  TOutputs extends WorkflowOutputValues = WorkflowOutputValues,
> extends Omit<AuthoringContract.WorkflowDefinition<TInputs, TOutputs, TInputs, WorkflowDefinitionBrand>, "run" | "__runInputs">, WorkflowDefinitionBrand {
  readonly run: WorkflowRunFn<TInputs, TOutputs>;
}
