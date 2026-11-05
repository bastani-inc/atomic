import type { Api, Model } from "@bastani/pi-ai/compat";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "./agent-session.js";
import type { ReleaseWhenIdleOptions } from "./agent-session-release.ts";
import type { ExtensionBindings } from "./agent-session-types.js";
import type {
	LoadExtensionsResult,
	OrchestrationContext,
	SessionStartEvent,
	SubagentChildPolicy,
	ToolDefinition,
} from "./extensions/index.js";
import type { ModelFallbackReason } from "./model-resolver-types.ts";
import type { ModelRuntime } from "./model-runtime.js";
import type { ResourceLoader } from "./resource-loader.ts";
import type { SessionManager } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";
import type { RunJournalOption, StorageSelection } from "./storage/provider.js";
import type { RunJournal } from "./storage/run-journal.js";
import type { SessionStore } from "./storage/session/types.js";

/** A `createAgentSession({ storage })` selection: a database path, a caller-owned database, memory, or an adapter. */
export type SessionStorageOption = Exclude<RunJournalOption, RunJournal>;

export type AtomicBuiltin = "workflows" | "subagents" | "mcp" | "web-access" | "intercom";

export interface CreateAgentSessionOptions {
	/** Shipped packages are enabled unless explicitly false. Independent of tool selection. */
	builtins?: Partial<Record<AtomicBuiltin, boolean>>;
	/** Working directory for project-local discovery. Default: process.cwd(), or the workspace worktree. */
	cwd?: string;
	/**
	 * Repository binding from `workspace({ … })`, or an already resolved binding. The session runs in the bound worktree
	 * (an explicit `cwd` must lie inside it), records the binding in the session, and a `"read-only"` workspace removes
	 * and refuses the file-writing tools (`write`, `edit`, `todo`).
	 */
	workspace?: import("./workspace/spec.ts").Workspace | import("./workspace/resolve.ts").BoundWorkspace;
	/** Global config directory. Default: ~/.atomic/agent */
	agentDir?: string;
	/**
	 * Workflow journal for this session's `workflow` tool: a file path, a caller-owned database, process-local
	 * memory, a storage adapter, or a supplied journal. Overrides process-level selections (`ATOMIC_WORKFLOWS_JOURNAL`,
	 * `ATOMIC_WORKFLOW_JOURNAL_PATH`, `ATOMIC_STORAGE`), the session's `workflows.journal` settings, and the default
	 * journal file. The caller closes a database or journal it supplies.
	 */
	journal?: RunJournalOption;
	/**
	 * Storage for this session's sessions and its `workflow` tool's journal, in the form of the top-level `storage`
	 * setting, for example the selection `teamProfileSelection()` returns. Outranks process-level selections and
	 * settings; `sessionStore` and `journal` outrank it for their domain. Intercom keeps the process's selection.
	 */
	storage?: SessionStorageOption;

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
	/** Hard eligibility gate applied before fallback inference, including compaction borrowing. */
	isFallbackModelAllowed?: (model: Model<Api>, effort: string | undefined) => boolean;
	/** Models available for cycling (Ctrl+P in interactive mode) */
	scopedModels?: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>;

	/**
	 * Tool suppression mode.
	 *
	 * - "all": no active tools, even with an explicit allowlist
	 * - "builtin": suppress coding-tool defaults only when tools is omitted;
	 *   extension/custom tools remain enabled
	 */
	noTools?: "all" | "builtin";
	/**
	 * Optional allowlist of tool names or patterns where `*` matches any characters.
	 *
	 * When omitted, Atomic uses the resolved `defaultTools` setting for the initial
	 * built-in selection when configured. Otherwise it enables the default
	 * built-in tools (read, bash, edit, write, find, search, ask_user_question,
	 * todo). Extension/custom tools remain enabled unless `noTools` changes
	 * that default. MCP tools stay registered for codemode and tool search unless
	 * an entry starts with `mcp__`; only matching tools are declared directly.
	 * `excludedTools` applies afterwards. `noTools: "all"` overrides this selection.
	 * Intercom follows the same selection and suppression rules as other extension tools.
	 * A list of only `+name`/`-name` entries changes the resolved defaults instead
	 * of allowlisting tools, and is reapplied on reload. Modifiers take exact names;
	 * mixing them with plain names or patterns throws. Total suppression still wins.
	 */
	tools?: string[];
	/**
	 * Optional blocklist of tool names or patterns, including MCP tools.
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
	/** Session storage. Defaults to the resolved settings or the shared local SQLite database. */
	sessionStore?: SessionStore | StorageSelection;
	/**
	 * Worktree snapshot settings for this session, overriding `snapshots.*` in settings.json. A turn that calls a
	 * file-writing tool records a `worktree_snapshot` entry per checkout it touched. Invalid values throw
	 * WorkspaceConfigError before the session is created.
	 */
	snapshots?: import("./worktree-snapshot/settings.ts").WorktreeSnapshotSettingsInput;

