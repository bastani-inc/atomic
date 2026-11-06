/** Workflow authoring primitives, stage/session contracts, and task option types. */

import type {
	AgentSession,
	AgentSessionEvent,
	BoundWorkspace,
	DecisionQuestions,
	DecisionRequest,
	DecisionResult,
	ModelConstraints,
	ModelRoute,
	ModelRouterOutput,
	RoutingInferenceBounds,
	TaskNeeds,
	Workspace,
	WorkspaceChangeSet,
} from "@bastani/atomic";
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
export type WorkflowExitStatus = "completed" | "skipped" | "cancelled" | "blocked" | "failed";
export type RunStatus = "pending" | "running" | "paused" | WorkflowExitStatus | "killed";

/**
 * Who performed a workflow lifecycle action. Mirrors the store-side union; the
 * authoring contract keeps its own copy so it stays independent of store types.
 */
export type WorkflowActor = "user" | "agent";
export type WorkflowDetailsMode = "named" | "inspection" | "control";
export type WorkflowDetailsStatus = "accepted" | "running" | WorkflowExitStatus | "killed" | "noop";
export type WorkflowAction = "list" | "get" | "inputs" | "run" | "status" | "pause" | "resume";

type WorkflowExitOutputValues<TOutputs extends WorkflowOutputValues = WorkflowOutputValues> = [keyof TOutputs] extends [
	never,
]
	? Readonly<Record<string, never>>
	: Partial<TOutputs>;

export interface WorkflowExitOptions<TOutputs extends WorkflowOutputValues = WorkflowOutputValues> {
	readonly status?: WorkflowExitStatus;
	readonly reason?: string;
	/** Failed exits are non-resumable by default; set this only when retry is intended. */
	readonly resumable?: boolean;
	readonly outputs?: WorkflowExitOutputValues<TOutputs>;
}

export interface WorkflowModelFallbackFields {
	/** Ordered model IDs to try after `model` fails; entries may use `:off|minimal|low|medium|high|xhigh|max` reasoning suffixes. */
	readonly fallbackModels?: readonly string[];
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

export interface WorkflowProviderRateLimit extends WorkflowSerializableObject {
	readonly provider: string;
	readonly rateLimitCount: number;
	readonly cooldownUntil: number;
	readonly waitingUntil?: number;
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
	routeModel?(input: {
		task: string;
		stageName: string;
		constraints: readonly ModelConstraints[];
		signal?: AbortSignal;
		selection?: ModelRouterOutput;
		taskNeeds?: TaskNeeds;
		/** The stage's own constraints set a provider list, replacing the user's provider settings. */
		overrideProviderSettings?: boolean;
		/** Deadline and concurrency limit the stage owns for routing inference. */
		inference?: RoutingInferenceBounds;
	}): Promise<ModelRoute>;
	/**
	 * The host's decision service, bound to the user's `decisionModel`: `decide()` with the host's settings, model
	 * registry and current chat model. Absent when the host has no decision model.
	 */
	decide?<const Q extends DecisionQuestions>(request: WorkflowDecisionRequest<Q>): Promise<DecisionResult<Q>>;
	/** The `workflows.autoAdvanceAfterSteer` setting, read when a readiness decision is due. */
	autoAdvanceAfterSteer?(): boolean;
	readonly currentModel?: WorkflowModelValue;
	readonly preferredProvider?: string;
	recordWarning?: (warning: string) => void;
}

/** A decision a workflow asks of the host's decision model; the host supplies settings, registry and current model. */
export type WorkflowDecisionRequest<Q extends DecisionQuestions = DecisionQuestions> = Pick<
	DecisionRequest<Q>,
	"state" | "questions" | "instructions" | "deadline" | "signal" | "requireProbabilities" | "model"
>;

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
	/**
	 * The call's work does not need the stage session once started, and running it again with the same call id and
	 * arguments after a restart is safe. A call still running after the stage's `releaseWhenWaiting` threshold then
	 * lets the stage release its session until the result arrives. A function decides per call from the call's
	 * arguments: only the calls it accepts may detach.
	 */
	readonly detachable?: boolean | { decide(params: Static<TParams>): boolean }["decide"];
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
}

/**
 * Whether a stage that is only waiting releases its session and admission slot. `true` releases after the default
 * threshold ({@link DEFAULT_RELEASE_WHEN_WAITING_AFTER_MS}), `false` keeps the stage resident for its whole wait, and
 * `{ afterMs }` sets the threshold. Waits shorter than the threshold stay inline.
 */
export type ReleaseWhenWaiting = boolean | { readonly afterMs: number };

