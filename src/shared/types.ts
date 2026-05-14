/**
 * Cross-cutting shared types for atomic workflows.
 * cross-ref: pi docs/sdk.md AgentSession
 */

import type {
  AgentSession,
  AgentSessionEvent,
  CompactionResult,
  CreateAgentSessionOptions,
  ModelCycleResult,
  PromptOptions,
} from "@earendil-works/pi-coding-agent";

export type { AgentSessionEvent, CompactionResult, ModelCycleResult, PromptOptions };

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
 * Mirrors pi ctx.ui.input / confirm / select / editor methods.
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
// StageOptions — per-stage configuration + pi SDK session options
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
 * All pi SDK createAgentSession options are forwarded to the stage session;
 * `mcp` remains workflow-owned and is stripped before SDK session creation.
 */
export interface StageOptions extends CreateAgentSessionOptions {
  /** Per-stage MCP server gating. No-op when no WorkflowMcpPort is configured. */
  mcp?: StageMcpOptions;
  /**
   * Override the session log directory for this stage.
   * Converted to a pi SessionManager before createAgentSession() is called.
   */
  sessionDir?: string;
  /**
   * Requested context mode for direct/task orchestration.
   * "fork" is recorded as workflow intent; the current pi SDK session is
   * created from forkFromSessionFile when the host supplies one, or fresh
   * unless a caller supplies a forked sessionManager.
   */
  context?: "fresh" | "fork";
  /** Parent session file used to materialize context:"fork". */
  forkFromSessionFile?: string;
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
}

export interface CompleteStageOpts {
  model?: string;
  maxTokens?: number;
}

/**
 * Options for `ctx.stage(name).subagent({...})` — maps onto the
 * pi-subagents v0.24.2 `subagent` tool execution shape.
 *
 * `context` is the literal union accepted by pi-subagents'
 * `SubagentParams` (`"fresh" | "fork"`). Passing any other value is a
 * type error — pi-subagents silently rejects unknown context values.
 *
 * cross-ref: pi-subagents/src/extension/schemas.ts SubagentParams
 */
export type SubagentAction =
  | "list"
  | "get"
  | "create"
  | "update"
  | "delete"
  | "status"
  | "interrupt"
  | "resume"
  | "doctor";

export type SubagentSkillOverride = string | readonly string[] | boolean;
export type SubagentReadsOverride = readonly string[] | boolean;
export type SubagentOutputOverride = string | boolean;
export type SubagentAgentScope = string;

export interface SubagentTaskItem {
  agent: string;
  task: string;
  cwd?: string;
  count?: number;
  output?: SubagentOutputOverride;
  outputMode?: WorkflowOutputMode;
  reads?: SubagentReadsOverride;
  progress?: boolean;
  model?: string;
  skill?: SubagentSkillOverride;
}

export interface SubagentParallelTaskItem {
  agent: string;
  task?: string;
  cwd?: string;
  count?: number;
  output?: SubagentOutputOverride;
  outputMode?: WorkflowOutputMode;
  reads?: SubagentReadsOverride;
  progress?: boolean;
  skill?: SubagentSkillOverride;
  model?: string;
}

export interface SubagentChainItem {
  agent?: string;
  task?: string;
  cwd?: string;
  output?: SubagentOutputOverride;
  outputMode?: WorkflowOutputMode;
  reads?: SubagentReadsOverride;
  progress?: boolean;
  skill?: SubagentSkillOverride;
  model?: string;
  parallel?: readonly SubagentParallelTaskItem[];
  concurrency?: number;
  failFast?: boolean;
  worktree?: boolean;
}

export interface SubagentControlOverrides {
  enabled?: boolean;
  needsAttentionAfterMs?: number;
  activeNoticeAfterMs?: number;
  activeNoticeAfterTurns?: number;
  activeNoticeAfterTokens?: number;
  failedToolAttemptsBeforeAttention?: number;
  notifyOn?: readonly ("active_long_running" | "needs_attention")[];
  notifyChannels?: readonly ("event" | "async" | "intercom")[];
}

