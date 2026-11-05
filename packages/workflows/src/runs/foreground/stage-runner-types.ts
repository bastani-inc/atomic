import type {
	AgentSession,
	CreateAgentSessionOptions,
	DetachedToolCall,
	DetachedToolResult,
	PromptOptions,
	SessionRecoveryReason,
	SessionRecoveryReport,
	SessionStore,
	SettingsManager,
} from "@bastani/atomic";
import type { StageWaitSnapshot } from "../../shared/authoring-contract-stage.js";
import type { WorkflowPendingStageRouteReadiness } from "../../shared/pending-stage-route-readiness.js";
import type { StageReleasePolicy } from "../../shared/stage-wait.js";
import type { StageReleaseError } from "../../shared/stage-wait-errors.js";
import type {
	CompleteStageOpts,
	StageContext,
	StageExecutionMeta,
	StageOptions,
	StageSendUserMessageOptions,
	StageUserMessageContent,
	WorkflowExecutionMode,
	WorkflowModelAttempt,
	WorkflowModelCatalogPort,
} from "../../shared/types.js";
import type { StageWakeDispatcher } from "./stage-wake-dispatcher.js";

/** How queued text is read: literal unless `expandPromptTemplates` asks for command/template expansion. */
export type StageQueuedTextOptions = Pick<StageSendUserMessageOptions, "expandPromptTemplates">;

/** An image part queued with steering or follow-up text. */
export type StageQueuedImage = Extract<Exclude<StageUserMessageContent, string>[number], { readonly type: "image" }>;

type WorkflowPendingStageDelivery = NonNullable<
	CreateAgentSessionOptions["orchestrationContext"]
>["pendingStageDelivery"];

type AgentStageSessionEvent = Parameters<AgentSession["subscribe"]>[0] extends (event: infer T) => void ? T : never;
export type StageSessionEvent = AgentStageSessionEvent & { readonly turnId?: string | number };

// External Pi hosts may predate the optional agent retry cap.
export type WorkflowRetrySettings = Omit<
	ReturnType<SettingsManager["getRetrySettings"]>,
	"maxAgentDelayMs" | "fallbackOnContentFilter"
> & {
	readonly maxAgentDelayMs?: number;
	readonly fallbackOnContentFilter?: boolean;
};

export type WorkflowSettingsManager = {
	getRetrySettings?(): WorkflowRetrySettings;
};

export type StageUserMessageDeliveryAction = "prompt" | "steer" | "followUp" | "handled";

/** Internal session preparation and side-effect-free eligibility boundary. */
export interface StageUserMessagePreparation {
	readonly sessionId?: string;
	readonly beforePreparation?: () => void;
}

export interface StageUserMessageDeliveryHooks {
	readonly beforeDelivery?: () => void;
	/** Releases serialized admission once an idle prompt synchronously owns the turn. */
	readonly promptStarted?: () => void;
	readonly delivered?: (action: StageUserMessageDeliveryAction) => void;
}

