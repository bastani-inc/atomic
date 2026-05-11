/**
 * Cross-cutting shared types for pi-workflows.
 * cross-ref: pi-subagents src/shared/types.ts
 */

// ---------------------------------------------------------------------------
// Workflow input schema
// ---------------------------------------------------------------------------

/** Discriminated union of supported input kinds. */
export type WorkflowInputType = "text" | "string" | "number" | "boolean" | "select";

interface BaseInputSchema {
  description?: string;
  required?: boolean;
}

export interface TextInputSchema extends BaseInputSchema {
  type: "text" | "string";
  default?: string;
}

export interface NumberInputSchema extends BaseInputSchema {
  type: "number";
  default?: number;
}

export interface BooleanInputSchema extends BaseInputSchema {
  type: "boolean";
  default?: boolean;
}

export interface SelectInputSchema extends BaseInputSchema {
  type: "select";
  /** Non-empty array of valid string choices. */
  choices: readonly string[];
  default?: string;
}

/** Union of all concrete input schema shapes. */
export type WorkflowInputSchema =
  | TextInputSchema
  | NumberInputSchema
  | BooleanInputSchema
  | SelectInputSchema;

// ---------------------------------------------------------------------------
// HIL (human-in-the-loop) primitives available inside run functions
// ---------------------------------------------------------------------------

/**
 * HIL surface available on WorkflowRunContext.ui.
 * Each primitive suspends the current stage until the user responds.
 * Mirrors pi's ctx.ui.input / confirm / select / editor methods.
 */
export interface WorkflowUIContext {
  /** Ask the user for a free-text value. */
  input(prompt: string): Promise<string>;
  /** Ask the user a yes/no question. */
  confirm(message: string): Promise<boolean>;
  /** Ask the user to pick from a fixed list of options. */
  select<T extends string>(message: string, options: readonly T[]): Promise<T>;
  /** Open a text editor; resolves with the user's final content. */
  editor(initial?: string): Promise<string>;
}

/**
 * Adapter supplied by the pi runtime (or test harness) to back the HIL
 * primitives.  Must implement the same surface as WorkflowUIContext so that
 * the executor can delegate directly.
 */
export type WorkflowUIAdapter = WorkflowUIContext;

// ---------------------------------------------------------------------------
// StageOptions — per-stage configuration
// ---------------------------------------------------------------------------

/**
 * MCP server gating options for a single stage.
 * When provided, the executor forwards these to the WorkflowMcpPort
 * before the stage starts and clears them after it settles.
 */
export interface StageMcpOptions {
  /** Allow only these server IDs during this stage (all others implicitly denied). */
  allow?: string[];
  /** Deny these server IDs during this stage (applied after allow when both set). */
  deny?: string[];
}

/**
 * Options accepted by WorkflowRunContext.stage(name, options?).
 * Extends backward-compatibly — omitting options keeps existing behaviour.
 */
export interface StageOptions {
  /** Per-stage MCP server gating. No-op when no WorkflowMcpPort is configured. */
  mcp?: StageMcpOptions;
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
  /** AbortSignal propagated from the executor's own AbortController. */
  signal?: AbortSignal;
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
 * Mirrors PersistenceAPI from persistence/session-entries — no hard import.
 */
export interface WorkflowPersistencePort {
  appendEntry(type: string, payload: Record<string, unknown>): string | undefined;
  setLabel?(entryId: string, label: string): void;
  appendCustomMessageEntry?(content: string, meta?: Record<string, unknown>): string | undefined;
}

// ---------------------------------------------------------------------------
// Stage context (provided to ctx.stage() calls)
// ---------------------------------------------------------------------------

/** Options for delegating a stage to a pi-subagents sub-agent. */
export interface SubagentStageOpts {
  /** Name of the registered sub-agent to invoke. */
  agent: string;
  /** Task description forwarded to the sub-agent. */
  task: string;
  /** Optional additional context to inject. */
  context?: string;
}

/** Options for a one-shot completion (no session, no tool use). */
export interface CompleteStageOpts {
  /** Override the model for this completion. */
  model?: string;
  /** Maximum tokens to generate. */
  maxTokens?: number;
}

export interface StageContext {
  /** Human-readable name for this stage (used in TUI + persistence). */
  readonly name: string;
  /**
   * Spawn a new pi session and send the prompt; awaits the full assistant
   * response.  This is the default stage execution mode.
   */
  prompt(text: string): Promise<string>;
  /**
   * Delegate this stage to a pi-subagents sub-agent.
   * Requires pi-subagents to be installed; throws a clear error if absent.
   */
  subagent(opts: SubagentStageOpts): Promise<string>;
  /**
   * Perform a one-shot LLM completion (no session, no tool use).
   * Useful for cheap classification/summarisation stages.
   */
  complete(text: string, opts?: CompleteStageOpts): Promise<string>;
}

// ---------------------------------------------------------------------------
// Workflow run context (top-level ctx passed to the run function)
// ---------------------------------------------------------------------------

export interface WorkflowRunContext<TInputs extends Record<string, unknown> = Record<string, unknown>> {
  /** Typed inputs provided by the caller, validated against the input schema. */
  readonly inputs: TInputs;
  /**
   * Create and register a named stage.  Stages can be sequenced (await) or
   * parallelised (Promise.all); the executor infers the DAG automatically.
   *
   * @param name   Human-readable stage name (used in TUI + persistence).
   * @param options Optional per-stage configuration (mcp allow/deny, etc.).
   *               Omitting options preserves backward-compatible behaviour.
   */
  stage(name: string, options?: StageOptions): StageContext;
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
export interface WorkflowRuntimeConfig {
  /** Maximum workflow recursion/nesting depth. Default: 4. */
  readonly maxDepth: number;
  /** Default stage concurrency limit. Default: 4. */
  readonly defaultConcurrency: number;
  /** Persist runs via pi.appendEntry. Default: true. */
  readonly persistRuns: boolean;
  /** Emit derived status file for CI polling. Default: false. */
  readonly statusFile: boolean;
  /**
   * Filesystem path for the emitted status file.
   * Only meaningful when statusFile is true.
   * Absence means the writer should choose a default path.
   */
  readonly statusFilePath?: string;
  /** Behaviour on session_start for in-flight runs. Default: "ask". */
  readonly resumeInFlight: "ask" | "auto" | "never";
}

// ---------------------------------------------------------------------------
// Workflow run function
// ---------------------------------------------------------------------------

export type WorkflowRunFn<TInputs extends Record<string, unknown> = Record<string, unknown>> = (
  ctx: WorkflowRunContext<TInputs>,
) => Promise<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// Compiled workflow definition
// ---------------------------------------------------------------------------

export interface WorkflowDefinition<TInputs extends Record<string, unknown> = Record<string, unknown>> {
  /** Sentinel consumed by the registry loader to validate the export. */
  readonly __piWorkflow: true;
  readonly name: string;
  /** Normalised name (lowercase, hyphens) used as the registry key. */
  readonly normalizedName: string;
  readonly description: string;
  readonly inputs: Readonly<Record<string, WorkflowInputSchema>>;
  readonly run: WorkflowRunFn<TInputs>;
}
