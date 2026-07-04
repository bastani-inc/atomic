/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * The historical import path is preserved here as a facade. Responsibilities are
 * implemented in sibling modules by lifecycle area so each authored source file
 * stays below the repository file-length gate.
 */

import type {
	Agent,
	AgentTool,
	ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai/compat";
import type { BashExecutionMessage, CustomMessage } from "./messages.ts";
import type { ModelRegistry } from "./model-registry.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import type { SessionManager } from "./session-manager.js";
import type { SettingsManager } from "./settings-manager.ts";
import type { BuildSystemPromptOptions } from "./system-prompt.ts";
import type { AsyncJobManager } from "./async/job-manager.js";
import { createSessionAsyncJobManager } from "./async/session-manager.js";
import { installAgentSessionAccessors } from "./agent-session-accessors.ts";
import { agentSessionAutoCompactionMethods } from "./agent-session-auto-compaction.ts";
import { agentSessionBashMethods } from "./agent-session-bash.ts";
import { agentSessionCompactionMethods } from "./agent-session-compaction.ts";
import { agentSessionEventsMethods } from "./agent-session-events.ts";
import { agentSessionExportMethods } from "./agent-session-export.ts";
import { agentSessionExtensionBindingsMethods } from "./agent-session-extension-bindings.ts";
import type { AgentSessionInternalSurface, AgentSessionPublicSurface } from "./agent-session-methods.ts";
import { agentSessionMessageQueueMethods } from "./agent-session-message-queue.ts";
import { agentSessionModelsMethods } from "./agent-session-models.ts";
import { agentSessionPromptMethods } from "./agent-session-prompt.ts";
import { agentSessionRetryMethods } from "./agent-session-retry.ts";
import { agentSessionStateMethods } from "./agent-session-state.ts";
import { agentSessionToolHooksMethods } from "./agent-session-tool-hooks.ts";
import { agentSessionToolRegistryMethods } from "./agent-session-tool-registry.ts";
import { agentSessionTreeMethods } from "./agent-session-tree.ts";
import type {
	AgentSessionConfig,
	AgentSessionEventListener,
	InterruptQueueHold,
	ToolDefinitionEntry,
} from "./agent-session-types.ts";
import type {
	ExtensionCommandContextActions,
	ExtensionErrorListener,
	ExtensionMode,
	ExtensionRunner,
	ExtensionUIContext,
	OrchestrationContext,
	SessionStartEvent,
	ToolDefinition,
} from "./extensions/index.ts";

export type {
	AgentSessionConfig,
	AgentSessionEvent,
	AgentSessionEventListener,
	ExtensionBindings,
	ModelCycleResult,
	PromptOptions,
	SessionStats,
} from "./agent-session-types.ts";
export { parseSkillBlock } from "./agent-session-skill-block.ts";
export type { ParsedSkillBlock } from "./agent-session-skill-block.ts";

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;

	protected _scopedModels: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>;
	protected _unsubscribeAgent?: () => void;
	protected _eventListeners: AgentSessionEventListener[] = [];
	protected _agentEventQueue: Promise<void> = Promise.resolve();
	protected _steeringMessages: string[] = [];
	protected _followUpMessages: string[] = [];
	protected _interruptDeliveryQueue: Promise<void> = Promise.resolve();
	protected _pendingInterruptDeliveries = 0;
	protected _activeInterruptQueueHold: InterruptQueueHold | undefined = undefined;
	protected _activeInterruptAbortMessage: string | undefined = undefined;
	protected _pendingNextTurnMessages: CustomMessage[] = [];
	protected _compactionAbortController: AbortController | undefined = undefined;
	protected _autoCompactionAbortController: AbortController | undefined = undefined;
	protected _overflowRecoveryAttempted = false;
	protected _branchSummaryAbortController: AbortController | undefined = undefined;
	protected _retryAbortController: AbortController | undefined = undefined;
	protected _retryAttempt = 0;
	protected _retryPromise: Promise<void> | undefined = undefined;
	protected _retryResolve: (() => void) | undefined = undefined;
	protected _bashAbortController: AbortController | undefined = undefined;
	protected _pendingBashMessages: BashExecutionMessage[] = [];
	protected _extensionRunner!: ExtensionRunner;
	protected _turnIndex = 0;
	protected _resourceLoader: ResourceLoader;
	protected _customTools: ToolDefinition[];
	protected _baseToolDefinitions: Map<string, ToolDefinition> = new Map();
	protected _cwd: string;
	protected _extensionRunnerRef?: { current?: ExtensionRunner };
	protected _initialActiveToolNames?: string[];
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
	protected _modelRegistry: ModelRegistry;
	protected _toolRegistry: Map<string, AgentTool> = new Map();
	protected _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	protected _toolPromptSnippets: Map<string, string> = new Map();
	protected _toolPromptGuidelines: Map<string, string[]> = new Map();
	protected _baseSystemPrompt = "";
	protected _baseSystemPromptOptions!: BuildSystemPromptOptions;
	protected _systemPromptOverride?: string;
	protected _lastAssistantMessage: AssistantMessage | undefined = undefined;
	protected _asyncJobManager: AsyncJobManager;
	protected _asyncJobManagerSessionId: symbol;
	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settingsManager;
		this._scopedModels = config.scopedModels ?? [];
		this._resourceLoader = config.resourceLoader;
		this._customTools = config.customTools ?? [];
		this._cwd = config.cwd;
		this._modelRegistry = config.modelRegistry;
		this._extensionRunnerRef = config.extensionRunnerRef;
		this._initialActiveToolNames = config.initialActiveToolNames;
		this._allowedToolNames = config.allowedToolNames ? new Set(config.allowedToolNames) : undefined;
		this._excludedToolNames = config.excludedToolNames ? new Set(config.excludedToolNames) : undefined;
		this._baseToolsOverride = config.baseToolsOverride;
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };
		this._orchestrationContext = config.orchestrationContext;
		const internals = this as unknown as AgentSessionInternalSurface;
		const asyncJobManagerHandle = createSessionAsyncJobManager(internals);
		this._asyncJobManager = asyncJobManagerHandle.manager;
		this._asyncJobManagerSessionId = asyncJobManagerHandle.sessionId;
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

export interface AgentSession extends AgentSessionPublicSurface {}

installAgentSessionAccessors(AgentSession.prototype as unknown as AgentSessionInternalSurface);
Object.assign(
	AgentSession.prototype,
	agentSessionToolHooksMethods,
	agentSessionEventsMethods,
	agentSessionStateMethods,
	agentSessionPromptMethods,
	agentSessionMessageQueueMethods,
	agentSessionModelsMethods,
	agentSessionCompactionMethods,
	agentSessionAutoCompactionMethods,
	agentSessionExtensionBindingsMethods,
	agentSessionToolRegistryMethods,
	agentSessionRetryMethods,
	agentSessionBashMethods,
	agentSessionTreeMethods,
	agentSessionExportMethods,
);
