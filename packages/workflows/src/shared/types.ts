/**
 * Cross-cutting shared types for atomic workflows.
 * cross-ref: pi docs/sdk.md AgentSession
 */

import type {
  AgentSession,
  AgentSessionEvent,
  VerbatimCompactionResult,
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

export type { AgentSessionEvent, VerbatimCompactionResult, ModelCycleResult, PromptOptions };

export type StageUserMessageContent = Parameters<AgentSession["sendUserMessage"]>[0];

export type StageUserMessageDelivery = "steer" | "followUp";

export interface StageSendUserMessageOptions {
  /** Delivery mode to use when the stage session is already streaming. Defaults to followUp. */
  readonly deliverAs?: StageUserMessageDelivery;
}

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
export type WorkflowExitStatus = AuthoringContract.WorkflowExitStatus;
export type WorkflowExitOptions<TOutputs extends WorkflowOutputValues = WorkflowOutputValues> = AuthoringContract.WorkflowExitOptions<TOutputs>;

// ---------------------------------------------------------------------------
// Workflow input / output schemas
// ---------------------------------------------------------------------------

/**
 * Inputs and outputs are declared as TypeBox schema maps on
 * `workflow({ inputs: { ... }, outputs: { ... } })`. Authors import `Type`
 * from typebox, while the workflow authoring types thread the corresponding
 * `Static<>` types and the runtime validates via TypeBox `Value`.
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

type WorkflowRequiredKeys<T extends object> = {
  [K in keyof T]-?: {} extends Pick<T, K> ? never : K;
}[keyof T];

export type WorkflowRunChildOptionsArgument<TInputs extends WorkflowInputValues = WorkflowInputValues> = [WorkflowRequiredKeys<TInputs>] extends [never]
  ? WorkflowRunChildOptions<TInputs>
  : WorkflowRunChildOptions<TInputs> & { readonly inputs: TInputs };

export type WorkflowRunChildArgs<TInputs extends WorkflowInputValues = WorkflowInputValues> = [WorkflowRequiredKeys<TInputs>] extends [never]
  ? readonly [options?: WorkflowRunChildOptionsArgument<NoInfer<TInputs>>]
  : readonly [options: WorkflowRunChildOptionsArgument<NoInfer<TInputs>>];

export type WorkflowCompletedChildResult<TOutputs extends WorkflowOutputValues = WorkflowOutputValues> = AuthoringContract.WorkflowCompletedChildResult<TOutputs>;
export type WorkflowExitedChildResult<TOutputs extends WorkflowOutputValues = WorkflowOutputValues> = AuthoringContract.WorkflowExitedChildResult<TOutputs>;
export type WorkflowChildResult<TOutputs extends WorkflowOutputValues = WorkflowOutputValues> = AuthoringContract.WorkflowChildResult<TOutputs>;

// ---------------------------------------------------------------------------
// HIL (human-in-the-loop) primitives available inside run functions
// ---------------------------------------------------------------------------

/**
 * HIL surface available on WorkflowRunContext.ui.
 * Each primitive suspends the current stage until the user responds.
 * Mirrors pi ctx.ui.input / confirm / select / editor methods.
 */
export type WorkflowCustomUiComponent = AuthoringContract.WorkflowCustomUiComponent;
export type WorkflowCustomUiTui = AuthoringContract.WorkflowCustomUiTui;
export type WorkflowCustomUiTheme = AuthoringContract.WorkflowCustomUiTheme;
export type WorkflowCustomUiKeybindings = AuthoringContract.WorkflowCustomUiKeybindings;
export type WorkflowCustomUiOverlayOptions = AuthoringContract.WorkflowCustomUiOverlayOptions;
export type WorkflowCustomUiOverlayHandle = AuthoringContract.WorkflowCustomUiOverlayHandle;
export type WorkflowCustomUiFactory<T> = AuthoringContract.WorkflowCustomUiFactory<T>;
export type WorkflowCustomUiOptions = AuthoringContract.WorkflowCustomUiOptions;

export interface WorkflowUIContext extends AuthoringContract.WorkflowUIContext {}

/**
 * Adapter supplied by the pi runtime (or test harness) to back the HIL
 * primitives.  The custom-widget method is optional for compatibility with
 * existing primitive-only adapters; the executor normalizes a missing custom
 * method to the same unavailable-UI rejection used in headless mode.
 */
export interface WorkflowUIAdapter extends AuthoringContract.WorkflowUIAdapter {}

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
export interface StageOptions<TSchemaDef extends TSchema | undefined = TSchema | undefined>
  extends Omit<CreateAgentSessionOptions, "model" | keyof AuthoringContract.StageOptions>,
    Omit<Mutable<AuthoringContract.StageOptions<TSchemaDef>>, "sessionManager" | "settingsManager"> {
  /** Optional structured final-answer schema. When set, the stage receives a schema-specific final-answer tool. */
  schema?: TSchemaDef;
  /** Model id or pi SDK model object used as the primary stage model. */
  model?: WorkflowModelValue;
  /** Per-stage MCP server gating. No-op when no WorkflowMcpPort is configured. */
  mcp?: StageMcpOptions;
  customTools?: ToolDefinition[];
  scopedModels?: CreateAgentSessionOptions["scopedModels"];
  sessionManager?: SessionManager;
  settingsManager?: SettingsManager;
  /** Internal durable resume hook: reopen this exact Atomic/Pi session file instead of forking. */
  resumeFromSessionFile?: string;
  /** Internal durable replay key used to map a live LM session to durable resume state. */
  durableReplayKey?: string;
  /** Internal durable timing baseline accumulated before a process-boundary resume. */
  durableAccumulatedDurationMs?: number;
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
  /** Internal stage-generation context reused across model-fallback sessions. */
  orchestrationContext?: CreateAgentSessionOptions["orchestrationContext"];
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
export type WorkflowStageResult<TSchemaDef extends TSchema | undefined = undefined> = AuthoringContract.WorkflowStageResult<TSchemaDef>;

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

// ---------------------------------------------------------------------------
// Stage context (provided to ctx.stage() calls)
// ---------------------------------------------------------------------------

/**
 * Stage context returned by WorkflowRunContext.stage().
 *
 * This exposes the supported subset of pi's SDK AgentSession. The workflow
 * executor owns disposal and wraps prompt() with stage lifecycle tracking.
 */
export interface StageContext<TSchemaDef extends TSchema | undefined = undefined> {
  /** Human-readable name for this stage (used in TUI + persistence). */
  readonly name: string;

  /** Send a prompt and wait for completion. */
  prompt(text: string, options?: StagePromptOptions): Promise<WorkflowStageResult<TSchemaDef>>;
  complete(text: string, options?: CompleteStageOpts): Promise<string>;

  /**
   * Send a user-authored follow-on message to this stage session.
   *
   * When the session is idle this starts a new user turn immediately. When the
   * session is streaming, the message is queued as a follow-up by default, or
   * as steering when `deliverAs: "steer"` is provided.
   */
  sendUserMessage(content: StageUserMessageContent, options?: StageSendUserMessageOptions): Promise<void>;

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
  compact(): Promise<VerbatimCompactionResult>;
  abortCompaction(): void;

  /** Abort current operation. */
  abort(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Workflow run context (top-level ctx passed to the run function)
// ---------------------------------------------------------------------------

export interface WorkflowRunContext<
  TInputs extends WorkflowInputValues = WorkflowInputValues,
  TOutputs extends WorkflowOutputValues = WorkflowOutputValues,
> {
  /** Typed inputs provided by the caller, validated against the input schema. */
  readonly inputs: TInputs;
  /** Invocation working directory for workflow-owned artifacts. Defaults to the host process cwd when omitted. */
  readonly cwd?: string;
  /** Intentionally end this workflow run from any call depth. */
  exit(options?: WorkflowExitOptions<TOutputs>): never;
  /**
   * Create and register a named stage synchronously. Stage work starts when
   * a stage method such as prompt() or complete() is awaited; the executor
   * infers the DAG automatically from those method calls.
   *
   * @param name   Human-readable stage name (used in TUI + persistence).
   * @param options Optional per-stage configuration (mcp allow/deny, etc.).
   */
  stage<TSchemaDef extends TSchema>(name: string, options: StageOptions<TSchemaDef> & { schema: TSchemaDef }): StageContext<TSchemaDef>;
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
  workflow<
    TChildInputs extends WorkflowInputValues,
    TChildOutputs extends WorkflowOutputValues,
    TChildRunInputs extends WorkflowInputValues = TChildInputs,
  >(
    definition: WorkflowDefinition<TChildInputs, TChildOutputs, TChildRunInputs>,
    ...args: WorkflowRunChildArgs<TChildRunInputs>
  ): Promise<WorkflowChildResult<TChildOutputs>>;
  /** HIL primitives for user interaction during a run. */
  readonly ui: WorkflowUIContext;
  /**
   * Durable cached tool execution. Runs arbitrary TypeScript code and caches
   * the result so completed side effects are not repeated on resume.
   * Only `ctx.*` blocks produce durable checkpoints.
   *
   * cross-ref: issue #1498 — DBOS-backed cross-session resumability.
   */
  tool: WorkflowToolPrimitive;
  /**
   * Model catalog port for the invoking session, when the host provides one.
   * `models.currentModel` is the user-selected session model; leading a stage's
   * model chain with it (bare, without a reasoning suffix) runs the stage at
   * the session's model and default thinking level.
   */
  readonly models?: WorkflowModelCatalogPort;
}

/**
 * `ctx.tool` primitive signature. Runs an async function and caches the result
 * durably via the durable workflow backend.
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
  /** When true, the tool function is retried on failure. Default false. */
  readonly retriesAllowed?: boolean;
  /** Max retry attempts when retriesAllowed is true. Default 3. */
  readonly maxAttempts?: number;
  /** Initial retry interval in ms. Default 1000. */
  readonly intervalMs?: number;
  /** Backoff multiplier. Default 2. */
  readonly backoffRate?: number;
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
> = (ctx: WorkflowRunContext<TInputs, TOutputs>) => ReturnType<AuthoringContract.WorkflowRunFn<TInputs, TOutputs>>;

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
  TRunInputs extends WorkflowInputValues = TInputs,
> extends Omit<AuthoringContract.WorkflowDefinition<TInputs, TOutputs, TRunInputs, WorkflowDefinitionBrand>, "run">, WorkflowDefinitionBrand {
  readonly run: WorkflowRunFn<TInputs, TOutputs>;
}
