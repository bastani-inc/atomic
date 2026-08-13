/**
 * RPC protocol types for headless operation.
 *
 * Commands are sent as JSON lines on stdin.
 * Responses and events are emitted as JSON lines on stdout.
 */

import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
	AuthInfoLink,
	Credential,
	OAuthAuthInfo,
	OAuthDeviceCodeInfo,
	OAuthPrompt,
	OAuthSelectPrompt,
} from "@earendil-works/pi-ai";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai/compat";
import type { CompactionReason, SessionStats } from "../../core/agent-session.ts";
import type { BashResult } from "../../core/bash-executor.ts";
import type { VerbatimCompactionResult } from "../../core/compaction/index.ts";
import type { ResourceOverlap } from "../../core/diagnostics.ts";
import type { ModelFallbackReason } from "../../core/model-resolver-types.ts";
import type { CredentialSynchronizationOperation } from "../../core/model-runtime.ts";
import type { OAuthProviderMetadata } from "../../core/oauth-login.ts";
import type { AuthStatus } from "../../core/provider-composer.ts";
import type { SessionEntry, SessionTreeNode } from "../../core/session-manager.ts";
import type { SourceInfo } from "../../core/source-info.ts";
import type { JsonAgentSessionEvent } from "../json-event.ts";

// ============================================================================
// RPC Commands (stdin)
// ============================================================================

export interface RpcModelCatalog {
	models: Model<Api>[];
	scopedModels: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>;
	customAuthProviders: Array<{ id: string; name: string }>;
	oauthProviders?: OAuthProviderMetadata[];
}

export interface RpcModelRefreshResult extends RpcModelCatalog {
	aborted: boolean;
	errors: Array<{ provider: string; message: string }>;
}
/**
 * The host supplied the API key through the login input form, so echoing it
 * back over the stdout pipe would make this response a second credential
 * egress. Only the metadata a caller needs to confirm the login travels.
 */
export type RpcLoginProviderResult =
	| (RpcModelCatalog & {
			provider: string;
			cancelled: false;
			type: "api_key";
	  })
	| { provider: string; cancelled: true };

export type RpcOAuthLoginProviderResult =
	| (RpcModelCatalog & { provider: string; cancelled: false })
	| { provider: string; cancelled: true };

export type RpcCommand =
	// Prompting
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "resume_unfinished_turn" }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "new_session"; parentSession?: string }

	// State
	| { id?: string; type: "get_state" }

	// Model
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model"; direction?: "forward" | "backward" }
	| { id?: string; type: "get_available_models" }
	| { id?: string; type: "login_provider"; provider: string; authType?: "api_key" | "oauth"; loginId?: string }
	| { id?: string; type: "save_provider_credential"; provider: string; credential: Credential }
	| { id?: string; type: "cancel_login_provider"; provider: string; loginId?: string }
	| { id?: string; type: "logout_provider"; provider: string }
	| { id?: string; type: "refresh_models"; timeoutMs?: number; force?: boolean; allowNetwork?: boolean }

	// Thinking
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }
	| { id?: string; type: "get_available_thinking_levels" }

	// Queue modes
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }

	// Compaction
	| { id?: string; type: "compact" }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }
	| { id?: string; type: "abort_compaction" }

	// Retry
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }
	| { id?: string; type: "clear_queue" }
	| { id?: string; type: "pause_queued_messages" }
	| { id?: string; type: "resume_queued_messages" }

	// Bash
	| { id?: string; type: "bash"; command: string; excludeFromContext?: boolean }
	| { id?: string; type: "user_bash"; command: string; excludeFromContext?: boolean }
	| { id?: string; type: "abort_bash"; requestId?: string }

	// Session
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "import_session"; inputPath: string; cwdOverride?: string }
	| { id?: string; type: "fork"; entryId: string }
	| { id?: string; type: "clone" }
	| { id?: string; type: "get_fork_messages" }
	| { id?: string; type: "get_entries"; since?: string }
	| { id?: string; type: "get_tree" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }
	| {
			id?: string;
			type: "navigate_tree";
			targetId: string;
			options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string };
	  }
	| { id?: string; type: "set_label"; entryId: string; label?: string }
	| { id?: string; type: "reload" }
	| { id?: string; type: "get_shortcuts" }
	| { id?: string; type: "invoke_shortcut"; key: string }

	// Messages
	| { id?: string; type: "get_messages" }

	// Commands and their live argument completions
	| { id?: string; type: "get_commands" }
	| { id?: string; type: "get_command_completions"; commandName: string; argumentPrefix: string };
