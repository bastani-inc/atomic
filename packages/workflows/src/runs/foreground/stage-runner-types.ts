import type {
  AgentSession,
  CreateAgentSessionOptions,
  PromptOptions,
} from "@bastani/atomic";
import type {
  CompleteStageOpts,
  StageContext,
  StageSendUserMessageOptions,
  StageUserMessageContent,
  StageExecutionMeta,
  StageOptions,
  WorkflowExecutionMode,
  WorkflowModelAttempt,
  WorkflowModelCatalogPort,
} from "../../shared/types.js";

export type StageSessionEvent = Parameters<AgentSession["subscribe"]>[0] extends (event: infer T) => void ? T : never;

export type WorkflowFastModeSettings = {
  readonly chat: boolean;
  readonly workflow: boolean;
};

export type WorkflowFastModeSettingsManager = {
  getCodexFastModeSettings(): WorkflowFastModeSettings;
};

export interface StageSessionRuntime {
  prompt(text: string, options?: PromptOptions): Promise<string | void>;
  sendUserMessage?(content: StageUserMessageContent, options?: StageSendUserMessageOptions): Promise<void>;
  sealWorkflowStageGeneration?(): void;
  closeWorkflowStageGeneration?(): Promise<void>;
  transferWorkflowStageDeliveriesTo?(target: object): void;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  subscribe(listener: (event: StageSessionEvent) => void): () => void;
  readonly sessionFile: string | undefined;
  readonly sessionId: string;
  setModel(model: Parameters<AgentSession["setModel"]>[0]): Promise<void>;
  setThinkingLevel(level: Parameters<AgentSession["setThinkingLevel"]>[0]): void;
  cycleModel(): ReturnType<AgentSession["cycleModel"]>;
  cycleThinkingLevel(): ReturnType<AgentSession["cycleThinkingLevel"]>;
  readonly agent: AgentSession["agent"];
  readonly model: AgentSession["model"];
  readonly thinkingLevel: AgentSession["thinkingLevel"];
  readonly messages: AgentSession["messages"];
  readonly isStreaming: AgentSession["isStreaming"];
  /** Number of SDK-level queued steering/follow-up messages, when supported. */
  readonly pendingMessageCount?: number;
  /** Settings manager supplied by the Atomic SDK when the adapter did not pre-create one. */
  readonly settingsManager?: WorkflowFastModeSettingsManager;
  navigateTree: AgentSession["navigateTree"];
  compact: AgentSession["compact"];
  abortCompaction(): void;
  abort(): Promise<void>;
  dispose(): void | Promise<void>;
  getLastAssistantText?: () => string | undefined;
}

export type StageSessionCreateOptions = CreateAgentSessionOptions & Pick<StageOptions, "mcp" | "fallbackModels" | "fallbackThinkingLevels">;

export interface StageSessionCreateResult {
  readonly session: StageSessionRuntime;
  readonly settingsManager?: WorkflowFastModeSettingsManager;
}

export interface AgentSessionAdapter {
  create(options: StageSessionCreateOptions, meta?: StageExecutionMeta): Promise<StageSessionRuntime | StageSessionCreateResult>;
}

export interface StageModelFallbackMeta {
  readonly model?: string;
  readonly fastMode?: boolean;
  readonly attemptedModels?: readonly string[];
  readonly modelAttempts?: readonly WorkflowModelAttempt[];
  readonly warnings?: readonly string[];
}

export interface PromptAdapter {
  prompt(text: string, meta?: StageExecutionMeta): Promise<string>;
}

export interface CompleteAdapter {
  complete(text: string, opts?: CompleteStageOpts, meta?: StageExecutionMeta): Promise<string>;
}

export interface StageAdapters {
  agentSession?: AgentSessionAdapter;
  prompt?: PromptAdapter;
  complete?: CompleteAdapter;
}

export interface StageRunnerOpts {
  stageId: string;
  stageName: string;
  adapters: StageAdapters;
  /** Options passed to ctx.stage(name, options?). Forwarded to createAgentSession except mcp. */
  stageOptions?: StageOptions;
  /** Run ID of the containing workflow execution — forwarded to session adapter metadata. */
  runId: string;
  /** AbortSignal from the executor's own AbortController — forwarded to session adapter metadata. */
  signal?: AbortSignal;
  /** Optional model catalog used for fallback validation/resolution. */
  models?: WorkflowModelCatalogPort;
  /** Runtime execution mode forwarded to stage session adapters. */
  executionMode?: WorkflowExecutionMode;
  /** Host-resolved non-default session directory inherited by stages without explicit sessionDir. */
  defaultSessionDir?: string;
  /** Internal: notifies the executor when an in-flight fallback changes model/fast metadata. */
  onModelFallbackMetaChange?: (meta: StageModelFallbackMeta) => void;
}

export interface InternalStageContext extends StageContext {
  /** Internal cleanup hook; intentionally omitted from the public StageContext type. */
  __dispose(): Promise<void>;
  /** Internal result snapshot hook for the workflow store/TUI. */
  __getLastAssistantText(): string | undefined;
  getLastAssistantText(): string | undefined;
  /**
   * Internal: eagerly create the underlying SDK AgentSession without sending a
   * prompt. Used by the live stage-control registry when a user attaches to a
   * stage and types their first message before the workflow body's natural
   * first `prompt()` lands.
   */
  __ensureSession(): Promise<void>;
  /** Internal: reopen an archived stage transcript before post-terminal follow-up. */
  __ensureSessionFromFile(sessionFile: string): Promise<void>;
  /** Internal: synchronously reject new detached traffic without waiting for active work. */
  __sealGeneration(): void;
  /** Internal: atomically stop detached traffic admission and drain admitted work. */
  __closeGeneration(): Promise<void>;
  /** Internal: snapshot of currently-known SDK session metadata. */
  __sessionMeta(): { sessionId: string | undefined; sessionFile: string | undefined };
  /** Internal: live coding-agent session when the adapter returned one. */
  __agentSession(): AgentSession | undefined;
  /** Internal: SDK queued steering/follow-up message count, when available. */
  __pendingMessageCount(): number;
  /** Internal: selected/effective model and fallback attempt metadata. */
  __modelFallbackMeta(): StageModelFallbackMeta;
  /** Internal: register a controlled-pause request. */
  __requestPause(): Promise<void>;
  /** Internal: complete a pending controlled pause. */
  __resume(message?: string): Promise<void>;
  /** Internal: true while a controlled pause is in flight. */
  __isPaused(): boolean;
  /** Internal: true once a schema-backed prompt captured its final structured output. */
  __structuredOutputFinalized(): boolean;
}

export type AgentSessionConsumer = "prompt" | "complete";