export interface SubagentStageOpts {
  /** Agent name for single mode, or target for management actions. */
  agent?: string;
  /** Task string for single mode. */
  task?: string;
  action?: SubagentAction;
  id?: string;
  runId?: string;
  dir?: string;
  index?: number;
  message?: string;
  chainName?: string;
  config?: Record<string, unknown> | string;
  tasks?: readonly SubagentTaskItem[];
  concurrency?: number;
  worktree?: boolean;
  chain?: readonly SubagentChainItem[];
  context?: "fresh" | "fork";
  chainDir?: string;
  async?: boolean;
  agentScope?: SubagentAgentScope;
  cwd?: string;
  artifacts?: boolean;
  includeProgress?: boolean;
  share?: boolean;
  sessionDir?: string;
  clarify?: boolean;
  control?: SubagentControlOverrides;
  output?: SubagentOutputOverride;
  outputMode?: WorkflowOutputMode;
  skill?: SubagentSkillOverride;
  model?: string;
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
 * Reusable context passed between high-level workflow tasks. This mirrors
 * pi-subagents' `{previous}` / contextual handoff concept, but keeps it as a
 * typed SDK primitive instead of requiring authors to manually concatenate
 * prior agent output into every prompt.
 */
export interface WorkflowTaskContext {
  /** Optional display label used when rendering the context block. */
  readonly name?: string;
  /** Textual context made available to the next task. */
  readonly text: string;
}

export type WorkflowTaskContextInput = string | WorkflowTaskContext | WorkflowTaskResult;

export interface WorkflowTaskResult extends WorkflowTaskContext {
  /** Stage/session metadata for UI and explicit downstream handoffs. */
  readonly stageName: string;
  readonly sessionId?: string;
  readonly sessionFile?: string;
  readonly artifacts?: WorkflowArtifact[];
}

/**
 * Higher-level task API: create a tracked stage, optionally inject prior task
 * output, prompt the agent, and return a reusable task result.
 *
 * This intentionally mirrors pi-subagents direct-command semantics:
 * `{previous}` means prior step output.
 */
export interface WorkflowTaskOptions extends StageOptions, WorkflowTaskSessionFields {
  /** Prompt/task text. Supports `{previous}` placeholders. */
  prompt?: string;
  /** Alias for `prompt`, matching pi-subagents' direct-command vocabulary. */
  task?: string;
  /** Prior task output/context. If placeholders are absent, it is appended. */
  previous?: WorkflowTaskContextInput | readonly WorkflowTaskContextInput[];
}

export interface WorkflowTaskStep extends WorkflowTaskOptions {
  /** Stage/task name. */
  name: string;
}

export interface WorkflowChainOptions {
  /** Shared/root task used for `{task}` in chain steps. */
  task?: string;
}

export interface WorkflowParallelOptions {
  /** Shared fallback task for parallel steps without their own task. */
  task?: string;
}

export type WorkflowOutputMode = "inline" | "file-only";

export interface WorkflowMaxOutput {
  /** Maximum UTF-8 bytes returned inline. Default: 204800. */
  readonly bytes?: number;
  /** Maximum lines returned inline. Default: 5000. */
  readonly lines?: number;
}

export interface StageOutputOptions {
  /** Optional output artifact path, or false to disable file output. */
  output?: string | false;
  /** Return saved output inline or as a concise saved-file reference. */
  outputMode?: WorkflowOutputMode;
  /** Accepted for parity with direct task/subagent options; stage creation options remain authoritative. */
  context?: "fresh" | "fork";
  /** Override working directory for output path resolution / subagent delegation. */
  cwd?: string;
  /** Final output truncation limits. */
  maxOutput?: WorkflowMaxOutput;
  /** Whether to include debug artifacts when delegated to subagents. */
  artifacts?: boolean;
  /** Override session log directory when delegated to subagents. */
  sessionDir?: string;
}

export type StagePromptOptions = PromptOptions & StageOutputOptions;

export interface WorkflowArtifact {
  readonly kind: "output" | "session" | "diff" | "patch";
  readonly path: string;
  readonly taskName?: string;
  readonly branch?: string;
  readonly diffStat?: string;
  readonly filesChanged?: number;
  readonly insertions?: number;
  readonly deletions?: number;
}

export interface WorkflowProgressSummary {
  readonly completed: number;
  readonly total: number;
}

export interface WorkflowControlEvent {
  readonly type: "notify" | "needs_attention" | "interrupted" | "resumed";
  readonly message: string;
}

export interface WorkflowIntercomSummary {
  readonly enabled: boolean;
  readonly delivery?: "off" | "notify" | "result" | "control-and-result";
  readonly parentSession?: string;
}

export type WorkflowDetailsMode =
  | "named"
  | "single"
  | "parallel"
  | "chain"
  | "inspection"
  | "control"
  | "doctor";

export type WorkflowDetailsStatus =
  | "accepted"
  | "running"
  | "completed"
  | "failed"
  | "killed"
  | "noop";

export type WorkflowAction =
  | "list"
  | "get"
  | "inputs"
  | "run"
  | "status"
  | "interrupt"
  | "resume"
  | "doctor";

export interface WorkflowDetails {
  readonly mode: WorkflowDetailsMode;
  readonly action?: WorkflowAction;
  readonly runId?: string;
  readonly status: WorkflowDetailsStatus;
  readonly context?: "fresh" | "fork";
  readonly results?: WorkflowTaskResult[];
  readonly output?: Record<string, unknown>;
  readonly progress?: WorkflowProgressSummary;
  readonly artifacts?: WorkflowArtifact[];
  readonly controlEvents?: WorkflowControlEvent[];
  readonly intercom?: WorkflowIntercomSummary;
  readonly warnings?: string[];
  readonly error?: string;
}

export interface WorkflowTaskSessionFields {
  /** Prompt text for direct single-task calls. */
  prompt?: string;
  /** Task text for parallel/chain calls. */
  task?: string;
  /** Optional output artifact path, or false to disable file output. */
  output?: string | false;
  outputMode?: WorkflowOutputMode;
  reads?: readonly string[] | false;
  progress?: boolean;
  /** Workflow-owned isolation flag; not forwarded to createAgentSession(). */
  worktree?: boolean;
  maxOutput?: WorkflowMaxOutput;
  /** Whether to include debug artifacts such as sessions and worktree diffs. */
  artifacts?: boolean;
}

export type WorkflowTaskSessionOptions = StageOptions & WorkflowTaskSessionFields;

export interface WorkflowDirectTaskItem extends WorkflowTaskOptions {
  /** Task/stage label passed to ctx.task(name, ...). */
  name: string;
  /** Repeat count for direct parallel expansion. */
  count?: number;
}

export interface WorkflowParallelChainStep {
  readonly parallel: readonly WorkflowDirectTaskItem[];
  readonly concurrency?: number;
  readonly failFast?: boolean;
  readonly worktree?: boolean;
}

export type WorkflowChainStep = WorkflowDirectTaskItem | WorkflowParallelChainStep;

export interface WorkflowDirectOptions {
  /** Shared/root task used for `{task}` in direct parallel or chain steps. */
  task?: string;
  /** Optional named chain identifier for status/artifact grouping. */
  chainName?: string;
  context?: "fresh" | "fork";
  forkFromSessionFile?: string;
  concurrency?: number;
  failFast?: boolean;
  chainDir?: string;
  cwd?: string;
  output?: string | false;
  outputMode?: WorkflowOutputMode;
  progress?: boolean;
  worktree?: boolean;
  maxOutput?: WorkflowMaxOutput;
  artifacts?: boolean;
  sessionDir?: string;
}

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
  subagent(options: SubagentStageOpts): Promise<string>;

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
  compact(customInstructions?: string): Promise<CompactionResult>;
  abortCompaction(): void;

  /** Abort current operation. */
  abort(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Workflow run context (top-level ctx passed to the run function)
// ---------------------------------------------------------------------------

export interface WorkflowRunContext<TInputs extends Record<string, unknown> = Record<string, unknown>> {
  /** Typed inputs provided by the caller, validated against the input schema. */
  readonly inputs: TInputs;
  /**
   * Create and register a named stage synchronously. Stage work starts when
   * a stage method such as prompt(), complete(), or subagent() is awaited;
   * the executor infers the DAG automatically from those method calls.
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
  /** Run tasks in sequence. Missing step tasks follow pi-subagents: first gets `{task}`, later steps get `{previous}`. */
  chain(steps: readonly WorkflowTaskStep[], options?: WorkflowChainOptions): Promise<WorkflowTaskResult[]>;
  /** Run tasks in parallel. Missing step tasks use the first available task as a fallback. */
  parallel(steps: readonly WorkflowTaskStep[], options?: WorkflowParallelOptions): Promise<WorkflowTaskResult[]>;
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