/**
 * Whether a run whose stages only wait on detached tool calls is evicted from memory and rebuilt by replaying its
 * journal when a result arrives. `true` evicts after the default quiet period
 * ({@link DEFAULT_EVICT_WHEN_WAITING_AFTER_MS}), `{ afterMs }` sets it, and `false` (the default) keeps the run
 * resident.
 */
export type EvictWhenWaiting = boolean | { readonly afterMs: number };

/**
 * What a waiting stage waits on, with its session released:
 * - `tool`: a detached tool call; the stage is `waiting` and reopens when the result arrives.
 * - `release`: an explicit `stage.release()`; the stage is `waiting` until `rehydrate()` or its next message reopens it.
 * - `prompt`: a human answer to the stage's readiness question; the stage stays `awaiting_input` and reopens when
 *   the answer arrives.
 * - `idle`: the workflow held the stage without using it (for example while it awaited a child workflow or a
 *   run-level prompt) for longer than its `releaseWhenWaiting` threshold; the stage is `waiting` until its next
 *   prompt, message or `rehydrate()`.
 */
export type StageWaitKind = "tool" | "release" | "prompt" | "idle";

/** A tool call a waiting stage waits on. */
export interface StageWaitToolCall extends WorkflowSerializableObject {
	readonly toolCallId: string;
	readonly toolName: string;
}

/** Why a stage is `waiting`, stored with the stage so the wait survives a restart. */
export interface StageWaitSnapshot extends WorkflowSerializableObject {
	readonly kind: StageWaitKind;
	/** When the stage released its session (epoch milliseconds). */
	readonly since: number;
	/** The calls the stage waits on, for `kind: "tool"`. */
	readonly toolCalls?: readonly StageWaitToolCall[];
	/**
	 * How many of the stage's prompts and messages had finished when it released its session. A resumed run answers
	 * that many replayed calls of the stage from its record without asking the model again.
	 */
	readonly promptsCompleted?: number;
}

/** Stage lifecycle events on the SDK event stream (`RunOpts.onStageLifecycleEvent`). */
export type StageLifecycleEvent =
	| {
			readonly type: "stage_waiting";
			readonly stageId: string;
			readonly stageName: string;
			readonly wait: StageWaitSnapshot;
	  }
	| {
			readonly type: "stage_rehydrated";
			readonly stageId: string;
			readonly stageName: string;
			readonly wait: StageWaitSnapshot;
			/** How long the stage waited released, in milliseconds. */
			readonly waitedMs: number;
	  };

export interface StageOptions<TSchemaDef extends TSchema | undefined = TSchema | undefined>
	extends WorkflowModelFallbackFields {
	/** Optional structured final-answer schema. When set, the stage receives a schema-specific final-answer tool. */
	readonly schema?: TSchemaDef;
	/**
	 * Wall-clock limit in milliseconds for each `structured_output` decision of a schema-backed stage, covering
	 * every repair attempt, transport retry and model fallback together. Defaults to the session's
	 * `httpIdleTimeoutMs` setting (10 minutes unless changed). A decision that overruns fails with an error naming
	 * the deadline. Ignored without `schema`.
	 */
	readonly schemaTimeoutMs?: number;
	readonly model?: WorkflowModelValue;
	/** Hard restrictions for automatic model selection and its execution fallbacks. */
	readonly modelConstraints?: ModelConstraints;
	/** What the author already knows about the task, for `model: "auto"`; routing asks only for the rest. */
	readonly taskNeeds?: TaskNeeds;
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
	readonly forkFromSessionId?: string;
	/**
	 * With `context: "fork"` and `forkFromSessionId`, start the stage session from this exact entry of the
	 * source session: the new session holds the branch from the session's root to the entry. A missing entry
	 * fails stage setup with `ForkEntryNotFoundError`.
	 */
	readonly forkFromEntryId?: string;
	readonly gitWorktreeDir?: string;
	readonly baseBranch?: string;
	/**
	 * Repository binding from `workspace({ … })`. The stage session runs in the bound worktree (a `cwd` must lie inside
	 * it), and a read-only workspace removes and refuses file-writing tools. Cannot be combined with `gitWorktreeDir`
	 * or a task's `worktree: true`.
	 */
	readonly workspace?: Workspace | BoundWorkspace;
	readonly sessionDir?: string;
	/**
	 * Intercom home group for this stage session. A named string joins that group;
	 * `true` auto-generates one shared UUID group per parallel set (all items in the
	 * set share it). Absent inherits per the precedence chain (ultimately "default").
	 * Only applied when the stage session actually has intercom access.
	 */
	readonly group?: string | true;
	/**
	 * Release the stage's session and admission slot while it only waits — on a long tool call, on a human answer to
	 * its readiness question, or held idle by the workflow — and reopen it from the session store when it is needed
	 * again. Defaults to the run's `releaseWhenWaiting`, then to `true`.
	 */
	readonly releaseWhenWaiting?: ReleaseWhenWaiting;
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
	appendEntry(
		type: string,
		payload: Record<string, unknown>,
	): string | void | Promise<string | undefined> | Promise<void>;
	setLabel?(entryId: string, label: string): void | Promise<void>;
	appendCustomMessageEntry?(
		content: string,
		meta?: Record<string, unknown>,
	): string | void | Promise<string | undefined> | Promise<void>;
}

