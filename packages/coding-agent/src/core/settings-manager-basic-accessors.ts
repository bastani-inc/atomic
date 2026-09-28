import { randomUUID } from "node:crypto";
import { DEFAULT_MAX_AGENT_RETRY_DELAY_MS, type Model } from "@bastani/pi-ai";
import { normalizePath } from "../utils/paths.ts";
import { DEFAULT_HTTP_IDLE_TIMEOUT_MS, parseHttpIdleTimeoutMs } from "./http-dispatcher.ts";
import { SettingsManager } from "./settings-manager-core.ts";
import { settingsInternals } from "./settings-manager-internals.ts";
import type {
	CompactionModelOverride,
	CompactionSettings,
	ModelRoutingSettings,
	TransportSetting,
} from "./settings-types.ts";
import { CACHE_WARMING_MODES, type CacheWarmingMode } from "./settings-types.ts";

type CompactionModel = Pick<Model<string>, "provider" | "id">;

const MODEL_ROUTING_ERROR =
	'Invalid modelRouting: allowedProviders and excludedProviders must be arrays of provider IDs, such as ["github-copilot"].';

function providerList(value: unknown): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim() || item.trim() !== item))
		throw new Error(MODEL_ROUTING_ERROR);
	return [...new Set(value as string[])];
}

function resolveCompactionSetting(
	compaction: CompactionSettings | undefined,
	field: keyof CompactionModelOverride,
	model?: CompactionModel,
): number {
	const ordinary = compaction?.[field];
	if (ordinary !== undefined && (typeof ordinary !== "number" || !Number.isSafeInteger(ordinary) || ordinary < 0)) {
		throw new Error(
			`Invalid compaction.${field} setting: ${String(ordinary)}. Expected a non-negative safe integer.`,
		);
	}
	const modelKey = model ? `${model.provider}/${model.id}` : undefined;
	const entry = modelKey === undefined ? undefined : compaction?.modelOverrides?.[modelKey];
	if (entry !== undefined && (entry === null || typeof entry !== "object" || Array.isArray(entry))) {
		throw new Error(
			`Invalid compaction.modelOverrides["${modelKey}"] setting: ${String(entry)}. Expected an object.`,
		);
	}
	const override = entry?.[field];
	if (override !== undefined && (typeof override !== "number" || !Number.isSafeInteger(override) || override < 0)) {
		throw new Error(
			`Invalid compaction.modelOverrides["${modelKey}"].${field} setting: ${String(override)}. Expected a non-negative safe integer.`,
		);
	}
	return override ?? ordinary ?? (field === "reserveTokens" ? 16384 : 2);
}

