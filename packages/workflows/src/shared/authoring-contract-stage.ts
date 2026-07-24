/** Workflow authoring primitives, stage/session contracts, and task option types. */

import type { Static, TSchema } from "typebox";

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
export type WorkflowThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type WorkflowExecutionMode = "interactive" | "non_interactive";
export type WorkflowExitStatus = "completed" | "skipped" | "cancelled" | "blocked";
export type RunStatus = "pending" | "running" | "paused" | WorkflowExitStatus | "failed" | "killed";
export type WorkflowDetailsMode = "named" | "inspection" | "control";
export type WorkflowDetailsStatus = "accepted" | "running" | WorkflowExitStatus | "failed" | "killed" | "noop";
export type WorkflowAction = "list" | "get" | "inputs" | "run" | "status" | "interrupt" | "resume";

type WorkflowExitOutputValues<TOutputs extends WorkflowOutputValues = WorkflowOutputValues> = [keyof TOutputs] extends [never]
  ? Readonly<Record<string, never>>
  : Partial<TOutputs>;

export interface WorkflowExitOptions<TOutputs extends WorkflowOutputValues = WorkflowOutputValues> {
  readonly status?: WorkflowExitStatus;
  readonly reason?: string;
  readonly outputs?: WorkflowExitOutputValues<TOutputs>;
}

export interface WorkflowModelFallbackFields {
  /** Ordered model IDs to try after `model` fails; entries may use `:off|minimal|low|medium|high|xhigh|max` reasoning suffixes. */
  readonly fallbackModels?: readonly string[];
  /** Optional deprecated compatibility helper aligned to `fallbackModels`; ignored for entries with a reasoning suffix. */
  readonly fallbackThinkingLevels?: readonly string[];
}

export type WorkflowModelValue = string | object;
// Standalone authoring contract mirror of shared/types.ts StageUserMessageContent,
// whose runtime source of truth is derived from AgentSession["sendUserMessage"].
export interface StageTextContent {
  readonly type: "text";
  readonly text: string;
}
export interface StageImageContent {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}
export type StageUserMessageContent = string | readonly (StageTextContent | StageImageContent)[];
export type WorkflowStageResult<TSchemaDef extends TSchema | undefined = undefined> = [TSchemaDef] extends [TSchema]
  ? Static<TSchemaDef>
  : string;

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

export interface StageOptions<TSchemaDef extends TSchema | undefined = TSchema | undefined> extends WorkflowModelFallbackFields {
  /** Optional structured final-answer schema. When set, the stage receives a schema-specific final-answer tool. */
  readonly schema?: TSchemaDef;
  readonly model?: WorkflowModelValue;
  /**
   * Context-window token budget for the stage session. May also be expressed
   * per-model via a parenthesized token in a `model`/`fallbackModels` entry
   * (e.g. `github-copilot/claude-opus-4.8 (1m):xhigh`), which is preferred when
   * only specific fallbacks should use a larger window. Non-strict by default:
   * an unsupported value keeps the model's default window (see
   * `contextWindowStrict`).
   */
  readonly contextWindow?: number;
  /** Treat an unsupported `contextWindow` as an error instead of falling back to the model default. */
  readonly contextWindowStrict?: boolean;
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
  /**
   * Intercom home group for this stage session. A named string joins that group;
   * `true` auto-generates one shared UUID group per parallel set (all items in the
   * set share it). Absent inherits per the precedence chain (ultimately "default").
   * Only applied when the stage session actually has intercom access.
   */
  readonly group?: string | true;
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

/** Stable public identifier used to correlate replayed/overlapping turn lifecycle events. */
export type StageSessionTurnId = string | number;

/** Public lifecycle events emitted by stage session adapters for turn ownership. */
export type StageSessionEvent =
  | { readonly type: "agent_start"; readonly turnId?: StageSessionTurnId }
  | { readonly type: "agent_end"; readonly turnId?: StageSessionTurnId; readonly messages?: readonly WorkflowSerializableValue[] };

export interface StageSessionRuntime {
  prompt(text: string, options?: PromptOptions): Promise<string | void>;
  sendUserMessage?(content: StageUserMessageContent, options?: StageSendUserMessageOptions): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  /** True when this runtime implements a native queued-message pause gate. */
  readonly queuedMessagesPaused?: boolean;
  /** Optional native optimization that synchronously holds queued steer/follow-up work. */
  pauseQueuedMessages?(): void;
  /** Optional native release; true reports that raw queued work was released. */
  resumeQueuedMessages?(): boolean | Promise<boolean>;
  /**
   * Must emit `agent_start` when a submitted user-message turn takes ownership and
   * `agent_end` when that owned turn terminates. Registration may replay state
   * synchronously; synchronous untagged replays are snapshots only. An adapter
   * that can emit a later end for a replayed turn while a newer turn is active
   * must provide the same stable `turnId` on that replayed start and its end.
   * After registration returns, starts must represent new turns.
   */
  subscribe(listener: (event: StageSessionEvent) => void): () => void;
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

export type StageUserMessageDelivery = "steer" | "followUp";

export interface StageSendUserMessageOptions {
  readonly deliverAs?: StageUserMessageDelivery;
}

export interface StageContext<TSchemaDef extends TSchema | undefined = undefined> {
  readonly name: string;
  prompt(text: string, options?: StagePromptOptions): Promise<WorkflowStageResult<TSchemaDef>>;
  complete(text: string, options?: CompleteStageOpts): Promise<string>;
  sendUserMessage(content: StageUserMessageContent, options?: StageSendUserMessageOptions): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  subscribe(listener: (event: StageSessionEvent) => void): () => void;
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
  /** Parsed structured value when the task/stage was configured with `schema`. */
  readonly structured?: WorkflowSerializableValue;
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

export type WorkflowTaskSessionOptions = StageOptions & WorkflowTaskSessionFields;


export interface WorkflowRunChildOptions<TInputs extends WorkflowInputValues = WorkflowInputValues> {
  readonly inputs?: TInputs;
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

export interface WorkflowCompletedChildResult<TOutputs extends WorkflowOutputValues = WorkflowOutputValues> extends WorkflowSerializableObject {
  readonly workflow: string;
  readonly runId: string;
  readonly status: "completed";
  readonly exited: false;
  readonly outputs: TOutputs;
}

export interface WorkflowExitedChildResult<TOutputs extends WorkflowOutputValues = WorkflowOutputValues> extends WorkflowSerializableObject {
  readonly workflow: string;
  readonly runId: string;
  readonly status: WorkflowExitStatus;
  readonly exited: true;
  readonly outputs: Partial<TOutputs>;
  readonly exitReason?: string;
}

export type WorkflowChildResult<TOutputs extends WorkflowOutputValues = WorkflowOutputValues> =
  | WorkflowCompletedChildResult<TOutputs>
  | WorkflowExitedChildResult<TOutputs>;

