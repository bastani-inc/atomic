/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * The historical import path is preserved here as a facade. Responsibilities are
 * implemented in sibling modules by lifecycle area so each authored source file
 * stays focused.
 */

import { join } from "node:path";
import type { Api, AssistantMessage, Model } from "@bastani/pi-ai/compat";
import type { Agent, AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { installAgentSessionAccessors } from "./agent-session-accessors.ts";
import { agentSessionAutoCompactionMethods } from "./agent-session-auto-compaction.ts";
import { agentSessionBashMethods } from "./agent-session-bash.ts";
import { agentSessionCompactionMethods } from "./agent-session-compaction.ts";
import { agentSessionCustomMessageCommitMethods } from "./agent-session-custom-message-commit.ts";
import { agentSessionEventsMethods } from "./agent-session-events.ts";
import { agentSessionExportMethods } from "./agent-session-export.ts";
import { agentSessionExtensionBindingsMethods } from "./agent-session-extension-bindings.ts";
import { agentSessionMessageQueueMethods } from "./agent-session-message-queue.ts";
import type { AgentSessionInternalSurface, AgentSessionPublicSurface } from "./agent-session-methods.ts";
import { agentSessionModelsMethods } from "./agent-session-models.ts";
import type { PendingPostToolCompactionGuard } from "./agent-session-post-tool-compaction.ts";
import { agentSessionPostToolCompactionMethods } from "./agent-session-post-tool-compaction.ts";
import { agentSessionPromptMethods } from "./agent-session-prompt.ts";
import { agentSessionRetryMethods } from "./agent-session-retry.ts";
import { agentSessionStateMethods } from "./agent-session-state.ts";
import { agentSessionSummaryMethods, type SessionSummaryRun } from "./agent-session-summary.ts";
import { agentSessionToolHooksMethods } from "./agent-session-tool-hooks.ts";
import { agentSessionToolRegistryMethods } from "./agent-session-tool-registry.ts";
import { agentSessionTreeMethods } from "./agent-session-tree.ts";
import type {
	AgentSessionConfig,
	AgentSessionEventListener,
	InterruptQueueHold,
	ToolDefinitionEntry,
} from "./agent-session-types.ts";
import type { VerbatimCompactionResult } from "./compaction/index.ts";
import type {
	ExtensionCommandContextActions,
	ExtensionErrorListener,
	ExtensionMode,
	ExtensionRunner,
	ExtensionUIContext,
	OrchestrationContext,
	SessionStartEvent,
	SubagentChildPolicy,
	ToolDefinition,
} from "./extensions/index.js";
import type { BashExecutionMessage, CustomMessage } from "./messages.ts";
import type { ModelRuntime } from "./model-runtime.js";
import type { ResourceLoader } from "./resource-loader.ts";
import type { SessionManager } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";
import type { BuildSystemPromptOptions } from "./system-prompt.ts";
import { scheduleSessionTempCleanup } from "./tools/session-temp-cleanup.ts";
import { acquireProtectedPaths, type ProtectedPathLease, setActiveSessionTempId } from "./tools/session-temp-dir.ts";
import { TOOL_RESULTS_SUBDIR } from "./tools/tool-limits.js";
import { WorkflowStageAdmissionBoundary } from "./workflow-stage-admission.ts";

export type { ParsedSkillBlock } from "./agent-session-skill-block.ts";
export { parseSkillBlock } from "./agent-session-skill-block.ts";
export type {
	AgentSessionConfig,
	AgentSessionEvent,
	AgentSessionEventListener,
	CompactionReason,
	ExtensionBindings,
	ModelCycleResult,
	PromptOptions,
	SessionStats,
} from "./agent-session-types.ts";

class AgentSessionBase {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;

	protected _scopedModels: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>;
	protected _fallbackModels: string[];
	protected _fallbackAttemptedKeys: Set<string> = new Set();
	/** Models condemned for this turn by a failure retrying them cannot repair. */
	protected _fallbackBlockedModels: Array<Model<Api>> = [];
	protected _fallbackOriginModel: Model<Api> | undefined;
	protected _fallbackOriginThinkingLevel: ThinkingLevel | undefined;
	protected _fallbackScopeGeneration = 0;
	protected _fallbackOriginGeneration: number | undefined;
	protected _fallbackRestoreError: string | undefined;
	protected _unsubscribeAgent?: () => void;
	protected _eventListeners: AgentSessionEventListener[] = [];
	protected _agentEventQueue: Promise<void> = Promise.resolve();
	protected _steeringMessages: string[] = [];
	protected _followUpMessages: string[] = [];
	protected _interruptDeliveryQueue: Promise<void> = Promise.resolve();
	protected _pendingInterruptDeliveries = 0;
	protected _activeInterruptQueueHold: InterruptQueueHold | undefined = undefined;
	protected _queuedMessagesPaused = false;
	protected _queuedMessagesPauseAbortBoundary: Promise<void> | undefined = undefined;
	/**
	 * Text of a queued steering/follow-up message the agent loop already admitted
	 * into the transcript and that has not received an assistant reply yet. The
	 * pause hold cannot reach such a message, so an interrupt would otherwise
	 * strand it (issue #2362).
	 */
	protected _admittedQueuedMessageAwaitingReply: string | undefined = undefined;
	/**
	 * Settlement boundary for the recovery turn that answers an already-admitted
	 * queued message. It starts after the pause abort boundary resolves, so the
	 * resume path must wait for it too or an ordinary submission made while it
	 * streams is rejected by the streaming guard (issue #2362).
	 */
	protected _admittedRecoveryTurn: Promise<void> | undefined = undefined;
	protected _workflowStageDeliveryForwardTarget: AgentSessionInternalSurface | undefined = undefined;
	protected _activeInterruptAbortMessage: string | undefined = undefined;
	protected _pendingNextTurnMessages: CustomMessage[] = [];
	/** Context-only custom messages queued during a run, flushed after the current turn's tool results. */
	protected _pendingCustomMessages: CustomMessage[] = [];
	protected _protectedStreamingCustomMessages: Array<{
		message: CustomMessage;
		delivery: "steer" | "followUp";
		phase: "queued" | "consumed-unpersisted" | "persistence-failed";
	}> = [];
	protected _compactionAbortController: AbortController | undefined = undefined;
	protected _compactionReason: import("./agent-session-types.ts").CompactionReason | undefined = undefined;
	protected _manualCompactionPromise: Promise<VerbatimCompactionResult> | undefined = undefined;
	protected _autoCompactionAbortController: AbortController | undefined = undefined;
	/** Resolves when the current automatic compaction has settled. */
	protected _autoCompactionCompletion: Promise<void> | undefined = undefined;
	protected _overflowRecoveryAttempted = false;
	protected _recoverableLengthRecoveryAttempted = false;
	/** Set when compaction cannot recover a context overflow on the current model. */
	protected _contextOverflowUnresolved = false;
	protected _pendingPostCompactionContinuation: Promise<void> | undefined = undefined;
	protected _postCompactionContinuationToken = 0;
	protected _lengthContinuationAttempts = 0;
	protected _outputBudgetErrorContinuationAttempts = 0;
	protected _postToolCompactionPreflightError: string | undefined = undefined;
	protected _pendingPostToolCompactionGuard: PendingPostToolCompactionGuard | undefined = undefined;
	protected _terminatingToolCallIds = new Set<string>();
	/** A positive stop callback keeps queued work pending until an explicit new run. */
	protected _stopAfterTurnBlockedContinuation = false;
	protected _disposed = false;
	protected _branchSummaryAbortController: AbortController | undefined = undefined;
	protected _sessionSummaryAbortController: AbortController | undefined = undefined;
	protected _sessionSummaryToken = 0;
	/** The summary request currently in flight, published so a later launch can join it. */
	protected _sessionSummaryRun: SessionSummaryRun | undefined = undefined;
	protected _lastSummarizedMessageId: string | undefined = undefined;
	protected _retryAbortController: AbortController | undefined = undefined;
	protected _retryAttempt = 0;
	protected _retryPromise: Promise<void> | undefined = undefined;
	protected _retryResolve: (() => void) | undefined = undefined;
	protected _bashAbortControllers = new Map<string | symbol, AbortController>();
	protected _pendingBashMessages: BashExecutionMessage[] = [];
	protected _extensionRunner!: ExtensionRunner;
	protected _turnIndex = 0;
	protected _resourceLoader: ResourceLoader;
	protected _customTools: ToolDefinition[];
	protected _baseToolDefinitions: Map<string, ToolDefinition> = new Map();
	protected _cwd: string;
	protected _extensionRunnerRef?: { current?: ExtensionRunner };
	protected _initialActiveToolNames?: string[];
	protected _subagentPolicy?: SubagentChildPolicy;
	protected _allowedToolNames?: Set<string>;
	protected _excludedToolNames?: Set<string>;
	protected _baseToolsOverride?: Record<string, AgentTool>;
	protected _sessionStartEvent: SessionStartEvent;
	protected _orchestrationContext?: OrchestrationContext;
	protected _extensionUIContext?: ExtensionUIContext;
	protected _extensionMode: ExtensionMode = "print";
	protected _extensionCommandContextActions?: ExtensionCommandContextActions;
	protected _extensionShutdownHandler?: () => void;
	protected _extensionErrorListener?: ExtensionErrorListener;
	protected _extensionErrorUnsubscriber?: () => void;
	protected _modelRuntime: ModelRuntime;
	protected _extensionProviderIds = new Set<string>();
	protected _toolRegistry: Map<string, AgentTool> = new Map();
	protected _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	protected _toolPromptSnippets: Map<string, string> = new Map();
	protected _toolPromptGuidelines: Map<string, string[]> = new Map();
	protected _baseSystemPrompt = "";
	protected _baseSystemPromptOptions!: BuildSystemPromptOptions;
	protected _systemPromptTransform?: (prompt: string) => string;
	protected _systemPromptOverride?: string;
	protected _lastAssistantMessage: AssistantMessage | undefined = undefined;
	/** Protection claim on this session's temp tree and tool-results directory. */
	protected _tempStorageLease: ProtectedPathLease | undefined;
	protected _workflowStageAdmission: WorkflowStageAdmissionBoundary | undefined;
	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settingsManager;
		this._scopedModels = config.scopedModels ?? [];
		this._fallbackModels = config.fallbackModels ?? [];
		this._resourceLoader = config.resourceLoader;
		this._customTools = config.customTools ?? [];
		this._cwd = config.cwd;
		this._modelRuntime = config.modelRuntime;
		this._extensionProviderIds = new Set(config.resourceLoader.getExtensions().runtime.extensionProviderIds);
		this._extensionRunnerRef = config.extensionRunnerRef;
		this._initialActiveToolNames = config.initialActiveToolNames;
		this._allowedToolNames = config.allowedToolNames ? new Set(config.allowedToolNames) : undefined;
		this._excludedToolNames = config.excludedToolNames ? new Set(config.excludedToolNames) : undefined;
		this._baseToolsOverride = config.baseToolsOverride;
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };
		this._orchestrationContext = config.orchestrationContext;
		this._subagentPolicy = config.subagentPolicy;
		this._systemPromptTransform = config.systemPromptTransform;
		const stageContext =
			config.orchestrationContext?.kind === "workflow-stage" ? config.orchestrationContext : undefined;
		this._workflowStageAdmission =
			stageContext?.messageAdmission?.boundary ??
			(stageContext ? WorkflowStageAdmissionBoundary.restore(this.sessionManager.getBranch()) : undefined);
		if (this._workflowStageAdmission && stageContext && stageContext.messageAdmission === undefined) {
			(
				stageContext as {
					messageAdmission?: {
						boundary: WorkflowStageAdmissionBoundary;
						extensionState: Map<string, object>;
						isOpen(): boolean;
					};
				}
			).messageAdmission = {
				boundary: this._workflowStageAdmission,
				extensionState: new Map(),
				isOpen: () => this._workflowStageAdmission?.isOpen() === true,
			};
		}
		// Claim this session's storage before any tool can spill into it, so the
		// sweeper below never reaps a directory this process is still writing to.
		// The claim is a lease, released in dispose(): a session that is gone must
		// stop protecting a tree the startup sweep exists to collect.
		try {
			const sessionId = this.sessionManager.getSessionId();
			const sessionDir = this.sessionManager.getSessionDir() || undefined;
			this._tempStorageLease = acquireProtectedPaths([
				setActiveSessionTempId(sessionId),
				// A disk-backed session's results are read back by path, and a replayed
				// result reuses an old file without touching its mtime, so age alone
				// cannot keep it alive.
				...(sessionDir ? [join(sessionDir, TOOL_RESULTS_SUBDIR)] : []),
			]);
			// A custom `--session-dir` keeps its tool results directly under that
			// directory, outside the project-nested roots the default sweep walks,
			// so it has to be named as its own target.
			const customSessionDir = this.sessionManager.usesDefaultSessionDir() ? undefined : sessionDir;
			scheduleSessionTempCleanup(customSessionDir ? { sessionDirs: [customSessionDir] } : {});
		} catch {
			// Temp-storage housekeeping must never block session construction.
		}
		const internals = this as unknown as AgentSessionInternalSurface;
		internals._handleAgentEvent = internals._handleAgentEvent.bind(this);
		this._unsubscribeAgent = this.agent.subscribe(internals._handleAgentEvent);
		internals._installAgentToolHooks();
		internals._installAgentNextTurnRefresh();
		internals._buildRuntime({
			activeToolNames: this._initialActiveToolNames,
			includeAllExtensionTools: true,
		});
	}
}

export interface AgentSession extends AgentSessionBase, AgentSessionPublicSurface {}

export const AgentSession = AgentSessionBase as unknown as {
	new (config: AgentSessionConfig): AgentSession;
	readonly prototype: AgentSession;
};

installAgentSessionAccessors(AgentSession.prototype as unknown as AgentSessionInternalSurface);
Object.assign(
	AgentSession.prototype,
	agentSessionToolHooksMethods,
	agentSessionEventsMethods,
	agentSessionStateMethods,
	agentSessionPromptMethods,
	agentSessionCustomMessageCommitMethods,
	agentSessionMessageQueueMethods,
	agentSessionModelsMethods,
	agentSessionCompactionMethods,
	agentSessionAutoCompactionMethods,
	agentSessionPostToolCompactionMethods,
	agentSessionExtensionBindingsMethods,
	agentSessionToolRegistryMethods,
	agentSessionRetryMethods,
	agentSessionBashMethods,
	agentSessionTreeMethods,
	agentSessionExportMethods,
	agentSessionSummaryMethods,
);
