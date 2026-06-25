import { normalizePath } from "../utils/paths.ts";
import { parseContextWindowValue, validateContextWindowValue } from "./context-window.ts";
import { DEFAULT_HTTP_IDLE_TIMEOUT_MS, parseHttpIdleTimeoutMs } from "./http-dispatcher.ts";
import { SettingsManager } from "./settings-manager-core.ts";
import { settingsInternals } from "./settings-manager-internals.ts";
import type { ContextWindowSetting, TransportSetting } from "./settings-types.ts";

interface SettingsManagerBasicAccessors {
	getLastChangelogVersion(): string | undefined;
	setLastChangelogVersion(version: string): void;
	getFirstRunOnboardingStartedVersion(): string | undefined;
	setFirstRunOnboardingStartedVersion(version: string): void;
	getOnboardedVersion(): string | undefined;
	setOnboardedVersion(version: string): void;
	getSessionDir(): string | undefined;
	getDefaultProvider(): string | undefined;
	getDefaultModel(): string | undefined;
	setDefaultProvider(provider: string): void;
	setDefaultModel(modelId: string): void;
	setDefaultModelAndProvider(provider: string, modelId: string): void;
	getSteeringMode(): "all" | "one-at-a-time";
	setSteeringMode(mode: "all" | "one-at-a-time"): void;
	getFollowUpMode(): "all" | "one-at-a-time";
	setFollowUpMode(mode: "all" | "one-at-a-time"): void;
	getThemeSetting(): string | undefined;
	getTheme(): string | undefined;
	setTheme(theme: string): void;
	getDefaultThinkingLevel(): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
	setDefaultThinkingLevel(level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"): void;
	getDefaultContextWindow(): number | undefined;
	getDefaultContextWindowForModel(provider: string, modelId: string): number | undefined;
	setDefaultContextWindow(contextWindow: number | undefined): void;
	setDefaultContextWindowForModel(provider: string, modelId: string, contextWindow: number | undefined): void;
	getTransport(): TransportSetting;
	setTransport(transport: TransportSetting): void;
	getCompactionEnabled(): boolean;
	setCompactionEnabled(enabled: boolean): void;
	getCompactionReserveTokens(): number;
	getCompactionCompressionRatio(): number;
	getCompactionPreserveRecent(): number;
	getCompactionQuery(): string | undefined;
	getCompactionSettings(): {
		enabled: boolean;
		reserveTokens: number;
		compression_ratio: number;
		preserve_recent: number;
		query?: string;
	};
	getBranchSummarySettings(): { reserveTokens: number; skipPrompt: boolean };
	getBranchSummarySkipPrompt(): boolean;
	getRetryEnabled(): boolean;
	setRetryEnabled(enabled: boolean): void;
	getRetrySettings(): { enabled: boolean; maxRetries: number; baseDelayMs: number };
	getHttpIdleTimeoutMs(): number;
	setHttpIdleTimeoutMs(timeoutMs: number): void;
	getWebSocketConnectTimeoutMs(): number | undefined;
	getProviderRetrySettings(): { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs: number };
}

declare module "./settings-manager-core.ts" {
	interface SettingsManager extends SettingsManagerBasicAccessors {}
}

function defaultContextWindowModelKey(provider: string, modelId: string): string {
	return `${provider}/${modelId}`;
}

function parseContextWindowSetting(configured: ContextWindowSetting | undefined): number | undefined {
	if (typeof configured === "number") {
		return validateContextWindowValue(configured) ? undefined : configured;
	}
	if (typeof configured === "string") {
		return parseContextWindowValue(configured).value;
	}
	return undefined;
}

const basicAccessors: SettingsManagerBasicAccessors = {
	getLastChangelogVersion() {
		return settingsInternals(this).settings.lastChangelogVersion;
	},

	setLastChangelogVersion(version) {
		const state = settingsInternals(this);
		state.globalSettings.lastChangelogVersion = version;
		state.markModified("lastChangelogVersion");
		state.save();
	},

	getFirstRunOnboardingStartedVersion() {
		return settingsInternals(this).settings.firstRunOnboardingStartedVersion;
	},

	setFirstRunOnboardingStartedVersion(version) {
		const state = settingsInternals(this);
		state.globalSettings.firstRunOnboardingStartedVersion = version;
		state.markModified("firstRunOnboardingStartedVersion");
		state.save();
	},

	getOnboardedVersion() {
		return settingsInternals(this).settings.onboardedVersion;
	},

	setOnboardedVersion(version) {
		const state = settingsInternals(this);
		state.globalSettings.onboardedVersion = version;
		state.markModified("onboardedVersion");
		state.save();
	},

	getSessionDir() {
		const sessionDir = settingsInternals(this).settings.sessionDir;
		return sessionDir ? normalizePath(sessionDir) : sessionDir;
	},

	getDefaultProvider() {
		return settingsInternals(this).settings.defaultProvider;
	},

	getDefaultModel() {
		return settingsInternals(this).settings.defaultModel;
	},

	setDefaultProvider(provider) {
		const state = settingsInternals(this);
		state.globalSettings.defaultProvider = provider;
		state.markModified("defaultProvider");
		state.save();
	},

	setDefaultModel(modelId) {
		const state = settingsInternals(this);
		state.globalSettings.defaultModel = modelId;
		state.markModified("defaultModel");
		state.save();
	},

	setDefaultModelAndProvider(provider, modelId) {
		const state = settingsInternals(this);
		state.globalSettings.defaultProvider = provider;
		state.globalSettings.defaultModel = modelId;
		state.markModified("defaultProvider");
		state.markModified("defaultModel");
		state.save();
	},

	getSteeringMode() {
		return settingsInternals(this).settings.steeringMode || "one-at-a-time";
	},

	setSteeringMode(mode) {
		const state = settingsInternals(this);
		state.globalSettings.steeringMode = mode;
		state.markModified("steeringMode");
		state.save();
	},

	getFollowUpMode() {
		return settingsInternals(this).settings.followUpMode || "one-at-a-time";
	},

	setFollowUpMode(mode) {
		const state = settingsInternals(this);
		state.globalSettings.followUpMode = mode;
		state.markModified("followUpMode");
		state.save();
	},

	getThemeSetting() {
		const value = settingsInternals(this).settings.theme;
		if (typeof value === "string") return value;
		return undefined;
	},

	getTheme() {
		const theme = this.getThemeSetting();
		return theme?.includes("/") ? undefined : theme;
	},

	setTheme(theme) {
		const state = settingsInternals(this);
		state.globalSettings.theme = theme;
		state.markModified("theme");
		state.save();
	},

	getDefaultThinkingLevel() {
		return settingsInternals(this).settings.defaultThinkingLevel;
	},

	setDefaultThinkingLevel(level) {
		const state = settingsInternals(this);
		state.globalSettings.defaultThinkingLevel = level;
		state.markModified("defaultThinkingLevel");
		state.save();
	},

	getDefaultContextWindow() {
		return parseContextWindowSetting(settingsInternals(this).settings.defaultContextWindow);
	},

	getDefaultContextWindowForModel(provider, modelId) {
		const key = defaultContextWindowModelKey(provider, modelId);
		return parseContextWindowSetting(settingsInternals(this).settings.defaultContextWindows?.[key]);
	},

	setDefaultContextWindow(contextWindow) {
		const state = settingsInternals(this);
		if (contextWindow === undefined) {
			delete state.globalSettings.defaultContextWindow;
		} else {
			state.globalSettings.defaultContextWindow = contextWindow;
		}
		state.markModified("defaultContextWindow");
		state.save();
	},

	setDefaultContextWindowForModel(provider, modelId, contextWindow) {
		const state = settingsInternals(this);
		const key = defaultContextWindowModelKey(provider, modelId);
		const next = { ...(state.globalSettings.defaultContextWindows ?? {}) };
		if (contextWindow === undefined) {
			delete next[key];
		} else {
			next[key] = contextWindow;
		}
		if (Object.keys(next).length === 0) {
			delete state.globalSettings.defaultContextWindows;
		} else {
			state.globalSettings.defaultContextWindows = next;
		}
		state.markModified("defaultContextWindows");
		state.save();
	},

	getTransport() {
		return settingsInternals(this).settings.transport ?? "auto";
	},

	setTransport(transport) {
		const state = settingsInternals(this);
		state.globalSettings.transport = transport;
		state.markModified("transport");
		state.save();
	},

	getCompactionEnabled() {
		return settingsInternals(this).settings.compaction?.enabled ?? true;
	},

	setCompactionEnabled(enabled) {
		const state = settingsInternals(this);
		if (!state.globalSettings.compaction) {
			state.globalSettings.compaction = {};
		}
		state.globalSettings.compaction.enabled = enabled;
		state.markModified("compaction", "enabled");
		state.save();
	},

	getCompactionReserveTokens() {
		return settingsInternals(this).settings.compaction?.reserveTokens ?? 16384;
	},

	getCompactionCompressionRatio() {
		const value = settingsInternals(this).settings.compaction?.compression_ratio;
		return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1 ? value : 0.5;
	},

	getCompactionPreserveRecent() {
		const value = settingsInternals(this).settings.compaction?.preserve_recent;
		return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 2;
	},

	getCompactionQuery() {
		const query = settingsInternals(this).settings.compaction?.query?.trim();
		return query && query.length > 0 ? query : undefined;
	},

	getCompactionSettings() {
		const query = this.getCompactionQuery();
		return {
			enabled: this.getCompactionEnabled(),
			reserveTokens: this.getCompactionReserveTokens(),
			compression_ratio: this.getCompactionCompressionRatio(),
			preserve_recent: this.getCompactionPreserveRecent(),
			...(query === undefined ? {} : { query }),
		};
	},

	getBranchSummarySettings() {
		return {
			reserveTokens: settingsInternals(this).settings.branchSummary?.reserveTokens ?? 16384,
			skipPrompt: settingsInternals(this).settings.branchSummary?.skipPrompt ?? false,
		};
	},

	getBranchSummarySkipPrompt() {
		return settingsInternals(this).settings.branchSummary?.skipPrompt ?? false;
	},

	getRetryEnabled() {
		return settingsInternals(this).settings.retry?.enabled ?? true;
	},

	setRetryEnabled(enabled) {
		const state = settingsInternals(this);
		if (!state.globalSettings.retry) {
			state.globalSettings.retry = {};
		}
		state.globalSettings.retry.enabled = enabled;
		state.markModified("retry", "enabled");
		state.save();
	},

	getRetrySettings() {
		return {
			enabled: this.getRetryEnabled(),
			maxRetries: settingsInternals(this).settings.retry?.maxRetries ?? 3,
			baseDelayMs: settingsInternals(this).settings.retry?.baseDelayMs ?? 2000,
		};
	},

	getHttpIdleTimeoutMs() {
		const value = settingsInternals(this).settings.httpIdleTimeoutMs;
		const timeoutMs = parseHttpIdleTimeoutMs(value);
		if (timeoutMs !== undefined) {
			return timeoutMs;
		}
		if (value !== undefined) {
			throw new Error(`Invalid httpIdleTimeoutMs setting: ${String(value)}`);
		}
		return DEFAULT_HTTP_IDLE_TIMEOUT_MS;
	},

	setHttpIdleTimeoutMs(timeoutMs) {
		const normalizedTimeoutMs = parseHttpIdleTimeoutMs(timeoutMs);
		if (normalizedTimeoutMs === undefined) {
			throw new Error(`Invalid httpIdleTimeoutMs setting: ${String(timeoutMs)}`);
		}
		const state = settingsInternals(this);
		state.globalSettings.httpIdleTimeoutMs = normalizedTimeoutMs;
		state.markModified("httpIdleTimeoutMs");
		state.save();
	},

	getWebSocketConnectTimeoutMs() {
		const value = settingsInternals(this).settings.websocketConnectTimeoutMs;
		const timeoutMs = parseHttpIdleTimeoutMs(value);
		if (timeoutMs !== undefined) {
			return timeoutMs;
		}
		if (value !== undefined) {
			throw new Error(`Invalid websocketConnectTimeoutMs setting: ${String(value)}`);
		}
		return undefined;
	},

	getProviderRetrySettings() {
		return {
			timeoutMs: settingsInternals(this).settings.retry?.provider?.timeoutMs,
			maxRetries: settingsInternals(this).settings.retry?.provider?.maxRetries,
			maxRetryDelayMs: settingsInternals(this).settings.retry?.provider?.maxRetryDelayMs ?? 60000,
		};
	},
};

Object.assign(SettingsManager.prototype, basicAccessors);
