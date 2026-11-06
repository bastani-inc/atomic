import type { Api, AssistantMessage, ImageContent, Model, TextContent, Usage } from "@bastani/pi-ai/compat";
import type { Agent, AgentEvent, AgentMessage, AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { VerbatimCompactionResult } from "./compaction/index.ts";
import type { UIPromptEndEvent, UIPromptStartEvent } from "./extensions/agent-events.ts";
import type {
	ContextUsage,
	ExtensionCommandContextActions,
	ExtensionErrorListener,
	ExtensionMode,
	ExtensionUIContext,
	InputSource,
	OrchestrationContext,
	SessionStartEvent,
	ShutdownHandler,
	SubagentChildPolicy,
	ToolDefinition,
} from "./extensions/index.js";
import type { CustomMessage } from "./messages.ts";
import type { ModelRuntime } from "./model-runtime.js";
import type { ResourceLoader } from "./resource-loader.ts";
import type { SessionManager } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";
import type { SourceInfo } from "./source-info.ts";
import type { ResourceFailure, TaskId } from "./tasks/contracts.js";
export type CompactionReason = "manual" | "threshold" | "overflow" | "branchSummary";

export type AgentSessionEvent =
	| (AgentEvent & { parentToolCallId?: string })
	| { type: "agent_settled"; aborted: boolean }
	| { type: "entry_appended"; entry: import("./session-manager.ts").SessionEntry }
	| {
			type: "queue_update";
			steering: readonly string[];
			followUp: readonly string[];
	  }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow"; midTurn?: boolean }
	| { type: "session_info_changed"; name: string | undefined }
	| {
			type: "model_changed";
			model: Model<Api>;
			previousModel: Model<Api> | undefined;
			source: "set" | "cycle" | "restore" | "fallback";
	  }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: VerbatimCompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			unresolvedOverflow?: boolean;
			errorMessage?: string;
			midTurn?: boolean;
			/** A manual request has claimed ownership and will emit its own completion. */
			manualTakeoverPending?: boolean;
			/** The boundary is a background compaction result committed at this turn boundary (#4330). */
			background?: true;
			/** Expected prompt-cache miss of the next request, when the last request was cached. */
			cacheMiss?: import("./cache-stats.ts").CompactionCacheMiss;
	  }
	| {
			/** Background compaction changed state; `discarded` names a stored result dropped without a commit. */
			type: "background_compaction";
			compaction: import("./compaction/background-compaction.ts").SerializedBackgroundCompactionState;
			discarded?: import("./compaction/background-compaction-errors.ts").SerializedBackgroundCompactionError;
	  }
	| { type: "agent_continue_error"; source: "post_compaction"; errorMessage: string }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| {
			type: "summarization_retry_scheduled";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| { type: "summarization_retry_attempt_start"; source: "branchSummary" }
	| {
			type: "summarization_retry_attempt_start";
			source: "compaction";
			reason: "manual" | "threshold" | "overflow";
	  }
	| { type: "summarization_retry_finished" }
	| { type: "bash_execution_update"; id?: string; channel: "stdout" | "stderr"; delta: string }
	| {
			type: "model_fallback_start";
			/** `provider/id` of the model that failed. */
			from: string;
			/** `provider/id` of the model the turn continues on. */
			to: string;
			/** The level `from` ran at, for a reasoning model. */
			fromThinkingLevel?: ThinkingLevel;
			/** The level `to` runs at, for a reasoning model. */
			toThinkingLevel?: ThinkingLevel;
			reason: string;
			attempt: number;
	  }
	| { type: "model_fallback_end"; success: boolean; from?: string; to?: string; finalError?: string }
	/**
	 * A task's result settled before its process cleanup was confirmed. Cleanup continues in the background; the
	 * owner's close fails with a `TaskCleanupError` only if it is never confirmed.
	 */
	| {
			type: "task_cleanup_quarantined";
			taskId: TaskId;
			resources: readonly ResourceFailure[];
	  }
	/**
	 * Once per distinct reason a turn's worktree snapshot could not be recorded; the turn itself is unaffected. `reason`
	 * is the typed error in JSON form, so it crosses RPC; `rehydrateWorkspaceError(reason)` restores its class.
	 */
	| {
			type: "worktree_snapshot_unavailable";
			reason: import("./worktree-snapshot/errors.ts").SerializedWorkspaceError;
	  };

export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

export interface PendingAgentMessageQueue {
	hasItems(): boolean;
	drain(): AgentMessage[];
}

export interface AgentQueueAccess {
	readonly steeringQueue?: PendingAgentMessageQueue;
	readonly followUpQueue?: PendingAgentMessageQueue;
}

export interface DrainedAgentQueues {
	readonly steering: AgentMessage[];
	readonly followUp: AgentMessage[];
}

export interface InterruptQueueHold {
	readonly steering: AgentMessage[];
	readonly followUp: AgentMessage[];
}

/** Insertion boundary after already admitted priority input in a queue hold. */
export const priorityHoldCounts = new WeakMap<InterruptQueueHold, number>();

export interface ClearQueueOptions {
	preserveUnprotectedCustomMessages?: boolean;
}

/** Text of queued messages, per lane, in queue order. */
export interface QueuedTexts {
	steering: string[];
	followUp: string[];
}

/** Images of queued messages, per lane, aligned with the text arrays: `undefined` for a message without images. */
export interface QueuedImages {
	steering: (ImageContent[] | undefined)[];
	followUp: (ImageContent[] | undefined)[];
}

/**
 * What `clearQueue()` removed. `steering` and `followUp` hold each message as queued, after `input` hooks, skills and
 * prompt templates. `typed` holds the same messages as they were submitted, in the same order, for a caller that gives
 * them back to the user to send again: sending the queued text would run those steps a second time (#4284). It is
 * left out when every message was queued as submitted, and by sessions from before it was added. `images` holds each
 * message's images at the same index, so a caller that queues the messages again sends them whole (#4309). It is left
 * out when no cleared message has images.
 */
export interface ClearedQueue extends QueuedTexts {
	typed?: QueuedTexts;
	images?: QueuedImages;
}

export function drainAgentMessageQueue(queue: PendingAgentMessageQueue | undefined): AgentMessage[] {
	if (!queue) return [];
	const drained: AgentMessage[] = [];
	while (queue.hasItems()) {
		drained.push(...queue.drain());
	}
	return drained;
}

export function normalizeInterruptAbortMessage(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function isGenericAbortText(value: string): boolean {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[.!]+$/, "");
	return (
		normalized === "operation aborted" ||
		normalized === "the operation was aborted" ||
		normalized === "request was aborted" ||
		normalized === "this operation was aborted" ||
		normalized === "extension custom ui aborted"
	);
}

export function isSingleGenericAbortTextContent(content: unknown): boolean {
	return (
		Array.isArray(content) &&
		content.length === 1 &&
		typeof content[0] === "object" &&
		content[0] !== null &&
		(content[0] as { type?: unknown }).type === "text" &&
		typeof (content[0] as { text?: unknown }).text === "string" &&
		isGenericAbortText((content[0] as { text: string }).text)
	);
}

export function replacementAbortContent(text: string): TextContent[] {
	return [{ type: "text", text }];
}

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	cwd: string;
	scopedModels?: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>;
	fallbackModels?: string[];
	isFallbackModelAllowed?: (model: Model<Api>, effort: string | undefined) => boolean;
	resourceLoader: ResourceLoader;
	customTools?: ToolDefinition[];
	modelRuntime: ModelRuntime;
	cacheWarmer?: import("./cache-warmer.ts").CacheWarmer;
	/** Delivers "compaction ready" wakes; without one the session notifies its own listeners (#4330). */
	compactionWake?: import("./compaction/background-compaction.ts").CompactionWakeDispatcher;
	childSessionOptions?: import("./child-session-options.ts").ChildSessionOptionsResolver;
	workflowJournal?: import("./storage/provider.js").RunJournalOption;
	/** The agent directory the session store resolved its storage against; the workflow journal uses the same base. */
	storageAgentDir?: string;
	initialActiveToolNames?: string[];
	usesDefaultTools?: boolean;
	defaultToolModifiers?: string[];
	allowedToolNames?: string[];
	excludedToolNames?: string[];
	baseToolsOverride?: Record<string, AgentTool>;
	extensionRunnerRef?: { current?: import("./extensions/index.js").ExtensionRunner };
	sessionStartEvent?: SessionStartEvent;
	subagentPolicy?: SubagentChildPolicy;
	/** Parent-issued shell task owner for an in-process subagent child. */
	parentCommandTaskOwner?: import("./tasks/child-command-owner.js").ChildCommandTaskOwner;
	resourceAdmission?: import("./sdk-types.ts").ResourceAdmission;
	/** Resolved workspace binding; a read-only binding refuses file-writing tools. */
	workspace?: import("./workspace/resolve.ts").BoundWorkspace;
	systemPromptTransform?: (prompt: string) => string;
	/**
	 * Transform the canonical session projection whenever it becomes the finalized
	 * context (session construction, provider requests, boundaries, recovery). The
	 * durable transcript stays unchanged; only derived context is filtered.
	 */
	contextProjectionTransform?: (messages: AgentMessage[]) => AgentMessage[];
	orchestrationContext?: OrchestrationContext;
	/** Resolved worktree snapshot settings; default: the settings manager's `snapshots.*`. */
	worktreeSnapshots?: import("./worktree-snapshot/types.ts").WorktreeSnapshotSettings;
}