export interface StageSessionRuntime {
	prompt(text: string, options?: PromptOptions): Promise<void> | Promise<string | undefined>;
	sendUserMessage?(
		content: StageUserMessageContent,
		options?: StageSendUserMessageOptions & { readonly __workflowDelivery?: StageUserMessageDeliveryHooks },
	): Promise<void>;
	sealWorkflowStageGeneration?(): void;
	closeWorkflowStageGeneration?(): Promise<void>;
	transferWorkflowStageDeliveriesTo?(target: object): void;
	/** True when this runtime implements a native queued-message pause gate. */
	readonly queuedMessagesPaused?: boolean;
	/** Optional native optimization that synchronously holds queued work. */
	pauseQueuedMessages?(): void;
	/** Optional native release; calls `beforeRelease` at the final synchronous boundary. */
	resumeQueuedMessages?(beforeRelease?: () => void): boolean | Promise<boolean>;
	/** Optional owned-execution hold: block launches synchronously, cancel and drain before resolving. */
	pauseTasks?(): Promise<void>;
	/** Restore interrupted children and replay pending deliveries of a reopened session, after binding (#3760). */
	startPendingRecovery?(reason: SessionRecoveryReason): Promise<SessionRecoveryReport>;
	/** Reopen launches only; cancelled executions must never restart. */
	resumeTasks?(): void;
	steer(
		text: string,
		images?: readonly StageQueuedImage[],
		options?: StageQueuedTextOptions,
	): Promise<void> | Promise<"handled" | "queued">;
	followUp(
		text: string,
		images?: readonly StageQueuedImage[],
		options?: StageQueuedTextOptions,
	): Promise<void> | Promise<"handled" | "queued">;
	subscribe(listener: (event: StageSessionEvent) => void): () => void;
	readonly sessionFile: string | undefined;
	readonly sessionId: string;
	setModel(model: Parameters<AgentSession["setModel"]>[0]): Promise<void>;
	setThinkingLevel(level: Parameters<AgentSession["setThinkingLevel"]>[0]): void | Promise<void>;
	cycleModel(): ReturnType<AgentSession["cycleModel"]>;
	cycleThinkingLevel(): ReturnType<AgentSession["cycleThinkingLevel"]>;
	readonly agent: AgentSession["agent"];
	readonly model: AgentSession["model"];
	readonly thinkingLevel: AgentSession["thinkingLevel"];
	readonly messages: AgentSession["messages"];
	readonly isStreaming: AgentSession["isStreaming"];
	/** Number of SDK-level queued steering/follow-up messages, when supported. */
	readonly pendingMessageCount?: number;
	/**
	 * Pending queued text this session already holds, when the runtime exposes
	 * it. Read once at attach, because a session created with a queue — one
	 * adopting a retired stage session's transferred messages, or a retained
	 * session reopened for post-mortem chat — announced that queue before any
	 * listener of this stage could be bound to it.
	 */
	getSteeringMessages?(): readonly string[];
	getFollowUpMessages?(): readonly string[];
	/** Settings manager supplied by the Atomic SDK when the adapter did not pre-create one. */
	readonly settingsManager?: WorkflowSettingsManager;
	navigateTree: AgentSession["navigateTree"];
	compact: AgentSession["compact"];
	abortCompaction(): void;
	abort(): Promise<void>;
	dispose(): void | Promise<void>;
	getLastAssistantText?: () => string | undefined;
	/** Detachable tool calls (see `AgentSession.setToolDetachment`); absent on runtimes that cannot detach. */
	setToolDetachment?(policy: { readonly afterMs: number } | undefined): void;
	takeDetachedToolCalls?(): DetachedToolCall[];
	hasPendingDetachedTurn?(): boolean;
	redispatchDetachedToolCalls?(): DetachedToolCall[];
	resumeDetachedTurn?(results: readonly DetachedToolResult[]): Promise<void>;
}

/**
 * The executor side of a stage that waits with its session released. The controller releases and reopens the
 * session; these hooks keep the stage's status, durable record, admission slot and listeners in step.
 */
export interface StageWaitHooks {
	/** When a waiting stage releases its session; `undefined` keeps it resident for its whole wait. */
	readonly policy: StageReleasePolicy | undefined;
	readonly dispatcher: StageWakeDispatcher;
	readonly wakeKey: string;
	/** The session is gone: record the stage as waiting, durably, and give back its admission and listeners. */
	enter(wait: StageWaitSnapshot): Promise<void>;
	/**
	 * The detached calls the stage waits on delivered their results: record them with the wait, durably, before the
	 * session reopens, so a resume continues the turn from them instead of running the calls again.
	 */
	recordResults(wait: StageWaitSnapshot, results: readonly DetachedToolResult[]): Promise<void>;
	/**
	 * The stage's record no longer needs the recorded results: the transcript the store holds has them, or a resumed
	 * stage's transcript no longer waits on the calls they answer.
	 */
	resultsInTranscript(): void;
	/**
	 * The stage is reopening its session: take its admission and listeners back and mark it running. Called before
	 * each attempt to reopen.
	 */
	leave(wait: StageWaitSnapshot): Promise<void>;
	/** An attempt to reopen the session failed: give the admission and listeners back and show the stage waiting again. */
	reopenFailed(wait: StageWaitSnapshot): Promise<void>;
	/** The session reopened: record the end of the wait, durably, before the stage goes on. */
	rehydrated(wait: StageWaitSnapshot): Promise<void>;
	/** The stage keeps its session for every wait, for the reason given; reported once per run. */
	resident(reason: StageReleaseError): void;
}