// ============================================================================
// RPC Argument Completion
// ============================================================================

export interface RpcAutocompleteItem {
	value: string;
	label: string;
	description?: string;
}

// RPC Slash Command (for get_commands response)
// ============================================================================

/** A command available for invocation via prompt */
export interface RpcSlashCommand {
	/** Command name (without leading slash) */
	name: string;
	/** Human-readable description */
	description?: string;
	/** Whether the engine can evaluate argument completions for this command. */
	hasArgumentCompletions?: boolean;
	/** What kind of command this is */
	source: "extension" | "prompt" | "skill";
	/** Source metadata for the owning resource */
	sourceInfo: SourceInfo;
}

// ============================================================================
// RPC State
// ============================================================================

export interface RpcSessionState {
	model?: Model<Api>;
	modelFallbackMessage?: string;
	modelFallbackReason?: ModelFallbackReason;
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	compactionReason?: CompactionReason;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	messageCount: number;
	pendingMessageCount: number;
	queuedMessagesPaused: boolean;
	resourceOverlaps?: ResourceOverlap[];
}

export interface RpcLogoutProviderResult {
	provider: string;
	authStatus: AuthStatus;
	models: Model<Api>[];
	scopedModels?: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>;
}

// ============================================================================
// RPC Responses (stdout)
// ============================================================================

