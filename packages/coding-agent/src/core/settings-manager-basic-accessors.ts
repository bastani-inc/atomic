import { randomUUID } from "node:crypto";
import { type Model, normalizeProviderId } from "@bastani/atomic-ai";
import { CompactionConfigError } from "./compaction/errors.js";
import { DecisionConfigError } from "./decision/errors.js";
import { parseHttpIdleTimeoutMs } from "./http-dispatcher.ts";
import { SETTINGS_DEFAULTS } from "./settings-defaults.ts";
import { SettingsManager } from "./settings-manager-core.ts";
import { settingsInternals, stringEntries } from "./settings-manager-internals.ts";
import { resolveDefaultTools, resolveDefaultToolsWith } from "./settings-merge.js";
import type { Settings } from "./settings-schema.ts";
import type { CompactionSettings, TransportSetting } from "./settings-types.ts";
import { CACHE_WARMING_MODES, type CacheWarmingMode } from "./settings-types.ts";
import type { WorktreePoolSettings } from "./worktree-snapshot/pool.ts";
import { resolveWorktreeSnapshotSettings } from "./worktree-snapshot/settings.ts";
import type { WorktreeSnapshotSettings } from "./worktree-snapshot/types.ts";

type CompactionModel = Pick<Model<string>, "provider" | "id">;

/** The storage keys `setStorageLayout` replaces; an absent key is left as it is. */
export interface StorageLayout {
	readonly storage?: Settings["storage"];
	readonly sessionsStorage?: NonNullable<Settings["sessions"]>["storage"];
}

function resolveReserveTokens(compaction: CompactionSettings | undefined): number {
	const value = compaction?.reserveTokens;
	if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) {
		throw new Error(
			`Invalid compaction.reserveTokens setting: ${String(value)}. Expected a non-negative safe integer.`,
		);
	}
	return value ?? SETTINGS_DEFAULTS.compaction.reserveTokens;
}

interface SettingsManagerBasicAccessors {
	getCacheWarmingMode(): CacheWarmingMode;
	setCacheWarmingMode(mode: CacheWarmingMode): void;
	getLastChangelogVersion(): string | undefined;
	setLastChangelogVersion(version: string): void;
	/** Replace the global top-level `storage` selection; other settings keep their values. */
	setStorage(storage: Settings["storage"]): void;
	/**
	 * Replace the global top-level `storage` selection and the `sessions.storage` pin in one settings write; only the
	 * keys present in `layout` change, and `undefined` removes one. An emptied `sessions` object is removed.
	 */
	setStorageLayout(layout: StorageLayout): void;
	getFirstRunOnboardingStartedVersion(): string | undefined;
	setFirstRunOnboardingStartedVersion(version: string): void;
	getOnboardedVersion(): string | undefined;
	setOnboardedVersion(version: string): void;
	getDefaultProvider(): string | undefined;
	getDefaultModel(): string | undefined;
	getDecisionModel(): string;
	getCompactionModel(): string;
	setCompactionModel(model: string, scope?: "global" | "project", options?: { persist?: boolean }): void;
	setDecisionModel(model: string, scope?: "global" | "project", options?: { persist?: boolean }): void;
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
	getOrCreateDeviceId(): string;
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
	getDefaultToolsWith(inherited: readonly string[]): string[] | undefined;
	getCodemodeMode(): "on" | "only" | undefined;
	setCodemodeMode(mode: "on" | "only" | undefined): void;
	getCodemodeInlineBudget(): number;
	getFallbackModels(): string[];
	getTransport(): TransportSetting;
	setTransport(transport: TransportSetting): void;
	getCompactionEnabled(): boolean;
	setCompactionEnabled(enabled: boolean): void;
	/** `model` is accepted for compatibility; per-model overrides were removed. */
	getCompactionReserveTokens(model?: CompactionModel): number;
	getCompactionSettings(model?: CompactionModel): {
		enabled: boolean;
		reserveTokens: number;
	};
	getBranchSummarySettings(): { reserveTokens: number; skipPrompt: boolean };
	getBranchSummarySkipPrompt(): boolean;
	getSessionSummarySettings(): { enabled: boolean };
	/** Merged `snapshots.*` settings; throws WorkspaceConfigError (source "settings") for an invalid value. */
	getWorktreeSnapshotSettings(): WorktreeSnapshotSettings;
	/** `snapshots.pool.*` settings; an invalid value falls back to its default, so a resume is never refused for it. */
	getWorktreePoolSettings(): WorktreePoolSettings;
	/**
	 * Deprecated `resume.setupCommand` from the global settings, trimmed; undefined when unset or blank. It runs as one
	 * global maintenance step of the blueprint build. A project's own value is ignored: it would run a
	 * repository-chosen command on a machine that never trusted the repository.
	 */
	getResumeSetupCommand(): string | undefined;
	/**
	 * `resume.waitForBlueprint`: `"prompt"` holds the session until the blueprint build ends; `"tools"` holds only its
	 * tool calls. Unset, it is `"prompt"` for a session with a UI (`interactive`, the default) and `"tools"` without one.
	 */
	getResumeWaitForBlueprint(interactive?: boolean): "prompt" | "tools";
	getRetryEnabled(): boolean;
	setRetryEnabled(enabled: boolean): void;
	getRetrySettings(): {
		enabled: boolean;
		maxRetries: number;
		baseDelayMs: number;
		maxAgentDelayMs: number;
		maxRetryDelayMs?: number;
		fallbackOnContentFilter: boolean;
	};
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
		return mode !== undefined && CACHE_WARMING_MODES.includes(mode) ? mode : SETTINGS_DEFAULTS.cacheWarming;
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