export interface ExtensionBindings {
	humanInput?: import("./extensions/host-input.js").HostInput | null;
	onDiagnostic?: (diagnostic: import("./extensions/host-input.js").HostDiagnostic) => void;
	onUIPrompt?: (event: UIPromptStartEvent | UIPromptEndEvent) => void;
	uiContext?: ExtensionUIContext;
	/**
	 * Receives the extension `setStatus` writes of a session that is bound no `uiContext`, so a host
	 * that presents the session elsewhere (a task's detail page) can show them. It does not make the
	 * session report a UI.
	 */
	onStatus?: (statusKey: string, text: string | undefined) => void;
	isPresentationOnly?: boolean;
	mode?: ExtensionMode;
	commandContextActions?: ExtensionCommandContextActions;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
}

export interface AgentSessionReloadOptions {
	reason?: "startup" | "reload";
	/** Runs after resources and the extension runtime are rebuilt, immediately before session_start. */
	beforeSessionStart?: () => void | Promise<void>;
	/** Leave the existing extension runner active unless every extension factory loaded successfully. */
	failOnExtensionErrors?: boolean;
}

/** What `AgentSession.startPendingRecovery()` did for interrupted work from an earlier process. */
export interface SessionRecoveryReport {
	/** Interrupted delivery cards replayed to the model. */
	replayed: number;
	/** Interrupted delivery cards an extension declined to replay. */
	dropped: number;
	/** Background task results delivered as visible cards without starting a turn. */
	completions: number;
	/** Notices shown to the user and the agent in one recovery message. */
	notices: string[];
}

export type QueuedInputDisposition = "handled" | "queued";
export type PromptDisposition = QueuedInputDisposition | "started";

export interface PromptOptions {
	/** Whether to dispatch extension commands and expand skill commands and prompt templates (default: true) */
	expandPromptTemplates?: boolean;
	images?: ImageContent[];
	streamingBehavior?: "steer" | "followUp";
	source?: InputSource;
	/** Called once when preflight accepts (`true`, with how the prompt was dispatched) or rejects (`false`) the prompt. */
	preflightResult?: (success: boolean, disposition?: PromptDisposition) => void;
}

export interface ModelMutationOptions {
	persist?: boolean;
}

export interface ModelCycleResult {
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	isScoped: boolean;
}

export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage?: ContextUsage;
	/** Usage of the newest assistant message, which the footer's cache-hit rate reads. */
	latestAssistantUsage?: Usage;
}

export interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

export const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function customMessageExcludesContext(message: CustomMessage): boolean {
	return (message as CustomMessage & { excludeFromContext?: boolean }).excludeFromContext === true;
}

export type AssistantMessageWithError = AssistantMessage;
