import type { ThinkingLevel } from "@bastani/atomic-agent-core";
import { normalizeProviderId } from "@bastani/atomic-ai";
import { type Api, clampThinkingLevel, type Model } from "@bastani/atomic-ai/compat";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";

/** The settings `model: "auto"` reads: the user's default model and its thinking level. */
export interface AutoModelSettings {
	readonly defaultProvider?: string;
	readonly defaultModel?: string;
	readonly defaultThinkingLevel?: ThinkingLevel;
	readonly modelThinkingLevels?: Readonly<Record<string, ThinkingLevel>>;
}

export interface ResolveAutoModelOptions {
	/** The settings in effect, such as `SettingsManager.getSettings()` or `ExtensionAPI.getSettings()`. */
	readonly settings?: AutoModelSettings;
	/** The models that have credentials configured, such as `ModelRegistry.getAvailable()`. */
	readonly availableModels: readonly Model<Api>[];
	/** The current session's model, used when no default model is configured or available. */
	readonly sessionModel?: Model<Api>;
	/** The current session's thinking level, kept with its model. */
	readonly sessionThinkingLevel?: ThinkingLevel;
	/** The effort the caller set, which wins over every default. */
	readonly thinkingLevel?: ThinkingLevel;
}

export interface AutoModelSelection {
	readonly model: Model<Api>;
	readonly thinkingLevel: ThinkingLevel;
}

function configuredDefaultModel(
	settings: AutoModelSettings | undefined,
	availableModels: readonly Model<Api>[],
): Model<Api> | undefined {
	if (!settings?.defaultProvider || !settings.defaultModel) return undefined;
	const provider = normalizeProviderId(settings.defaultProvider);
	return availableModels.find((model) => model.provider === provider && model.id === settings.defaultModel);
}

/**
 * The model and thinking level `model: "auto"` stands for, without any model request: the user's configured default
 * model (`defaultProvider`/`defaultModel`, when it has credentials) at the caller's effort, else its
 * `modelThinkingLevels` entry, else `defaultThinkingLevel`; otherwise the current session's model at the caller's
 * effort, else the session's thinking level. Undefined when there is neither.
 */
export function resolveAutoModel(options: ResolveAutoModelOptions): AutoModelSelection | undefined {
	const configured = configuredDefaultModel(options.settings, options.availableModels);
	if (configured !== undefined) {
		const level =
			options.thinkingLevel ??
			options.settings?.modelThinkingLevels?.[`${configured.provider}/${configured.id}`] ??
			options.settings?.defaultThinkingLevel ??
			DEFAULT_THINKING_LEVEL;
		return { model: configured, thinkingLevel: clampThinkingLevel(configured, level) as ThinkingLevel };
	}
	if (options.sessionModel === undefined) return undefined;
	const level =
		options.thinkingLevel ??
		options.sessionThinkingLevel ??
		options.settings?.defaultThinkingLevel ??
		DEFAULT_THINKING_LEVEL;
	return {
		model: options.sessionModel,
		thinkingLevel: clampThinkingLevel(options.sessionModel, level) as ThinkingLevel,
	};
}
