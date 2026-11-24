/**
 * Configuration, execution option, display, and event bus types.
 */

import type { AgentSessionEvent, SessionManager, SessionStore } from "@bastani/atomic";
import type { AgentToolResult } from "@bastani/atomic-agent-core";
import type { CwdVerdict } from "./launch-cwd.js";
import type { CandidateModelResolver } from "./model-resolution.js";

/** The queueing surface of a stub test session: queued messages are read after the current prompt, steering first. */
export interface TestSessionQueue {
	steer(text: string): Promise<void>;
	followUp(text: string): Promise<void>;
	/** Starts a turn on the idle session, as a message delivered to an interrupted child does. */
	prompt(text: string): Promise<void>;
}

import type {
	ArtifactConfig,
	ControlConfig,
	ControlEvent,
	Details,
	MaxOutputConfig,
	OutputMode,
	ResolvedControlConfig,
	SingleResult,
} from "./types-results.js";

// ============================================================================
// Display
// ============================================================================

export type DisplayItem =
	| { type: "text"; text: string }
	| { type: "tool"; name: string; args: Record<string, unknown> };

// ============================================================================
// Error Handling
// ============================================================================

export interface ErrorInfo {
	hasError: boolean;
	exitCode?: number;
	errorType?: string;
	details?: string;
}

export interface IntercomEventBus {
	on(channel: string, handler: (data: unknown) => void): () => void;
	emit(channel: string, data: unknown): void;
}

export const INTERCOM_DETACH_REQUEST_EVENT = "pi-intercom:detach-request";
export const PARENT_ASK_HANDOFF_REQUEST_EVENT = "subagent:parent-ask-handoff-request";
export const SUBAGENT_COMPLETE_EVENT = "subagent:complete";
/** The execution has ended, but Atomic has not yet released its temporary worktree. */
export const SUBAGENT_FINISHING_EVENT = "subagent:finishing";
export const INTERCOM_DETACH_RESPONSE_EVENT = "pi-intercom:detach-response";
export const SUBAGENT_CONTROL_EVENT = "subagent:control-event";
export const SUBAGENT_CONTROL_INTERCOM_EVENT = "subagent:control-intercom";
export const SUBAGENT_RESULT_INTERCOM_EVENT = "subagent:result-intercom";
export const SUBAGENT_TERMINAL_ORDERING_BARRIER_EVENT = "subagent:terminal-ordering-barrier";
export const SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT = "subagent:result-intercom-delivery";

export type ParentAskKind = "decision" | "interview" | "intercom";

export interface ParentAskInterviewQuestion extends Record<string, unknown> {
	id: string;
	type: "single" | "multi" | "text" | "image" | "info";
	question: string;
	options?: unknown[];
}

export interface ParentAskInterviewRequest extends Record<string, unknown> {
	title?: string;
	description?: string;
	questions: ParentAskInterviewQuestion[];
}

export interface ParentAskAttachment {
	type: "file" | "snippet" | "context";
	name: string;
	content: string;
	language?: string;
}

export interface ParentAskHandoffRequest {
	runId: string;
	index: number;
	agent: string;
	childIntercomTarget: string;
	orchestratorTarget: string;
	kind: ParentAskKind;
	question: string;
	attachments?: ParentAskAttachment[];
	interview?: ParentAskInterviewRequest;
	resolvedTargetId?: string;
	/** Original delegated task supplied by the parent model for a fresh-child handoff. */
	taskContext?: string;
	claimed: boolean;
}

// ============================================================================
// Execution Options
// ============================================================================