	setStorage(storage) {
		const state = settingsInternals(this);
		state.globalSettings.storage = storage;
		state.markModified("storage");
		state.save();
	},

	setStorageLayout(layout) {
		const state = settingsInternals(this);
		if (Object.hasOwn(layout, "storage")) {
			state.globalSettings.storage = layout.storage;
			state.markModified("storage");
		}
		if (Object.hasOwn(layout, "sessionsStorage")) {
			const sessions = { ...state.globalSettings.sessions, storage: layout.sessionsStorage };
			if (layout.sessionsStorage === undefined) delete sessions.storage;
			if (Object.keys(sessions).length === 0) {
				state.globalSettings.sessions = undefined;
				state.markModified("sessions");
			} else {
				state.globalSettings.sessions = sessions;
				state.markModified("sessions", "storage");
			}
		}
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

	getDefaultProvider() {
		return settingsInternals(this).settings.defaultProvider;
	},

	getDefaultModel() {
		return settingsInternals(this).settings.defaultModel;
	},

	getDecisionModel() {
		const value = settingsInternals(this).settings.decisionModel;
		if (value === undefined) return SETTINGS_DEFAULTS.decisionModel;
		if (typeof value !== "string" || value.trim() !== value) {
			throw new DecisionConfigError({ code: "invalid-setting", source: "settings", field: "decisionModel" });
		}
		return value;
	},

	getCompactionModel() {
		const value = settingsInternals(this).settings.compactionModel;
		if (value === undefined) return "";
		if (typeof value !== "string") {
			throw new Error("Invalid compactionModel: expected auto, an empty string, or an exact compactor model ID.");
		}
		return value.trim();
	},

	setCompactionModel(model, scope = "global", options) {
		if (typeof model !== "string" || model.trim() !== model) {
			throw new CompactionConfigError({ source: "sdk", field: "compactionModel", scope });
		}
		const state = settingsInternals(this);
		if (options?.persist === false) {
			if (scope === "project") {
				state.projectSettings = { ...state.projectSettings, compactionModel: model };
			} else {
				state.globalSettings.compactionModel = model;
			}
			state.settings = state.mergeEffectiveSettings();
			return;
		}
		if (scope === "project") {
			state.markProjectModified("compactionModel");
			state.saveProjectSettings({ ...state.projectSettings, compactionModel: model });
			return;
		}
		state.globalSettings.compactionModel = model;
		state.markModified("compactionModel");
		state.save();
	},

	setDecisionModel(model, scope, options) {
		if (typeof model !== "string" || model.trim() !== model) {
			throw new DecisionConfigError({
				code: "invalid-setting",
				source: "sdk",
				field: "decisionModel",
				...(scope ? { scope } : {}),
			});
		}
		const state = settingsInternals(this);
		if (options?.persist === false) {
			if (scope === "project") {
				state.projectSettings = { ...state.projectSettings, decisionModel: model };
			} else {
				state.globalSettings.decisionModel = model;
			}
			state.settings = state.mergeEffectiveSettings();
			return;
		}
		if (scope === "project") {
			const projectSettings = { ...state.projectSettings, decisionModel: model };
			state.markProjectModified("decisionModel");
			state.saveProjectSettings(projectSettings);
			return;
		}
		state.globalSettings.decisionModel = model;
		state.markModified("decisionModel");
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
		return settingsInternals(this).settings.steeringMode || SETTINGS_DEFAULTS.steeringMode;
	},

	setSteeringMode(mode) {
		const state = settingsInternals(this);
		state.globalSettings.steeringMode = mode;
		state.markModified("steeringMode");
		state.save();
	},

	getFollowUpMode() {
		return settingsInternals(this).settings.followUpMode || SETTINGS_DEFAULTS.followUpMode;
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

	getOrCreateDeviceId() {
		const state = settingsInternals(this);
		if (!state.globalSettings.deviceId) {
			state.globalSettings.deviceId = randomUUID();
			state.markModified("deviceId");
			state.save();
		}
		return state.globalSettings.deviceId;
	},

	getShowCacheMissNotices() {
		return settingsInternals(this).settings.showCacheMissNotices ?? SETTINGS_DEFAULTS.showCacheMissNotices;
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
		return settingsInternals(this).settings.modelThinkingLevels?.[`${normalizeProviderId(provider)}/${modelId}`];
	},

	getAllModelThinkingLevels() {
		return { ...(settingsInternals(this).settings.modelThinkingLevels ?? {}) };
	},

	setModelThinkingLevel(provider, modelId, level) {
		const state = settingsInternals(this);
		const key = `${normalizeProviderId(provider)}/${modelId}`;
		state.globalSettings.modelThinkingLevels ??= {};
		state.globalSettings.modelThinkingLevels[key] = level;
		state.markModified("modelThinkingLevels", key);
		state.save();
	},

	removeModelThinkingLevel(provider, modelId) {
		const state = settingsInternals(this);
		if (!state.globalSettings.modelThinkingLevels) return;
		const key = `${normalizeProviderId(provider)}/${modelId}`;
		delete state.globalSettings.modelThinkingLevels[key];
		if (Object.keys(state.globalSettings.modelThinkingLevels).length === 0)
			delete state.globalSettings.modelThinkingLevels;
		state.markModified("modelThinkingLevels", key);
		state.save();
	},

	getCodemodeMode() {
		const mode = settingsInternals(this).settings.codemode?.mode;
		return mode === "on" || mode === "only" ? mode : undefined;
	},
	setCodemodeMode(mode) {
		const state = settingsInternals(this);
		state.globalSettings.codemode = { ...state.globalSettings.codemode, mode };
		state.markModified("codemode", "mode");
		state.save();
	},
	getCodemodeInlineBudget() {
		const budget = settingsInternals(this).settings.codemode?.inlineBudget;
		return typeof budget === "number" && Number.isFinite(budget) && budget >= 0
			? Math.floor(budget)
			: SETTINGS_DEFAULTS.codemode.inlineBudget;
	},

	getDefaultTools() {
		// Settings load unvalidated from disk, so guard the shape here the same
		// way getFallbackModels() does: a non-array (or null) reads as unset,
		// and non-string entries are dropped rather than passed through to the
		// initial tool selection.
		const tools = settingsInternals(this).settings.defaultTools;
		return Array.isArray(tools)
			? resolveDefaultTools(tools.filter((tool): tool is string => typeof tool === "string"))
			: undefined;
	},

	getDefaultToolsWith(inherited) {
		const tools = settingsInternals(this).settings.defaultTools;
		return Array.isArray(tools)
			? resolveDefaultToolsWith(
					tools.filter((tool): tool is string => typeof tool === "string"),
					inherited,
				)
			: undefined;
	},

	getFallbackModels() {
		return stringEntries(settingsInternals(this).settings.fallbackModels)
			.map((model) => model.trim())
			.filter((model) => model.length > 0);
	},

	getTransport() {
		return settingsInternals(this).settings.transport ?? SETTINGS_DEFAULTS.transport;
	},

	setTransport(transport) {
		const state = settingsInternals(this);
		state.globalSettings.transport = transport;
		state.markModified("transport");
		state.save();
	},

	getCompactionEnabled() {
		return settingsInternals(this).settings.compaction?.enabled ?? SETTINGS_DEFAULTS.compaction.enabled;
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
		return resolveReserveTokens(settingsInternals(this).settings.compaction);
	},

	getCompactionSettings() {
		return {
			enabled: this.getCompactionEnabled(),
			reserveTokens: this.getCompactionReserveTokens(),
		};
	},

	getBranchSummarySettings() {
		return {
			reserveTokens:
				settingsInternals(this).settings.branchSummary?.reserveTokens ??
				SETTINGS_DEFAULTS.branchSummary.reserveTokens,
			skipPrompt:
				settingsInternals(this).settings.branchSummary?.skipPrompt ?? SETTINGS_DEFAULTS.branchSummary.skipPrompt,
		};
	},

	getBranchSummarySkipPrompt() {
		return settingsInternals(this).settings.branchSummary?.skipPrompt ?? SETTINGS_DEFAULTS.branchSummary.skipPrompt;
	},

	getSessionSummarySettings() {
		return {
			enabled: settingsInternals(this).settings.sessionSummary?.enabled ?? SETTINGS_DEFAULTS.sessionSummary.enabled,
		};
	},

	getWorktreeSnapshotSettings() {
		return resolveWorktreeSnapshotSettings(settingsInternals(this).settings.snapshots, "settings", "snapshots");
	},

	getWorktreePoolSettings() {
		const configured = settingsInternals(this).settings.snapshots?.pool?.maxIdlePerRepository;
		return {
			maxIdlePerRepository:
				Number.isSafeInteger(configured) && (configured as number) >= 0
					? (configured as number)
					: SETTINGS_DEFAULTS.snapshots.pool.maxIdlePerRepository,
		};
	},

	getResumeSetupCommand() {
		const command = settingsInternals(this).globalSettings.resume?.setupCommand?.trim();
		return command ? command : undefined;
	},

	getResumeWaitForBlueprint(interactive = true) {
		const configured = settingsInternals(this).settings.resume?.waitForBlueprint;
		if (configured === "prompt" || configured === "tools") return configured;
		return interactive ? "prompt" : "tools";
	},

	getRetryEnabled() {
		return settingsInternals(this).settings.retry?.enabled ?? SETTINGS_DEFAULTS.retry.enabled;
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
			maxRetries: settingsInternals(this).settings.retry?.maxRetries ?? SETTINGS_DEFAULTS.retry.maxRetries,
			baseDelayMs: settingsInternals(this).settings.retry?.baseDelayMs ?? SETTINGS_DEFAULTS.retry.baseDelayMs,
			maxRetryDelayMs: this.getProviderRetrySettings().maxRetryDelayMs,
			maxAgentDelayMs:
				settingsInternals(this).settings.retry?.maxAgentDelayMs ?? SETTINGS_DEFAULTS.retry.maxAgentDelayMs,
			fallbackOnContentFilter:
				settingsInternals(this).settings.retry?.fallbackOnContentFilter ??
				SETTINGS_DEFAULTS.retry.fallbackOnContentFilter,
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
		return SETTINGS_DEFAULTS.httpIdleTimeoutMs;
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
			maxRetryDelayMs:
				settingsInternals(this).settings.retry?.provider?.maxRetryDelayMs ??
				SETTINGS_DEFAULTS.retry.provider.maxRetryDelayMs,
		};
	},
};

Object.assign(SettingsManager.prototype, basicAccessors);