// Success responses with data
export type RpcResponse =
	// Prompting (async - events follow)
	| { id?: string; type: "response"; command: "prompt"; success: true }
	| {
			id?: string;
			type: "response";
			command: "resume_unfinished_turn";
			success: true;
			data: { resumed: boolean; completed: boolean };
	  }
	| { id?: string; type: "response"; command: "steer"; success: true }
	| { id?: string; type: "response"; command: "follow_up"; success: true }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { cancelled: boolean } }

	// State
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }

	// Model
	| {
			id?: string;
			type: "response";
			command: "set_model";
			success: true;
			data: Model<Api>;
	  }
	| {
			id?: string;
			type: "response";
			command: "cycle_model";
			success: true;
			data: { model: Model<Api>; thinkingLevel: ThinkingLevel; isScoped: boolean } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_models";
			success: true;
			data: RpcModelCatalog;
	  }
	| {
			id?: string;
			type: "response";
			command: "refresh_models";
			success: true;
			data: RpcModelRefreshResult;
	  }
	| {
			id?: string;
			type: "response";
			command: "login_provider";
			success: true;
			data: RpcLoginProviderResult | RpcOAuthLoginProviderResult;
	  }
	| {
			id?: string;
			type: "response";
			command: "save_provider_credential";
			success: true;
			data: RpcModelCatalog;
	  }
	| { id?: string; type: "response"; command: "cancel_login_provider"; success: true }
	| {
			id?: string;
			type: "response";
			command: "logout_provider";
			success: true;
			data: RpcLogoutProviderResult;
	  }

	// Thinking
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
	| {
			id?: string;
			type: "response";
			command: "cycle_thinking_level";
			success: true;
			data: { level: ThinkingLevel } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_thinking_levels";
			success: true;
			data: { levels: ThinkingLevel[] };
	  }

	// Queue modes
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }

	// Compaction
	| { id?: string; type: "response"; command: "compact"; success: true; data: VerbatimCompactionResult }
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }
	| { id?: string; type: "response"; command: "abort_compaction"; success: true }

	// Retry
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }
	| {
			id?: string;
			type: "response";
			command: "clear_queue";
			success: true;
			data: { steering: string[]; followUp: string[] };
	  }
	| { id?: string; type: "response"; command: "pause_queued_messages"; success: true }
	| { id?: string; type: "response"; command: "resume_queued_messages"; success: true; data: { released: boolean } }

	// Bash
	| { id?: string; type: "response"; command: "bash"; success: true; data: BashResult }
	| { id?: string; type: "response"; command: "user_bash"; success: true; data: BashResult }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }

	// Session
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: SessionStats }
	| { id?: string; type: "response"; command: "import_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "fork"; success: true; data: { text: string; cancelled: boolean } }
	| { id?: string; type: "response"; command: "clone"; success: true; data: { cancelled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "get_fork_messages";
			success: true;
			data: { messages: Array<{ entryId: string; text: string }> };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_entries";
			success: true;
			data: { entries: SessionEntry[]; leafId: string | null };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_tree";
			success: true;
			data: { tree: SessionTreeNode[]; leafId: string | null };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_last_assistant_text";
			success: true;
			data: { text: string | null };
	  }
	| { id?: string; type: "response"; command: "set_session_name"; success: true }
	| {
			id?: string;
			type: "response";
			command: "navigate_tree";
			success: true;
			data: { cancelled: boolean; editorText?: string };
	  }
	| { id?: string; type: "response"; command: "set_label"; success: true }
	| { id?: string; type: "response"; command: "reload"; success: true }
	| {
			id?: string;
			type: "response";
			command: "get_shortcuts";
			success: true;
			data: { shortcuts: Array<{ key: string; description?: string }> };
	  }
	| { id?: string; type: "response"; command: "invoke_shortcut"; success: true }

	// Messages
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }

	// Commands
	| {
			id?: string;
			type: "response";
			command: "get_commands";
			success: true;
			data: { commands: RpcSlashCommand[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_command_completions";
			success: true;
			data: { completions: RpcAutocompleteItem[] | null };
	  }

	// Error response (any command can fail)
	| {
			id?: string;
			type: "response";
			command: string;
			success: false;
			error: string;
			errorCode?: "credential_synchronization";
			errorDetails?: {
				providerId: string;
				operation: CredentialSynchronizationOperation;
			};
	  };

// ============================================================================
// RPC Events (stdout)
// ============================================================================

/** Events streamed by RPC mode as session activity occurs. */
export type RpcEvent = JsonAgentSessionEvent;

// ============================================================================
// Extension UI Events (stdout)
// ============================================================================
type RpcOAuthUIEnvelope = { type: "extension_ui_request"; id: string; provider: string; loginId: string };

export type RpcExtensionUIRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string }
	| (RpcOAuthUIEnvelope & { method: "oauth_auth"; info: OAuthAuthInfo })
	| (RpcOAuthUIEnvelope & { method: "oauth_device_code"; info: OAuthDeviceCodeInfo })
	| (RpcOAuthUIEnvelope & { method: "oauth_progress"; message: string })
	| (RpcOAuthUIEnvelope & { method: "oauth_info"; message: string; links: AuthInfoLink[] })
	| (RpcOAuthUIEnvelope & { method: "oauth_prompt"; prompt: OAuthPrompt })
	| (RpcOAuthUIEnvelope & { method: "oauth_select"; prompt: OAuthSelectPrompt })
	| (RpcOAuthUIEnvelope & { method: "oauth_manual_code" })
	| (RpcOAuthUIEnvelope & { method: "oauth_manual_code_cancel" });

// ============================================================================
// Extension UI Commands (stdin)
// ============================================================================

/** Response to an extension UI request */
export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true };

// ============================================================================
// Helper type for extracting command types
// ============================================================================

export type RpcCommandType = RpcCommand["type"];
