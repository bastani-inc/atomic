import type { CacheWarmingMode, Settings } from "./settings-schema.ts";

export const CACHE_WARMING_MODES = ["off", "streaming", "idle"] as const satisfies readonly CacheWarmingMode[];

export type {
	BashInterceptorSettings,
	BranchSummarySettings,
	CacheWarmingMode,
	CodemodeMode,
	CodemodeSettings,
	CompactionModelOverride,
	CompactionSettings,
	DefaultProjectTrust,
	FullscreenExitOutput,
	ImageSettings,
	MarkdownSettings,
	MermaidRenderingMode,
	ModelRoutingSettings,
	PackageSource,
	ProviderRetrySettings,
	QuietStartup,
	RetrySettings,
	SearchSettings,
	SessionSummarySettings,
	Settings,
	TerminalSettings,
	ThinkingBudgetsSettings,
	TransportSetting,
	WarningSettings,
} from "./settings-schema.ts";

export type SettingsScope = "global" | "project";

export interface SettingsManagerCreateOptions {
	projectTrusted?: boolean;
}

export type SettingsFieldOrigin = "primary" | "legacy";

export interface SettingsStorage {
	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void;
	/**
	 * Optional write-specific lock whose callback receives the current primary
	 * document rather than a layered effective view. Storage implementations
	 * without a distinct primary document can omit this method; layered storage
	 * implementations must provide it to keep fallback fields out of the primary
	 * document.
	 */
	withPrimaryWriteLock?(scope: SettingsScope, fn: (currentPrimary: string | undefined) => string | undefined): void;
	getFieldOrigin?(scope: SettingsScope, field: keyof Settings): SettingsFieldOrigin | undefined;
}

export interface SettingsError {
	scope: SettingsScope;
	path?: string;
	error: Error;
}