export type StageSessionCreateOptions = CreateAgentSessionOptions & Pick<StageOptions, "mcp" | "fallbackModels">;

export interface StageSessionCreateResult {
	readonly session: StageSessionRuntime;
	readonly settingsManager?: WorkflowSettingsManager;
}

export interface AgentSessionAdapter {
	create(
		options: StageSessionCreateOptions,
		meta?: StageExecutionMeta,
	): Promise<StageSessionRuntime | StageSessionCreateResult>;
}

export interface StageModelFallbackMeta {
	readonly model?: string;
	readonly thinkingLevel?: string;
	readonly routerSelection?: import("@bastani/atomic").ModelRouterOutput;
	readonly attemptedModels?: readonly string[];
	readonly modelAttempts?: readonly WorkflowModelAttempt[];
	readonly rateLimits?: readonly import("../../shared/types.js").WorkflowProviderRateLimit[];
	readonly warnings?: readonly string[];
}

export interface PromptAdapter {
	prompt(text: string, meta?: StageExecutionMeta): Promise<string>;
}

export interface CompleteAdapter {
	complete(text: string, opts?: CompleteStageOpts, meta?: StageExecutionMeta): Promise<string>;
}

export interface StageAdapters {
	sessionStore?: import("@bastani/atomic").SessionStore;
	/**
	 * True once the host session that owns the run is closing. A closed-session
	 * error raised then is a resumable suspension, not a failure of the run (#3742).
	 */
	ownerSessionClosing?: () => boolean;
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
	/** Runtime-owned home group shared by this top-level workflow invocation. */
	workflowIntercomGroup?: string;
	/** AbortSignal from the executor's own AbortController — forwarded to session adapter metadata. */
	signal?: AbortSignal;
	/** Optional model catalog used for fallback validation/resolution. */
	models?: WorkflowModelCatalogPort;
	/** Runtime execution mode forwarded to stage session adapters. */
	executionMode?: WorkflowExecutionMode;
	/** Host-resolved non-default session directory inherited by stages without explicit sessionDir. */
	defaultSessionDir?: string;
	defaultCwd?: string;
	/** Internal: notifies the executor when an in-flight fallback changes model metadata. */
	onModelFallbackMetaChange?: (meta: StageModelFallbackMeta) => void;
	/** Internal: persist stage-session identity once the SDK has created its path. */
	onSessionReady?: () => void | Promise<void>;
	/** Internal: observes every event from each attached session, including fallback replacements. */
	onSessionEvent?: (event: StageSessionEvent) => void;
	/** Internal phase/age observation, including cancellation with retained ownership. */
	onStartupChange?: (snapshot: import("../../shared/stage-startup.js").StageStartupSnapshot) => void;
	/** Internal: acknowledged owner authority required before session_start can register a live route. */
	routeAuthorityReady?: () => WorkflowPendingStageRouteReadiness | undefined;
	/** Internal durable pre-start message bridge consumed by the intercom extension. */
	pendingStageDelivery?: WorkflowPendingStageDelivery;
	/** Internal: release the session while the stage only waits. Absent keeps every wait resident. */
	waiting?: StageWaitHooks;
}

