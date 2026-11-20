import type { ThinkingLevel } from "@bastani/atomic-agent-core";
import type { Api, ImageContent, Model, TextContent } from "@bastani/atomic-ai/compat";
import type { VerbatimCompactionResult } from "../compaction/index.ts";
import type { CustomMessage } from "../messages.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type { ScopedModel } from "../model-resolver.ts";
import type { ReadonlySessionManager, SessionManager } from "../session-manager.ts";
import type { SkillCatalog } from "../skill-catalog.ts";
import type { BuildSystemPromptOptions } from "../system-prompt.ts";
import type { SendMessageOptions } from "./message-types.ts";
import type { ExtensionUIContext } from "./ui-types.js";
export interface ExecuteToolOptions {
	signal?: AbortSignal;
	onUpdate?: import("@bastani/atomic-agent-core").AgentToolUpdateCallback;
}

/** Tool-only context. Nested calls retain session validation and permission hooks. */
export interface ExtensionToolContext extends ExtensionContext {
	/** The calling tool's id for a nested invocation; absent for a direct call from the model. */
	readonly parentToolCallId?: string;
	readonly tools: readonly import("@bastani/atomic-agent-core").AgentTool[];
	executeTool(
		name: string,
		args: unknown,
		options?: ExecuteToolOptions,
	): Promise<import("@bastani/atomic-agent-core").AgentToolCallOutcome>;
}

export interface ContextUsage {
	/** Estimated context tokens, or null if unknown (e.g. right after compaction, before next LLM response). */
	tokens: number | null;
	contextWindow: number;
	/** Context usage as percentage of context window, or null if tokens is unknown. */
	percent: number | null;
}

export interface CompactOptions {
	/** Instructions for this compaction: what to recover first, and a compactor model's query. */
	query?: string;
	/**
	 * `auto` or an exact compactor model `provider/model` for this run only; overrides the `compactionModel` setting
	 * without saving it.
	 */
	compactionModel?: string;
	onComplete?: (result: VerbatimCompactionResult) => void;
	onError?: (error: Error) => void;
}

/** Typed child intercom identity and supervisor capability issued at admission. */
export interface SubagentIntercomIdentity {
	readonly orchestratorTarget: string;
	readonly runId: string;
	readonly agent: string;
	readonly index: number;
	readonly sessionName?: string;
	readonly supervisor?: {
		readonly capability: string;
		readonly supervisorSessionId: string;
	};
}

/**
 * Host-owned hooks of an in-process child's start (its first turn not started yet). Intercom registers the child
 * before that turn and names its step while it does; a start that runs out of its budget aborts `signal`.
 */
export interface SubagentStartupHooks {
	/** Aborts when the start is given up, as when its start budget runs out. */
	readonly signal: AbortSignal;
	/** The start moves on to `step`. */
	enterStep(step: "registering-intercom" | "creating-session"): void;
	/** Whether the child has yet to start its first turn: a message arriving now is context for that turn. */
	firstTurnPending(): boolean;
}

/** Typed child capability policy supplied by an in-process subagent admission. */
export interface SubagentChildPolicy {
	readonly managementActions: "full" | "restricted";
	readonly fanoutAuthorized: boolean;
	readonly inheritProjectContext: boolean;
	readonly inheritSkills: boolean;
	/** Host-owned signal fired when this noninteractive execution ends, before disposal. */
	readonly executionEnded?: AbortSignal;
	readonly onTurnDrained?: () => void;
	/**
	 * Host-owned: whether the execution has yet to give the session its task. A settled turn keeps message admission
	 * open while it has, so the task is answered; the execution ending seals admission.
	 */
	readonly taskPending?: () => boolean;
	/**
	 * Host-owned: whether Esc in the child's chat paused it. Its queue, other agents' messages included, is held until
	 * the user continues it from that chat.
	 */
	readonly turnPaused?: () => boolean;
	/** SDK-owned inbound lifetime; closing drains admitted messages without reopening the task. */
	readonly messageAdmission?: {
		isOpen(): boolean;
		/** Reserve the full producer operation, including retries, before child settlement. */
		run(deliver: () => void | Promise<void>): Promise<void>;
	};
	/** Host-owned: the child's start, until its first turn starts. */
	readonly startup?: SubagentStartupHooks;
	/** Current admitted in-process nesting depth; absent for top-level sessions. */
	readonly depth?: number;
	/** SDK-resolved exact child tool allowlist; undefined leaves ordinary tools unrestricted. */
	readonly tools?: readonly string[];
	/** Server or server/tool selections. Undefined preserves MCP defaults; [] disables selector-based access. */
	readonly mcpDirectTools?: readonly string[];
	/** Admission-issued identity/capability; never inherited through process environment. */
	readonly intercom?: SubagentIntercomIdentity;
	/** Resolved intercom group for this admitted child, when one was assigned. */
	readonly intercomGroup?: string;
}

/**
 * Context passed to extension event handlers.
 */
export type ExtensionMode = "tui" | "rpc" | "json" | "print";