	/** Settings manager. Default: SettingsManager.create(cwd, agentDir) */
	settingsManager?: SettingsManager;
	/** Session start event metadata for extension runtime startup. */
	sessionStartEvent?: SessionStartEvent;
	/** Host bindings installed before extension startup. Rebinding does not replay startup. */
	extensionBindings?: ExtensionBindings;
	/** Session-scoped orchestration policy exposed to extension/tool handlers. */
	orchestrationContext?: OrchestrationContext;
	/** Typed capability policy for an in-process subagent child. */
	subagentPolicy?: SubagentChildPolicy;
	/**
	 * Internal: parent-issued shell task owner for an in-process subagent child. Supplied by the
	 * parent's child-session options, so child background shells appear in the parent's `/tasks`.
	 */
	parentCommandTaskOwner?: import("./tasks/child-command-owner.js").ChildCommandTaskOwner;
	/**
	 * Capacity policy for this session and its managed commands. Omitted, the session draws its own permit from the
	 * enclosing `withResourceAdmission` scope, if any. `null` means it holds none, even inside such a scope. Child
	 * options from `getChildSessionOptions()` carry the parent's admission, or `null` when the parent holds none.
	 */
	resourceAdmission?: ResourceAdmission | null;
	/**
	 * Receives "compaction ready" wakes when a background compaction result is stored (#4330). Omitted,
	 * the session notifies its own `onCompactionReady` listeners and applies the result at its next turn.
	 */
	compactionWake?: import("./compaction/background-compaction.ts").CompactionWakeDispatcher;
	resourceAdmissionSignal?: AbortSignal;
	resourceAdmissionDelegated?: boolean;
	/**
	 * Internal: called with `true` when this session starts waiting for its resource-admission permit and `false` when
	 * the wait ends, so an in-process subagent's start budget can tell that wait from the rest of its setup.
	 */
	onResourceAdmissionWait?: (waiting: boolean) => void;
	/**
	 * Release the session once it has been idle (no run, compaction, shell command or queued message) for `afterMs`
	 * milliseconds: it lets go of everything live and keeps only its stored history, and subscribers get a
	 * `session_released` event first. Rehydrate it with `AgentSessionRuntime.rehydrate(sessionId)`. Validated before
	 * anything is created; an invalid value throws `AgentReleaseConfigError`.
	 */
	releaseWhenIdle?: ReleaseWhenIdleOptions;
	/** Transform the fully constructed base system prompt at session construction. */
	systemPromptTransform?: (prompt: string) => string;
	/** Filter inherited session messages before they enter the new AgentSession. */
	initialContextTransform?: (messages: AgentMessage[]) => AgentMessage[];
}

export interface ResourceAdmissionRequest {
	readonly delegated?: boolean;
}

export interface ResourceProcessIdentity {
	readonly kind: "unix-process-group";
	readonly id: number;
}

export type ResourcePermit = (() => Promise<void>) & {
	bindProcess?: (identity: ResourceProcessIdentity) => Promise<void>;
};

export interface ResourceAdmission {
	acquire(
		kind: "session" | "process",
		signal?: AbortSignal,
		request?: ResourceAdmissionRequest,
	): Promise<ResourcePermit>;
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
	/** The resolved workspace binding, when the session was created with `workspace`. */
	workspace?: import("./workspace/resolve.ts").BoundWorkspace;
}