export interface InternalStageContext extends StageContext {
	/** Internal executor continuation of the current output generation. */
	__continuePrompt(text: string): Promise<string>;
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
	__ensureSessionFromId(sessionId: string): Promise<void>;
	/** Internal idle-aware delivery primitive; returns the action actually taken. */
	__sendUserMessage(
		content: StageUserMessageContent,
		options?: StageSendUserMessageOptions,
		beforeDelivery?: () => void,
		preparation?: StageUserMessagePreparation,
	): Promise<StageUserMessageDeliveryAction>;
	/**
	 * Internal: subscribe to workflow-owned delivery lifecycle facts for this
	 * stage. An accepted idle delivery reports `delivery_start` before the public
	 * `agent_start` reaches subscribers, so an attached chat can paint Working
	 * for the whole turn rather than only after the SDK event queue drains.
	 */
	__subscribeDeliveryActivity(
		listener: (event: import("./stage-delivery-activity.js").StageDeliveryActivityEvent) => void,
	): () => void;
	/**
	 * Internal: synchronously reject new detached traffic without waiting for active work. `closedForGood` marks a
	 * stage that finished or whose run ended, rather than one interrupted, so its subagent children end with it.
	 */
	__sealGeneration(closedForGood?: boolean): void;
	/** Internal: atomically stop detached traffic admission and drain admitted work; `closedForGood` as for seal. */
	__closeGeneration(closedForGood?: boolean): Promise<string | undefined>;
	/** Internal: snapshot of currently-known SDK session metadata. */
	__sessionMeta(): { sessionId: string | undefined; sessionFile: string | undefined };
	/** Internal: live coding-agent session when the adapter returned one. */
	__agentSession(): AgentSession | undefined;
	/** Internal: SDK queued steering/follow-up message count, when available. */
	__pendingMessageCount(): number;
	/** Internal: store of a caller-supplied session manager, which outlives the live session. */
	__persistedSessionStore(): SessionStore | undefined;
	/** Internal: synchronous; true when no message, turn, retry, pause, or queue work needs the live session. */
	__idleForRelease(): boolean;
	/** Internal: true while a message, the stage's own prompt included, holds or waits for the turn loop. */
	__turnLoopBusy?(): boolean;
	/** Internal: true when the stage's generation closed while the stage still ran (not by its own finish). */
	__generationClosedUnderStage?(): boolean;
	/**
	 * Internal: queues text into the turn the stage's current session is running, without waiting
	 * for the stage's session to be ready; false when no turn runs.
	 */
	__queueIntoLiveTurn?(text: string, kind: "steer" | "followUp", options?: StageQueuedTextOptions): Promise<boolean>;
	/** Internal: `steer()`/`followUp()` with explicit text semantics (see `StageQueuedTextOptions`). */
	__queueUserText?(text: string, kind: "steer" | "followUp", options?: StageQueuedTextOptions): Promise<void>;
	/** Internal: selected/effective model and fallback attempt metadata. */
	__modelFallbackMeta(): StageModelFallbackMeta;
	/** Internal: register a controlled-pause request. */
	__requestPause(): Promise<void>;
	/** Internal: complete a pending controlled pause and report its released raw work. */
	__resume(
		message?: string,
		beforeResolve?: (result: import("./stage-runner-pause.js").StageSessionPauseResumeResult) => void,
		beforeRelease?: () => void,
	): Promise<import("./stage-runner-pause.js").StageSessionPauseResumeResult>;
	/** Internal: true while a controlled pause is in flight. */
	__isPaused(): boolean;
	/** Internal: true once a schema-backed prompt captured its final structured output. */
	__structuredOutputFinalized(): boolean;
	/** Internal: true while the stage waits with its session released. */
	__isReleased?(): boolean;
	/**
	 * Internal: true while the stage waits on a tool call with its session released. A message sent meanwhile is held
	 * for the turn the results continue, as a message to a streaming stage joins its turn.
	 */
	__holdsInput?(): boolean;
	/** Internal: release a stage the workflow holds idle; false when it is busy or may not release. */
	__releaseIdle?(): Promise<boolean>;
	/** Internal: release the stage while its readiness question waits on a human; false when it cannot. */
	__releaseForPrompt?(): Promise<boolean>;
	/** Internal: when the stage last became idle with its session resident; undefined while busy or released. */
	__idleSince?(): number | undefined;
	/** Internal: start a durably resumed stage released, reopening `sessionId` only when a live call needs it. */
	__startReleased?(wait: StageWaitSnapshot, sessionId: string): void;
}

/** The stage runner's own context: a live stage can release its session while it waits and reopen it afterwards. */
export type LiveInternalStageContext = InternalStageContext &
	Required<
		Pick<
			InternalStageContext,
			"__isReleased" | "__holdsInput" | "__releaseIdle" | "__releaseForPrompt" | "__idleSince" | "__startReleased"
		>
	>;

export type AgentSessionConsumer = "prompt" | "complete";