export interface ExtensionContext {
	/** Paths of actually loaded extensions, when supplied by the host. */
	getExtensionPaths?(): string[];
	/** Internal actual-session binding; never populated from model arguments. */
	getAgentTaskHost?(): import("../tasks/agent-adapter.js").AgentTaskHost;
	/** Internal owner-bound defaults and capability ceiling for builtin child adapters. */
	getChildSessionOptions?: import("../child-session-options.ts").ChildSessionOptionsResolver;
	/**
	 * Internal: a child-options resolver that stays valid after this context's session is replaced or closed (#3981).
	 * A queued or restored child calls it when it starts, possibly after this context is stale. It answers from the
	 * owning session’s last state. Obtain it while the context is live; the call itself asserts that.
	 */
	getChildSessionOptionsResolver?(): import("../child-session-options.ts").ChildSessionOptionsResolver;
	/** Typed capability policy for an in-process subagent child, when this session is one. */
	readonly subagentPolicy?: SubagentChildPolicy;
	/**
	 * the session's Intercom home group and reach, when its host set one with `createAgentSession({ intercom })`
	 * or it is a subagent of such a session.
	 */
	readonly intercomPolicy?: import("../intercom-policy.ts").IntercomPolicyView;
	/** UI methods for user interaction */
	ui: ExtensionUIContext;
	/** Current run mode. Use "tui" to guard terminal-only UI such as custom components. */
	mode: ExtensionMode;
	/** Whether dialog-capable UI is available (true in TUI and RPC modes) */
	hasUI: boolean;
	/** Whether a semantic human-input adapter is available, independently of rendering. */
	hasHumanInput: boolean;
	readonly isPresentationOnly?: boolean;
	/** Current working directory */
	cwd: string;
	/** Session manager (read-only) */
	sessionManager: ReadonlySessionManager;
	/** Model registry for API key resolution */
	modelRegistry: ModelRegistry;
	/** Current model (may be undefined) */
	model: Model<Api> | undefined;
	/** Models scoped to this session (resolved from `--models` / `enabledModels`
	 *  settings against the available catalogue). Same set the `/scoped-models`
	 *  command shows. Empty when no scoping is configured (all available models
	 *  are usable). Read-only snapshot, resolved at access time. */
	scopedModels: readonly ScopedModel[];
	/** Current thinking level, resolved from the active session at access time. */
	thinkingLevel?: ThinkingLevel;
	/** Session-scoped internal resource router (e.g. artifact:// resolver). */
	readonly internalResourceRouter?: import("../tools/resource-selectors.ts").InternalResourceRouter;
	/** Whether the agent is idle (not streaming) */
	isIdle(): boolean;
	/** Whether project-local trust is active for this context. */
	isProjectTrusted(): boolean;
	/** The current abort signal, or undefined when the agent is not streaming. */
	signal: AbortSignal | undefined;
	/** Ends on reload or shutdown, before admitted work is drained. Independent of agent streaming. */
	readonly sessionSignal: AbortSignal;
	/**
	 * @internal The owning session's lifetime signal as it is now. `sessionSignal` is fixed when this context is
	 * created, so it stays aborted for good once a reload that the host rolls back has begun.
	 */
	getCurrentSessionSignal?(): AbortSignal;
	/** Abort the current agent operation */
	abort(): void;
	/** Whether there are queued messages waiting */
	hasPendingMessages(): boolean;
	/** Whether background session summaries are enabled. */
	isSessionSummaryEnabled?(): boolean;
	/** Gracefully shutdown pi and exit. Available in all contexts. */
	shutdown(): void;
	/** Get current context usage for the active model. */
	getContextUsage(): ContextUsage | undefined;
	/** Trigger compaction without awaiting completion. */
	compact(options?: CompactOptions): void;
	/** Get the current effective system prompt. */
	getSystemPrompt(): string;
	/** Current loader-owned skill candidates and exact selector resolver. */
	getSkillCatalog?(): SkillCatalog;
	/**
	 * Subagent definition files that installed packages ship through their manifest's `agents` field, as resolved by
	 * the last resource reload: enabled by the package filters, and only from project-installed packages when the
	 * project is trusted.
	 */
	getPackageAgents?(): readonly import("../resource-loader-types.ts").PackageAgentFile[];
	/**
	 * The owning session's `decisionModel`: an exact `provider/model`, `"auto"` or `""`. Every decision uses it: the
	 * `structured_output` tool without a `model`, readiness after a steer, and `decide()`. Does not change the chat model.
	 */
	getDecisionModel(): string;
	/** The owning session's `httpIdleTimeoutMs` setting in milliseconds; 0 means the idle timeout is disabled. */
	getHttpIdleTimeoutMs?(): number;
}

/**
 * Extended context for command handlers.
 * Includes session control methods only safe in user-initiated commands.
 */
export interface ExtensionCommandContext extends ExtensionContext {
	/** Get the current base system-prompt construction options. */
	getSystemPromptOptions(): BuildSystemPromptOptions;

	/** Wait for the agent to finish streaming */
	waitForIdle(): Promise<void>;

	/** Start a new session, optionally with initialization. */
	newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }>;

	/** Fork from a specific entry, creating a new session file. */
	fork(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean }>;

	/** Navigate to a different point in the session tree. */
	navigateTree(
		targetId: string,
		options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
	): Promise<{ cancelled: boolean }>;

	/** Switch to a different session by ID. */
	switchSession(
		sessionId: string,
		options?: { withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean }>;

	/** Reload extensions, skills, prompts, and themes. */
	reload(): Promise<void>;
}

/**
 * Fresh command-capable context bound to the replacement session after a session switch.
 *
 * This is passed to `withSession()` callbacks on `newSession()`, `fork()`, and `switchSession()`.
 */
export interface ReplacedSessionContext extends ExtensionCommandContext {
	sendMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: SendMessageOptions,
	): Promise<void>;

	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
	): Promise<void>;
}