export interface RunSyncOptions {
	runningCapacity?: number;
	getChildSessionOptions?: import("@bastani/atomic").ExtensionContext["getChildSessionOptions"];
	resourceLoaderInheritanceSnapshot?: import("@bastani/atomic").DefaultResourceLoaderInheritanceSnapshot;
	cwd?: string;
	cwdVerdict?: CwdVerdict;
	signal?: AbortSignal;
	interruptSignal?: AbortSignal;
	allowIntercomDetach?: boolean;
	intercomEvents?: IntercomEventBus;
	onDetachedExit?: (result: SingleResult) => void;
	/** Observation-only group yield after an exact child Intercom commit; never execution cancellation. */
	intercomDetachSignal?: AbortSignal;
	/** Releases foreground observations, including queued tasks, without ending any child execution. */
	onIntercomDetachCommit?: () => void;
	/** Single-child only: claims an exact blocking ask and ends it with a fresh-child handoff. */
	onParentAskHandoff?: (request: ParentAskHandoffRequest) => void;
	onUpdate?: (r: AgentToolResult<Details>) => void;
	onControlEvent?: (event: ControlEvent) => void;
	controlConfig?: ResolvedControlConfig;
	intercomSessionName?: string;
	orchestratorIntercomTarget?: string;
	/** Typed supervisor capability issued for this child; never read from environment. */
	supervisorAuthorization?: {
		capability: string;
		supervisorSessionId: string;
		childName: string;
	};
	/** Resolved intercom home group for the spawned child (explicit subagent group or inherited session group). */
	intercomGroup?: string;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig?: ArtifactConfig;
	runId: string;
	index?: number;
	sessionDir?: string;
	/** Create the child's own session in this store, its parent's, rather than as a file in `sessionDir`. */
	sessionStore?: SessionStore;
	sessionManager?: SessionManager;
	/** Reopen `sessionManager` as this child's own interrupted session rather than a fork. */
	resumeSession?: boolean;
	/** Queued as follow-ups to the task, in order: a resumed child's held messages, then its continuation. Delivered as written. */
	resumeFollowUps?: readonly string[];
	/** The task is a resume's message or one the child already received, delivered as written rather than as a fresh launch's task. */
	resumeTaskLiteral?: boolean;
	/** Release the child while it waits on detachable tool calls, and hand those calls to `onReleased` (#4326). */
	releaseWhenWaiting?: import("../runs/inprocess/runner.js").SubagentReleasePolicy;
	/** Reserve the child's address before its released session disconnects. */
	onBeforeRelease?: () => Promise<void>;
	/** Results for the detached calls the reopened child's transcript ends on; its interrupted turn continues with them. */
	resumeToolResults?: readonly import("@bastani/atomic").DetachedToolResult[];
	/** Results of calls the child was already told are still running: read in one notice with its next turn. */
	resumeLateToolResults?: readonly import("@bastani/atomic").DetachedToolResult[];
	/**
	 * By position in `resumeLateToolResults`, the entry that issued each late result's call, when the caller already read
	 * the history back to it.
	 */
	resumeLateToolResultCalls?: readonly (string | undefined)[];
	/** Notices of finished background tasks held for the child: each delivered as a notice with its next turn. */
	resumeNotices?: readonly import("../runs/foreground/subagent-child-records.js").SubagentChildHeldNotice[];
	/** Why the child runs again, when Atomic says so rather than a message: read with its turn, never as a message. */
	resumeNote?: import("../runs/foreground/resume-note.js").SubagentResumeNote;
	/** A wake that only hands back tool results: the continued turn is the whole run and the task is not prompted. */
	skipTaskPrompt?: boolean;
	/**
	 * The task is only a wake's fallback prompt: it starts the child's turn when none runs yet, is never queued behind a
	 * turn that runs, and is never handed back as a message the child holds.
	 */
	resumeTaskFallback?: boolean;
	/**
	 * The user had paused the child when Atomic restarted: it is restored paused, with nothing prompted. `false` restores
	 * a child whose record still names a pause that no longer holds, and records that it is not paused.
	 */
	resumePaused?: boolean;
	wakeToolResultIds?: readonly string[];
	/**
	 * The results held for the child that a wake gives it, each by the number it is held under, and whether it is read
	 * late: only these are let go once saved, never a result held since for a later call a provider gave the same id
	 * (#3274). A result an earlier version held has no number, and is let go by its id.
	 */
	wakeHeldToolResults?: readonly import("../runs/foreground/subagent-child-records.js").SubagentWakeHeldToolResult[];
	/** The calls the child is told are still running, recorded with every record its run writes (#5014). */
	stillRunning?: readonly import("../runs/foreground/subagent-child-records.js").SubagentChildStillRunningCall[];
	redispatchDetachedCalls?: boolean;
	/** Told the child's own session once it is created, for a launch no task host records (an SDK session). */
	onChildSession?: (session: { sessionId: string; sessionFile: string | undefined }) => void;
	/** Told the model and thinking level the child's session started on, and its leaf entry then, as `onChildSession`. */
	onChildLaunch?: (launch: {
		model: string | undefined;
		thinking: string | undefined;
		leafId: string | null;
		leafSeq?: number;
	}) => void;
	share?: boolean;
	outputPath?: string;
	outputMode?: OutputMode;
	/** Current session depth passed to the in-process admission door. */
	parentDepth?: number;
	/** Override the agent's default model (format: "provider/id" or just "id") */
	modelOverride?: string;
	/**
	 * False when `modelOverride` is not a model the launch named, as for a restored child continuing on the model its
	 * parent gave it. Otherwise a launch whose `modelOverride` or agent names a concrete model runs it with only the
	 * agent's own fallbackModels (#4188).
	 */
	runsNamedModel?: false;
	/**
	 * The model the original launch asked for, when this launch continues it on another one, as a restored child that
	 * had fallen back does. Reported beside the model it runs on (#4188).
	 */
	requestedModel?: string;
	/** Registry models available for heuristic bare-model resolution */
	availableModels?: Array<{ provider: string; id: string; fullId: string }>;
	/** Providers known to the registry before auth filtering */
	knownModelProviders?: string[];
	/**
	 * When defined, restricts candidate selection, explicit launches, and child mid-run fallback to these
	 * canonical `provider/id` models (resolved from the session's `enabledModels` / `--models` scope).
	 */
	allowedModels?: readonly string[];
	/**
	 * Resolve the selected `provider/model[:thinking]` candidate to a concrete
	 * registry model. Without it the child session receives no model and a
	 * fork-context child silently runs on the model restored from the parent's
	 * session file.
	 */
	resolveCandidateModel?: CandidateModelResolver;
	/** Current parent-session provider to prefer for ambiguous bare model ids */
	preferredModelProvider?: string;
	/** Current parent-session model: the model of a launch that names none, and its last fallback (#4188). */
	currentModel?: string;
	/**
	 * Current parent-session thinking level. Inherited by a child that pins no
	 * model of its own — no frontmatter `model`, no `fallbackModels`, and no
	 * per-call override — matching upstream pi #7897: a subagent dispatched
	 * without a model runs on the dispatching session's model and thinking
	 * level. An agent whose fallback chain selects its own first candidate
	 * runs on that model, not the parent's, and keeps its own thinking
	 * configuration.
	 */
	currentThinkingLevel?: string;
	/** Skills to inject (overrides agent default if provided) */
	skills?: string[];
	/** Run-scoped progress.md path used to recover partial findings after parent abort. */
	progressPath?: string;
	/** Surviving progress.md path to cite after parent cancellation. */
	progressArtifactPath?: string;
	/** How long the child's session may take to start before it fails; `SUBAGENT_SESSION_START_TIMEOUT_MS` when omitted. */
	sessionStartTimeoutMs?: number;
	/** The child's start ran out of its budget and is about to be retried: hold sends to it again for the retry. */
	onStartRetry?: () => Promise<void> | void;
	/** Test-only in-process session stub configuration; production runs create a real AgentSession. */
	testSession?:
		| false
		| {
				output?: string;
				promptLogPath?: string;
				/** Hold a test prompt open until the caller releases the supplied promise. */
				promptGate?: Promise<void>;
				/** Match AgentSession.abort() settling an active prompt without throwing. */
				abortResolvesPrompt?: boolean;
				/** Emit a fallback event for tests that exercise live model metadata. */
				fallbackModel?: string;
				/** Emit the effective thinking level applied to the fallback candidate. */
				fallbackThinkingLevel?: string;
				/** Test-only session model exposed through the AgentSession accessors. */
				sessionModel?: string;
				/** Test-only effective thinking level exposed through the AgentSession accessors. */
				sessionThinkingLevel?: string;
				/** Test-only session events emitted in order after the initial agent_start event. */
				events?: readonly AgentSessionEvent[];
				/** Seed an earlier assistant message so abort recovery can find real text. */
				seededAssistantText?: string;
				/** Receives the stub session, to queue steering and follow-up messages as an SDK caller does. */
				onSession?: (session: TestSessionQueue) => void;
				/** After abort, append a thinking-only aborted message with no text. */
				thinkingOnlyOnAbort?: boolean;
				/** Emit the fallback event before the prompt gate so abort can preserve live fallback metadata. */
				fallbackBeforeGate?: boolean;
		  };
}

export type IntercomBridgeMode = "off" | "fork-only" | "always";

export interface IntercomBridgeConfig {
	mode?: IntercomBridgeMode;
	instructionFile?: string;
}

export const RESUME_IN_FLIGHT_MODES = ["ask", "auto", "never"] as const;

export type ResumeInFlight = (typeof RESUME_IN_FLIGHT_MODES)[number];

interface TopLevelParallelConfig {
	maxTasks?: number;
	concurrency?: number;
	runningCapacity?: number;
}

export interface ExtensionConfig {
	defaultSessionDir?: string;
	control?: ControlConfig;
	parallel?: TopLevelParallelConfig;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	intercomBridge?: IntercomBridgeConfig;
	/** Startup recovery of the paused and quit subagents a session launched. Default: "never". */
	resumeInFlight?: ResumeInFlight;
	/** How long each child may take to start before it fails; `SUBAGENT_SESSION_START_TIMEOUT_MS` when omitted. */
	sessionStartTimeoutMs?: number;
}
