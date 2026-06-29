import type { Transport } from "@earendil-works/pi-ai/compat";

export interface CompactionSettings {
	enabled?: boolean; // default: true
	reserveTokens?: number; // default: 16384
	compression_ratio?: number; // default: 0.5 (fraction of compactable context to keep)
	preserve_recent?: number; // default: 2 (recent context-eligible messages to keep)
	query?: string; // default: auto-detected from session context
}

export interface BranchSummarySettings {
	reserveTokens?: number; // default: 16384 (tokens reserved for prompt + LLM response)
	skipPrompt?: boolean; // default: false - when true, skips "Summarize branch?" prompt and defaults to no summary
}

export interface ProviderRetrySettings {
	timeoutMs?: number; // SDK/provider request timeout in milliseconds
	maxRetries?: number; // SDK/provider retry attempts
	maxRetryDelayMs?: number; // default: 60000 (max server-requested delay before failing)
}

export interface RetrySettings {
	enabled?: boolean; // default: true
	maxRetries?: number; // default: 3
	baseDelayMs?: number; // default: 2000 (exponential backoff: 2s, 4s, 8s)
	provider?: ProviderRetrySettings;
}

export interface TerminalSettings {
	showImages?: boolean; // default: true (only relevant if terminal supports images)
	imageWidthCells?: number; // default: 60 (preferred inline image width in terminal cells)
	clearOnShrink?: boolean; // default: false (clear empty rows when content shrinks)
	showTerminalProgress?: boolean; // default: false (OSC 9;4 terminal progress indicators)
}

export interface ImageSettings {
	autoResize?: boolean; // default: true (resize images to 2000x2000 max for better model compatibility)
	blockImages?: boolean; // default: false - when true, prevents all images from being sent to LLM providers
}

export interface SearchSettings { contextBefore?: number; contextAfter?: number }
export interface ThinkingBudgetsSettings {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

export interface MarkdownSettings {
	codeBlockIndent?: string; // default: "  "
}

export interface WarningSettings {
	anthropicExtraUsage?: boolean; // default: true
}

export interface CodexFastModeSettings {
	chat?: boolean; // default: false
	workflow?: boolean; // default: false
}

export type DefaultProjectTrust = "ask" | "always" | "never";

export type TransportSetting = Transport;

export type ContextWindowSetting = number | string;
export type ModelContextWindowSettings = Record<string, ContextWindowSetting>;

/**
 * Package source for npm/git packages.
 * - String form: load all resources from the package
 * - Object form: filter which resources to load
 */
export type PackageSource =
	| string
	| {
			source: string;
			extensions?: string[];
			skills?: string[];
			prompts?: string[];
			themes?: string[];
			workflows?: string[];
	  };

export interface BashInterceptorSettings {
	enabled?: boolean; // default: false
}

export interface Settings {
	lastChangelogVersion?: string;
	firstRunOnboardingStartedVersion?: string;
	onboardedVersion?: string;
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	defaultContextWindow?: ContextWindowSetting; // Optional global fallback; model picker writes defaultContextWindows instead.
	defaultContextWindows?: ModelContextWindowSettings; // Per-model defaults keyed as "provider/modelId".
	transport?: TransportSetting; // default: "auto"
	steeringMode?: "all" | "one-at-a-time";
	followUpMode?: "all" | "one-at-a-time";
	theme?: string;
	compaction?: CompactionSettings;
	branchSummary?: BranchSummarySettings;
	retry?: RetrySettings;
	hideThinkingBlock?: boolean;
	shellPath?: string; // Custom shell path (e.g., for Cygwin users on Windows)
	quietStartup?: boolean;
	defaultProjectTrust?: DefaultProjectTrust; // default: "ask"; global setting only
	shellCommandPrefix?: string; // Prefix prepended to every bash command (e.g., "shopt -s expand_aliases" for alias support)
	bashInterceptor?: BashInterceptorSettings; // default: disabled; when enabled, user_bash handlers can intercept bash tool execution
	search?: SearchSettings; // Context lines for search results; defaults: before=1, after=3
	npmCommand?: string[]; // Command used for npm package lookup/install operations, argv-style (e.g., ["mise", "exec", "node@20", "--", "npm"])
	collapseChangelog?: boolean; // Show condensed changelog after update (use /changelog for full)
	enableInstallTelemetry?: boolean; // default: true - anonymous version/update ping after changelog-detected updates
	packages?: PackageSource[]; // Array of npm/git package sources (string or object with filtering)
	extensions?: string[]; // Array of local extension file paths or directories
	skills?: string[]; // Array of local skill file paths or directories
	prompts?: string[]; // Array of local prompt template paths or directories
	themes?: string[]; // Array of local theme file paths or directories
	workflows?: string[]; // Array of local workflow file paths or directories
	enableSkillCommands?: boolean; // default: true - register skills as /skill:name commands
	terminal?: TerminalSettings;
	images?: ImageSettings;
	enabledModels?: string[]; // Model patterns for cycling (same format as --models CLI flag)
	doubleEscapeAction?: "fork" | "tree" | "none"; // Action for double-escape with empty editor (default: "tree")
	treeFilterMode?: "default" | "no-tools" | "user-only" | "labeled-only" | "all"; // Default filter when opening /tree
	thinkingBudgets?: ThinkingBudgetsSettings; // Custom token budgets for thinking levels
	editorPaddingX?: number; // Horizontal padding for input editor (default: 0)
	autocompleteMaxVisible?: number; // Max visible items in autocomplete dropdown (default: 5)
	showHardwareCursor?: boolean; // Show terminal cursor while still positioning it for IME
	markdown?: MarkdownSettings;
	warnings?: WarningSettings;
	codexFastMode?: CodexFastModeSettings; // OpenAI priority service tier toggles for chat/workflow
	sessionDir?: string; // Custom session storage directory (same format as --session-dir CLI flag)
	httpIdleTimeoutMs?: number; // HTTP header/body idle timeout in milliseconds; 0 disables it
	websocketConnectTimeoutMs?: number; // WebSocket connect/open handshake timeout in milliseconds; 0 disables it
}

export type SettingsScope = "global" | "project";

export interface SettingsManagerCreateOptions {
	projectTrusted?: boolean;
}

export interface SettingsStorage {
	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void;
}

export interface SettingsError {
	scope: SettingsScope;
	error: Error;
}
