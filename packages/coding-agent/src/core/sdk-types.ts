import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { AgentSession } from "./agent-session.ts";
import type {
	LoadExtensionsResult,
	OrchestrationContext,
	SessionStartEvent,
	SubagentChildPolicy,
	ToolDefinition,
} from "./extensions/index.ts";
import type { ModelFallbackReason } from "./model-resolver-types.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import type { SessionManager } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";

export interface CreateAgentSessionOptions {
	/** Working directory for project-local discovery. Default: process.cwd() */
	cwd?: string;
	/** Global config directory. Default: ~/.atomic/agent */
	agentDir?: string;

	/** Canonical model/auth runtime. Defaults to agentDir/auth.json and models.json. */
	modelRuntime?: ModelRuntime;

	/** Model to use. Default: from settings, else first available */
	model?: Model<Api>;
	/** Thinking level. Default: from settings, else 'medium' (clamped to model capabilities) */
	thinkingLevel?: ThinkingLevel;
	/**
	 * Ordered fallback models as provider/model strings with optional :thinkingLevel suffix.
	 * Used by main-chat turns and borrowed, planner-only, for compaction range planning when
	 * the current model cannot produce a usable plan — so a configured candidate may receive
	 * the compaction transcript. Borrowing never changes the session model or thinking level.
	 * Default: settings.fallbackModels
	 */
	fallbackModels?: string[];
	/** Models available for cycling (Ctrl+P in interactive mode) */
	scopedModels?: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>;

	/**
	 * Optional default tool suppression mode when no explicit allowlist is provided.
	 *
	 * - "all": start with no tools enabled
	 * - "builtin": disable the default built-in tools (read, bash, edit, write,
	 *   find, search, ask_user_question, todo) but keep extension/custom tools enabled
	 */
	noTools?: "all" | "builtin";
	/**
	 * Optional allowlist of tool names.
	 *
	 * When omitted, pi enables the default built-in tools (read, bash, edit, write,
	 * find, search, ask_user_question, todo) and leaves extension/custom tools enabled unless
	 * `noTools` changes that default.
	 * When provided, only the listed tool names are enabled, minus any names in
	 * `excludedTools`.
	 */
	tools?: string[];
	/**
	 * Optional blocklist of tool names.
	 *
	 * Matching built-in, extension, and SDK custom tools are omitted from the
	 * final session tool registry and active tool set. Unknown names are ignored.
	 */
	excludedTools?: string[];
	/** Custom tools to register (in addition to built-in tools). */
	customTools?: ToolDefinition[];

	/** Resource loader. When omitted, DefaultResourceLoader is used. */
	resourceLoader?: ResourceLoader;

	/** Session manager. Default: SessionManager.create(cwd) */
	sessionManager?: SessionManager;

	/** Settings manager. Default: SettingsManager.create(cwd, agentDir) */
	settingsManager?: SettingsManager;
	/** Session start event metadata for extension runtime startup. */
	sessionStartEvent?: SessionStartEvent;
	/** Session-scoped orchestration policy exposed to extension/tool handlers. */
	orchestrationContext?: OrchestrationContext;
	/** Typed capability policy for an in-process subagent child. */
	subagentPolicy?: SubagentChildPolicy;
	/** Transform the fully constructed base system prompt at session construction. */
	systemPromptTransform?: (prompt: string) => string;
	/** Filter inherited session messages before they enter the new AgentSession. */
	initialContextTransform?: (messages: AgentMessage[]) => AgentMessage[];
}

/** Result from createAgentSession */
export interface CreateAgentSessionResult {
	/** The created session */
	session: AgentSession;
	/** Extensions result (for UI context setup in interactive mode) */
	extensionsResult: LoadExtensionsResult;
	/** Warning when a restored or configured model cannot be selected. */
	modelFallbackMessage?: string;
	/** Semantic reason for modelFallbackMessage; suitable for mode control flow. */
	modelFallbackReason?: ModelFallbackReason;
}