interface SettingsManagerBasicAccessors {
	getCacheWarmingMode(): CacheWarmingMode;
	setCacheWarmingMode(mode: CacheWarmingMode): void;
	getLastChangelogVersion(): string | undefined;
	setLastChangelogVersion(version: string): void;
	getFirstRunOnboardingStartedVersion(): string | undefined;
	setFirstRunOnboardingStartedVersion(version: string): void;
	getOnboardedVersion(): string | undefined;
	setOnboardedVersion(version: string): void;
	getSessionDir(): string | undefined;
	getDefaultProvider(): string | undefined;
	getDefaultModel(): string | undefined;
	getRouterModel(): string;
	getModelRouting(): ModelRoutingSettings;
	setRouterModel(model: string, scope?: "global" | "project"): void;
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
	getEnableAnalytics(): boolean | undefined;
	setEnableAnalytics(enabled: boolean): void;
	getTrackingId(): string | undefined;
	getShowCacheMissNotices(): boolean;
	setShowCacheMissNotices(enabled: boolean): void;
	getDefaultThinkingLevel(): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined;
	setDefaultThinkingLevel(level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"): void;
	getModelThinkingLevel(
		provider: string,
		modelId: string,
	): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined;
	getAllModelThinkingLevels(): Record<string, "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max">;
	setModelThinkingLevel(
		provider: string,
		modelId: string,
		level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
	): void;
	removeModelThinkingLevel(provider: string, modelId: string): void;
	getDefaultTools(): string[] | undefined;
	getFallbackModels(): string[];
	getTransport(): TransportSetting;
	setTransport(transport: TransportSetting): void;
	getCompactionEnabled(): boolean;
	setCompactionEnabled(enabled: boolean): void;
	getCompactionReserveTokens(model?: CompactionModel): number;
	getCompactionCompressionRatio(): number;
	getCompactionPreserveRecent(model?: CompactionModel): number;
	getCompactionQuery(): string | undefined;
	getCompactionSettings(model?: CompactionModel): {
		enabled: boolean;
		reserveTokens: number;
		compression_ratio: number;
		preserve_recent: number;
		query?: string;
	};
	getBranchSummarySettings(): { reserveTokens: number; skipPrompt: boolean };
	getBranchSummarySkipPrompt(): boolean;
	getSessionSummarySettings(): { enabled: boolean };
	getRetryEnabled(): boolean;
	setRetryEnabled(enabled: boolean): void;
	getRetrySettings(): { enabled: boolean; maxRetries: number; baseDelayMs: number; maxAgentDelayMs: number };
	getHttpProxy(): string | undefined;
	setHttpProxy(proxy: string | undefined): void;
	getHttpIdleTimeoutMs(): number;
	setHttpIdleTimeoutMs(timeoutMs: number): void;
	getWebSocketConnectTimeoutMs(): number | undefined;
	getStreamDeadlineMs(): number | undefined;
	getProviderRetrySettings(): { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs: number };
}

declare module "./settings-manager-core.ts" {
	interface SettingsManager extends SettingsManagerBasicAccessors {}
}

const basicAccessors: SettingsManagerBasicAccessors = {
	getCacheWarmingMode() {
		const mode = settingsInternals(this).globalSettings.cacheWarming;
		return mode !== undefined && CACHE_WARMING_MODES.includes(mode) ? mode : "streaming";
	},
	setCacheWarmingMode(mode) {
		const state = settingsInternals(this);
		state.globalSettings.cacheWarming = mode;
		state.markModified("cacheWarming");
		state.save();
	},
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

	getRouterModel() {
		const value = settingsInternals(this).settings.routerModel;
		if (value === undefined) return "";
		if (typeof value !== "string" || value.trim() !== value) {
			throw new Error("Invalid routerModel: expected an exact provider/model ID, auto, or an empty string.");
		}
		return value;
	},

	getModelRouting() {
		const value = settingsInternals(this).settings.modelRouting;
		if (value === undefined) return {};
		if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(MODEL_ROUTING_ERROR);
		const allowedProviders = providerList(value.allowedProviders);
		const excludedProviders = providerList(value.excludedProviders);
		return {
			...(allowedProviders ? { allowedProviders } : {}),
			...(excludedProviders ? { excludedProviders } : {}),
		};
	},

	setRouterModel(model, scope = "global") {
		if (typeof model !== "string" || model.trim() !== model) {
			throw new Error("Invalid routerModel: expected an exact provider/model ID, auto, or an empty string.");
		}
		const state = settingsInternals(this);
		if (scope === "project") {
			const projectSettings = { ...state.projectSettings, routerModel: model };
			state.markProjectModified("routerModel");
			state.saveProjectSettings(projectSettings);
			return;
		}
		state.globalSettings.routerModel = model;
		state.markModified("routerModel");
		state.save();
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

	getEnableAnalytics() {
		return settingsInternals(this).settings.enableAnalytics;
	},

	setEnableAnalytics(enabled) {
		const state = settingsInternals(this);
		state.globalSettings.enableAnalytics = enabled;
		state.markModified("enableAnalytics");
		if (enabled && !state.globalSettings.trackingId) {
			state.globalSettings.trackingId = randomUUID();
			state.markModified("trackingId");
		}
		state.save();
	},

	getTrackingId() {
		return settingsInternals(this).settings.trackingId;
	},

	getShowCacheMissNotices() {
		return settingsInternals(this).settings.showCacheMissNotices ?? false;
	},

	setShowCacheMissNotices(enabled) {
		const state = settingsInternals(this);
		state.globalSettings.showCacheMissNotices = enabled;
		state.markModified("showCacheMissNotices");
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

	getModelThinkingLevel(provider, modelId) {
		return settingsInternals(this).settings.modelThinkingLevels?.[`${provider}/${modelId}`];
	},

	getAllModelThinkingLevels() {
		return { ...(settingsInternals(this).settings.modelThinkingLevels ?? {}) };
	},

	setModelThinkingLevel(provider, modelId, level) {
		const state = settingsInternals(this);
		state.globalSettings.modelThinkingLevels ??= {};
		state.globalSettings.modelThinkingLevels[`${provider}/${modelId}`] = level;
		state.markModified("modelThinkingLevels");
		state.save();
	},

	removeModelThinkingLevel(provider, modelId) {
		const state = settingsInternals(this);
		if (!state.globalSettings.modelThinkingLevels) return;
		delete state.globalSettings.modelThinkingLevels[`${provider}/${modelId}`];
		if (Object.keys(state.globalSettings.modelThinkingLevels).length === 0)
			delete state.globalSettings.modelThinkingLevels;
		state.markModified("modelThinkingLevels");
		state.save();
	},

	getDefaultTools() {
		// Settings load unvalidated from disk, so guard the shape here the same
		// way getFallbackModels() does: a non-array (or null) reads as unset,
		// and non-string entries are dropped rather than passed through to the
		// initial tool selection.
		const tools = settingsInternals(this).settings.defaultTools;
		return Array.isArray(tools) ? tools.filter((tool): tool is string => typeof tool === "string") : undefined;
	},

	getFallbackModels() {
		return (settingsInternals(this).settings.fallbackModels ?? [])
			.filter((model): model is string => typeof model === "string")
			.map((model) => model.trim())
			.filter((model) => model.length > 0);
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

	getCompactionReserveTokens(model) {
		return resolveCompactionSetting(settingsInternals(this).settings.compaction, "reserveTokens", model);
	},

	getCompactionCompressionRatio() {
		const value = settingsInternals(this).settings.compaction?.compression_ratio;
		return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1 ? value : 0.5;
	},

	getCompactionPreserveRecent(model) {
		return resolveCompactionSetting(settingsInternals(this).settings.compaction, "preserve_recent", model);
	},

	getCompactionQuery() {
		const query = settingsInternals(this).settings.compaction?.query?.trim();
		return query && query.length > 0 ? query : undefined;
	},

	getCompactionSettings(model) {
		const query = this.getCompactionQuery();
		return {
			enabled: this.getCompactionEnabled(),
			reserveTokens: this.getCompactionReserveTokens(model),
			compression_ratio: this.getCompactionCompressionRatio(),
			preserve_recent: this.getCompactionPreserveRecent(model),
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

	getSessionSummarySettings() {
		return {
			enabled: settingsInternals(this).settings.sessionSummary?.enabled ?? true,
		};
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
			maxAgentDelayMs: settingsInternals(this).settings.retry?.maxAgentDelayMs ?? DEFAULT_MAX_AGENT_RETRY_DELAY_MS,
		};
	},

	getHttpProxy() {
		return settingsInternals(this).globalSettings.httpProxy;
	},

	setHttpProxy(proxy) {
		const state = settingsInternals(this);
		state.globalSettings.httpProxy = proxy;
		state.markModified("httpProxy");
		state.save();
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

	getStreamDeadlineMs() {
		const value = settingsInternals(this).settings.streamDeadlineMs;
		const deadlineMs = parseHttpIdleTimeoutMs(value);
		if (deadlineMs !== undefined) {
			return deadlineMs;
		}
		if (value !== undefined) {
			throw new Error(`Invalid streamDeadlineMs setting: ${String(value)}`);
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
