import { type AnyModel, normalizeProviderId } from "@bastani/pi-ai";
import type { Settings } from "./settings-types.ts";

export const LEGACY_AZURE_PROVIDER = "azure-openai-responses";

export function normalizeModelProvider<T extends AnyModel>(model: T): T {
	const provider = normalizeProviderId(model.provider);
	return provider === model.provider ? model : { ...model, provider };
}

export function normalizeModelReference(reference: string): string {
	const slash = reference.indexOf("/");
	return slash < 0 ? reference : `${normalizeProviderId(reference.slice(0, slash))}${reference.slice(slash)}`;
}

export function normalizeProviderKeys<T>(entries: Record<string, T>): Record<string, T> {
	const result = { ...entries };
	for (const [key, value] of Object.entries(entries)) {
		const canonical = normalizeModelReference(normalizeProviderId(key));
		if (canonical === key) continue;
		if (!Object.hasOwn(result, canonical)) result[canonical] = value;
		delete result[key];
	}
	return result;
}

function isRecord<T>(value: T): value is T & Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function normalizeAzureSettings(settings: Settings): Settings {
	return {
		...settings,
		...(typeof settings.defaultProvider === "string" && {
			defaultProvider: normalizeProviderId(settings.defaultProvider),
		}),
		...(typeof settings.routerModel === "string" && { routerModel: normalizeModelReference(settings.routerModel) }),
		...(isStringArray(settings.enabledModels) && {
			enabledModels: settings.enabledModels.map(normalizeModelReference),
		}),
		...(isStringArray(settings.fallbackModels) && {
			fallbackModels: settings.fallbackModels.map(normalizeModelReference),
		}),
		...(isRecord(settings.modelThinkingLevels) && {
			modelThinkingLevels: normalizeProviderKeys(settings.modelThinkingLevels),
		}),
		...(isRecord(settings.modelRouting) && {
			modelRouting: {
				...settings.modelRouting,
				...(isStringArray(settings.modelRouting.allowedProviders) && {
					allowedProviders: settings.modelRouting.allowedProviders.map(normalizeProviderId),
				}),
				...(isStringArray(settings.modelRouting.excludedProviders) && {
					excludedProviders: settings.modelRouting.excludedProviders.map(normalizeProviderId),
				}),
			},
		}),
		...(isRecord(settings.compaction) &&
			isRecord(settings.compaction.modelOverrides) && {
				compaction: {
					...settings.compaction,
					modelOverrides: normalizeProviderKeys(settings.compaction.modelOverrides),
				},
			}),
	};
}