/** Stable public identifier used to correlate replayed/overlapping turn lifecycle events. */
export type StageSessionTurnId = string | number;

/** Public lifecycle events emitted by stage session adapters for turn ownership. */
export type StageSessionEvent =
	| { readonly type: "agent_start"; readonly turnId?: StageSessionTurnId }
	| {
			readonly type: "agent_end";
			readonly turnId?: StageSessionTurnId;
			readonly messages?: readonly WorkflowSerializableValue[];
	  };

export interface StageSessionRuntime {
	/** Resolves when the prompted turn settles. The runtime ignores any resolved value; Atomic's `AgentSession` resolves `void`. */
	prompt(text: string, options?: PromptOptions): Promise<void> | Promise<string | undefined>;
	sendUserMessage?(content: StageUserMessageContent, options?: StageSendUserMessageOptions): Promise<void>;
	/** Atomic's `AgentSession` reports whether the text was handled immediately or queued. */
	steer(text: string): Promise<void> | Promise<"handled" | "queued">;
	followUp(text: string): Promise<void> | Promise<"handled" | "queued">;
	/** True when this runtime implements a native queued-message pause gate. */
	readonly queuedMessagesPaused?: boolean;
	/** Optional native optimization that synchronously holds queued steer/follow-up work. */
	pauseQueuedMessages?(): void;
	/** Optional native release; calls `beforeRelease` at final admission. */
	resumeQueuedMessages?(beforeRelease?: () => void): boolean | Promise<boolean>;
	/**
	 * Must emit `agent_start` when a submitted user-message turn takes ownership and
	 * `agent_end` when that owned turn terminates. Registration may replay state
	 * synchronously; synchronous untagged replays are snapshots only. An adapter
	 * that can emit a later end for a replayed turn while a newer turn is active
	 * must provide the same stable `turnId` on that replayed start and its end.
	 * After registration returns, starts must represent new turns. Atomic's
	 * `AgentSession` may deliver its full event stream; turn ownership only reads
	 * `agent_start` and `agent_end`.
	 */
	subscribe(listener: (event: StageSessionEvent | AgentSessionEvent) => void): () => void;
	readonly sessionFile: string | undefined;
	readonly sessionId: string;
	/** Atomic's `AgentSession` members are accepted alongside serializable stand-ins for custom adapters. */
	setModel(model: WorkflowSerializableValue | Parameters<AgentSession["setModel"]>[0]): Promise<void>;
	setThinkingLevel(level: WorkflowThinkingLevel): void | Promise<void>;
	cycleModel(): WorkflowSerializableValue | ReturnType<AgentSession["cycleModel"]>;
	cycleThinkingLevel(): WorkflowThinkingLevel | undefined | Promise<WorkflowThinkingLevel | undefined>;
	readonly agent: WorkflowSerializableValue | AgentSession["agent"];
	readonly model: WorkflowSerializableValue | AgentSession["model"];
	readonly thinkingLevel: WorkflowThinkingLevel | undefined;
	readonly messages: readonly WorkflowSerializableValue[] | AgentSession["messages"];
	readonly isStreaming: boolean;
	readonly pendingMessageCount?: number;
	navigateTree(
		targetId: string,
		options?: {
			readonly summarize?: boolean;
			readonly customInstructions?: string;
			readonly replaceInstructions?: boolean;
			readonly label?: string;
		},
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
	create(
		options: StageSessionCreateOptions,
		meta?: StageExecutionMeta,
	): Promise<StageSessionRuntime | StageSessionCreateResult>;
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
	setThinkingLevel(level: WorkflowThinkingLevel): void | Promise<void>;
	cycleModel(): Promise<object | undefined>;
	cycleThinkingLevel(): WorkflowThinkingLevel | undefined | Promise<WorkflowThinkingLevel | undefined>;
	/** Throws `StageReleasedError` (`stage-released`) while the stage's session is released. */
	readonly agent: object;
	/** While the stage's session is released: the model it had when it was released. */
	readonly model: WorkflowModelValue | undefined;
	/** While the stage's session is released: the level it had when it was released, or the one set since. */
	readonly thinkingLevel: WorkflowThinkingLevel | undefined;
	/** Throws `StageReleasedError` (`stage-released`) while the stage's session is released; see `readMessages()`. */
	readonly messages: readonly object[];
	/** False while the stage's session is released. */
	readonly isStreaming: boolean;
	/**
	 * The stage's messages, as `messages` returns them. While the session is released they are read from the session
	 * store, and the session stays released.
	 */
	readMessages(): Promise<readonly object[]>;
	navigateTree(
		targetId: string,
		options?: {
			readonly summarize?: boolean;
			readonly customInstructions?: string;
			readonly replaceInstructions?: boolean;
			readonly label?: string;
		},
	): Promise<{ readonly editorText?: string; readonly cancelled: boolean }>;
	compact(): Promise<object>;
	abortCompaction(): void;
	abort(): Promise<void>;
	/**
	 * Give up the stage's session while the workflow holds the stage across a long wait between prompts. The stage is
	 * `waiting` until `rehydrate()` or the next prompt reopens it from the session store.
	 */
	release(): Promise<void>;
	/** Reopen a released stage's session from the session store. Does nothing when the stage is resident. */
	rehydrate(): Promise<void>;
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
	readonly thinkingLevel?: string;
	readonly routerSelection?: ModelRouterOutput;
	readonly attemptedModels?: readonly string[];
	readonly modelAttempts?: readonly WorkflowModelAttempt[];
	readonly rateLimits?: readonly WorkflowProviderRateLimit[];
	readonly warnings?: readonly string[];
	/** Committed changes of a task bound to a `workspace`, from the binding's base commit to its branch head. */
	readonly changeSet?: WorkspaceChangeSet;
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
	/** Static discovery only: literal conservative stage names/globs for an otherwise opaque step array. */
	readonly possibleStageNames?: readonly string[];
}

/**
 * Error thrown by `ctx.parallel(..., { failFast: false })` after every step has settled and at least one
 * failed. `partialResults` has one entry per step in step order; a step that failed or never ran is `undefined`.
 */
export interface WorkflowParallelFailure<TResult = WorkflowTaskResult> extends AggregateError {
	readonly partialResults: readonly (TResult | undefined)[];
}

export type WorkflowTaskSessionOptions = StageOptions & WorkflowTaskSessionFields;

export interface WorkflowRunChildOptions<TInputs extends WorkflowInputValues = WorkflowInputValues> {
	readonly inputs?: TInputs;
	readonly stageName?: string;
	readonly budget?: import("./budget.js").WorkflowBudget;
	readonly workspace?: Workspace;
}

type WorkflowRequiredKeys<T extends object> = {
	[K in keyof T]-?: Record<never, never> extends Pick<T, K> ? never : K;
}[keyof T];

export type WorkflowRunChildOptionsArgument<TInputs extends WorkflowInputValues = WorkflowInputValues> = [
	WorkflowRequiredKeys<TInputs>,
] extends [never]
	? WorkflowRunChildOptions<TInputs>
	: WorkflowRunChildOptions<TInputs> & { readonly inputs: TInputs };

export type WorkflowRunChildArgs<TInputs extends WorkflowInputValues = WorkflowInputValues> = [
	WorkflowRequiredKeys<TInputs>,
] extends [never]
	? readonly [options?: WorkflowRunChildOptionsArgument<NoInfer<TInputs>>]
	: readonly [options: WorkflowRunChildOptionsArgument<NoInfer<TInputs>>];

export interface WorkflowCompletedChildResult<TOutputs extends WorkflowOutputValues = WorkflowOutputValues>
	extends WorkflowSerializableObject {
	readonly workflow: string;
	readonly runId: string;
	readonly status: "completed";
	readonly exited: false;
	readonly outputs: TOutputs;
	/** Committed changes of a child bound to a `workspace`. */
	readonly changeSet?: WorkspaceChangeSet;
}

export interface WorkflowExitedChildResult<TOutputs extends WorkflowOutputValues = WorkflowOutputValues>
	extends WorkflowSerializableObject {
	readonly workflow: string;
	readonly runId: string;
	readonly status: WorkflowExitStatus;
	readonly exited: true;
	readonly outputs: Partial<TOutputs>;
	readonly exitReason?: string;
	/** Committed changes of a child bound to a `workspace`. */
	readonly changeSet?: WorkspaceChangeSet;
}

export type WorkflowChildResult<TOutputs extends WorkflowOutputValues = WorkflowOutputValues> =
	| WorkflowCompletedChildResult<TOutputs>
	| WorkflowExitedChildResult<TOutputs>;
