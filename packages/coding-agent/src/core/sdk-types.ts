import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { AuthStorage } from "./auth-storage.ts";
import type { ModelRegistry } from "./model-registry.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import type { SessionManager } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";
import type { AgentSession } from "./agent-session.ts";
import type { LoadExtensionsResult, OrchestrationContext, SessionStartEvent, ToolDefinition } from "./extensions/index.ts";

export interface CreateAgentSessionOptions {
  /** Working directory for project-local discovery. Default: process.cwd() */
  cwd?: string;
  /** Global config directory. Default: ~/.atomic/agent */
  agentDir?: string;

  /** Auth storage for credentials. Default: AuthStorage.create(agentDir/auth.json) */
  authStorage?: AuthStorage;
  /** Model registry. Default: ModelRegistry.create(authStorage, agentDir/models.json) */
  modelRegistry?: ModelRegistry;

  /** Model to use. Default: from settings, else first available */
  model?: Model<Api>;
  /** Thinking level. Default: from settings, else 'medium' (clamped to model capabilities) */
  thinkingLevel?: ThinkingLevel;
  /** Ordered fallback models for main chat, as provider/model strings with optional :thinkingLevel suffix. Default: settings.fallbackModels */
  fallbackModels?: string[];
  /** Context window token count. Default: model scalar contextWindow, or settings/session override when supported. */
  contextWindow?: number;
  /** Treat unsupported contextWindow as an error instead of a warning/fallback. */
  contextWindowStrict?: boolean;
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
}

/** Result from createAgentSession */
export interface CreateAgentSessionResult {
  /** The created session */
  session: AgentSession;
  /** Extensions result (for UI context setup in interactive mode) */
  extensionsResult: LoadExtensionsResult;
  /** Warning if session was restored with a different model than saved */
  modelFallbackMessage?: string;
  /** Warning if a saved/default context window could not be applied to the selected model. */
  contextWindowWarning?: string;
  /** Error if an explicit strict context-window selection is unsupported. */
  contextWindowError?: string;
}

